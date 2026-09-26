// Change detection on synthetic frames.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findChanges } from '../js/detect.js';
import { medianStack } from '../js/render.js';

const n = 64;
function noise(seed) {
  let s = seed;
  const rnd = () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  return Float32Array.from({ length: n * n }, () => (rnd() + rnd() + rnd() - 1.5) * 0.02);
}
function addStar(d, x, y, amp) {
  for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) d[(y + dy) * n + x + dx] += amp * Math.exp(-(dx * dx + dy * dy) / 1.5);
}

function frames({ mover, glitch }) {
  return Array.from({ length: 7 }, (_, t) => {
    const parts = [0, 1, 2].map(k => {
      const d = noise(100 * t + k + 1);
      addStar(d, 20, 20, 5); // a steady star
      if (mover) addStar(d, 10 + 6 * t, 40, 1.5);
      if (glitch && t === 3 && k === 0) addStar(d, 30, 30, 3); // a compact hit in one exposure only
      return d;
    });
    const data = parts[0].map((_, i) => (parts[0][i] + parts[1][i] + parts[2][i]) / 3);
    return { data, parts, sigma: 0.02 };
  });
}

test('finds a moving source in every frame and ignores the steady star', () => {
  const fr = frames({ mover: true });
  const c = findChanges(fr, medianStack(fr.map(f => f.data)), n);
  const hits = c.filter(x => x.kind === 'new' && Math.abs(x.y - 40) <= 1);
  assert.ok(hits.length >= 6, `found ${hits.length}`);
  assert.ok(!c.some(x => Math.abs(x.x - 20) <= 2 && Math.abs(x.y - 20) <= 2), 'steady star flagged');
  assert.ok(hits.every(h => !h.glitch));
});

test('a hit in one exposure of a visit is marked as a glitch', () => {
  const fr = frames({ glitch: true });
  const c = findChanges(fr, medianStack(fr.map(f => f.data)), n);
  const g = c.filter(x => Math.abs(x.x - 30) <= 1 && Math.abs(x.y - 30) <= 1);
  assert.ok(g.length >= 1, 'the hit should be detected');
  assert.ok(g.every(x => x.glitch && x.seenIn === 1), JSON.stringify(g));
});
