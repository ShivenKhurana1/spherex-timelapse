// TAN-SIP world coordinate system (FITS Paper II + SIP convention).
// Pixel coordinates here are 0-based array indices (FITS pixel minus 1).

const D2R = Math.PI / 180;
const R2D = 180 / Math.PI;

function sipCoeffs(h, prefix) {
  const order = h[`${prefix}_ORDER`];
  if (!order) return null;
  const terms = [];
  for (let p = 0; p <= order; p++) {
    for (let q = 0; q <= order - p; q++) {
      const c = h[`${prefix}_${p}_${q}`];
      if (c) terms.push([p, q, c]);
    }
  }
  return terms;
}

function poly(terms, u, v) {
  if (!terms) return 0;
  let s = 0;
  for (const [p, q, c] of terms) s += c * u ** p * v ** q;
  return s;
}

export class WCS {
  constructor(h) {
    this.crpix = [h.CRPIX1, h.CRPIX2];
    this.crval = [h.CRVAL1 * D2R, h.CRVAL2 * D2R];
    const c1 = h.CDELT1 ?? 1, c2 = h.CDELT2 ?? 1;
    if (h.CD1_1 !== undefined) {
      this.cd = [h.CD1_1, h.CD1_2 ?? 0, h.CD2_1 ?? 0, h.CD2_2];
    } else {
      this.cd = [(h.PC1_1 ?? 1) * c1, (h.PC1_2 ?? 0) * c1, (h.PC2_1 ?? 0) * c2, (h.PC2_2 ?? 1) * c2];
    }
    const [a, b, c, d] = this.cd;
    const det = a * d - b * c;
    this.icd = [d / det, -b / det, -c / det, a / det];
    this.A = sipCoeffs(h, 'A');
    this.B = sipCoeffs(h, 'B');
    this.AP = sipCoeffs(h, 'AP');
    this.BP = sipCoeffs(h, 'BP');
  }

  // 0-based pixel -> [ra, dec] degrees
  pixToSky(x, y) {
    const u = x + 1 - this.crpix[0];
    const v = y + 1 - this.crpix[1];
    const U = u + poly(this.A, u, v);
    const V = v + poly(this.B, u, v);
    const [a, b, c, d] = this.cd;
    const xi = (a * U + b * V) * D2R;
    const eta = (c * U + d * V) * D2R;
    return tanDeproject(this.crval, xi, eta);
  }

  // [ra, dec] degrees -> 0-based pixel. Returns null behind the tangent point.
  skyToPix(ra, dec) {
    const p = tanProject(this.crval, ra * D2R, dec * D2R);
    if (!p) return null;
    const X = p[0] * R2D, Y = p[1] * R2D;
    const [a, b, c, d] = this.icd;
    const U = a * X + b * Y;
    const V = c * X + d * Y;
    let u = U + poly(this.AP, U, V);
    let v = V + poly(this.BP, U, V);
    if (!this.AP && this.A) {
      // No inverse polynomial provided: iterate the forward one.
      u = U; v = V;
      for (let i = 0; i < 10; i++) {
        u = U - poly(this.A, u, v);
        v = V - poly(this.B, u, v);
      }
    }
    return [u + this.crpix[0] - 1, v + this.crpix[1] - 1];
  }
}

// Gnomonic projection about centre [ra0, dec0] (radians). Returns [xi, eta] radians.
export function tanProject([ra0, dec0], ra, dec) {
  const cosc = Math.sin(dec0) * Math.sin(dec) + Math.cos(dec0) * Math.cos(dec) * Math.cos(ra - ra0);
  if (cosc <= 0) return null;
  const xi = (Math.cos(dec) * Math.sin(ra - ra0)) / cosc;
  const eta = (Math.cos(dec0) * Math.sin(dec) - Math.sin(dec0) * Math.cos(dec) * Math.cos(ra - ra0)) / cosc;
  return [xi, eta];
}

// Inverse gnomonic. Returns [ra, dec] degrees.
export function tanDeproject([ra0, dec0], xi, eta) {
  const dec = Math.asin((Math.sin(dec0) + eta * Math.cos(dec0)) / Math.sqrt(1 + xi * xi + eta * eta));
  const ra = ra0 + Math.atan2(xi, Math.cos(dec0) - eta * Math.sin(dec0));
  return [((ra * R2D) % 360 + 360) % 360, dec * R2D];
}

export { D2R, R2D };
