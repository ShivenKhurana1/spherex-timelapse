# SPHEREx Time-Lapse

**Live:** http://gradepeach.me/spherex-timelapse/

A public web tool for watching the sky change in NASA SPHEREx images.

Type an object name or coordinates, pick a detector band, and the app gathers every
SPHEREx exposure that covers that spot, aligns them on a common north-up grid, and lets
you **play them as a movie**, **blink** two epochs, or view their **difference** — the
fastest way to spot asteroids, comets, high-proper-motion stars and variable sources.

No install, no account, no backend. Everything runs in the browser.

## Features

- **Five views:** time-lapse, blink, difference (each date minus the median sky),
  motion trail (residual light coloured by date), and a deep median stack.
- **Scan for changes:** finds compact sources that appear or brighten in any visit,
  rejects one-exposure glitches (cosmic rays, satellite glints) by checking each
  exposure within a visit, and matches the rest against known asteroids. What's
  left is a short list of unidentified candidates for a person to review.
- **Known asteroids** labelled on each frame, from IMCCE's SkyBoT service.
- **Light curves:** click any star to plot its brightness at every visit (CSV export).
- **Bad-pixel masking** from SPHEREx's own FLAGS layer (cosmic rays, hot pixels,
  persistence), decoded in the browser.
- Shareable links, PNG and video export, keyboard controls (← → space, `b`, `d`).

## How it works

1. **Name → coordinates** via the CDS Sesame resolver.
2. **Find exposures** in a static, sky-tiled index of every SPHEREx Quick Release
   level-2 image (`spherex_qr2` + `spherex_qr3`, ~1.2 million detector images). The index
   lives in [`data/`](data/) and is rebuilt weekly from IRSA's TAP service by
   [`tools/build_index.py`](tools/build_index.py) in a GitHub Action. (IRSA's search APIs
   don't send CORS headers, so a browser can't query them directly.)
3. **Fetch only what's needed.** Each SPHEREx image is a ~66 MB multi-extension FITS
   file on the public `nasa-irsa-spherex` S3 bucket, which does allow CORS. The app
   reads the FITS header with an HTTP range request, solves the TAN-SIP WCS for the
   target, then range-reads just the image rows that contain the cutout (usually well
   under 1 MB).
4. **Reproject** every cutout onto the same tangent-plane grid centred on the target
   (6.15″ pixels, north up, east left), so stars stay put and moving things move.
5. **Mask** pixels SPHEREx flagged as bad. The FLAGS layer is Rice-compressed one row
   per tile, so the app range-reads just those rows and decompresses them in
   JavaScript (checked bit-for-bit against astropy).
6. **Display** with a shared stretch across all epochs, with background (zodiacal
   light) removed per frame so the sky level doesn't flicker.

## Running locally

It's a static site — any file server works:

```bash
python3 -m http.server 8000
```

then open <http://localhost:8000>.

## Rebuilding the index

```bash
python3 tools/build_index.py            # incremental: new + most recent folders
python3 tools/build_index.py --refresh all
```

Standard library only; the first full build takes about an hour.

## Data credit

SPHEREx data are provided by NASA/JPL-Caltech and served by the NASA/IPAC Infrared
Science Archive (IRSA). Asteroid positions from IMCCE's SkyBoT; name lookup from
CDS Sesame. This project is not affiliated with NASA.
