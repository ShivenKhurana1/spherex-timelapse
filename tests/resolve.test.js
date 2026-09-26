import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCoords } from '../js/resolve.js';

const close = (a, b) => a && Math.abs(a[0] - b[0]) < 1e-6 && Math.abs(a[1] - b[1]) < 1e-6;

test('decimal and sexagesimal coordinates', () => {
  assert.ok(close(parseCoords('83.82 -5.39'), [83.82, -5.39]));
  assert.ok(close(parseCoords('270, 66.56'), [270, 66.56]));
  assert.ok(close(parseCoords('05:35:16.8 -05:23:15'), [83.82, -5.3875]));
  assert.ok(close(parseCoords('05h35m16.8s -05d23m15s'), [83.82, -5.3875]));
});

test('names and out-of-range values are not coordinates', () => {
  assert.equal(parseCoords('M42'), null);
  assert.equal(parseCoords('400 1'), null);
  assert.equal(parseCoords('10 95'), null);
});
