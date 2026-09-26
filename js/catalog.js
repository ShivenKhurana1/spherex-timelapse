// Find SPHEREx exposures covering a sky position using the static tile index
// built by tools/build_index.py (IRSA's own search API doesn't allow browser CORS).

// The same public bucket answers on several hostnames. S3 speaks HTTP/1.1, where
// browsers allow only ~6 connections per host, so spreading files across hosts
// lets many more range requests run at once. A file always maps to the same host.
const S3_HOSTS = [
  'https://nasa-irsa-spherex.s3.amazonaws.com/',
  'https://nasa-irsa-spherex.s3.us-east-1.amazonaws.com/',
  'https://s3.amazonaws.com/nasa-irsa-spherex/',
  'https://s3.us-east-1.amazonaws.com/nasa-irsa-spherex/',
];

function s3Base(key) {
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) | 0;
  return S3_HOSTS[Math.abs(h) % S3_HOSTS.length];
}
const HALF_SIDE = 1.74;   // detector half-width in degrees (2040 px × 6.15″ / 2)
const SEARCH_R = 2.5;     // max centre distance for a detector to contain the target

export const DETECTORS = {
  1: { name: 'D1', range: '0.75–1.09 µm', color: '#7aa2ff' },
  2: { name: 'D2', range: '1.10–1.62 µm', color: '#6fd3ff' },
  3: { name: 'D3', range: '1.63–2.41 µm', color: '#77e0b5' },
  4: { name: 'D4', range: '2.42–3.82 µm', color: '#f2d36b' },
  5: { name: 'D5', range: '3.83–4.41 µm', color: '#ffa25c' },
  6: { name: 'D6', range: '4.42–5.00 µm', color: '#ff6b6b' },
};

let indexPromise = null;
export function loadIndex() {
  indexPromise ??= fetch('data/index.json').then(r => {
    if (!r.ok) throw new Error('Could not load the SPHEREx image index.');
    return r.json();
  });
  indexPromise.catch(() => { indexPromise = null; });
  return indexPromise;
}

const tileCache = new Map();
function loadTile(key, signal) {
  if (!tileCache.has(key)) {
    const p = fetch(`data/tiles/${key}.bin`, { signal }).then(r => {
      if (!r.ok) throw new Error(`tile ${key}: HTTP ${r.status}`);
      return r.arrayBuffer();
    });
    tileCache.set(key, p);
    p.catch(() => tileCache.delete(key));
  }
  return tileCache.get(key);
}

// Must mirror tile_key() in tools/build_index.py.
function bandInfo(band, deg) {
  const lo = -90 + band * deg, hi = lo + deg;
  const edge = lo < 0 && hi > 0 ? 0 : Math.min(Math.abs(lo), Math.abs(hi));
  return Math.max(1, Math.ceil((360 * Math.cos((edge * Math.PI) / 180)) / deg));
}

function tilesNear(ra, dec, r, deg) {
  const keys = new Set();
  const nBands = Math.round(180 / deg);
  const b0 = Math.max(0, Math.floor((dec - r + 90) / deg));
  const b1 = Math.min(nBands - 1, Math.floor((dec + r + 90) / deg));
  const maxAbsDec = Math.min(90, Math.abs(dec) + r);
  const dra = maxAbsDec >= 89.9 ? 360 : r / Math.cos((maxAbsDec * Math.PI) / 180);
  for (let b = b0; b <= b1; b++) {
    const n = bandInfo(b, deg);
    if (dra >= 180) { for (let i = 0; i < n; i++) keys.add(`${b}_${i}`); continue; }
    const i0 = Math.floor((((ra - dra) % 360 + 360) % 360) / 360 * n);
    const span = Math.ceil((2 * dra) / 360 * n) + 1;
    for (let k = 0; k <= span; k++) keys.add(`${b}_${(i0 + k) % n}`);
  }
  return [...keys];
}

const D2R = Math.PI / 180;

function project(ra0, dec0, ra, dec) {
  ra0 *= D2R; dec0 *= D2R; ra *= D2R; dec *= D2R;
  const c = Math.sin(dec0) * Math.sin(dec) + Math.cos(dec0) * Math.cos(dec) * Math.cos(ra - ra0);
  if (c <= 0) return null;
  return [
    (Math.cos(dec) * Math.sin(ra - ra0)) / c / D2R,
    (Math.cos(dec0) * Math.sin(dec) - Math.sin(dec0) * Math.cos(dec) * Math.cos(ra - ra0)) / c / D2R,
  ];
}

export function mjdToDate(mjd) {
  return new Date((mjd - 40587) * 86400000);
}

// Decode one tile row into an exposure record.
function decodeRow(v, o, index) {
  const det = v.getUint8(o + 14), sub = v.getUint8(o + 15);
  const [coll, folder] = index.folders[v.getUint16(o + 16, true)].split('/');
  const seq = String(v.getUint16(o + 18, true)).padStart(4, '0');
  const ver = index.versions[v.getUint16(o + 20, true)];
  const id = `${folder}_${seq}_${sub}`;
  const mjd = v.getFloat32(o + 8, true) + index.mjd0;
  return {
    id,
    detector: det,
    mjd,
    date: mjdToDate(mjd),
    url: `${s3Base(id + det)}${coll}/level2/${folder}/${ver}/${det}/level2_${id}D${det}_spx_${ver}.fits`,
  };
}

// Is (ra, dec) inside the detector footprint stored at row offset o? Returns
// the fractional distance to the edge (0 = centre, 1 = edge) or null.
function contains(v, o, ra, dec) {
  const p = project(v.getFloat32(o, true), v.getFloat32(o + 4, true), ra, dec);
  if (!p || Math.hypot(p[0], p[1]) > SEARCH_R) return null;
  const pa = (v.getInt16(o + 12, true) / 100) * D2R;
  const u = p[0] * Math.cos(pa) + p[1] * Math.sin(pa);
  const w = -p[0] * Math.sin(pa) + p[1] * Math.cos(pa);
  if (Math.abs(u) > HALF_SIDE || Math.abs(w) > HALF_SIDE) return null;
  return Math.max(Math.abs(u), Math.abs(w)) / HALF_SIDE;
}

// Returns exposures sorted by time: {id, detector, mjd, date, url}
export async function findExposures(ra, dec, signal) {
  const index = await loadIndex();
  const keys = tilesNear(ra, dec, SEARCH_R, index.tileDeg).filter(k => index.tiles[k]);
  const buffers = await Promise.all(keys.map(k => loadTile(k, signal)));
  const out = [];
  for (const buf of buffers) {
    const v = new DataView(buf);
    for (let o = 0; o + index.rowBytes <= buf.byteLength; o += index.rowBytes) {
      const edge = contains(v, o, ra, dec);
      if (edge !== null) out.push({ ...decodeRow(v, o, index), edge });
    }
  }
  return out.sort((a, b) => a.mjd - b.mjd);
}

// Exposures that caught a moving object. positionAt(mjd) -> {ra, dec, vmag} | null.
// Each result carries the object's position at that exposure's time.
export async function findAlongPath(points, positionAt, signal, onProgress) {
  const index = await loadIndex();
  const keys = new Set();
  for (const p of points) for (const k of tilesNear(p.ra, p.dec, SEARCH_R, index.tileDeg)) if (index.tiles[k]) keys.add(k);
  const list = [...keys];
  const out = [];
  let done = 0;
  const queue = [...list];
  const worker = async () => {
    while (queue.length) {
      const buf = await loadTile(queue.shift(), signal);
      const v = new DataView(buf);
      for (let o = 0; o + index.rowBytes <= buf.byteLength; o += index.rowBytes) {
        const mjd = v.getFloat32(o + 8, true) + index.mjd0;
        const pos = positionAt(mjd);
        if (!pos) continue;
        const edge = contains(v, o, pos.ra, pos.dec);
        if (edge !== null) out.push({ ...decodeRow(v, o, index), edge, obj: pos });
      }
      onProgress?.(++done, list.length);
    }
  };
  await Promise.all(Array.from({ length: 8 }, worker));
  return out.sort((a, b) => a.mjd - b.mjd);
}
