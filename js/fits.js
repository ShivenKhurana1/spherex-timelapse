// Minimal FITS reader that uses HTTP range requests so we only download the
// header and the image rows we actually need from a 66 MB SPHEREx file.

const BLOCK = 2880;
const CARD = 80;

async function fetchRange(url, start, end, signal) {
  const res = await fetch(url, { headers: { Range: `bytes=${start}-${end}` }, signal });
  if (!res.ok && res.status !== 206) throw new Error(`HTTP ${res.status} for ${url}`);
  return new Uint8Array(await res.arrayBuffer());
}

function parseValue(raw) {
  // Strip inline comment (outside quotes).
  let s = raw.trim();
  if (s.startsWith("'")) {
    const end = s.indexOf("'", 1);
    return s.slice(1, end).trim();
  }
  const slash = s.indexOf('/');
  if (slash >= 0) s = s.slice(0, slash).trim();
  if (s === 'T') return true;
  if (s === 'F') return false;
  const n = Number(s);
  return Number.isNaN(n) ? s : n;
}

// Parse header cards starting at `offset` in `bytes`. Returns null if END isn't
// inside the buffer yet.
function parseHeader(bytes, offset) {
  const header = {};
  const dec = new TextDecoder('ascii');
  for (let p = offset; p + CARD <= bytes.length; p += CARD) {
    const card = dec.decode(bytes.subarray(p, p + CARD));
    const key = card.slice(0, 8).trim();
    if (key === 'END') {
      const headerEnd = Math.ceil((p + CARD - offset) / BLOCK) * BLOCK + offset;
      return { header, dataStart: headerEnd };
    }
    if (card.slice(8, 10) === '= ') header[key] = parseValue(card.slice(10));
  }
  return null;
}

function dataSize(h) {
  if (!h.NAXIS) return 0;
  let n = Math.abs(h.BITPIX) / 8;
  for (let i = 1; i <= h.NAXIS; i++) n *= h[`NAXIS${i}`];
  return Math.ceil(n / BLOCK) * BLOCK;
}

// Read primary + first IMAGE extension headers. SPHEREx L2 headers fit in ~26 KB.
export async function readImageHeader(url, signal) {
  let bytes = await fetchRange(url, 0, BLOCK * 12 - 1, signal);
  const grow = async () => {
    const more = await fetchRange(url, bytes.length, bytes.length + BLOCK * 12 - 1, signal);
    const merged = new Uint8Array(bytes.length + more.length);
    merged.set(bytes); merged.set(more, bytes.length);
    bytes = merged;
  };
  let prim;
  while (!(prim = parseHeader(bytes, 0))) await grow();
  const extStart = prim.dataStart + dataSize(prim.header);
  while (bytes.length <= extStart) await grow();
  let ext;
  while (!(ext = parseHeader(bytes, extStart))) await grow();
  const h = ext.header;
  if (h.BITPIX !== -32 || h.NAXIS !== 2) throw new Error('Unexpected image format');
  return {
    header: h,
    primary: prim.header,
    dataStart: ext.dataStart,
    width: h.NAXIS1,
    height: h.NAXIS2,
    // FLAGS extension follows the IMAGE data directly.
    nextHduStart: ext.dataStart + dataSize(h),
  };
}

// Read rows [y0, y1] (0-based, inclusive) of a big-endian float32 image.
export async function readRows(url, info, y0, y1, signal) {
  y0 = Math.max(0, y0); y1 = Math.min(info.height - 1, y1);
  const rowBytes = info.width * 4;
  const start = info.dataStart + y0 * rowBytes;
  const end = info.dataStart + (y1 + 1) * rowBytes - 1;
  const bytes = await fetchRange(url, start, end, signal);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out = new Float32Array(bytes.byteLength / 4);
  for (let i = 0; i < out.length; i++) out[i] = view.getFloat32(i * 4, false);
  return { y0, y1, width: info.width, data: out };
}

// ---------- FLAGS extension (tile-compressed, RICE_1, one tile per row) ----------

// Bit planes we treat as bad data. Deliberately NOT masked: OVERFLOW/NONLINEAR
// (would punch holes in bright stars and asteroids), STREAK (could hide fast
// movers), SOURCE and GHOST* (informational).
export const BAD_FLAGS =
  (1 << 0) | (1 << 2) | (1 << 6) | (1 << 9) | (1 << 10) | (1 << 11) |
  (1 << 17) | (1 << 19) | (1 << 27) | (1 << 28);

// Header + the whole row-descriptor table usually fit in one ~34 KB read.
export async function readFlagsInfo(url, info, signal) {
  let bytes = await fetchRange(url, info.nextHduStart, info.nextHduStart + BLOCK * 14 - 1, signal);
  let hdr = parseHeader(bytes, 0);
  if (!hdr) throw new Error('FLAGS header too long');
  const h = hdr.header;
  if (h.EXTNAME !== 'FLAGS' || h.ZCMPTYPE !== 'RICE_1' || h.ZTILE2 !== 1) return null;
  const tableBytes = h.NAXIS1 * h.NAXIS2;
  if (bytes.length < hdr.dataStart + tableBytes) {
    bytes = await fetchRange(url, info.nextHduStart, info.nextHduStart + hdr.dataStart + tableBytes - 1, signal);
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset + hdr.dataStart, tableBytes);
  const desc = new Int32Array(h.NAXIS2 * 2);
  for (let r = 0; r < h.NAXIS2; r++) {
    desc[2 * r] = view.getInt32(r * h.NAXIS1, false);       // compressed bytes
    desc[2 * r + 1] = view.getInt32(r * h.NAXIS1 + 4, false); // heap offset
  }
  return {
    width: h.ZNAXIS1,
    desc,
    heapStart: info.nextHduStart + hdr.dataStart + (h.THEAP ?? tableBytes),
    blocksize: 32,
  };
}

export async function readFlagRows(url, flags, y0, y1, signal) {
  const { desc, width } = flags;
  let lo = Infinity, hi = -Infinity;
  for (let r = y0; r <= y1; r++) {
    lo = Math.min(lo, desc[2 * r + 1]);
    hi = Math.max(hi, desc[2 * r + 1] + desc[2 * r]);
  }
  const heap = await fetchRange(url, flags.heapStart + lo, flags.heapStart + hi - 1, signal);
  const out = new Int32Array((y1 - y0 + 1) * width);
  for (let r = y0; r <= y1; r++) {
    const off = desc[2 * r + 1] - lo;
    riceDecode32(heap.subarray(off, off + desc[2 * r]), out.subarray((r - y0) * width, (r - y0 + 1) * width), flags.blocksize);
  }
  return out;
}

// Port of cfitsio's fits_rdecomp for 4-byte pixels.
export function riceDecode32(c, out, nblock) {
  const FSBITS = 5, FSMAX = 25, BBITS = 32;
  let pos = 4;
  let lastpix = ((c[0] << 24) | (c[1] << 16) | (c[2] << 8) | c[3]) | 0;
  let b = c[pos++] | 0;  // bit buffer
  let nbits = 8;         // bits remaining in b
  const n = out.length;
  for (let i = 0; i < n;) {
    nbits -= FSBITS;
    while (nbits < 0) { b = (b << 8) | c[pos++]; nbits += 8; }
    const fs = ((b >>> nbits) & ((1 << FSBITS) - 1)) - 1;
    b &= (1 << nbits) - 1;
    const imax = Math.min(i + nblock, n);
    if (fs < 0) {
      for (; i < imax; i++) out[i] = lastpix;
    } else if (fs === FSMAX) {
      for (; i < imax; i++) {
        let k = BBITS - nbits;
        let diff = (b << k) >>> 0;
        for (k -= 8; k >= 0; k -= 8) { b = c[pos++]; diff = (diff | (b << k)) >>> 0; }
        if (nbits > 0) { b = c[pos++]; diff = (diff | (b >>> (-k))) >>> 0; b &= (1 << nbits) - 1; } else b = 0;
        const d = diff & 1 ? ~(diff >>> 1) : diff >>> 1;
        out[i] = lastpix = (d + lastpix) | 0;
      }
    } else {
      for (; i < imax; i++) {
        while (b === 0) { nbits += 8; b = c[pos++]; }
        const nzero = nbits - (31 - Math.clz32(b)) - 1;
        nbits -= nzero + 1;
        b ^= 1 << nbits;
        nbits -= fs;
        while (nbits < 0) { b = (b << 8) | c[pos++]; nbits += 8; }
        const diff = ((nzero << fs) | (b >>> nbits)) >>> 0;
        b &= (1 << nbits) - 1;
        const d = diff & 1 ? ~(diff >>> 1) : diff >>> 1;
        out[i] = lastpix = (d + lastpix) | 0;
      }
    }
  }
  return out;
}
