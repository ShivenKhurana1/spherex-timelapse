// Colour correction: removes wavelength-driven scatter, keeps real variability.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { colourCorrect } from '../js/lightcurve.js';

let seed = 3;
const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
const spectrum = lam => 20 * (1.2 / lam) ** 2.2; // a star getting fainter to the red
const robustScatter = v => {
  const m = [...v].sort((a, b) => a - b)[v.length >> 1];
  const d = v.map(x => Math.abs(x - m)).sort((a, b) => a - b);
  return (1.4826 * d[d.length >> 1]) / m;
};

function visits(variability) {
  return Array.from({ length: 40 }, (_, i) => {
    const lam = 1.1 + 0.5 * rnd();
    const t = i;
    const flux = spectrum(lam) * variability(t) * (1 + 0.005 * (rnd() - 0.5));
    return { lam, flux, err: 0.05, mjd: t };
  });
}

test('a steady star’s colour scatter is removed', () => {
  const pts = visits(() => 1);
  const before = robustScatter(pts.map(p => p.flux));
  const after = robustScatter(colourCorrect(pts).points.map(p => p.flux));
  assert.ok(before > 0.1, `setup: scatter ${before}`);
  assert.ok(after < 0.01, `after correction ${after}`);
});

test('real variability over time survives', () => {
  const amp = 0.15;
  const pts = visits(t => 1 + amp * Math.sin(t / 3));
  const out = colourCorrect(pts).points;
  // Correlate corrected flux with the injected signal
  const sig = out.map(p => Math.sin(p.mjd / 3));
  const f = out.map(p => p.flux);
  const mean = a => a.reduce((s, v) => s + v, 0) / a.length;
  const ms = mean(sig), mf = mean(f);
  const cov = mean(sig.map((s, i) => (s - ms) * (f[i] - mf)));
  const slope = cov / mean(sig.map(s => (s - ms) ** 2));
  const recovered = slope / mf;
  assert.ok(Math.abs(recovered - amp) < 0.03, `recovered amplitude ${recovered.toFixed(3)} vs ${amp}`);
});

test('too few points: no correction', () => {
  assert.equal(colourCorrect(visits(() => 1).slice(0, 4)), null);
});
