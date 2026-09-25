// Known solar-system objects in the field at a given time, from IMCCE's SkyBoT
// cone search (which, unlike JPL's services, allows browser CORS requests).

const SKYBOT = 'https://ssp.imcce.fr/webservices/skybot/api/conesearch.php';
const cache = new Map();

function hms(s) {
  const [h, m, x] = s.trim().split(/\s+/).map(Number);
  return 15 * (h + m / 60 + x / 3600);
}

function dms(s) {
  const t = s.trim();
  const [d, m, x] = t.replace(/^[+-]/, '').split(/\s+/).map(Number);
  return (t.startsWith('-') ? -1 : 1) * (d + m / 60 + x / 3600);
}

// Geocentric positions; SPHEREx's low-Earth orbit shifts main-belt asteroids by
// only a few arcsec (under a pixel), near-Earth objects by more.
export function knownObjects(mjd, ra, dec, radiusDeg, signal) {
  const key = `${mjd.toFixed(4)},${ra.toFixed(4)},${dec.toFixed(4)},${radiusDeg.toFixed(3)}`;
  if (!cache.has(key)) {
    const q = new URLSearchParams({
      '-ep': (mjd + 2400000.5).toFixed(5),
      '-ra': ra.toFixed(5),
      '-dec': dec.toFixed(5),
      '-rd': radiusDeg.toFixed(4),
      '-mime': 'json',
      '-output': 'basic',
      '-loc': '500',
      '-filter': '0',
      '-objFilter': '111',
      '-from': 'SPHEREx-TimeLapse',
    });
    const p = fetch(`${SKYBOT}?${q}`, { signal })
      .then(r => {
        if (!r.ok) throw new Error(`SkyBoT HTTP ${r.status}`);
        return r.text();
      })
      .then(text => {
        // SkyBoT answers "no body found" with a non-JSON message.
        let rows;
        try { rows = JSON.parse(text); } catch { return []; }
        if (!Array.isArray(rows)) return [];
        return rows.map(o => ({
          name: o.Num ? `(${o.Num}) ${o.Name}` : o.Name,
          ra: hms(o['RA (hms)']),
          dec: dms(o['DEC (dms)']),
          vmag: Number(o['VMag (mag)']),
          kind: o.Class,
          rate: Math.hypot(Number(o['dRA (arcsec/h)']) || 0, Number(o['dDEC (arcsec/h)']) || 0),
        }));
      });
    cache.set(key, p);
    p.catch(() => cache.delete(key));
  }
  return cache.get(key);
}
