// Ephemerides for comets and asteroids from IMCCE's Miriade service (CORS-enabled).

const MIRIADE = 'https://ssp.imcce.fr/webservices/miriade/api/ephemcc.php';
export const SURVEY_START_MJD = 60785; // 2025-04-20, first SPHEREx Quick Release week
const STEP_H = 6;

function sexa(s, hours) {
  const neg = s.trim().startsWith('-');
  const [a, b, c] = s.replace(/^[+-]/, '').split(':').map(Number);
  return (neg ? -1 : 1) * (a + b / 60 + c / 3600) * (hours ? 15 : 1);
}

function looksLikeComet(name) {
  // 3I/ATLAS, 12P, 12P/Pons-Brooks, C/2023 A3, P/2019 LD2, 2I
  return /^\s*(\d+\s*[PCDXI]\b|[PCDXI]\/)/i.test(name);
}

async function query(prefixed, startMjd, days, signal) {
  const q = new URLSearchParams({
    '-name': prefixed,
    '-ep': (startMjd + 2400000.5).toFixed(1),
    '-nbd': String(Math.ceil((days * 24) / STEP_H) + 1),
    '-step': `${STEP_H}h`,
    '-observer': '500',
    '-mime': 'json',
  });
  const r = await fetch(`${MIRIADE}?${q}`, { signal });
  const d = await r.json();
  if (!d.sso || !Array.isArray(d.data)) throw new Error(d.message || 'not found');
  return d;
}

let featured = null;
export function featuredTracks() {
  featured ??= fetch('data/tracks/index.json').then(r => (r.ok ? r.json() : { objects: [] })).catch(() => ({ objects: [] }));
  return featured;
}

const norm = t => t.toLowerCase().replace(/[()]/g, '').replace(/\s+/g, ' ').trim();

// Returns { name, kind, source, points: [{mjd, ra, dec, vmag}] } covering the survey so far.
// Featured objects use precomputed JPL Horizons tracks (as seen from SPHEREx);
// anything else is computed live by IMCCE Miriade (geocentric).
export async function ephemeris(name, signal) {
  const { objects } = await featuredTracks();
  const hit = objects.find(o => o.aliases.includes(norm(name)));
  if (hit) {
    const d = await fetch(`data/tracks/${hit.file}`, { signal }).then(r => r.json());
    return {
      name: d.name,
      kind: d.kind,
      source: d.source,
      precise: true,
      points: d.points.map(([mjd, ra, dec, vmag]) => ({ mjd, ra, dec, vmag })),
    };
  }
  return miriade(name, signal);
}

async function miriade(name, signal) {
  const start = SURVEY_START_MJD;
  const days = Date.now() / 864e5 + 40587 - start + 1;
  const tries = looksLikeComet(name) ? [`c:${name}`, `a:${name}`] : [`a:${name}`, `c:${name}`];
  let d;
  for (const t of tries) {
    try { d = await query(t.trim(), start, days, signal); break; } catch (e) {
      if (signal?.aborted) throw e;
    }
  }
  if (!d) throw new Error(`Couldn't find a comet or asteroid called “${name}”.`);
  const points = d.data.map(p => ({
    mjd: Date.parse(p.Date.endsWith('Z') ? p.Date : `${p.Date}Z`) / 864e5 + 40587,
    ra: sexa(p.RA, true),
    dec: sexa(p.DEC, false),
    vmag: Number(p.VMag),
  }));
  return { name: d.sso.name, kind: d.sso.type, source: 'IMCCE Miriade (geocentric)', precise: false, points };
}

// Linear interpolation (RA wrap-safe) of the object's position at time mjd.
export function positionAt(points, mjd) {
  if (mjd < points[0].mjd || mjd > points[points.length - 1].mjd) return null;
  let lo = 0, hi = points.length - 1;
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (points[m].mjd <= mjd) lo = m; else hi = m; }
  const a = points[lo], b = points[hi];
  const f = (mjd - a.mjd) / (b.mjd - a.mjd || 1);
  let dra = b.ra - a.ra;
  if (dra > 180) dra -= 360; else if (dra < -180) dra += 360;
  return { ra: ((a.ra + dra * f) % 360 + 360) % 360, dec: a.dec + (b.dec - a.dec) * f, vmag: a.vmag + (b.vmag - a.vmag) * f };
}
