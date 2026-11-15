import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCoords, formatRA, formatDec } from '../js/resolve.js';

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

test('sexagesimal formatting carries rounded seconds', () => {
  assert.equal(formatDec(-(5 + 23 / 60 + 59.7 / 3600)), '−05°24′00″');
  assert.equal(formatDec(10 + 59 / 60 + 59.9 / 3600), '+11°00′00″');
  assert.equal(formatRA(15 * (1 + 59 / 60 + 59.97 / 3600)), '02h00m00.0s');
  assert.equal(formatRA(359.99999), '00h00m00.0s');
  assert.equal(formatRA(83.82), '05h35m16.8s');
});
