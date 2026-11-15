// Runs the change scan off the main thread so the page stays responsive.
import { findChanges, linkWithinVisits } from './detect.js';

onmessage = ({ data: { frames, template, w, scale } }) => {
  try {
    postMessage({ all: findChanges(frames, template, w, { scale }), fast: linkWithinVisits(frames, template, w) });
  } catch (e) {
    postMessage({ error: String(e) });
  }
};
