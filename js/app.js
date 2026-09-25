import { resolve, formatRA, formatDec } from './resolve.js';
import { findExposures, DETECTORS, loadIndex } from './catalog.js';
import { makeCutout, PIXEL_ARCSEC } from './cutout.js';
import { tanDeproject, D2R } from './wcs.js';
import {
  backgroundSubtract, medianStack, subtract, stretchLimits, paint, paintDiff, paintMotion, median,
} from './render.js';

const $ = id => document.getElementById(id);

const EXAMPLES = [
  { name: "Barnard's Star", ra: 269.4464, dec: 4.7673, note: 'Fastest-moving star in the sky — watch it creep north', size: 48 },
  { name: 'Asteroid 4 Vesta', ra: 215.95, dec: -6.76, note: 'Caught crossing the field, July 2025', size: 240, band: 2, mode: 'motion' },
  { name: 'North Ecliptic Pole', ra: 270.0, dec: 66.5607, note: 'SPHEREx deep field: hundreds of visits' },
  { name: 'Betelgeuse', ra: 88.7929, dec: 7.4071, note: 'Pulsating red supergiant' },
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
  if (state.target.name) p.set('name', state.target.name);
  p.set('ra', state.target.ra.toFixed(5));
  p.set('dec', state.target.dec.toFixed(5));
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
  imageData = ctx.createImageData(state.size, state.size);
  canvas.width = canvas.height = state.size;
  ctx.clearRect(0, 0, state.size, state.size);
  $('filmstrip').innerHTML = '';
  writeHash();
  renderTimeline();
  drawOverlay();
  setLoading(`Downloading ${state.frames.length} visits in ${DETECTORS[state.band].name}…`);

  const queue = [...state.frames];
  let done = 0;
  const size = state.size;
  const { ra, dec } = state.target;
  const worker = async () => {
    while (queue.length && !abort.signal.aborted) {
      const frame = queue.shift();
      try {
        const cuts = [];
        for (const e of frame.exposures) {
          const c = await makeCutout(e, ra, dec, size, abort.signal);
          if (!c.offImage) cuts.push(c.data);
        }
        if (!cuts.length) { frame.status = 'off'; continue; }
        const combined = cuts.length === 1 ? cuts[0] : nanMean(cuts);
        const { data, sigma } = backgroundSubtract(combined);
        frame.data = data;
        frame.sigma = sigma;
        frame.status = 'ok';
      } catch (e) {
        if (abort.signal.aborted) return;
        console.warn('frame failed', e);
        frame.status = 'error';
      } finally {
        done++;
        if (!abort.signal.aborted) onFrameLoaded(done);
      }
    }
  };
  await Promise.all(Array.from({ length: 6 }, worker));
  if (abort.signal.aborted) return;
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
  requestAnimationFrame(() => {
    refreshQueued = false;
    state.template = null;
    recomputeLimits();
    if (state.blinkB < 0 || state.blinkB >= loaded().length) state.blinkB = loaded().length - 1;
    drawAll();
  });
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
    case 'static':
      paint(imageData, getTemplate(), limits, stretch, cmap, invert);
      break;
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
    $('hudFrame').textContent = `${fr.indexOf(f) + 1} / ${fr.length}`;
  }
  updateTimelineMarks();
  updateFilmstripMarks();
}

function drawAll() {
  draw();
  renderTimeline();
  renderFilmstrip();
}

function drawOverlay() {
  const svg = $('overlay');
  if (!state.crosshair || !state.target) { svg.innerHTML = ''; return; }
  const g = 3, l = 6;
  svg.innerHTML = `
    <g stroke="rgba(111,211,255,0.85)" stroke-width="0.35" vector-effect="non-scaling-stroke">
      <line x1="${50 - g - l}" y1="50" x2="${50 - g}" y2="50"/><line x1="${50 + g}" y1="50" x2="${50 + g + l}" y2="50"/>
      <line x1="50" y1="${50 - g - l}" x2="50" y2="${50 - g}"/><line x1="50" y1="${50 + g}" x2="50" y2="${50 + g + l}"/>
    </g>`;
}

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

function renderFilmstrip() {
  const strip = $('filmstrip');
  const fr = loaded();
  strip.innerHTML = '';
  const n = state.size;
  const id = new ImageData(n, n);
  fr.forEach((f, i) => {
    const b = document.createElement('button');
    b.className = 'thumb';
    b.dataset.i = i;
    const c = document.createElement('canvas');
    c.width = c.height = n;
    paint(id, f.data, state.limits, state.stretch, state.cmap, state.invert);
    c.getContext('2d').putImageData(id, 0, 0);
    const s = document.createElement('small');
    s.textContent = fmtDate(f.date);
    b.append(c, s);
    strip.appendChild(b);
  });
  updateFilmstripMarks();
}

function updateFilmstripMarks() {
  const cur = loaded().indexOf(currentFrame());
  for (const b of $('filmstrip').children) {
    const on = Number(b.dataset.i) === cur;
    if (on && !b.classList.contains('current') && state.playing) b.scrollIntoView({ block: 'nearest', inline: 'nearest' });
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
  $('modeHint').textContent = MODE_HINTS[state.mode];
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
  const [ra, dec] = tanDeproject([state.target.ra * D2R, state.target.dec * D2R], -(i - half) * s, (half - j) * s);
  const f = currentFrame();
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
  if (q) lookAt(q);
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
  b.onclick = () => { $('q').value = ex.name; lookAt(ex.name, ex); };
  $('examples').appendChild(b);
}

// Start from a shared link if present
function fromHash() {
  const p = new URLSearchParams(location.hash.slice(1));
  const ra = Number(p.get('ra')), dec = Number(p.get('dec'));
  const opts = {
    band: Number(p.get('band')) || undefined,
    size: Number(p.get('fov')) || undefined,
    mode: MODE_HINTS[p.get('view')] ? p.get('view') : undefined,
  };
  if (p.has('ra') && p.has('dec') && Number.isFinite(ra) && Number.isFinite(dec)) {
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
