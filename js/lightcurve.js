// Aperture photometry on aligned cutouts + a small SVG brightness-vs-time chart.

import { PIXEL_ARCSEC } from './cutout.js';

const R_AP = 2.5, R_IN = 5, R_OUT = 8;
// MJy/sr summed over pixels -> mJy: 1e9 mJy/MJy × pixel solid angle (sr).
const TO_MJY = 1e9 * ((PIXEL_ARCSEC / 206265) ** 2);

// Snap a click to the brightest pixel within 2 px (on the median stack).
export function snapToPeak(img, n, i, j) {
  let best = [i, j], bv = -Infinity;
  for (let y = Math.max(0, j - 2); y <= Math.min(n - 1, j + 2); y++) {
    for (let x = Math.max(0, i - 2); x <= Math.min(n - 1, i + 2); x++) {
      const v = img[y * n + x];
      if (v > bv) { bv = v; best = [x, y]; }
    }
  }
  return best;
}

export function photometry(d, n, cx, cy, sigma) {
  let sum = 0, npix = 0, holes = 0;
  const ring = [];
  for (let y = Math.max(0, Math.floor(cy - R_OUT)); y <= Math.min(n - 1, Math.ceil(cy + R_OUT)); y++) {
    for (let x = Math.max(0, Math.floor(cx - R_OUT)); x <= Math.min(n - 1, Math.ceil(cx + R_OUT)); x++) {
      const r = Math.hypot(x - cx, y - cy), v = d[y * n + x];
      if (v !== v) { if (r <= 1.5) holes++; continue; }
      if (r <= R_AP) { sum += v; npix++; } else if (r >= R_IN && r <= R_OUT) ring.push(v);
    }
  }
  // Blank pixels at the centre mean the star saturated the detector.
  if (holes) return { saturated: true };
  if (npix < 10 || ring.length < 20) return null;
  ring.sort((a, b) => a - b);
  const bg = ring[ring.length >> 1];
  return { flux: (sum - bg * npix) * TO_MJY, err: sigma * Math.sqrt(npix) * TO_MJY };
}

const W = 760, H = 230, M = { l: 56, r: 16, t: 14, b: 30 };

function niceTicks(lo, hi, count = 4) {
  const span = hi - lo || 1;
  const step0 = span / count, mag = 10 ** Math.floor(Math.log10(step0));
  const step = [1, 2, 2.5, 5, 10].map(m => m * mag).find(s => s >= step0);
  const out = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + 1e-9; v += step) out.push(+v.toPrecision(12));
  return out;
}

function fmtFlux(v) {
  const a = Math.abs(v);
  return a >= 1000 ? `${(v / 1000).toFixed(a >= 10000 ? 0 : 1)} Jy` : `${v.toFixed(a >= 100 ? 0 : a >= 10 ? 1 : 2)} mJy`;
}

// points: [{mjd, date, flux, err, i}] ; current: index into frames
export function renderChart(svg, points, current, fmtDate) {
  if (!points.length) { svg.innerHTML = ''; return; }
  const t0 = points[0].mjd, t1 = points[points.length - 1].mjd;
  const tp = Math.max(1, (t1 - t0) * 0.03);
  const lo = Math.min(...points.map(p => p.flux - p.err));
  const hi = Math.max(...points.map(p => p.flux + p.err));
  const pad = (hi - lo) * 0.08 || Math.abs(hi) * 0.1 || 1;
  const y0 = lo - pad, y1 = hi + pad;
  const X = t => M.l + ((t - (t0 - tp)) / (t1 - t0 + 2 * tp)) * (W - M.l - M.r);
  const Y = v => H - M.b - ((v - y0) / (y1 - y0)) * (H - M.t - M.b);

  const yTicks = niceTicks(y0, y1);
  const grid = yTicks.map(v => `
    <line x1="${M.l}" x2="${W - M.r}" y1="${Y(v)}" y2="${Y(v)}" class="lc-grid"/>
    <text x="${M.l - 8}" y="${Y(v) + 4}" text-anchor="end" class="lc-tick">${fmtFlux(v)}</text>`).join('');

  // Month ticks along the bottom
  const xt = [];
  const start = new Date((t0 - 40587) * 864e5), end = new Date((t1 - 40587) * 864e5);
  const months = (end.getUTCFullYear() - start.getUTCFullYear()) * 12 + end.getUTCMonth() - start.getUTCMonth();
  const step = months > 18 ? 6 : months > 8 ? 3 : months > 2 ? 1 : 0;
  if (step) {
    for (const d = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 1)); d <= end; d.setUTCMonth(d.getUTCMonth() + step)) {
      const x = X(d.getTime() / 864e5 + 40587);
      xt.push(`<text x="${x}" y="${H - 8}" text-anchor="middle" class="lc-tick">${d.toLocaleDateString(undefined, { month: 'short', year: '2-digit', timeZone: 'UTC' })}</text>`);
    }
  } else {
    xt.push(`<text x="${X(t0)}" y="${H - 8}" text-anchor="start" class="lc-tick">${fmtDate(points[0].date)}</text>`);
    xt.push(`<text x="${X(t1)}" y="${H - 8}" text-anchor="end" class="lc-tick">${fmtDate(points[points.length - 1].date)}</text>`);
  }

  const marks = points.map((p, k) => {
    const x = X(p.mjd), y = Y(p.flux);
    const cur = p.i === current;
    return `<g class="lc-pt${cur ? ' cur' : ''}" data-k="${k}">
      <line x1="${x}" x2="${x}" y1="${Y(p.flux - p.err)}" y2="${Y(p.flux + p.err)}" class="lc-err"/>
      <circle cx="${x}" cy="${y}" r="${cur ? 6 : 4.5}" class="lc-dot"/>
      <circle cx="${x}" cy="${y}" r="12" class="lc-hit"/>
    </g>`;
  }).join('');

  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.innerHTML = `${grid}
    <line x1="${M.l}" x2="${W - M.r}" y1="${H - M.b}" y2="${H - M.b}" class="lc-axis"/>
    ${xt.join('')}${marks}`;
}

export function toCSV(points) {
  return 'date_utc,mjd,flux_mJy,err_mJy\n' + points.map(p =>
    `${p.date.toISOString()},${p.mjd.toFixed(5)},${p.flux.toFixed(4)},${p.err.toFixed(4)}`).join('\n');
}
