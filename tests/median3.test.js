import test from 'node:test';
import assert from 'node:assert/strict';
import { median3 } from '../js/render.js';

test('fast 3x3 median matches a plain sort, NaNs included', () => {
  const w = 37, d = new Float32Array(w * w);
  let s = 7;
  const rnd = () => ((s = (s * 1103515245 + 12345) % 2147483648) / 2147483648);
  for (let i = 0; i < d.length; i++) d[i] = rnd() < 0.03 ? NaN : Math.round(rnd() * 50) - 20;
  const got = median3(d, w);
  for (let y = 0; y < w; y++) for (let x = 0; x < w; x++) {
    const v = [];
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const yy = y + dy, xx = x + dx;
      if (yy >= 0 && xx >= 0 && yy < w && xx < w && d[yy * w + xx] === d[yy * w + xx]) v.push(d[yy * w + xx]);
    }
    v.sort((a, b) => a - b);
    const want = v.length ? v[v.length >> 1] : NaN;
    assert.ok(Object.is(got[y * w + x], Math.fround(want)) || got[y * w + x] === want, `(${x},${y}) ${got[y * w + x]} vs ${want}`);
  }
});
