#!/usr/bin/env python3
"""Build a static, sky-tiled index of every SPHEREx level-2 exposure.

The browser can't query IRSA directly (no CORS), so we pre-build an index that
GitHub Pages can serve. Positions come from IRSA's ObsCore table and file paths
from the CAOM artifact table, fetched one weekly folder at a time.

Output (data/):
  index.json        folders, version strings, tile sizes and row counts
  tiles/<key>.bin   24-byte little-endian rows, one per exposure+detector:
                      f32 ra, f32 dec, f32 mjd-60000, i16 pa*100, u8 detector,
                      u8 sub-exposure, u16 folder index, u16 sequence,
                      u16 version index, u16 reserved

Incremental: folders already in index.json are skipped unless --refresh is given.
Stdlib only, so it runs anywhere (including GitHub Actions) with no installs.
"""

import argparse
import csv
import io
import json
import math
import os
import re
import struct
import sys
import time
import urllib.parse
import urllib.request
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor

TAP = 'https://irsa.ipac.caltech.edu/TAP/sync'
# Survey releases look like spherex_qr2, spherex_qr3, ... ; *_deep repeats the same
# exposures and *_cal holds calibration files, so both are skipped.
COLLECTION_RE = re.compile(r'^spherex_qr\d+$')
TILE_DEG = 5.0
ROW = struct.Struct('<fffhBBHHHH')
MJD0 = 60000.0
ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'data')

URI_RE = re.compile(r'spherex/(qr\d+)/level2/([^/]+)/([^/]+)/(\d)/level2_(\S+?)_(\d+)_(\d+)D(\d)_spx_\3\.fits$')


def tap(query, tries=4):
    body = urllib.parse.urlencode({'QUERY': query, 'FORMAT': 'csv'}).encode()
    for attempt in range(tries):
        try:
            with urllib.request.urlopen(urllib.request.Request(TAP, data=body), timeout=600) as r:
                text = r.read().decode()
            if text.startswith('<?xml'):
                raise RuntimeError(text[:400])
            return list(csv.DictReader(io.StringIO(text)))
        except Exception as e:  # noqa: BLE001
            if attempt == tries - 1:
                raise
            print(f'  retry ({e})', file=sys.stderr)
            time.sleep(5 * (attempt + 1))


def discover_collections():
    # Any SIA response describes its parameters, including every collection name,
    # so a query for a tiny empty patch of sky lists the releases cheaply.
    url = 'https://irsa.ipac.caltech.edu/SIA?COLLECTION=spherex_qr2&POS=CIRCLE+0+0+0.00001'
    for attempt in range(4):
        try:
            with urllib.request.urlopen(url, timeout=120) as r:
                text = r.read().decode()
            break
        except Exception:  # noqa: BLE001
            if attempt == 3:
                raise
            time.sleep(5 * (attempt + 1))
    names = set(re.findall(r'value="(spherex_[a-z0-9_]+)"', text))
    found = sorted((c for c in names if COLLECTION_RE.match(c)), key=lambda c: int(c.rsplit('qr', 1)[1]))
    if not found:
        raise RuntimeError('no SPHEREx releases found')
    return found


def tile_key(ra, dec):
    band = min(int((dec + 90) // TILE_DEG), int(180 / TILE_DEG) - 1)
    edge = min(abs(-90 + band * TILE_DEG), abs(-90 + (band + 1) * TILE_DEG))
    if (-90 + band * TILE_DEG) < 0 < (-90 + (band + 1) * TILE_DEG):
        edge = 0
    n = max(1, math.ceil(360 * math.cos(math.radians(edge)) / TILE_DEG))
    return f'{band}_{int((ra % 360) / 360 * n) % n}'


def tan_project(ra0, dec0, ra, dec):
    ra0, dec0, ra, dec = map(math.radians, (ra0, dec0, ra, dec))
    c = math.sin(dec0) * math.sin(dec) + math.cos(dec0) * math.cos(dec) * math.cos(ra - ra0)
    x = math.cos(dec) * math.sin(ra - ra0) / c
    y = (math.cos(dec0) * math.sin(dec) - math.sin(dec0) * math.cos(dec) * math.cos(ra - ra0)) / c
    return math.degrees(x), math.degrees(y)


def position_angle(ra, dec, region):
    nums = [float(v) for v in region.split()[2:]]
    pts = [tan_project(ra, dec, nums[i], nums[i + 1]) for i in range(0, 4, 2)]
    (x0, y0), (x1, y1) = pts
    return math.degrees(math.atan2(y1 - y0, x1 - x0))


def version_rank(v):
    # l2b-v27-2026-223 / l2b_retry-v27-2026-223: newest processing date wins, retry breaks ties.
    m = re.search(r'v(\d+)-(\d{4})-(\d+)$', v)
    base = tuple(int(g) for g in m.groups()) if m else (0, 0, 0)
    return base + (1 if 'retry' in v else 0,)


def fetch_folder(collection, folder):
    qr = collection.replace('spherex_', '')
    obs = tap(
        "SELECT obs_id, energy_bandpassname, t_min, s_ra, s_dec, s_region FROM spherex.obscore "
        f"WHERE obs_collection='{collection}' AND obs_id LIKE '{folder}%'"
    )
    arts = tap(
        "SELECT uri FROM spherex.artifact WHERE producttype='science' "
        f"AND uri LIKE 'ibe/data/spherex/{qr}/level2/{folder}/%'"
    )
    versions = {}
    for a in arts:
        m = URI_RE.search(a['uri'])
        if not m:
            continue
        _, _, ver, _, prefix, seq, sub, det = m.groups()
        key = (f'{prefix}_{seq}_{sub}', int(det))
        if key not in versions or version_rank(ver) > version_rank(versions[key][0]):
            versions[key] = (ver, int(seq), int(sub))
    rows = []
    for o in obs:
        det = int(re.sub(r'\D', '', o['energy_bandpassname']) or 0)
        hit = versions.get((o['obs_id'], det))
        if not hit or not o['s_region']:
            continue
        ra, dec = float(o['s_ra']), float(o['s_dec'])
        rows.append((ra, dec, float(o['t_min']), position_angle(ra, dec, o['s_region']), det, hit[2], hit[1], hit[0]))
    return rows


def load_existing():
    path = os.path.join(ROOT, 'index.json')
    if not os.path.exists(path):
        return None, {}
    with open(path) as f:
        index = json.load(f)
    tiles = {}
    for key in index['tiles']:
        with open(os.path.join(ROOT, 'tiles', f'{key}.bin'), 'rb') as f:
            tiles[key] = [ROW.unpack_from(b, i) for b in [f.read()] for i in range(0, len(b), ROW.size)]
    return index, tiles


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--refresh', nargs='*', default=[], help='folders to re-fetch (e.g. qr3/2026W33_1A); "all" for everything')
    ap.add_argument('--recent', type=int, default=4, help='always re-fetch this many newest folders per collection')
    ap.add_argument('--workers', type=int, default=4)
    ap.add_argument('--limit', type=int, default=0, help='only fetch this many new folders (testing)')
    args = ap.parse_args()

    index, old_tiles = load_existing()
    folders = list(index['folders']) if index else []
    version_list = list(index['versions']) if index else []
    done = set(index.get('complete', [])) if index else set()

    print('Discovering releases…')
    collections = discover_collections()
    print(f"  {', '.join(collections)}")
    print('Listing folders…')
    listing = tap(
        "SELECT DISTINCT obs_collection, substring(obs_id, 1, 10) AS folder FROM spherex.obscore "
        f"WHERE obs_collection IN ({','.join(repr(c) for c in collections)})"
    )
    wanted = sorted({(r['obs_collection'], r['folder']) for r in listing}, key=lambda x: (x[1], x[0]))
    recent = set()
    for c in collections:
        recent |= set([w for w in wanted if w[0] == c][-args.recent:])
    refresh_all = 'all' in args.refresh

    def name(w):
        return f"{w[0].replace('spherex_', '')}/{w[1]}"

    todo = [w for w in wanted if refresh_all or name(w) not in done or w in recent or name(w) in args.refresh]
    if args.limit:
        todo = todo[: args.limit]
    print(f'{len(wanted)} folders, fetching {len(todo)}')

    fetched = {}
    with ThreadPoolExecutor(args.workers) as pool:
        futures = {pool.submit(fetch_folder, *w): w for w in todo}
        for i, (fut, w) in enumerate(futures.items()):
            fetched[name(w)] = fut.result()
            print(f'  [{i + 1}/{len(todo)}] {name(w)}: {len(fetched[name(w)])} images', flush=True)

    # Drop re-fetched folders from existing tiles, then add new rows.
    tiles = defaultdict(list)
    for key, rows in old_tiles.items():
        for r in rows:
            if folders[r[6]] not in fetched:
                tiles[key].append(r)

    def idx(lst, v):
        if v not in lst:
            lst.append(v)
        return lst.index(v)

    for fname, rows in fetched.items():
        fi = idx(folders, fname)
        for ra, dec, mjd, pa, det, sub, seq, ver in rows:
            vi = idx(version_list, ver)
            tiles[tile_key(ra, dec)].append((ra, dec, mjd - MJD0, int(round(pa * 100)), det, sub, fi, seq, vi, 0))
        done.add(fname)

    os.makedirs(os.path.join(ROOT, 'tiles'), exist_ok=True)
    for f in os.listdir(os.path.join(ROOT, 'tiles')):
        if f.endswith('.bin') and f[:-4] not in tiles:
            os.remove(os.path.join(ROOT, 'tiles', f))
    counts = {}
    for key, rows in sorted(tiles.items()):
        rows.sort(key=lambda r: r[2])
        with open(os.path.join(ROOT, 'tiles', f'{key}.bin'), 'wb') as f:
            f.write(b''.join(ROW.pack(*r) for r in rows))
        counts[key] = len(rows)

    out = {
        'updated': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
        'tileDeg': TILE_DEG,
        'mjd0': MJD0,
        'rowBytes': ROW.size,
        'folders': folders,
        'versions': version_list,
        'complete': sorted(done),
        'total': sum(counts.values()),
        'tiles': counts,
    }
    with open(os.path.join(ROOT, 'index.json'), 'w') as f:
        json.dump(out, f, separators=(',', ':'))
    print(f"Wrote {out['total']} images in {len(counts)} tiles")


if __name__ == '__main__':
    main()
