import { resolve, formatRA, formatDec } from './resolve.js';
import { findExposures, findAlongPath, DETECTORS, loadIndex } from './catalog.js';
import { ephemeris, positionAt } from './ephem.js';
import { makeCutout, PIXEL_ARCSEC } from './cutout.js';
import { tanDeproject, tanProject, D2R } from './wcs.js';
import { knownObjects } from './asteroids.js';
import { findChanges, crop } from './detect.js';
import { snapToPeak, photometry, renderChart, toCSV } from './lightcurve.js';
import {
  backgroundSubtract, medianStack, subtract, stretchLimits, paint, paintDiff, paintMotion, median,
} from './render.js';

const $ = id => document.getElementById(id);

const EXAMPLES = [
  { name: 'Interstellar comet 3I/ATLAS', track: '3I/ATLAS', note: 'Follow the third known interstellar visitor', size: 96, band: 1 },
  { name: "Barnard's Star", ra: 269.4464, dec: 4.7673, note: 'Fastest-moving star in the sky — watch it creep north', size: 48 },
  { name: 'Asteroid 4 Vesta', ra: 215.95, dec: -6.76, note: 'Caught crossing the field, July 2025', size: 240, band: 2, mode: 'motion' },
  { name: 'North Ecliptic Pole', ra: 270.0, dec: 66.5607, note: 'SPHEREx deep field: hundreds of visits' },
  { name: 'Crab Nebula', ra: 83.6331, dec: 22.0145, note: 'Wreck of a star that exploded in 1054', size: 160 },
  { name: 'Orion Nebula', ra: 83.8221, dec: -5.3911, note: 'Star nursery glowing in infrared', size: 240 },
  { name: 'Galactic Center', ra: 266.4168, dec: -29.0078, note: 'The crowded heart of the Milky Way' },
  { name: 'South Ecliptic Pole', ra: 90.0, dec: -66.5607, note: 'Second deep field, near the LMC' },
];

const MODE_HINTS = {
  play: 'Every visit in date order. Press play or use ← → keys.',
  blink: 'Flips between two dates. Click the timeline to choose A, shift-click for B.',
  diff: 'Each date minus the typical sky. Red = brighter than usual, blue = fainter.',
  motion: 'Extra light from every date, coloured purple (earliest) → red (latest). Movers leave a rainbow trail.',
  static: 'Median of all visits: a deeper, cleaner picture with movers removed.',
};

// In tracking mode the frame follows the object, so stars are what move.
const TRACK_HINTS = {
  play: 'The view follows the object: it stays centred while background stars stream past.',
  diff: 'Each date minus the typical view. In the moving frame, stars show up as streaks of red and blue.',
  motion: 'Stars leave the rainbow trails here, because the view is following the object.',
  static: 'Median of all visits in the object’s frame: background stars vanish and the object adds up.',
};

const state = {
  target: null,
  exposures: [],
  band: 2,
  size: 96,
  group: true,
  mode: 'play',
  frames: [],
  idx: 0,
  blinkA: 0,
  blinkB: -1,
  playing: false,
  fps: 4,
  stretch: 'asinh',
  cmap: 'gray',
  contrast: 0.998,
  invert: false,
  crosshair: true,
  probe: null,
  track: null,
  changes: null,
  chFilter: 'unknown',
  mark: null,
  asteroids: false,
  astMag: 20,
  astList: null,
  lcPoints: null,
  mask: true,
  maxFrames: 80,
  limits: [0, 1],
  template: null,
  abort: null,
  blinkPhase: 0,
};

try { state.maxFrames = Number(localStorage.getItem('maxFrames')) || 80; } catch {}

const canvas = $('canvas');
const ctx = canvas.getContext('2d');
let imageData = ctx.createImageData(state.size, state.size);

// ---------- helpers ----------

const loaded = () => state.frames.filter(f => f.status === 'ok');

function toast(msg) {
  const t = document.createElement('div');
  t.className = 'toast';
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 6000);
}

function fmtDate(d) {
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' });
}

function fmtDateTime(d) {
  return d.toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
}

function setLoading(text) {
  $('loading').hidden = !text;
  if (text) $('loadingText').textContent = text;
}

function writeHash() {
  if (!state.target) return;
  const p = new URLSearchParams();
  if (state.track) {
    p.set('track', state.track.query);
  } else {
    if (state.target.name) p.set('name', state.target.name);
    p.set('ra', state.target.ra.toFixed(5));
    p.set('dec', state.target.dec.toFixed(5));
  }
  p.set('band', state.band);
  p.set('fov', state.size);
  p.set('view', state.mode);
  history.replaceState(null, '', '#' + p.toString());
}

// ---------- search & loading ----------

async function lookAt(query, opts = {}) {
  state.abort?.abort();
  const abort = new AbortController();
  state.abort = abort;
  $('intro').hidden = true;
  $('workspace').hidden = false;
  stop();
  if (opts.size) state.size = opts.size;
  if (opts.mode) state.mode = opts.mode;
  renderSizes();
  renderModes();
  state.frames = [];
  state.template = null;
  drawAll();
  setLoading(opts.ra !== undefined ? 'Searching the SPHEREx archive…' : `Looking up “${query}”…`);

  if (opts.track) return trackObject(opts.track, opts, abort);
  state.track = null;
  renderModes();
  $('trackNote').hidden = true;
  $('changes').hidden = false;
  try {
    const target = opts.ra !== undefined
      ? { ra: opts.ra, dec: opts.dec, name: opts.name || null }
      : await resolve(query, abort.signal);
    state.target = target;
    $('targetName').textContent = target.name || 'Custom position';
    $('targetCoords').textContent = `${formatRA(target.ra)}  ${formatDec(target.dec)}`;
    document.title = `${target.name || 'Sky position'} · SPHEREx Time-Lapse`;
    setLoading('Searching the SPHEREx archive…');

    state.exposures = await findExposures(target.ra, target.dec, abort.signal);
    if (abort.signal.aborted) return;
    if (!state.exposures.length) {
      setLoading('');
      toast('SPHEREx hasn’t released images of this spot yet. Try another target.');
      renderBands();
      return;
    }
    const counts = bandCounts();
    if (opts.band && counts[opts.band]) state.band = opts.band;
    else if (!counts[state.band]) state.band = Number(Object.keys(counts).sort((a, b) => counts[b] - counts[a])[0]);
    renderBands();
    loadBand();
  } catch (e) {
    if (e.name === 'AbortError') return;
    setLoading('');
    toast(e.message || String(e));
  }
}

async function trackObject(name, opts, abort) {
  try {
    setLoading(`Computing the orbit of “${name}”…`);
    const eph = await ephemeris(name, abort.signal);
    if (abort.signal.aborted) return;
    setLoading(`Searching SPHEREx images along the path of ${eph.name}…`);
    const at = mjd => positionAt(eph.points, mjd);
    const exps = await findAlongPath(eph.points, at, abort.signal, (d, n) => {
      $('loadingText').textContent = `Searching SPHEREx images along the path of ${eph.name}… ${Math.round((100 * d) / n)}%`;
    });
    if (abort.signal.aborted) return;
    state.track = { ...eph, query: name };
    renderModes();
    $('trackNote').hidden = false;
    $('trackNote').textContent = eph.precise
      ? 'Positions from JPL Horizons as seen from SPHEREx, including comets’ non-gravitational forces.'
      : 'Positions from IMCCE Miriade. Comet predictions can be off by a minute of arc or two; if the object isn’t at the centre, try a wider field of view.';
    if (!eph.precise && !opts.size && eph.kind === 'comet') { state.size = 160; renderSizes(); }
    state.exposures = exps;
    $('changes').hidden = true;
    $('targetName').textContent = eph.name;
    $('targetCoords').textContent = `Moving ${eph.kind || 'object'}`;
    document.title = `${eph.name} · SPHEREx Time-Lapse`;
    if (!exps.length) {
      setLoading('');
      toast(`SPHEREx hasn’t released any images of ${eph.name} yet.`);
      state.target = null;
      renderBands();
      return;
    }
    state.target = { name: eph.name, ra: exps[0].obj.ra, dec: exps[0].obj.dec, moving: true };
    const counts = bandCounts();
    if (opts.band && counts[opts.band]) state.band = opts.band;
    else if (!counts[state.band]) state.band = Number(Object.keys(counts).sort((a, b) => counts[b] - counts[a])[0]);
    renderBands();
    loadBand();
  } catch (e) {
    if (e.name === 'AbortError') return;
    setLoading('');
    toast(e.message || String(e));
  }
}

// Sky centre of a frame: fixed for a place, the object's position when tracking.
function centreOf(frame) {
  return frame?.centre || [state.target.ra, state.target.dec];
}

function bandCounts() {
  const c = {};
  for (const e of state.exposures) c[e.detector] = (c[e.detector] || 0) + 1;
  return c;
}

function groupExposures(list) {
  if (!state.group) return list.map(e => ({ mjd: e.mjd, date: e.date, exposures: [e] }));
  const groups = [];
  for (const e of list) {
    const g = groups[groups.length - 1];
    if (g && e.mjd - g.exposures[0].mjd < 0.5) g.exposures.push(e);
    else groups.push({ mjd: e.mjd, date: e.date, exposures: [e] });
  }
  // Four exposures per visit is plenty; more just costs bandwidth.
  for (const g of groups) if (g.exposures.length > 4) g.exposures = g.exposures.filter((_, i, a) => i % Math.ceil(a.length / 4) === 0);
  return groups;
}

function sampleEvenly(arr, n) {
  if (arr.length <= n) return arr;
  const out = [];
  for (let i = 0; i < n; i++) out.push(arr[Math.round((i * (arr.length - 1)) / (n - 1))]);
  return [...new Set(out)];
}

async function loadBand() {
  state.abort?.abort();
  const abort = new AbortController();
  state.abort = abort;
  stop();
  const list = state.exposures.filter(e => e.detector === state.band);
  const groups = sampleEvenly(groupExposures(list), state.maxFrames);
  state.frames = groups.map(g => ({ ...g, status: 'pending' }));
  state.idx = 0;
  state.blinkA = 0;
  state.blinkB = -1;
  state.template = null;
  state.probe = null;
  state.lcPoints = null;
  state.changes = null;
  state.mark = null;
  renderChanges();
  imageData = ctx.createImageData(state.size, state.size);
  canvas.width = canvas.height = state.size;
  ctx.clearRect(0, 0, state.size, state.size);
  $('filmstrip').innerHTML = '';
  writeHash();
  renderTimeline();
  drawOverlay();
  setLoading(`Downloading ${state.frames.length} visits in ${DETECTORS[state.band].name}…`);

  let done = 0;
  const size = state.size;
  const { ra, dec } = state.target;

  // Finish a frame once all its exposures are in.
  const finish = frame => {
    const cuts = frame.cuts.filter(Boolean);
    delete frame.cuts;
    if (!cuts.length) {
      frame.status = frame.failed ? 'error' : 'off';
    } else {
      const combined = cuts.length === 1 ? cuts[0] : nanMean(cuts);
      const { data, sigma } = backgroundSubtract(combined);
      frame.data = data;
      frame.sigma = sigma;
      if (frame.exposures[0].obj) {
        frame.centre = [frame.exposures[0].obj.ra, frame.exposures[0].obj.dec];
        frame.vmag = frame.exposures[0].obj.vmag;
      }
      // Keep the individual exposures so the change scan can reject
      // one-exposure glitches (cosmic rays, satellite glints).
      frame.parts = cuts.length > 1 ? cuts.map(c => backgroundSubtract(c).data) : null;
      frame.status = 'ok';
    }
    done++;
    onFrameLoaded(done);
  };

  // One pool over all exposures (in frame order), so a frame's exposures
  // download in parallel instead of one after another.
  const queue = [];
  for (const frame of state.frames) {
    frame.cuts = [];
    frame.pending = frame.exposures.length;
    frame.exposures.forEach((e, k) => queue.push({ frame, e, k }));
  }
  const worker = async () => {
    while (queue.length && !abort.signal.aborted) {
      const { frame, e, k } = queue.shift();
      try {
        const c = await makeCutout(e, e.obj ? e.obj.ra : ra, e.obj ? e.obj.dec : dec, size, abort.signal, { mask: state.mask });
        frame.cuts[k] = c.offImage ? null : c.data;
      } catch (err) {
        if (abort.signal.aborted) return;
        console.warn('exposure failed', err);
        frame.failed = true;
      }
      if (--frame.pending === 0 && !abort.signal.aborted) finish(frame);
    }
  };
  await Promise.all(Array.from({ length: 16 }, worker));
  if (abort.signal.aborted) return;
  await new Promise(r => setTimeout(r, 80)); // let the last incremental refresh land
  recomputeLimits();
  drawAll(true);
  setLoading('');
  $('progressBar').style.width = '0';
  const n = loaded().length;
  if (!n) toast('None of these images cover the exact position. Try a different band.');
  else if (state.mode === 'play' && n > 1) play();
}

function nanMean(frames) {
  const out = new Float32Array(frames[0].length);
  for (let i = 0; i < out.length; i++) {
    let s = 0, m = 0;
    for (const f of frames) if (f[i] === f[i]) { s += f[i]; m++; }
    out[i] = m ? s / m : NaN;
  }
  return out;
}

let refreshQueued = false;
function onFrameLoaded(done) {
  $('progressBar').style.width = `${(100 * done) / state.frames.length}%`;
  if (loaded().length) setLoading('');
  if (refreshQueued) return;
  refreshQueued = true;
  // A timer rather than requestAnimationFrame, so loading still refreshes in a background tab.
  setTimeout(() => {
    refreshQueued = false;
    state.template = null;
    state.lcPoints = null;
    recomputeLimits();
    if (state.blinkB < 0 || state.blinkB >= loaded().length) state.blinkB = loaded().length - 1;
    drawAll(false);
  }, 250);
}

// ---------- rendering ----------

function recomputeLimits() {
  const fr = loaded();
  if (!fr.length) return;
  state.limits = stretchLimits(fr.map(f => f.data), 0.25, state.contrast);
  // Lower limit a touch below the background so noise isn't clipped to black.
  const sig = median(fr.map(f => f.sigma));
  state.limits[0] = -1.5 * sig;
}

function getTemplate() {
  const fr = loaded();
  if (!state.template && fr.length) state.template = medianStack(fr.map(f => f.data));
  return state.template;
}

function currentFrame() {
  const fr = loaded();
  if (!fr.length) return null;
  if (state.mode === 'blink') {
    const i = state.blinkPhase ? state.blinkB : state.blinkA;
    return fr[Math.max(0, Math.min(fr.length - 1, i))];
  }
  state.idx = Math.max(0, Math.min(fr.length - 1, state.idx));
  return fr[state.idx];
}

function draw() {
  const fr = loaded();
  if (!fr.length) { $('hudDate').textContent = ''; $('hudFrame').textContent = ''; return; }
  const f = currentFrame();
  const { stretch, cmap, invert, limits } = state;
  switch (state.mode) {
    case 'diff': {
      const sig = median(fr.map(x => x.sigma));
      paintDiff(imageData, subtract(f.data, getTemplate()), 6 * sig);
      break;
    }
    case 'motion': {
      const t = getTemplate();
      paintMotion(imageData, fr.map(x => subtract(x.data, t)), fr.map(x => x.sigma));
      break;
    }
    case 'static': {
      // The stack is fainter than the brightest single visits: scale it on its own.
      const t = getTemplate();
      const own = stretchLimits([t], 0.25, state.contrast);
      const noise = backgroundSubtract(t).sigma;
      own[0] = -1.5 * noise;
      own[1] = Math.max(own[1], 15 * noise);
      paint(imageData, t, own, stretch, cmap, invert);
      break;
    }
    default:
      paint(imageData, f.data, limits, stretch, cmap, invert);
  }
  ctx.putImageData(imageData, 0, 0);

  const composite = state.mode === 'motion' || state.mode === 'static';
  if (composite) {
    $('hudDate').textContent = `${fmtDate(fr[0].date)} → ${fmtDate(fr[fr.length - 1].date)}`;
    $('hudFrame').textContent = `${fr.length} visits combined`;
  } else {
    const label = state.mode === 'blink' ? (state.blinkPhase ? 'B  ' : 'A  ') : '';
    $('hudDate').textContent = label + fmtDateTime(f.date);
    $('hudFrame').textContent = `${fr.indexOf(f) + 1} / ${fr.length}${f.vmag ? ` · V ${f.vmag.toFixed(1)}` : ''}`;
  }
  updateTimelineMarks();
  updateFilmstripMarks();
  drawLightcurve();
  requestAsteroids(composite ? null : f);
  if (state.mark) drawOverlay();
}

// full=false (while loading) only paints thumbnails for newly arrived frames.
function drawAll(full = true) {
  draw();
  renderTimeline();
  renderFilmstrip(full);
}

function drawOverlay() {
  const svg = $('overlay');
  const n = state.size;
  const probe = state.probe
    ? `<circle cx="${((state.probe[0] + 0.5) / n) * 100}" cy="${((state.probe[1] + 0.5) / n) * 100}" r="${(3.5 / n) * 100}"
        fill="none" stroke="rgba(255,162,92,0.95)" stroke-width="1.5" vector-effect="non-scaling-stroke"/>`
    : '';
  const ast = asteroidMarks() + (state.mark && currentFrame() === state.mark.frameRef
    ? `<circle cx="${((state.mark.x + 0.5) / n) * 100}" cy="${((state.mark.y + 0.5) / n) * 100}" r="${(5 / n) * 100}"
        fill="none" stroke="#ff6b6b" stroke-width="1.5" stroke-dasharray="3 2" vector-effect="non-scaling-stroke"/>`
    : '');
  if (!state.crosshair || !state.target) { svg.innerHTML = probe + ast; return; }
  const g = 3, l = 6;
  svg.innerHTML = ast + probe + `
    <g stroke="rgba(111,211,255,0.85)" stroke-width="0.35" vector-effect="non-scaling-stroke">
      <line x1="${50 - g - l}" y1="50" x2="${50 - g}" y2="50"/><line x1="${50 + g}" y1="50" x2="${50 + g + l}" y2="50"/>
      <line x1="50" y1="${50 - g - l}" x2="50" y2="${50 - g}"/><line x1="50" y1="${50 + g}" x2="50" y2="${50 + g + l}"/>
    </g>`;
}

// ---------- known asteroids ----------

let astFrame = null;
function requestAsteroids(frame) {
  if (!state.asteroids || !frame) {
    if (state.astList) { state.astList = null; drawOverlay(); }
    $('astNote').textContent = state.asteroids && !frame ? 'Asteroid labels show on single-date views.' : '';
    return;
  }
  if (astFrame === frame) return;
  astFrame = frame;
  state.astList = null;
  drawOverlay();
  $('astNote').textContent = 'Checking for known asteroids…';
  const radius = (state.size * PIXEL_ARCSEC) / 3600 * 0.72;
  const [cra, cdec] = centreOf(frame);
  knownObjects(frame.exposures[0].mjd, cra, cdec, radius)
    .then(list => {
      if (astFrame !== frame) return;
      state.astList = list;
      drawOverlay();
    })
    .catch(() => {
      if (astFrame === frame) $('astNote').textContent = 'Couldn’t reach the asteroid service (IMCCE SkyBoT).';
    });
}

function asteroidMarks() {
  if (!state.asteroids || !state.astList || !state.target) return '';
  const [cra, cdec] = centreOf(astFrame);
  const n = state.size, half = (n - 1) / 2, s = PIXEL_ARCSEC / 3600;
  const shown = [];
  for (const o of state.astList) {
    if (!(o.vmag <= state.astMag)) continue;
    const p = tanProject([cra * D2R, cdec * D2R], o.ra * D2R, o.dec * D2R);
    if (!p) continue;
    const i = half - p[0] / D2R / s, j = half - p[1] / D2R / s;
    if (i < 0 || j < 0 || i > n - 1 || j > n - 1) continue;
    shown.push({ ...o, x: ((i + 0.5) / n) * 100, y: ((j + 0.5) / n) * 100 });
  }
  $('astNote').textContent = shown.length
    ? `${shown.length} known asteroid${shown.length > 1 ? 's' : ''} brighter than V ${state.astMag} in view (positions: IMCCE SkyBoT).`
    : `No known asteroids brighter than V ${state.astMag} in view on this date.`;
  return shown.map(o => `
    <g class="ast">
      <circle cx="${o.x}" cy="${o.y}" r="2.2" fill="none" stroke="#77e0b5" stroke-width="1.2" vector-effect="non-scaling-stroke"/>
      <text x="${o.x + 2.8}" y="${o.y - 1.8}" fill="#77e0b5" font-size="2.6" font-family="Inter, sans-serif">${escapeHtml(o.name)} · V${o.vmag.toFixed(1)}</text>
    </g>`).join('');
}

function escapeHtml(t) {
  return String(t).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

$('asteroids').addEventListener('change', e => {
  state.asteroids = e.target.checked;
  astFrame = null;
  draw();
  drawOverlay();
});
$('astMag').addEventListener('change', e => { state.astMag = Number(e.target.value); drawOverlay(); });

// ---------- change scan ----------

const CH_LIMIT = 60;

async function scanChanges() {
  const fr = loaded();
  if (fr.length < 3) { toast('Need at least three visits to find changes.'); return; }
  const btn = $('scanBtn');
  btn.disabled = true;
  btn.textContent = 'Scanning…';
  await new Promise(r => setTimeout(r, 20)); // let the button repaint
  const n = state.size;
  const found = findChanges(fr, getTemplate(), n).slice(0, 300);
  for (const c of found) c.frameRef = fr[c.frame];
  state.changes = found;
  state.chFilter = 'unknown';
  renderChanges();

  // Identify "new" sources against catalogued asteroids, one visit at a time.
  const byFrame = new Map();
  for (const c of found) if (c.kind === 'new' && !c.glitch) (byFrame.get(c.frameRef) || byFrame.set(c.frameRef, []).get(c.frameRef)).push(c);
  let k = 0;
  const radius = (n * PIXEL_ARCSEC) / 3600 * 0.72, half = (n - 1) / 2, px = PIXEL_ARCSEC / 3600;
  const queue = [...byFrame];
  const check = async () => {
    while (queue.length) {
      const [frame, cands] = queue.shift();
      try {
        const objs = await knownObjects(frame.exposures[0].mjd, state.target.ra, state.target.dec, radius);
        for (const c of cands) {
          let best = null, bd = Infinity;
          for (const o of objs) {
            const p = tanProject([state.target.ra * D2R, state.target.dec * D2R], o.ra * D2R, o.dec * D2R);
            if (!p) continue;
            const d = Math.hypot(half - p[0] / D2R / px - c.x, half - p[1] / D2R / px - c.y);
            // ~21″ normally; bright objects saturate and their detected peak wanders.
            const tol = o.vmag < 12 ? 8 : 3.5;
            if (d < tol && d < bd) { bd = d; best = o; }
          }
          c.known = best;
        }
      } catch {
        for (const c of cands) c.known = undefined;
      }
      btn.textContent = `Checking asteroids ${++k}/${byFrame.size}`;
      queueRenderChanges();
    }
  };
  // A few at a time: SkyBoT is a shared public service.
  await Promise.all([check(), check(), check()]);
  btn.textContent = 'Scan again';
  btn.disabled = false;
  renderChanges();
}

let renderPending = false;
function queueRenderChanges() {
  if (renderPending) return;
  renderPending = true;
  setTimeout(() => { renderPending = false; renderChanges(); }, 150);
}

function changeFilter(c) {
  switch (state.chFilter) {
    case 'unknown': return c.kind === 'new' && !c.known && !c.glitch;
    case 'glitch': return c.glitch;
    case 'known': return !!c.known;
    case 'brightened': return c.kind === 'brightened' && !c.glitch;
    default: return true;
  }
}

function renderChanges() {
  const list = $('chList');
  list.innerHTML = '';
  $('chFilters').hidden = !state.changes;
  if (!state.changes) {
    $('scanBtn').textContent = 'Scan for changes';
    $('chSummary').textContent = 'Scan every visit for sources that appear, move or brighten, then check them against known asteroids.';
    return;
  }
  const all = state.changes;
  const nNew = all.filter(c => c.kind === 'new' && !c.known && !c.glitch).length;
  const nGlitch = all.filter(c => c.glitch).length;
  const nKnown = all.filter(c => c.known).length;
  const nBright = all.filter(c => c.kind === 'brightened' && !c.glitch).length;
  $('chSummary').textContent = all.length
    ? `${all.length} change${all.length > 1 ? 's' : ''} across ${loaded().length} visits: ${nNew} unidentified, ${nKnown} known asteroid${nKnown === 1 ? '' : 's'}, ${nBright} brightened, ${nGlitch} single-exposure glitch${nGlitch === 1 ? '' : 'es'}.`
    : `Nothing changed significantly across ${loaded().length} visits.`;
  for (const b of $('chFilters').children) b.setAttribute('aria-pressed', String(b.dataset.f === state.chFilter));

  const shown = all.filter(changeFilter).slice(0, CH_LIMIT);
  if (!shown.length) {
    list.innerHTML = `<li class="ch-empty">${all.length ? 'None in this group.' : 'Try a larger field of view or another band.'}</li>`;
    return;
  }
  const n = state.size, t = getTemplate();
  const sig = median(loaded().map(f => f.sigma));
  for (const c of shown) {
    const li = document.createElement('li');
    const b = document.createElement('button');
    b.className = 'ch-item' + (state.mark === c ? ' active' : '');
    const crops = document.createElement('div');
    crops.className = 'ch-crops';
    const f = c.frameRef;
    const cutF = crop(f.data, n, c.x, c.y), cutT = crop(t, n, c.x, c.y);
    const diff = cutF.map((v, i) => v - cutT[i]);
    const cw = Math.round(Math.sqrt(cutF.length));
    for (const [data, isDiff] of [[cutF, false], [cutT, false], [diff, true]]) {
      const cv = document.createElement('canvas');
      cv.width = cv.height = cw;
      const id = new ImageData(cw, cw);
      if (isDiff) paintDiff(id, data, 6 * sig); else paint(id, data, state.limits, state.stretch, 'gray', false);
      cv.getContext('2d').putImageData(id, 0, 0);
      crops.appendChild(cv);
    }
    const txt = document.createElement('div');
    txt.className = 'ch-text';
    const s = (PIXEL_ARCSEC / 3600) * D2R, half = (n - 1) / 2;
    const [ra, dec] = tanDeproject([state.target.ra * D2R, state.target.dec * D2R], -(c.x - half) * s, (half - c.y) * s);
    const badge = c.known
      ? `<span class="ch-badge known">Known asteroid</span>`
      : c.glitch ? `<span class="ch-badge glitch">Glitch</span>`
      : `<span class="ch-badge ${c.kind}">${c.kind === 'new' ? 'New source' : 'Brightened'}</span>`;
    const seen = c.parts ? ` · in ${c.seenIn} of ${c.parts} exposures` : ' · single exposure, could be a glitch';
    const who = c.known
      ? `${escapeHtml(c.known.name)} · V ${c.known.vmag.toFixed(1)}`
      : c.kind === 'new'
        ? (!('known' in c) ? 'Checking asteroid catalogue…' : c.known === undefined ? 'Asteroid check failed' : 'Not a catalogued asteroid')
        : `${Math.round((100 * c.flux) / Math.max(c.base, 1e-9))}% brighter than usual`;
    txt.innerHTML = `${badge}<strong>${fmtDateTime(f.date)}</strong>
      <small>${who}${seen} · ${fmtSnr(c.snr)} · ${formatRA(ra)} ${formatDec(dec)}</small>`;
    b.append(crops, txt);
    b.onclick = () => showChange(c);
    li.appendChild(b);
    list.appendChild(li);
  }
}

function fmtSnr(v) {
  return v >= 1000 ? `${Math.round(v / 1000)}kσ` : `${Math.round(v)}σ`;
}

function showChange(c) {
  stop();
  if (state.mode !== 'diff') setMode('diff');
  state.idx = loaded().indexOf(c.frameRef);
  state.mark = c;
  draw();
  drawOverlay();
  renderChanges();
  $('viewer').scrollIntoView({ behavior: 'smooth', block: 'center' });
}

$('scanBtn').addEventListener('click', scanChanges);
$('chFilters').addEventListener('click', e => {
  const f = e.target.closest('button')?.dataset.f;
  if (!f) return;
  state.chFilter = f;
  renderChanges();
});

// ---------- light curve ----------

function lightcurvePoints() {
  if (!state.probe) return [];
  if (!state.lcPoints) {
    const n = state.size;
    state.lcPoints = [];
    state.lcSaturated = 0;
    loaded().forEach((f, i) => {
      const p = photometry(f.data, n, state.probe[0], state.probe[1], f.sigma);
      if (p?.saturated) state.lcSaturated++;
      else if (p) state.lcPoints.push({ ...p, mjd: f.mjd, date: f.date, i });
    });
  }
  return state.lcPoints;
}

function drawLightcurve() {
  $('lc').hidden = !state.probe;
  $('lcInvite').hidden = !!state.probe || !loaded().length;
  if (!state.probe) return;
  const composite = state.mode === 'motion' || state.mode === 'static';
  const cur = composite ? -1 : loaded().indexOf(currentFrame());
  const pts = lightcurvePoints();
  renderChart($('lcSvg'), pts, cur, fmtDate);
  const sat = state.lcSaturated;
  $('lcNote').textContent = !pts.length && sat
    ? 'This star is too bright: it saturates SPHEREx’s detector, so its brightness can’t be measured.'
    : !pts.length ? 'Not enough clean data around this point to measure it.'
    : sat ? `${sat} visit${sat > 1 ? 's' : ''} skipped: pixels at the star’s centre were blank (saturated or flagged as bad).` : '';
}

function setProbe(i, j) {
  const n = state.size;
  const t = getTemplate();
  state.probe = t ? snapToPeak(t, n, i, j) : [i, j];
  state.lcPoints = null;
  const s = (PIXEL_ARCSEC / 3600) * D2R, half = (n - 1) / 2;
  const [pra, pdec] = centreOf(currentFrame());
  const [ra, dec] = tanDeproject([pra * D2R, pdec * D2R], -(state.probe[0] - half) * s, (half - state.probe[1]) * s);
  $('lcWhere').textContent = state.track
    ? `${state.probe[0] === Math.round(half) && state.probe[1] === Math.round(half) ? state.track.name : 'Point'} in the moving frame · ${DETECTORS[state.band].name} · aperture 15″ radius`
    : `${formatRA(ra)} ${formatDec(dec)} · ${DETECTORS[state.band].name} · aperture 15″ radius`;
  drawOverlay();
  drawLightcurve();
}

$('viewer').addEventListener('click', e => {
  if (!loaded().length) return;
  const r = canvas.getBoundingClientRect(), n = state.size;
  const i = Math.floor(((e.clientX - r.left) / r.width) * n);
  const j = Math.floor(((e.clientY - r.top) / r.height) * n);
  if (i >= 0 && j >= 0 && i < n && j < n) setProbe(i, j);
});

$('lcClear').addEventListener('click', () => { state.probe = null; state.lcPoints = null; drawOverlay(); drawLightcurve(); });

$('lcCsv').addEventListener('click', () => {
  download(new Blob([toCSV(lightcurvePoints())], { type: 'text/csv' }), 'csv');
});

$('lcSvg').addEventListener('mousemove', e => {
  const g = e.target.closest('.lc-pt');
  const tip = $('lcTip');
  if (!g) { tip.hidden = true; return; }
  const p = lightcurvePoints()[Number(g.dataset.k)];
  const dot = g.querySelector('.lc-dot').getBoundingClientRect();
  const wrap = $('lcSvg').parentElement.getBoundingClientRect();
  tip.innerHTML = `${fmtDateTime(p.date)}<br>${p.flux.toFixed(2)} <span>± ${p.err.toFixed(2)} mJy</span>`;
  tip.style.left = `${dot.left + dot.width / 2 - wrap.left}px`;
  tip.style.top = `${dot.top - wrap.top}px`;
  tip.hidden = false;
});
$('lcSvg').addEventListener('mouseleave', () => { $('lcTip').hidden = true; });
$('lcSvg').addEventListener('click', e => {
  const g = e.target.closest('.lc-pt');
  if (!g) return;
  stop();
  if (state.mode === 'motion' || state.mode === 'static') setMode('play');
  if (state.mode === 'blink') setMode('play');
  state.idx = lightcurvePoints()[Number(g.dataset.k)].i;
  draw();
});

// ---------- timeline & filmstrip ----------

function timeRange() {
  const all = state.frames;
  if (!all.length) return [0, 1];
  const t0 = all[0].mjd, t1 = all[all.length - 1].mjd;
  return t1 > t0 ? [t0, t1] : [t0 - 1, t1 + 1];
}

function renderTimeline() {
  const ticks = $('ticks'), axis = $('axis');
  ticks.innerHTML = '';
  axis.innerHTML = '';
  const [t0, t1] = timeRange();
  const fr = loaded();
  for (const f of state.frames) {
    if (f.status === 'off' || f.status === 'error') continue;
    const d = document.createElement('div');
    d.className = 'tick' + (f.status === 'ok' ? ' loaded' : '');
    d.style.left = `${(100 * (f.mjd - t0)) / (t1 - t0)}%`;
    d.dataset.i = fr.indexOf(f);
    d.title = fmtDateTime(f.date);
    ticks.appendChild(d);
  }
  // Month labels
  if (state.frames.length) {
    const start = new Date((t0 - 40587) * 864e5), end = new Date((t1 - 40587) * 864e5);
    const months = (end.getUTCFullYear() - start.getUTCFullYear()) * 12 + end.getUTCMonth() - start.getUTCMonth();
    const step = months > 18 ? 6 : months > 8 ? 3 : 1;
    const d = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 1));
    for (; d <= end; d.setUTCMonth(d.getUTCMonth() + step)) {
      const mjd = d.getTime() / 864e5 + 40587;
      const s = document.createElement('span');
      s.style.left = `${(100 * (mjd - t0)) / (t1 - t0)}%`;
      s.textContent = d.toLocaleDateString(undefined, { month: 'short', year: '2-digit', timeZone: 'UTC' });
      axis.appendChild(s);
    }
  }
  updateTimelineMarks();
}

function updateTimelineMarks() {
  const blink = state.mode === 'blink';
  const composite = state.mode === 'motion' || state.mode === 'static';
  for (const t of $('ticks').children) {
    const i = Number(t.dataset.i);
    t.classList.toggle('current', !blink && !composite && i === state.idx);
    t.classList.toggle('blink-a', blink && i === state.blinkA);
    t.classList.toggle('blink-b', blink && i === state.blinkB);
  }
  const fr = loaded();
  $('blinkPick').hidden = !blink || fr.length < 2;
  if (blink && fr.length >= 2) {
    $('blinkA').textContent = fmtDate(fr[state.blinkA]?.date ?? fr[0].date);
    $('blinkB').textContent = fmtDate(fr[state.blinkB]?.date ?? fr[fr.length - 1].date);
  }
}

const thumbs = new WeakMap(); // frame -> thumbnail button

function renderFilmstrip(full = true) {
  const strip = $('filmstrip');
  const fr = loaded();
  const n = state.size;
  const id = new ImageData(n, n);
  const paintThumb = (f, c) => {
    paint(id, f.data, state.limits, state.stretch, state.cmap, state.invert);
    c.getContext('2d').putImageData(id, 0, 0);
  };
  const keep = new Set();
  fr.forEach((f, i) => {
    let b = thumbs.get(f);
    if (!b || b.firstChild.width !== n) {
      b = document.createElement('button');
      b.className = 'thumb';
      const c = document.createElement('canvas');
      c.width = c.height = n;
      const s = document.createElement('small');
      s.textContent = fmtDate(f.date);
      b.append(c, s);
      thumbs.set(f, b);
      paintThumb(f, c);
    } else if (full) {
      paintThumb(f, b.firstChild);
    }
    b.dataset.i = i;
    keep.add(b);
    strip.appendChild(b); // re-appending keeps date order as frames arrive out of order
  });
  for (const b of [...strip.children]) if (!keep.has(b)) b.remove();
  updateFilmstripMarks();
}

function updateFilmstripMarks() {
  const cur = loaded().indexOf(currentFrame());
  for (const b of $('filmstrip').children) {
    const on = Number(b.dataset.i) === cur;
    if (on && !b.classList.contains('current') && state.playing) {
      // Scroll only the strip sideways; scrollIntoView would also jump the page.
      const strip = $('filmstrip');
      const left = b.offsetLeft - strip.offsetLeft;
      if (left < strip.scrollLeft || left + b.offsetWidth > strip.scrollLeft + strip.clientWidth) {
        strip.scrollLeft = left - strip.clientWidth / 2 + b.offsetWidth / 2;
      }
    }
    b.classList.toggle('current', on);
  }
}

// ---------- playback ----------

let timer = null;
function play() {
  if (loaded().length < 2) return;
  state.playing = true;
  $('playBtn').classList.add('playing');
  $('playBtn').setAttribute('aria-label', 'Pause');
  clearInterval(timer);
  const blink = state.mode === 'blink';
  timer = setInterval(() => {
    if (state.mode === 'blink') state.blinkPhase ^= 1;
    else state.idx = (state.idx + 1) % loaded().length;
    draw();
  }, 1000 / (blink ? Math.max(1, state.fps / 2) : state.fps));
}

function stop() {
  state.playing = false;
  clearInterval(timer);
  $('playBtn').classList.remove('playing');
  $('playBtn').setAttribute('aria-label', 'Play');
}

function step(d) {
  stop();
  const n = loaded().length;
  if (!n) return;
  if (state.mode === 'blink') state.blinkPhase ^= 1;
  else { if (state.mode === 'motion' || state.mode === 'static') setMode('play'); state.idx = (state.idx + d + n) % n; }
  draw();
}

// ---------- export ----------

const EXPORT_PX = 720;

function exportCanvas() {
  const c = document.createElement('canvas');
  c.width = c.height = EXPORT_PX;
  const g = c.getContext('2d');
  g.imageSmoothingEnabled = false;
  return [c, g];
}

function stamp(g) {
  g.drawImage(canvas, 0, 0, EXPORT_PX, EXPORT_PX);
  g.font = '500 20px Inter, sans-serif';
  g.fillStyle = 'rgba(7,6,13,0.7)';
  const label = $('hudDate').textContent;
  g.fillRect(12, 12, g.measureText(label).width + 20, 34);
  g.fillStyle = '#ece9ff';
  g.fillText(label, 22, 36);
  g.font = '13px Inter, sans-serif';
  g.fillStyle = 'rgba(236,233,255,0.75)';
  const credit = `SPHEREx ${DETECTORS[state.band].name} · ${state.target.name || ''} · NASA/JPL-Caltech/IPAC`;
  g.fillText(credit, 14, EXPORT_PX - 14);
}

function download(blob, ext) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `spherex-${(state.target.name || 'sky').replace(/\W+/g, '-').toLowerCase()}-${DETECTORS[state.band].name}.${ext}`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

$('pngBtn').addEventListener('click', () => {
  if (!loaded().length) return;
  const [c, g] = exportCanvas();
  stamp(g);
  c.toBlob(b => download(b, 'png'));
});

$('videoBtn').addEventListener('click', async () => {
  const fr = loaded();
  if (fr.length < 2 || !window.MediaRecorder) { toast('Video export needs at least two frames and a modern browser.'); return; }
  const btn = $('videoBtn');
  btn.disabled = true;
  stop();
  const mode = state.mode === 'motion' || state.mode === 'static' ? 'play' : state.mode;
  if (mode !== state.mode) setMode(mode);
  const [c, g] = exportCanvas();
  const mime = ['video/mp4;codecs=avc1', 'video/webm;codecs=vp9', 'video/webm'].find(m => MediaRecorder.isTypeSupported(m));
  const rec = new MediaRecorder(c.captureStream(30), { mimeType: mime, videoBitsPerSecond: 6e6 });
  const chunks = [];
  rec.ondataavailable = e => chunks.push(e.data);
  const done = new Promise(r => { rec.onstop = r; });
  rec.start();
  const steps = mode === 'blink' ? 8 : fr.length;
  const saved = [state.idx, state.blinkPhase];
  for (let i = 0; i < steps; i++) {
    btn.textContent = `${Math.round((100 * i) / steps)}%`;
    if (mode === 'blink') state.blinkPhase = i % 2; else state.idx = i;
    draw();
    stamp(g);
    await new Promise(r => setTimeout(r, 1000 / (mode === 'blink' ? Math.max(1, state.fps / 2) : state.fps)));
  }
  rec.stop();
  await done;
  [state.idx, state.blinkPhase] = saved;
  draw();
  btn.textContent = 'Video';
  btn.disabled = false;
  download(new Blob(chunks, { type: mime }), mime.startsWith('video/mp4') ? 'mp4' : 'webm');
});

// ---------- controls ----------

function renderBands() {
  const counts = bandCounts();
  $('bands').innerHTML = '';
  for (const [k, d] of Object.entries(DETECTORS)) {
    const b = document.createElement('button');
    b.className = 'band';
    b.style.setProperty('--c', d.color);
    b.disabled = !counts[k];
    b.setAttribute('aria-pressed', String(Number(k) === state.band));
    b.innerHTML = `<span style="color:${d.color}">${d.name}</span><small>${d.range}</small><small>${counts[k] || 0} images</small>`;
    b.onclick = () => { state.band = Number(k); renderBands(); loadBand(); };
    $('bands').appendChild(b);
  }
}

function renderSizes() {
  for (const b of $('sizes').children) b.setAttribute('aria-pressed', String(Number(b.dataset.size) === state.size));
}

function renderModes() {
  for (const b of $('modes').children) b.setAttribute('aria-selected', String(b.dataset.mode === state.mode));
  $('modeHint').textContent = (state.track && TRACK_HINTS[state.mode]) || MODE_HINTS[state.mode];
}

function setMode(m) {
  const wasPlaying = state.playing;
  stop();
  state.mode = m;
  state.blinkPhase = 0;
  renderModes();
  writeHash();
  draw();
  if (wasPlaying && (m === 'play' || m === 'diff' || m === 'blink')) play();
  else if (m === 'blink') play();
}

$('modes').addEventListener('click', e => {
  const m = e.target.closest('button')?.dataset.mode;
  if (m) setMode(m);
});

$('sizes').addEventListener('click', e => {
  const s = Number(e.target.closest('button')?.dataset.size);
  if (!s || s === state.size) return;
  state.size = s;
  renderSizes();
  if (state.exposures.length) loadBand();
});

$('mask').addEventListener('change', e => { state.mask = e.target.checked; if (state.exposures.length) loadBand(); });
$('groupDay').addEventListener('change', e => { state.group = e.target.checked; if (state.exposures.length) loadBand(); });

for (const id of ['stretch', 'cmap']) {
  $(id).addEventListener('change', e => { state[id] = e.target.value; drawAll(); });
}
$('contrast').addEventListener('input', e => { state.contrast = Number(e.target.value); recomputeLimits(); draw(); });
$('contrast').addEventListener('change', () => renderFilmstrip());
$('invert').addEventListener('change', e => { state.invert = e.target.checked; drawAll(); });
$('crosshair').addEventListener('change', e => { state.crosshair = e.target.checked; drawOverlay(); });

$('playBtn').addEventListener('click', () => (state.playing ? stop() : play()));
$('prevBtn').addEventListener('click', () => step(-1));
$('nextBtn').addEventListener('click', () => step(1));
$('speed').addEventListener('input', e => {
  state.fps = Number(e.target.value);
  $('speedVal').textContent = `${state.fps} fps`;
  if (state.playing) play();
});

$('timeline').addEventListener('click', e => {
  const fr = loaded();
  if (!fr.length) return;
  const rect = $('ticks').getBoundingClientRect();
  const [t0, t1] = timeRange();
  const mjd = t0 + ((e.clientX - rect.left) / rect.width) * (t1 - t0);
  let best = 0;
  fr.forEach((f, i) => { if (Math.abs(f.mjd - mjd) < Math.abs(fr[best].mjd - mjd)) best = i; });
  if (state.mode === 'blink') {
    if (e.shiftKey) state.blinkB = best; else state.blinkA = best;
  } else {
    stop();
    if (state.mode === 'motion' || state.mode === 'static') setMode('play');
    state.idx = best;
  }
  draw();
});

$('filmstrip').addEventListener('click', e => {
  const b = e.target.closest('.thumb');
  if (!b) return;
  stop();
  const i = Number(b.dataset.i);
  if (state.mode === 'blink') {
    if (e.shiftKey) state.blinkB = i; else state.blinkA = i;
  } else {
    if (state.mode === 'motion' || state.mode === 'static') setMode('play');
    state.idx = i;
  }
  draw();
});

$('viewer').addEventListener('mousemove', e => {
  if (!state.target) return;
  const r = canvas.getBoundingClientRect();
  const n = state.size;
  const i = Math.floor(((e.clientX - r.left) / r.width) * n);
  const j = Math.floor(((e.clientY - r.top) / r.height) * n);
  if (i < 0 || j < 0 || i >= n || j >= n) return;
  const s = (PIXEL_ARCSEC / 3600) * D2R, half = (n - 1) / 2;
  const f = currentFrame();
  const [hra, hdec] = centreOf(state.mode === 'motion' || state.mode === 'static' ? null : f);
  const [ra, dec] = tanDeproject([hra * D2R, hdec * D2R], -(i - half) * s, (half - j) * s);
  const v = f && state.mode !== 'motion' ? (state.mode === 'static' ? getTemplate() : f.data)[j * n + i] : NaN;
  $('hudCursor').textContent = `${formatRA(ra)} ${formatDec(dec)}${v === v ? `  ${v.toFixed(3)} MJy/sr` : ''}`;
});
$('viewer').addEventListener('mouseleave', () => { $('hudCursor').textContent = ''; });

document.addEventListener('keydown', e => {
  if (e.target.closest('input, select, textarea') || $('workspace').hidden) return;
  if (e.key === 'ArrowRight') step(1);
  else if (e.key === 'ArrowLeft') step(-1);
  else if (e.key === ' ') { e.preventDefault(); state.playing ? stop() : play(); }
  else if (e.key === 'b') setMode('blink');
  else if (e.key === 'd') setMode('diff');
});

$('search').addEventListener('submit', e => {
  e.preventDefault();
  const q = $('q').value.trim();
  if (!q) return;
  if ($('searchMode').value === 'track') lookAt(q, { track: q });
  else lookAt(q);
});

// Settings
$('settingsBtn').addEventListener('click', () => {
  $('maxFrames').value = state.maxFrames;
  $('settings').showModal();
});
$('settings').addEventListener('close', () => {
  if ($('settings').returnValue !== 'save') return;
  state.maxFrames = Math.max(4, Math.min(400, Number($('maxFrames').value) || 80));
  try { localStorage.setItem('maxFrames', state.maxFrames); } catch {}
  if (state.exposures.length) loadBand();
});

// Examples
for (const ex of EXAMPLES) {
  const b = document.createElement('button');
  b.className = 'example';
  b.innerHTML = `<strong></strong><span></span>`;
  b.querySelector('strong').textContent = ex.name;
  b.querySelector('span').textContent = ex.note;
  b.onclick = () => {
    $('q').value = ex.track || ex.name;
    $('searchMode').value = ex.track ? 'track' : 'place';
    updatePlaceholder();
    lookAt(ex.name, ex);
  };
  $('examples').appendChild(b);
}

function updatePlaceholder() {
  $('q').placeholder = $('searchMode').value === 'track'
    ? 'Comet or asteroid — e.g. 3I/ATLAS, 12P, Ceres, 2024 YR4'
    : "Object name or RA Dec — e.g. Barnard's Star, M42, 270 66.56";
}
$('searchMode').addEventListener('change', updatePlaceholder);

// Start from a shared link if present
function fromHash() {
  const p = new URLSearchParams(location.hash.slice(1));
  const ra = Number(p.get('ra')), dec = Number(p.get('dec'));
  const opts = {
    band: Number(p.get('band')) || undefined,
    size: Number(p.get('fov')) || undefined,
    mode: MODE_HINTS[p.get('view')] ? p.get('view') : undefined,
  };
  if (p.get('track')) {
    $('q').value = p.get('track');
    $('searchMode').value = 'track';
    updatePlaceholder();
    lookAt(p.get('track'), { ...opts, track: p.get('track') });
  } else if (p.has('ra') && p.has('dec') && Number.isFinite(ra) && Number.isFinite(dec)) {
    const name = p.get('name');
    $('q').value = name || `${ra} ${dec}`;
    lookAt(name || '', { ...opts, ra, dec, name });
  } else if (p.get('name')) {
    $('q').value = p.get('name');
    lookAt(p.get('name'), opts);
  }
}

renderModes();
renderSizes();
fromHash();

loadIndex().then(ix => {
  const d = new Date(ix.updated);
  $('stats').textContent = `${ix.total.toLocaleString()} SPHEREx images indexed · updated ${fmtDate(d)}`;
}).catch(() => {});
