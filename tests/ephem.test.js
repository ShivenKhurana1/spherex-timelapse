import { test } from 'node:test';
import assert from 'node:assert/strict';
import { positionAt } from '../js/ephem.js';

test('interpolation wraps across RA = 0', () => {
  const pts = [{ mjd: 0, ra: 359.9, dec: 1, vmag: 10 }, { mjd: 1, ra: 0.1, dec: 2, vmag: 11 }];
  const p = positionAt(pts, 0.5);
  assert.ok(Math.abs(p.ra - 0) < 1e-9 || Math.abs(p.ra - 360) < 1e-9);
  assert.equal(p.dec, 1.5);
  assert.equal(positionAt(pts, 2), null);
});
