// Turn user input ("M42", "83.82 -5.39", "05:35:17 -05:23:15") into [ra, dec] degrees.

const SESAME = 'https://cds.unistra.fr/cgi-bin/nph-sesame/-oxp/SNV?';

function sexa(str, hours) {
  const parts = str.trim().replace(/[hdms°'"′″:]/g, ' ').trim().split(/\s+/).map(Number);
  if (parts.some(Number.isNaN)) return NaN;
  const neg = /^\s*-/.test(str);
  const [a, b = 0, c = 0] = parts.map(Math.abs);
  const v = a + b / 60 + c / 3600;
  return (neg ? -v : v) * (hours ? 15 : 1);
}

export function parseCoords(input) {
  const s = input.trim().replace(/,/g, ' ');
  // Two plain decimal numbers
  let m = s.match(/^([+-]?\d+(?:\.\d+)?)\s+([+-]?\d+(?:\.\d+)?)$/);
  if (m) return check(Number(m[1]), Number(m[2]));
  // Sexagesimal: split where the declination sign starts, or into halves
  m = s.match(/^(\d{1,2}[\s:h]+\d{1,2}[\s:m]+\d{1,2}(?:\.\d+)?s?)\s+([+-]?\d{1,2}[\s:d°]+\d{1,2}[\s:m'′]+\d{1,2}(?:\.\d+)?["″s]?)$/);
  if (m) return check(sexa(m[1], true), sexa(m[2], false));
  return null;
}

function check(ra, dec) {
  if (!(ra >= 0 && ra < 360 && dec >= -90 && dec <= 90)) return null;
  return [ra, dec];
}

export async function resolve(input, signal) {
  const c = parseCoords(input);
  if (c) return { ra: c[0], dec: c[1], name: null };
  const res = await fetch(SESAME + encodeURIComponent(input.trim()), { signal });
  const doc = new DOMParser().parseFromString(await res.text(), 'application/xml');
  const ra = doc.querySelector('jradeg'), dec = doc.querySelector('jdedeg');
  if (!ra || !dec) throw new Error(`Couldn't find "${input}". Try another name or enter RA Dec in degrees.`);
  return { ra: Number(ra.textContent), dec: Number(dec.textContent), name: input.trim() };
}

export function formatRA(ra) {
  const h = ra / 15;
  const hh = Math.floor(h), mm = Math.floor((h - hh) * 60), ss = ((h - hh) * 60 - mm) * 60;
  return `${String(hh).padStart(2, '0')}h${String(mm).padStart(2, '0')}m${ss.toFixed(1).padStart(4, '0')}s`;
}

export function formatDec(dec) {
  const sign = dec < 0 ? '−' : '+';
  const d = Math.abs(dec);
  const dd = Math.floor(d), mm = Math.floor((d - dd) * 60), ss = ((d - dd) * 60 - mm) * 60;
  return `${sign}${String(dd).padStart(2, '0')}°${String(mm).padStart(2, '0')}′${ss.toFixed(0).padStart(2, '0')}″`;
}
