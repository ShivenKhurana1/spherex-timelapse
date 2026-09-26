// The FLAGS layer's Rice decoder, bit-for-bit against astropy.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { riceDecode32 } from '../js/fits.js';

const fx = JSON.parse(readFileSync(new URL('./fixtures/rice.json', import.meta.url)));

for (const r of fx.rows) {
  test(`row ${r.row} decodes exactly`, () => {
    const comp = new Uint8Array(Buffer.from(r.compressed, 'base64'));
    const out = riceDecode32(comp, new Int32Array(fx.width), fx.blocksize);
    const exp = new Int32Array(new Uint8Array(Buffer.from(r.expected, 'base64')).buffer);
    assert.deepEqual(Array.from(out), Array.from(exp));
  });
}
