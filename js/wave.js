// Wavelength at a detector pixel, from each file's WCS-WAVE lookup table.
//
// SPHEREx's linear variable filter makes wavelength change across each detector.
// The table (a coarse X×Y grid of [wavelength, bandwidth] in µm) is the last HDU
// of every file, so one small suffix range request fetches it. Tables are shared
// by files with the same processing version and detector, so we cache by that.

const cache = new Map();
const BLOCK = 2880;

function tableKey(url) {
  const m = url.match(/level2\/[^/]+\/([^/]+)\/(\d)\//);
  return m ? `${m[1]}/${m[2]}` : url;
}

export function parseWaveTable(bytes) {
  const txt = new TextDecoder('ascii').decode(bytes);
  const at = txt.lastIndexOf("XTENSION= 'BINTABLE'");
  if (at < 0) throw new Error('WCS-WAVE not found');
  const cards = {};
  let p = at;
  for (; p + 80 <= txt.length; p += 80) {
    const c = txt.slice(p, p + 80);
    if (c.startsWith('END')) break;
    if (c.slice(8, 10) === '= ') cards[c.slice(0, 8).trim()] = c.slice(10).split('/')[0].trim().replace(/'/g, '').trim();
  }
  if (cards.EXTNAME !== 'WCS-WAVE') throw new Error('last HDU is not WCS-WAVE');
  const dataStart = at + Math.ceil((p + 80 - at) / BLOCK) * BLOCK;
  const nx = parseInt(cards.TFORM1, 10), ny = parseInt(cards.TFORM2, 10), nv = parseInt(cards.TFORM3, 10);
  const v = new DataView(bytes.buffer, bytes.byteOffset + dataStart);
  const xs = Array.from({ length: nx }, (_, i) => v.getInt32(4 * i, false));
  const ys = Array.from({ length: ny }, (_, i) => v.getInt32(4 * (nx + i), false));
  // VALUES has FITS dims (2, nx, ny): [wavelength, bandwidth] fastest, then X, then Y.
  const vals = Float32Array.from({ length: nv }, (_, i) => v.getFloat32(4 * (nx + ny + i), false));
  return { xs, ys, vals };
}

function bracket(nodes, t) {
  let i = 0;
  while (i < nodes.length - 2 && t > nodes[i + 1]) i++;
  const f = Math.max(0, Math.min(1, (t - nodes[i]) / (nodes[i + 1] - nodes[i])));
  return [i, f];
}

// x, y: 0-based pixel. Returns { lam, bw } in µm.
export function lookup(table, x, y) {
  const { xs, ys, vals } = table;
  const nx = xs.length;
  const [i, fx] = bracket(xs, x + 1); // table uses raw 1-based FITS pixels
  const [j, fy] = bracket(ys, y + 1);
  const at = (ii, jj, k) => vals[((jj * nx) + ii) * 2 + k];
  const bil = k => (at(i, j, k) * (1 - fx) + at(i + 1, j, k) * fx) * (1 - fy) + (at(i, j + 1, k) * (1 - fx) + at(i + 1, j + 1, k) * fx) * fy;
  return { lam: bil(0), bw: bil(1) };
}

export function waveTable(url, signal) {
  const key = tableKey(url);
  if (!cache.has(key)) {
    const p = fetch(url, { headers: { Range: `bytes=-${4 * BLOCK}` }, signal })
      .then(r => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.arrayBuffer();
      })
      .then(b => parseWaveTable(new Uint8Array(b)));
    cache.set(key, p);
    p.catch(() => cache.delete(key));
  }
  return cache.get(key);
}

export async function wavelengthAt(url, x, y, signal) {
  return lookup(await waveTable(url, signal), x, y);
}
