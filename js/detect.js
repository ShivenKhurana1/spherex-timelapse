// Find things that changed: compact sources in (frame − median sky) that are
// either absent from the template ("new": asteroids, comets, transients) or much
// brighter than usual ("brightened": flaring or variable stars).

import { median } from './render.js';

const THRESH = 6;          // peak significance (σ of the filtered residual)
const MIN_PIX = 4;         // connected pixels above 3σ, to reject leftover spikes
const EDGE = 4;            // ignore the cutout border
const NEW_FRAC = 0.35;     // template flux below this × residual ⇒ "new"
const BRIGHT_FRAC = 0.5;   // residual above this × template ⇒ "brightened"
const HALO_R = 25;         // px: glow radius around very bright sources
const HALO_FRAC = 0.05;    // fainter than this × a neighbour ⇒ part of its glow

function median3(d, w) {
  const out = new Float32Array(d.length);
  const buf = new Float32Array(9);
  for (let y = 0; y < w; y++) {
    for (let x = 0; x < w; x++) {
      let m = 0;
      for (let dy = -1; dy <= 1; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= w) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx;
          if (xx < 0 || xx >= w) continue;
          const v = d[yy * w + xx];
          if (v === v) buf[m++] = v;
        }
      }
      out[y * w + x] = m ? buf.subarray(0, m).sort()[m >> 1] : NaN;
    }
  }
  return out;
}

function robustSigma(d) {
  const a = [];
  for (let i = 0; i < d.length; i += 2) if (d[i] === d[i]) a.push(Math.abs(d[i]));
  return 1.4826 * median(a) || 1;
}

// Sum within radius r of (cx, cy), and mean of an annulus [r1, r2].
function apStats(d, w, cx, cy, r, r1, r2) {
  let s = 0, n = 0, a = 0, an = 0;
  for (let y = Math.max(0, cy - r2); y <= Math.min(w - 1, cy + r2); y++) {
    for (let x = Math.max(0, cx - r2); x <= Math.min(w - 1, cx + r2); x++) {
      const v = d[y * w + x];
      if (v !== v) continue;
      const rr = Math.hypot(x - cx, y - cy);
      if (rr <= r) { s += v; n++; } else if (rr >= r1 && rr <= r2) { a += v; an++; }
    }
  }
  return { sum: s, n, ring: an ? a / an : 0 };
}

// frames: [{data, ...}], template: Float32Array, w: size.
// Returns [{frame, x, y, snr, kind, flux, base}] sorted by significance.
export function findChanges(frames, template, w) {
  const out = [];
  frames.forEach((f, fi) => {
    const res = new Float32Array(w * w);
    for (let i = 0; i < res.length; i++) res[i] = f.data[i] - template[i];
    const r = median3(res, w);
    const s = robustSigma(r);
    for (let y = EDGE; y < w - EDGE; y++) {
      for (let x = EDGE; x < w - EDGE; x++) {
        const v = r[y * w + x];
        if (!(v > THRESH * s)) continue;
        // Local maximum in a 5x5 box
        let isMax = true;
        for (let dy = -2; dy <= 2 && isMax; dy++) {
          for (let dx = -2; dx <= 2; dx++) {
            if ((dx || dy) && r[(y + dy) * w + x + dx] > v) { isMax = false; break; }
          }
        }
        if (!isMax) continue;
        // Enough connected signal, and point-like (not a broad glow or ghost band)
        let npix = 0;
        for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) if (r[(y + dy) * w + x + dx] > 3 * s) npix++;
        if (npix < MIN_PIX) continue;
        const R = apStats(r, w, x, y, 2, 5, 7);
        if (R.ring > 0.3 * v) continue;
        // Any blank pixels at the peak means saturation or masking: not trustworthy.
        let holes = 0;
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) if (f.data[(y + dy) * w + x + dx] !== f.data[(y + dy) * w + x + dx]) holes++;
        if (holes) continue;
        const flux = R.sum - R.ring * R.n;
        const T = apStats(template, w, x, y, 2, 5, 7);
        const base = T.sum - T.ring * T.n;
        let kind = null;
        if (base < NEW_FRAC * flux) kind = 'new';
        else if (flux > BRIGHT_FRAC * base) kind = 'brightened';
        if (!kind) continue;
        // Sub-pixel centroid (3x3, positive residual only) for measuring motion.
        let sx = 0, sy = 0, sw = 0;
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
          const q = r[(y + dy) * w + x + dx];
          if (q > 0) { sx += q * dx; sy += q * dy; sw += q; }
        }
        const c = { frame: fi, x, y, cx: x + sx / sw, cy: y + sy / sw, snr: v / s, kind, flux, base };
        if (f.parts) {
          // Real sources show up in every exposure of the visit; a cosmic ray
          // or satellite glint shows up in one.
          const peak = raw => {
            let m = -Infinity;
            for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
              const k = (y + dy) * w + x + dx;
              const d = raw[k] - template[k];
              if (d > m) m = d;
            }
            return m;
          };
          const ref = peak(f.data);
          c.parts = f.parts.length;
          c.seenIn = f.parts.filter(p => peak(p) > 0.4 * ref).length;
          c.glitch = c.seenIn < 2;
        }
        out.push(c);
      }
    }
  });
  // Something flagged at the same spot in most visits is a static source the
  // median missed (or a persistent artifact), not a change.
  const persistent = out.filter(a => out.filter(b => Math.abs(a.x - b.x) <= 2 && Math.abs(a.y - b.y) <= 2).length > frames.length / 2);
  const kept = [];
  for (const c of out.filter(a => !persistent.includes(a)).sort((a, b) => b.snr - a.snr)) {
    // Same source found twice, or a bump in the glow of something far brighter.
    const shadowed = kept.some(k => k.frame === c.frame && (
      Math.hypot(k.x - c.x, k.y - c.y) < 3 ||
      (Math.hypot(k.x - c.x, k.y - c.y) < HALO_R && c.snr < HALO_FRAC * k.snr)));
    if (!shadowed) kept.push(c);
  }
  return kept;
}

// Cut a small square around (x, y) for list thumbnails.
export function crop(d, w, x, y, half = 8) {
  const n = 2 * half + 1;
  const out = new Float32Array(n * n);
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const xx = x - half + i, yy = y - half + j;
      out[j * n + i] = xx < 0 || yy < 0 || xx >= w || yy >= w ? NaN : d[yy * w + xx];
    }
  }
  return out;
}

// ---------- linking detections into moving-object tracklets ----------

const LINK_TOL = 2.5;       // px: how far a detection may sit from the straight-line path
const MIN_MOVE = 3;        // px of total motion; less can't be told apart from a stationary source
const MAX_SPAN = 30;        // days

function fitLine(pts) {
  // Least squares x(t), y(t) = a + b·t; returns velocity and RMS residual.
  const n = pts.length, mt = pts.reduce((s, p) => s + p.t, 0) / n;
  const mx = pts.reduce((s, p) => s + p.x, 0) / n, my = pts.reduce((s, p) => s + p.y, 0) / n;
  const stt = pts.reduce((s, p) => s + (p.t - mt) ** 2, 0) || 1e-12;
  const vx = pts.reduce((s, p) => s + (p.t - mt) * (p.x - mx), 0) / stt;
  const vy = pts.reduce((s, p) => s + (p.t - mt) * (p.y - my), 0) / stt;
  const rms = Math.sqrt(pts.reduce((s, p) => s + (p.x - (mx + vx * (p.t - mt))) ** 2 + (p.y - (my + vy * (p.t - mt))) ** 2, 0) / n);
  return { vx, vy, rms, t0: mt, x0: mx, y0: my };
}

// Greedy linking: try every pair as a seed, collect detections on the implied
// path (at most one per time), keep the longest paths first.
function link(dets, { minPoints, minMove, maxSpan, tol }) {
  const used = new Set();
  const tracks = [];
  const seeds = [];
  for (let i = 0; i < dets.length; i++) {
    for (let j = i + 1; j < dets.length; j++) {
      const a = dets[i], b = dets[j];
      const dt = b.t - a.t;
      if (a.group === b.group || dt <= 0 || dt > maxSpan) continue;
      seeds.push([a, b]);
    }
  }
  const candidates = [];
  for (const [a, b] of seeds) {
    const dt = b.t - a.t;
    const vx = (b.x - a.x) / dt, vy = (b.y - a.y) / dt;
    const members = new Map();
    for (const c of dets) {
      if (Math.abs(c.t - a.t) > maxSpan) continue;
      const px = a.x + vx * (c.t - a.t), py = a.y + vy * (c.t - a.t);
      const d = Math.hypot(c.x - px, c.y - py);
      if (d > tol) continue;
      const prev = members.get(c.group);
      if (!prev || d < prev.d) members.set(c.group, { c, d });
    }
    if (members.size < minPoints) continue;
    const pts = [...members.values()].map(m => m.c).sort((p, q) => p.t - q.t);
    const fit = fitLine(pts);
    const move = Math.hypot(fit.vx, fit.vy) * (pts.at(-1).t - pts[0].t);
    if (move < minMove || fit.rms > tol / 1.5) continue;
    candidates.push({ pts, fit });
  }
  candidates.sort((p, q) => q.pts.length - p.pts.length || p.fit.rms - q.fit.rms);
  for (const cand of candidates) {
    if (cand.pts.some(p => used.has(p))) continue;
    cand.pts.forEach(p => used.add(p));
    tracks.push(cand);
  }
  return tracks;
}

// Slow movers seen on several visits. changes: output of findChanges (non-glitch
// "new" sources); frames: the loaded frames (for times).
export function linkAcrossVisits(changes, frames) {
  const dets = changes
    // "Brightened" counts too: a mover passing over a faint star looks like one.
    .filter(c => !c.glitch)
    .map(c => ({ x: c.cx ?? c.x, y: c.cy ?? c.y, t: frames[c.frame].mjd, group: c.frame, change: c }));
  return link(dets, { minPoints: 3, minMove: MIN_MOVE, maxSpan: MAX_SPAN, tol: LINK_TOL })
    .map(tr => ({ kind: 'slow', ...tr, changes: tr.pts.map(p => p.change) }));
}

// Fast movers within one visit: detect in each exposure separately and link
// detections that step along a line in time order. frame.parts[k] is exposure k
// (background-subtracted) taken at frame.partTimes[k].
export function linkWithinVisits(frames, template, w) {
  const out = [];
  frames.forEach((f, fi) => {
    if (!f.parts || f.parts.length < 3) return;
    const dets = [];
    f.parts.forEach((part, k) => {
      const res = new Float32Array(w * w);
      for (let i = 0; i < res.length; i++) res[i] = part[i] - template[i];
      const r = median3(res, w);
      const s = robustSigma(r);
      for (let y = EDGE; y < w - EDGE; y++) {
        for (let x = EDGE; x < w - EDGE; x++) {
          const v = r[y * w + x];
          if (!(v > THRESH * s)) continue;
          let isMax = true;
          for (let dy = -2; dy <= 2 && isMax; dy++) for (let dx = -2; dx <= 2; dx++) if ((dx || dy) && r[(y + dy) * w + x + dx] > v) { isMax = false; break; }
          if (!isMax) continue;
          let npix = 0;
          for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) if (r[(y + dy) * w + x + dx] > 3 * s) npix++;
          if (npix < 3) continue;
          dets.push({ x, y, t: f.partTimes[k], group: k, snr: v / s });
        }
      }
    });
    if (dets.length > 150) return; // a crowded or artifact-ridden visit; linking would be noise
    // Peak positions jitter by a pixel, so demand clear motion across the visit,
    // and that each spot is empty in the visit's other exposures: a real fast
    // mover leaves its earlier positions behind, a stationary source doesn't.
    const vacated = (d, others) => {
      const at = img => {
        let s = 0;
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) s += (img[(d.y + dy) * w + d.x + dx] - template[(d.y + dy) * w + d.x + dx]) || 0;
        return s;
      };
      const here = at(f.parts[d.group]);
      return others.every(k => at(f.parts[k]) < 0.3 * here);
    };
    for (const tr of link(dets, { minPoints: 3, minMove: 4, maxSpan: 1, tol: 1.5 })) {
      const groups = tr.pts.map(p => p.group);
      if (!tr.pts.every(p => vacated(p, groups.filter(g => g !== p.group)))) continue;
      out.push({ kind: 'fast', ...tr, frame: fi });
    }
  });
  return out;
}
