# SPHEREx Time-Lapse

A public web tool for watching the sky change in NASA SPHEREx images.

Type an object name or coordinates, pick a detector band, and the app gathers every
SPHEREx exposure that covers that spot, aligns them on a common north-up grid, and lets
you **play them as a movie**, **blink** two epochs, or view their **difference** — the
fastest way to spot asteroids, comets, high-proper-motion stars and variable sources.

No install, no account, no backend. Everything runs in the browser.

## How it works

1. **Name → coordinates** via the CDS Sesame resolver.
2. **Find exposures** with IRSA's Simple Image Access (SIA v2) service, collections
   `spherex_qr2` and `spherex_qr3` (Quick Release level-2 spectral images).
3. **Fetch only what's needed.** Each SPHEREx image is a 66 MB multi-extension FITS
   file on the public `nasa-irsa-spherex` S3 bucket. The app reads the FITS header
   with an HTTP range request, solves the TAN-SIP WCS for the target, then range-reads
   just the image rows that contain the cutout (usually well under 1 MB).
4. **Reproject** every cutout onto the same tangent-plane grid centred on the target
   (6.15″ pixels, north up, east left), so stars stay put and moving things move.
5. **Display** with a shared stretch across all epochs, with background (zodiacal
   light) removed per frame so the sky level doesn't flicker.

## Running locally

It's a static site — any file server works:

```bash
python3 -m http.server 8000
```

then open <http://localhost:8000>.

## CORS proxy

IRSA's search endpoint doesn't send CORS headers, so browsers can't call it directly.
By default the app routes the *search request only* through a public CORS proxy.
Image data comes straight from S3, which does allow CORS. For a dependable deployment,
deploy [`worker/cors-proxy.js`](worker/cors-proxy.js) as a free Cloudflare Worker and
set its URL under **Settings**.

## Data credit

SPHEREx data are provided by NASA/JPL-Caltech and served by the NASA/IPAC Infrared
Science Archive (IRSA). This project is not affiliated with NASA.
