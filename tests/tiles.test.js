// The browser must look in the same sky tiles the Python index builder wrote to.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { tilesNear } from '../js/catalog.js';

const pts = JSON.parse(readFileSync(new URL('./fixtures/tiles.json', import.meta.url)));

test('tile keys agree with tools/build_index.py', () => {
  for (const [ra, dec, key] of pts) {
    assert.ok(tilesNear(ra, dec, 0.001, 5).includes(key), `${ra},${dec} should include ${key}`);
  }
});
