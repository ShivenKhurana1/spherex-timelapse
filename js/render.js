// Image statistics, stretches, colour maps and composite products.

export function median(arr) {
  const v = Float32Array.from(arr.filter(x => x === x));
  if (!v.length) return 0;
  v.sort();
  return v[v.length >> 1];
}

export function percentile(values, p) {
  if (!values.length) return 0;
  const i = Math.min(values.length - 1, Math.max(0, Math.round(p * (values.length - 1))));
  return values[i];
}

// Subtract the sky background so zodiacal light variations don't flicker.
export function backgroundSubtract(data) {
  const med = median(data);
  const out = new Float32Array(data.length);
  for (let i = 0; i < data.length; i++) out[i] = data[i] - med;
  const absdev = new Float32Array(data.length);
  for (let i = 0; i < data.length; i++) absdev[i] = Math.abs(out[i]);
  const sigma = 1.4826 * median(absdev) || 1;
  return { data: out, sigma };
}

// Per-pixel median across frames: the "static sky" template.
export function medianStack(frames) {
  const n = frames[0].length;
  const out = new Float32Array(n);
  const buf = new Float32Array(frames.length);
  for (let i = 0; i < n; i++) {
    let m = 0;
    for (const f of frames) { const v = f[i]; if (v === v) buf[m++] = v; }
    if (!m) { out[i] = NaN; continue; }
    const s = buf.subarray(0, m).sort();
    out[i] = m % 2 ? s[m >> 1] : 0.5 * (s[m / 2 - 1] + s[m / 2]);
  }
  return out;
}

export function subtract(a, b) {
  const out = new Float32Array(a.length);
  for (let i = 0; i < a.length; i++) out[i] = a[i] - b[i];
  return out;
}

// Sample finite values across frames and pick display limits.
export function stretchLimits(frames, lo = 0.005, hi = 0.998) {
  const sample = [];
  const step = Math.max(1, Math.floor((frames.length * frames[0].length) / 200000));
  let k = 0;
  for (const f of frames) for (let i = 0; i < f.length; i++) if (k++ % step === 0 && f[i] === f[i]) sample.push(f[i]);
  sample.sort((x, y) => x - y);
  return [percentile(sample, lo), percentile(sample, hi)];
}

const STRETCH = {
  linear: t => t,
  sqrt: t => Math.sqrt(t),
  asinh: t => Math.asinh(10 * t) / Math.asinh(10),
  log: t => Math.log10(1 + 999 * t) / 3,
};

function lerpStops(stops) {
  const lut = new Uint8ClampedArray(256 * 3);
  for (let i = 0; i < 256; i++) {
    const t = i / 255;
    let s = 0;
    while (s < stops.length - 2 && t > stops[s + 1][0]) s++;
    const [t0, c0] = stops[s], [t1, c1] = stops[s + 1];
    const f = (t - t0) / (t1 - t0 || 1);
    for (let ch = 0; ch < 3; ch++) lut[i * 3 + ch] = c0[ch] + (c1[ch] - c0[ch]) * f;
  }
  return lut;
}

export const COLORMAPS = {
  gray: lerpStops([[0, [0, 0, 0]], [1, [255, 255, 255]]]),
  infrared: lerpStops([[0, [0, 0, 4]], [0.25, [60, 10, 90]], [0.5, [180, 40, 80]], [0.75, [250, 140, 30]], [1, [252, 255, 164]]]),
  ice: lerpStops([[0, [4, 6, 20]], [0.35, [20, 60, 130]], [0.7, [90, 180, 220]], [1, [240, 255, 255]]]),
  // Diverging map for difference images: blue = fainter, red = brighter.
  diverging: lerpStops([[0, [40, 110, 255]], [0.5, [12, 14, 22]], [1, [255, 80, 50]]]),
};

// Paint a float image into an ImageData buffer.
export function paint(imageData, data, [lo, hi], stretch = 'asinh', cmap = 'gray', invert = false) {
  const f = STRETCH[stretch] || STRETCH.linear;
  const lut = COLORMAPS[cmap] || COLORMAPS.gray;
  const px = imageData.data;
  const range = hi - lo || 1;
  for (let i = 0; i < data.length; i++) {
    const v = data[i];
    if (v !== v) { px[4 * i] = 30; px[4 * i + 1] = 22; px[4 * i + 2] = 40; px[4 * i + 3] = 255; continue; }
    let t = Math.min(1, Math.max(0, (v - lo) / range));
    t = f(t);
    if (invert) t = 1 - t;
    const c = Math.round(t * 255) * 3;
    px[4 * i] = lut[c]; px[4 * i + 1] = lut[c + 1]; px[4 * i + 2] = lut[c + 2]; px[4 * i + 3] = 255;
  }
}

// Symmetric stretch for difference images.
export function paintDiff(imageData, data, limit) {
  const lut = COLORMAPS.diverging;
  const px = imageData.data;
  for (let i = 0; i < data.length; i++) {
    const v = data[i];
    if (v !== v) { px[4 * i] = 30; px[4 * i + 1] = 22; px[4 * i + 2] = 40; px[4 * i + 3] = 255; continue; }
    const t = 0.5 + 0.5 * Math.max(-1, Math.min(1, Math.asinh(3 * v / limit) / Math.asinh(3)));
    const c = Math.round(t * 255) * 3;
    px[4 * i] = lut[c]; px[4 * i + 1] = lut[c + 1]; px[4 * i + 2] = lut[c + 2]; px[4 * i + 3] = 255;
  }
}

// Colour-by-time composite of positive residuals: moving objects show up as a
// rainbow trail (purple = earliest, red = latest); static stars cancel out.
export function paintMotion(imageData, residuals, sigmas, threshold = 3) {
  const px = imageData.data;
  const n = residuals[0].length;
  const acc = new Float32Array(n * 3);
  const wsum = new Float32Array(n);
  const T = residuals.length;
  residuals.forEach((r, t) => {
    const [cr, cg, cb] = hue(T === 1 ? 0 : t / (T - 1));
    const s = sigmas[t] || 1;
    for (let i = 0; i < n; i++) {
      const z = r[i] / s;
      if (!(z > threshold)) continue;
      const w = Math.min(1, (z - threshold) / 8);
      acc[3 * i] += cr * w; acc[3 * i + 1] += cg * w; acc[3 * i + 2] += cb * w;
      wsum[i] += w;
    }
  });
  for (let i = 0; i < n; i++) {
    const w = wsum[i];
    const b = Math.min(1, w) / (w || 1);
    px[4 * i] = 8 + acc[3 * i] * b; px[4 * i + 1] = 8 + acc[3 * i + 1] * b; px[4 * i + 2] = 14 + acc[3 * i + 2] * b;
    px[4 * i + 3] = 255;
  }
}

export function hue(t) {
  // purple -> blue -> green -> yellow -> red
  const stops = [[0.55, 0.3, 1], [0.2, 0.6, 1], [0.2, 0.95, 0.5], [1, 0.9, 0.2], [1, 0.3, 0.2]];
  const x = t * (stops.length - 1);
  const i = Math.min(stops.length - 2, Math.floor(x)), f = x - i;
  return stops[i].map((c, k) => 255 * (c + (stops[i + 1][k] - c) * f));
}
