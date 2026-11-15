import test from 'node:test';
import assert from 'node:assert/strict';
import { leakFraction, starNoise, tame } from '../js/render.js';

const W = 40, SIG = 1;
const star = (img, x0, y0, flux, dx = 0) => {
  for (let y = 0; y < W; y++) for (let x = 0; x < W; x++) {
    img[y * W + x] += flux * Math.exp(-((x - x0 - dx) ** 2 + (y - y0) ** 2) / 2);
  }
};

test('star leftovers fade but a new source keeps its strength', () => {
  const T = new Float32Array(W * W);
  star(T, 12, 12, 500);
  star(T, 28, 25, 300);
  // Each visit: the stars land slightly off, as SPHEREx's coarse pixels do.
  const frames = [-0.3, 0.2, 0.35, -0.15].map(dx => {
    const f = new Float32Array(W * W);
    star(f, 12, 12, 500, dx);
    star(f, 28, 25, 300, dx);
    return f;
  });
  const leak = leakFraction(frames, T, SIG);
  assert.ok(leak > 0.05 && leak < 1, `leak ${leak}`);
  const k = starNoise(T, W, SIG, leak);

  const f = frames[2].slice();
  star(f, 20, 33, 30); // an asteroid where the template is empty
  const r = f.map((v, i) => v - T[i]);
  const tamed = tame(r, k);
  const peak = (a, x, y, rad) => {
    let m = 0;
    for (let yy = y - rad; yy <= y + rad; yy++) for (let xx = x - rad; xx <= x + rad; xx++) m = Math.max(m, Math.abs(a[yy * W + xx]));
    return m;
  };
  assert.ok(peak(tamed, 12, 12, 3) < peak(r, 12, 12, 3) / 5, 'star residual is suppressed');
  assert.ok(peak(tamed, 20, 33, 1) > 0.95 * peak(r, 20, 33, 1), 'new source is untouched');
});
