// Change detection on synthetic frames.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findChanges, pairSignal, pairVerdict } from '../js/detect.js';
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

test('exposures hours apart do not call a moving source a glitch', () => {
  // Same-day grouping: one exposure, then two more ~5 hours later, by which
  // time the asteroid has moved 12 px. It is unverified, not a glitch.
  const times = [60000, 60000.2, 60000.203];
  const fr = Array.from({ length: 7 }, (_, t) => {
    const parts = times.map((_, k) => {
      const d = noise(500 + 10 * t + k);
      addStar(d, 20, 20, 5);
      if (t === 3) addStar(d, k === 0 ? 30 : 42, 30, 3);
      return d;
    });
    const data = parts[0].map((_, i) => (parts[0][i] + parts[1][i] + parts[2][i]) / 3);
    return { data, parts, partTimes: times, sigma: 0.02 };
  });
  const c = findChanges(fr, medianStack(fr.map(f => f.data)), n);
  const early = c.find(x => x.frame === 3 && Math.abs(x.x - 30) <= 1 && Math.abs(x.y - 30) <= 1);
  const late = c.find(x => x.frame === 3 && Math.abs(x.x - 42) <= 1 && Math.abs(x.y - 30) <= 1);
  assert.ok(early && !early.glitch && !early.parts, 'early position should be unverified, not a glitch');
  assert.ok(late && !late.glitch && late.seenIn === 2, 'late position is in both close exposures');
});

test('an exposure with blank pixels at the spot abstains', () => {
  const fr = frames({ mover: true });
  for (const f of fr) for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
    // saturate the mover's core in exposure 0 of every visit
    const t = fr.indexOf(f);
    f.parts[0][(40 + dy) * n + 10 + 6 * t + dx] = NaN;
  }
  const c = findChanges(fr, medianStack(fr.map(f => f.data)), n);
  const hits = c.filter(x => x.kind === 'new' && Math.abs(x.y - 40) <= 1);
  assert.ok(hits.length >= 6 && hits.every(h => !h.glitch && h.parts === 2), JSON.stringify(hits.map(h => [h.seenIn, h.parts])));
});

test('partner detector: real sources confirm, bright cosmic rays are rejected', () => {
  const s = 15, flat = () => Float32Array.from({ length: s * s }, (_, i) => Math.sin(i * 12.9898) * 0.01);
  const withStar = flat(); withStar[7 * s + 7] += 0.3; withStar[7 * s + 8] += 0.2;
  assert.ok(pairSignal(withStar, s) > 20);
  assert.ok(pairSignal(flat(), s) < 4);
  assert.equal(pairVerdict(500, 2), 'cosmic');
  assert.equal(pairVerdict(500, 20), 'cosmic', 'a 500σ source should be far brighter than 20σ on the partner');
  assert.equal(pairVerdict(40, 13), 'confirmed');
  assert.equal(pairVerdict(10, 2), null, 'too faint to judge');
  assert.equal(pairVerdict(30, null), null);
});
