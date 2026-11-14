// Page logic for the SPHEREx viewer: the bundled example, search, progressive frame loading,
// playback and the target marker.

import {
  capNotice, computeStretch, formatPosition, frameLabel, joinStatus, markerPercent, nextIndex,
  parseExample, plural, previousIndex, toRGBA,
} from "./lib.js";

const PLAY_INTERVAL_MS = 500;
const UNREACHABLE = "the server could not be reached";
const EXAMPLE_URL = "api/example.json";
const EXAMPLE_FAILED = "The example could not be loaded; enter coordinates to search.";

const form = document.getElementById("search");
const raInput = document.getElementById("ra");
const decInput = document.getElementById("dec");
const detectorSelect = document.getElementById("detector");
const enterDisclosure = document.getElementById("enter");
const statusLine = document.getElementById("status");
const canvas = document.getElementById("image");
const marker = document.getElementById("marker");
const prevButton = document.getElementById("prev");
const playButton = document.getElementById("play");
const nextButton = document.getElementById("next");
const slider = document.getElementById("slider");
const dateLabel = document.getElementById("date");
const nameLine = document.getElementById("name");
const positionLine = document.getElementById("position");
const hintLine = document.getElementById("hint");
const markerControl = document.getElementById("marker-control");
const markerToggle = document.getElementById("show-marker");
const context = canvas.getContext("2d");

let controller = null;
let frames = [];
let stretch = null;
let current = 0;
let timer = null;

function setStatus(text) {
  statusLine.textContent = text;
}

function showTarget(name, position, hint) {
  nameLine.textContent = name;
  positionLine.textContent = position;
  hintLine.textContent = hint;
  hintLine.hidden = hint === "";
}

function enablePlayer(enabled) {
  for (const control of [prevButton, playButton, nextButton, slider]) control.disabled = !enabled;
}

function stopPlayback() {
  clearInterval(timer);
  timer = null;
  playButton.textContent = "Play";
}

function reset() {
  stopPlayback();
  frames = [];
  stretch = null;
  current = 0;
  context.clearRect(0, 0, canvas.width, canvas.height);
  enablePlayer(false);
  slider.max = "0";
  slider.value = "0";
  dateLabel.textContent = "";
  marker.hidden = true;
  markerControl.hidden = true;
}

function placeMarker(frame) {
  marker.hidden = frame.marker === undefined || !markerToggle.checked;
  if (marker.hidden) return;
  const { left, top } = markerPercent(frame.marker, frame.width, frame.height);
  marker.style.left = `${left}%`;
  marker.style.top = `${top}%`;
}

function show(index) {
  current = index;
  const frame = frames[index];
  const image = new ImageData(toRGBA(frame.pixels, stretch), frame.width, frame.height);
  context.putImageData(image, 0, 0);
  slider.value = String(index);
  dateLabel.textContent = frame.label;
  placeMarker(frame);
}

async function errorDetail(response) {
  try {
    const body = await response.json();
    if (typeof body.detail === "string") return body.detail;
  } catch {
    // Not a JSON error body; fall back to the HTTP status.
  }
  return `${response.status} ${response.statusText}`.trim();
}

/**
 * Sends one request and reads its JSON body.
 * Returns {body} on success, {reason} on a network or HTTP failure, null once aborted;
 * any other error propagates.
 */
async function request(url, options, signal) {
  try {
    const response = await fetch(url, { ...options, signal });
    if (!response.ok) return { reason: await errorDetail(response) };
    return { body: await response.json() };
  } catch (err) {
    if (signal.aborted) return null;
    // fetch and body reads reject with TypeError when the network fails.
    if (err instanceof TypeError) return { reason: UNREACHABLE };
    throw err;
  }
}

/** Shows the bundled example's first frame without playing it; a search started first wins. */
async function loadExample(signal) {
  let data;
  try {
    const response = await fetch(EXAMPLE_URL, { signal });
    data = response.ok ? await response.json() : null;
  } catch (err) {
    if (signal.aborted) return;
    // TypeError: the network failed; SyntaxError: the file is not JSON.
    if (!(err instanceof TypeError || err instanceof SyntaxError)) throw err;
    data = null;
  }
  if (signal.aborted) return;
  const example = data === null ? null : parseExample(data);
  if (example === null) {
    setStatus(EXAMPLE_FAILED);
    return;
  }
  frames = example.frames;
  stretch = computeStretch(frames.map((f) => f.pixels));
  slider.max = String(frames.length - 1);
  markerControl.hidden = frames[0].marker === undefined;
  showTarget(example.name, example.position, example.hint);
  enablePlayer(true);
  show(0);
}

function sentence(text) {
  return text.endsWith(".") ? text : `${text}.`;
}

async function loadFrames(plan, signal) {
  const notice = capNotice(plan);
  const n = plan.frames.length;
  let used = 0;
  let failed = 0;
  let reason = "";
  for (const [i, planned] of plan.frames.entries()) {
    setStatus(joinStatus(`Loading frame ${i + 1} of ${n}…`, notice));
    const outcome = await request("api/frame", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ra_deg: plan.ra_deg, dec_deg: plan.dec_deg, uris: planned.uris }),
    }, signal);
    if (outcome === null || signal.aborted) return;
    if (outcome.reason !== undefined) {
      failed += 1;
      reason = outcome.reason;
      continue;
    }
    const result = outcome.body;
    frames.push({
      pixels: result.pixels,
      width: result.width,
      height: result.height,
      label: frameLabel(planned.label, result.n_used),
    });
    used += result.n_used;
    stretch = computeStretch(frames.map((f) => f.pixels));
    slider.max = String(frames.length - 1);
    if (frames.length === 1) enablePlayer(true);
    show(frames.length === 1 ? 0 : current);
  }
  if (frames.length === 0) {
    setStatus(sentence(`No frame could be loaded: ${reason}`));
    return;
  }
  setStatus(joinStatus(
    `${plural(frames.length, "frame")} from ${used} of ${plural(plan.n_exposures, "exposure")}.`,
    notice,
    failed > 0 ? sentence(`${plural(failed, "frame")} could not be loaded: ${reason}`) : "",
  ));
}

async function search(ra, dec, detector) {
  if (controller) controller.abort();
  controller = new AbortController();
  const { signal } = controller;
  reset();
  showTarget(`RA ${ra.trim()}, Dec ${dec.trim()}`, "", "");
  setStatus("Searching the SPHEREx archive…");
  const outcome = await request("api/search?" + new URLSearchParams({ ra, dec, detector }), {},
    signal);
  if (outcome === null || signal.aborted) return;
  if (outcome.reason !== undefined) {
    setStatus(`Error: ${outcome.reason}`);
    return;
  }
  const plan = outcome.body;
  positionLine.textContent = formatPosition(plan.ra_deg, plan.dec_deg, plan.detector);
  if (plan.frames.length === 0) {
    setStatus(`No SPHEREx exposures cover this position in ${plan.detector}.`);
    return;
  }
  await loadFrames(plan, signal);
}

form.addEventListener("submit", (event) => {
  event.preventDefault();
  search(raInput.value, decInput.value, detectorSelect.value);
});

enterDisclosure.addEventListener("toggle", () => {
  if (enterDisclosure.open) raInput.focus();
});

slider.addEventListener("input", () => {
  show(Number(slider.value));
});

prevButton.addEventListener("click", () => {
  stopPlayback();
  show(previousIndex(current, frames.length));
});

nextButton.addEventListener("click", () => {
  stopPlayback();
  show(nextIndex(current, frames.length));
});

playButton.addEventListener("click", () => {
  if (timer !== null) {
    stopPlayback();
    return;
  }
  playButton.textContent = "Pause";
  timer = setInterval(() => show(nextIndex(current, frames.length)), PLAY_INTERVAL_MS);
});

markerToggle.addEventListener("change", () => {
  if (frames.length > 0) placeMarker(frames[current]);
});

controller = new AbortController();
loadExample(controller.signal);
