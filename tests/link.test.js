// Linking detections into moving-object tracklets, on synthetic data.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { linkAcrossVisits, linkWithinVisits } from '../js/detect.js';

test('links a slow mover seen on several visits', () => {
  const frames = [0, 1.1, 2.0, 4.2, 6.4].map(mjd => ({ mjd }));
  // 2 px/day to the right and 1 px/day down, plus scattered unrelated detections
  const changes = frames.map((f, i) => ({ frame: i, x: 30 + 2 * f.mjd, y: 40 + f.mjd, kind: 'new' }));
  changes.push({ frame: 0, x: 70, y: 10, kind: 'new' }, { frame: 2, x: 12, y: 75, kind: 'new' }, { frame: 4, x: 55, y: 60, kind: 'new' });
  const tr = linkAcrossVisits(changes, frames);
  assert.equal(tr.length, 1);
  assert.equal(tr[0].changes.length, 5);
  assert.ok(Math.abs(tr[0].fit.vx - 2) < 0.05 && Math.abs(tr[0].fit.vy - 1) < 0.05);
});

test('unrelated single detections do not link', () => {
  const frames = [0, 1, 2, 3].map(mjd => ({ mjd }));
  const changes = [[10, 10], [50, 70], [80, 20], [30, 85]].map(([x, y], i) => ({ frame: i, x, y, kind: 'new' }));
  assert.equal(linkAcrossVisits(changes, frames).length, 0);
});

test('glitches are not linked', () => {
  const frames = [0, 1, 2].map(mjd => ({ mjd }));
  const changes = frames.map((f, i) => ({ frame: i, x: 20 + 3 * i, y: 20, kind: 'new', glitch: true }));
  assert.equal(linkAcrossVisits(changes, frames).length, 0);
});

test('finds a fast mover stepping across the exposures of one visit', () => {
  const n = 48;
  let seed = 9;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  const template = new Float32Array(n * n);
  const blob = (d, x, y, a) => { for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) d[(y + dy) * n + x + dx] += a * Math.exp(-(dx * dx + dy * dy) / 1.5); };
  const times = [0, 0.0015, 0.003, 0.0045];
  const parts = times.map((_, k) => {
    const d = Float32Array.from({ length: n * n }, () => (rnd() - 0.5) * 0.02);
    blob(d, 10 + 5 * k, 24 + 2 * k, 1); // 5 px right, 2 px down per exposure
    return d;
  });
  const tr = linkWithinVisits([{ parts, partTimes: times }], template, n);
  assert.equal(tr.length, 1);
  assert.ok(tr[0].pts.length >= 3);
  const perExposure = Math.hypot(tr[0].fit.vx, tr[0].fit.vy) * 0.0015;
  assert.ok(Math.abs(perExposure - Math.hypot(5, 2)) < 0.3, `speed ${perExposure}`);
});
