// Build aligned, north-up cutouts from SPHEREx exposures.

import { readImageHeader, readRows } from './fits.js';
import { WCS, tanDeproject, D2R } from './wcs.js';

export const PIXEL_ARCSEC = 6.15;
const headerCache = new Map();

async function getHeader(url, signal) {
  if (!headerCache.has(url)) {
    const p = readImageHeader(url, signal).then(info => ({ ...info, wcs: new WCS(info.header) }));
    headerCache.set(url, p);
    p.catch(() => headerCache.delete(url));
  }
  return headerCache.get(url);
}

// Output grid: size x size, north up, east left, centred on (ra, dec).
function gridToSky(ra, dec, size, scaleArcsec) {
  const centre = [ra * D2R, dec * D2R];
  const s = (scaleArcsec / 3600) * D2R;
  const half = (size - 1) / 2;
  const sky = new Float64Array(size * size * 2);
  for (let j = 0; j < size; j++) {
    for (let i = 0; i < size; i++) {
      const [r, d] = tanDeproject(centre, -(i - half) * s, (half - j) * s);
      const k = (j * size + i) * 2;
      sky[k] = r; sky[k + 1] = d;
    }
  }
  return sky;
}

const gridCache = new Map();
function cachedGrid(ra, dec, size, scale) {
  const k = `${ra},${dec},${size},${scale}`;
  if (!gridCache.has(k)) { gridCache.clear(); gridCache.set(k, gridToSky(ra, dec, size, scale)); }
  return gridCache.get(k);
}

// Returns { data: Float32Array(size*size), valid } or { offImage: true }.
export async function makeCutout(exposure, ra, dec, size, signal, scale = PIXEL_ARCSEC) {
  const info = await getHeader(exposure.url, signal);
  const { wcs, width, height } = info;
  const c = wcs.skyToPix(ra, dec);
  if (!c || c[0] < -size / 2 || c[1] < -size / 2 || c[0] > width + size / 2 || c[1] > height + size / 2) {
    return { offImage: true };
  }

  const sky = cachedGrid(ra, dec, size, scale);
  const px = new Float32Array(size * size * 2);
  let ymin = Infinity, ymax = -Infinity;
  for (let k = 0; k < size * size; k++) {
    const p = wcs.skyToPix(sky[2 * k], sky[2 * k + 1]);
    px[2 * k] = p[0]; px[2 * k + 1] = p[1];
    if (p[1] < ymin) ymin = p[1];
    if (p[1] > ymax) ymax = p[1];
  }
  const y0 = Math.max(0, Math.floor(ymin) - 1);
  const y1 = Math.min(height - 1, Math.ceil(ymax) + 1);
  if (y0 > y1) return { offImage: true };

  const rows = await readRows(exposure.url, info, y0, y1, signal);
  const out = new Float32Array(size * size);
  let valid = 0;
  for (let k = 0; k < size * size; k++) {
    const v = bilinear(rows, px[2 * k], px[2 * k + 1] - rows.y0, width, rows.y1 - rows.y0 + 1);
    out[k] = v;
    if (v === v) valid++;
  }
  if (valid < size * size * 0.1) return { offImage: true };
  return { data: out, valid: valid / (size * size), header: info.header };
}

function bilinear(rows, x, y, w, h) {
  if (x < 0 || y < 0 || x > w - 1 || y > h - 1) return NaN;
  const x0 = Math.floor(x), y0 = Math.floor(y);
  const x1 = Math.min(x0 + 1, w - 1), y1 = Math.min(y0 + 1, h - 1);
  const fx = x - x0, fy = y - y0;
  const d = rows.data;
  const a = d[y0 * w + x0], b = d[y0 * w + x1], c = d[y1 * w + x0], e = d[y1 * w + x1];
  // If a neighbour is bad, fall back to nearest pixel.
  if (!(a === a && b === b && c === c && e === e)) {
    return d[Math.round(y) * w + Math.round(x)];
  }
  return (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + e * fx) * fy;
}
