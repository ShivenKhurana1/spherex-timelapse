// TAN-SIP world coordinates against astropy, using a real SPHEREx header.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { WCS, tanProject, tanDeproject, D2R } from '../js/wcs.js';

const fx = JSON.parse(readFileSync(new URL('./fixtures/wcs.json', import.meta.url)));
const wcs = new WCS(fx.header);
const sepArcsec = ([r1, d1], [r2, d2]) =>
  Math.hypot((r1 - r2) * Math.cos(d1 * D2R), d1 - d2) * 3600;

test('pixel -> sky matches astropy to 0.1″', () => {
  fx.pix.forEach(([x, y], i) => {
    assert.ok(sepArcsec(wcs.pixToSky(x, y), fx.sky[i]) < 0.1, `pixel ${x},${y}`);
  });
});

test('sky -> pixel inverts astropy positions to 0.05 px', () => {
  fx.pix.forEach(([x, y], i) => {
    const [px, py] = wcs.skyToPix(...fx.sky[i]);
    assert.ok(Math.hypot(px - x, py - y) < 0.05, `pixel ${x},${y} -> ${px},${py}`);
  });
});

test('gnomonic projection round-trips, including across RA = 0', () => {
  for (const [ra0, dec0, ra, dec] of [[0.2, 10, 359.8, 10.3], [180, -89, 20, -88.5], [45, 30, 46, 31]]) {
    const c = [ra0 * D2R, dec0 * D2R];
    const [xi, eta] = tanProject(c, ra * D2R, dec * D2R);
    const back = tanDeproject(c, xi, eta);
    assert.ok(sepArcsec(back, [ra, dec]) < 1e-6);
  }
});
