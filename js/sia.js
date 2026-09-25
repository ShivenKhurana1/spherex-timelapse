// Find SPHEREx exposures covering a sky position via IRSA's SIA v2 service.

const SIA = 'https://irsa.ipac.caltech.edu/SIA';
const COLLECTIONS = ['spherex_qr2', 'spherex_qr3'];
const S3 = 'https://nasa-irsa-spherex.s3.amazonaws.com/';
export const DEFAULT_PROXY = 'https://api.allorigins.win/raw?url={url}';

export const DETECTORS = {
  1: { name: 'D1', range: '0.75–1.09 µm', color: '#7aa2ff' },
  2: { name: 'D2', range: '1.10–1.62 µm', color: '#6fd3ff' },
  3: { name: 'D3', range: '1.63–2.41 µm', color: '#77e0b5' },
  4: { name: 'D4', range: '2.42–3.82 µm', color: '#f2d36b' },
  5: { name: 'D5', range: '3.83–4.41 µm', color: '#ffa25c' },
  6: { name: 'D6', range: '4.42–5.00 µm', color: '#ff6b6b' },
};

export function getProxy() {
  try { return localStorage.getItem('proxy') || DEFAULT_PROXY; } catch { return DEFAULT_PROXY; }
}

export function setProxy(v) {
  try { v ? localStorage.setItem('proxy', v) : localStorage.removeItem('proxy'); } catch {}
}

function viaProxy(url) {
  const p = getProxy();
  return p.includes('{url}') ? p.replace('{url}', encodeURIComponent(url)) : p + url;
}

function parseVOTable(text) {
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  const err = doc.querySelector('INFO[name="QUERY_STATUS"][value="ERROR"]');
  if (err) throw new Error(err.textContent.trim() || 'SIA query failed');
  const names = [...doc.getElementsByTagName('FIELD')].map(f => f.getAttribute('name'));
  return [...doc.getElementsByTagName('TR')].map(tr => {
    const row = {};
    [...tr.getElementsByTagName('TD')].forEach((td, i) => { row[names[i]] = td.textContent; });
    return row;
  });
}

// S3 serves the same files as IRSA's IBE, but with CORS + range support.
function toS3(row) {
  try {
    const ca = JSON.parse(row.cloud_access);
    if (ca?.aws?.key) return S3 + ca.aws.key;
  } catch {}
  return row.access_url.replace(/^https:\/\/irsa\.ipac\.caltech\.edu\/ibe\/data\/spherex\//, S3);
}

async function queryCollection(collection, ra, dec, signal) {
  const q = `${SIA}?COLLECTION=${collection}&POS=${encodeURIComponent(`CIRCLE ${ra} ${dec} 0.002`)}&RESPONSEFORMAT=VOTABLE`;
  const res = await fetch(viaProxy(q), { signal });
  if (!res.ok) throw new Error(`Search failed (HTTP ${res.status}). Try again, or set a proxy in Settings.`);
  return parseVOTable(await res.text());
}

// Returns exposures sorted by time: {id, detector, mjd, date, url, exptime, collection}
export async function findExposures(ra, dec, signal) {
  const key = `sia:${ra.toFixed(5)},${dec.toFixed(5)}`;
  try {
    const hit = sessionStorage.getItem(key);
    if (hit) return JSON.parse(hit);
  } catch {}

  const results = await Promise.all(COLLECTIONS.map(c => queryCollection(c, ra, dec, signal)));
  const byKey = new Map();
  for (const rows of results) {
    for (const r of rows) {
      if (r.dataproduct_subtype && r.dataproduct_subtype !== 'science') continue;
      const detector = Number((r.energy_bandpassname || '').replace(/\D/g, ''));
      const k = `${r.obs_id}/${detector}`;
      // Later collections are newer processing; let them win.
      byKey.set(k, {
        id: r.obs_id,
        detector,
        mjd: Number(r.t_min),
        date: mjdToDate(Number(r.t_min)),
        url: toS3(r),
        exptime: Number(r.t_exptime),
        collection: r.obs_collection,
      });
    }
  }
  const list = [...byKey.values()].sort((a, b) => a.mjd - b.mjd);
  try { sessionStorage.setItem(key, JSON.stringify(list)); } catch {}
  return list;
}

export function mjdToDate(mjd) {
  return new Date((mjd - 40587) * 86400000);
}
