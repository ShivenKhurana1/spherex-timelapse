// Wavelength lookup (WCS-WAVE table) against scipy's bilinear interpolation of the same table.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseWaveTable, lookup } from '../js/wave.js';

const fx = JSON.parse(readFileSync(new URL('./fixtures/wave.json', import.meta.url)));
const table = parseWaveTable(new Uint8Array(Buffer.from(fx.tail, 'base64')));

test('parses the table from the end of a real file', () => {
  assert.equal(table.xs.length, 11);
  assert.equal(table.ys.length, 11);
});

test('wavelength matches reference interpolation to 1e-5 µm', () => {
  fx.pix.forEach(([x, y], i) => {
    const { lam } = lookup(table, x, y);
    assert.ok(Math.abs(lam - fx.lam[i]) < 1e-5, `(${x},${y}) ${lam} vs ${fx.lam[i]}`);
  });
});
