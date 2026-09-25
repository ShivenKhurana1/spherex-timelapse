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
