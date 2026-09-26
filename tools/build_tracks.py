#!/usr/bin/env python3
"""Precompute accurate tracks for featured comets and asteroids.

JPL Horizons has the best orbits (including comets' non-gravitational forces)
and can compute positions as seen from SPHEREx itself, but it doesn't allow
browser requests. So we fetch featured objects here and ship the tracks as
static JSON. Anything else falls back to IMCCE Miriade in the browser.

Output: data/tracks/index.json and data/tracks/<slug>.json with
  points: [[mjd, ra_deg, dec_deg, vmag], ...] every STEP_H hours.
Stdlib only.
"""

import calendar
import json
import os
import re
import time
import urllib.parse
import urllib.request

HORIZONS = 'https://ssd.jpl.nasa.gov/api/horizons.api'
OBSERVER = '500@-163182'   # SPHEREx spacecraft
START = '2025-04-20'
STEP_H = 2
ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'data', 'tracks')

# name shown to users, Horizons command, aliases people might type
FEATURED = [
    ('3I/ATLAS', "DES=C/2025 N1;", ['3i', '3i/atlas', 'c/2025 n1', 'atlas interstellar']),
    ('C/2025 A6 (Lemmon)', "DES=C/2025 A6;CAP;", ['c/2025 a6', 'lemmon', 'comet lemmon']),
    ('C/2025 R2 (SWAN)', "DES=C/2025 R2;CAP;", ['c/2025 r2', 'swan', 'comet swan']),
    ('29P/Schwassmann-Wachmann', "DES=29P;CAP;", ['29p', 'schwassmann-wachmann', '29p/schwassmann-wachmann']),
    ('(1) Ceres', "1;", ['ceres', '1']),
    ('(4) Vesta', "4;", ['vesta', '4']),
    ('(2) Pallas', "2;", ['pallas', '2']),
    ('(10) Hygiea', "10;", ['hygiea', '10']),
]


def slug(name):
    return re.sub(r'[^a-z0-9]+', '-', name.lower()).strip('-')


def horizons(command, stop):
    params = {
        'format': 'text',
        'COMMAND': f"'{command}'",
        'EPHEM_TYPE': 'OBSERVER',
        'CENTER': f"'{OBSERVER}'",
        'START_TIME': f"'{START}'",
        'STOP_TIME': f"'{stop}'",
        'STEP_SIZE': f"'{STEP_H} h'",
        'QUANTITIES': "'1,9'",
        'ANG_FORMAT': 'DEG',
        'CSV_FORMAT': 'YES',
        'EXTRA_PREC': 'YES',
    }
    url = HORIZONS + '?' + urllib.parse.urlencode(params)
    for attempt in range(4):
        try:
            with urllib.request.urlopen(url, timeout=300) as r:
                return r.read().decode()
        except Exception:  # noqa: BLE001
            if attempt == 3:
                raise
            time.sleep(10)


def parse(text):
    if '$$SOE' not in text:
        raise RuntimeError(text[-600:])
    body = text[text.index('$$SOE') + 5:text.index('$$EOE')]
    kind = 'comet' if 'T-mag' in text else 'asteroid'
    pts = []
    for line in body.strip().splitlines():
        f = [x.strip() for x in line.split(',')]
        t = time.strptime(f[0][:17], '%Y-%b-%d %H:%M')
        mjd = calendar.timegm(t) / 86400 + 40587
        ra, dec = float(f[3]), float(f[4])
        mag = next((float(x) for x in f[5:] if re.fullmatch(r'-?\d+(\.\d+)?', x)), None)
        pts.append([round(mjd, 5), round(ra, 6), round(dec, 6), None if mag is None else round(mag, 2)])
    return kind, pts


def main():
    os.makedirs(ROOT, exist_ok=True)
    stop = time.strftime('%Y-%m-%d', time.gmtime(time.time() + 86400))
    index = []
    for name, command, aliases in FEATURED:
        print(f'{name}…', flush=True)
        kind, pts = parse(horizons(command, stop))
        s = slug(name)
        with open(os.path.join(ROOT, f'{s}.json'), 'w') as f:
            json.dump({'name': name, 'kind': kind, 'source': 'JPL Horizons, as seen from SPHEREx', 'points': pts}, f, separators=(',', ':'))
        index.append({'name': name, 'file': f'{s}.json', 'aliases': sorted({name.lower(), *aliases})})
        print(f'  {len(pts)} points', flush=True)
    with open(os.path.join(ROOT, 'index.json'), 'w') as f:
        json.dump({'updated': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()), 'objects': index}, f, indent=1)


if __name__ == '__main__':
    main()
