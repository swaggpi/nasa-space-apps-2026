// Page logic for the SPHEREx viewer: search, progressive frame loading and playback.

import {
  capNotice, computeStretch, frameLabel, joinStatus, nextIndex, plural, toRGBA,
} from "./lib.js";

const PLAY_INTERVAL_MS = 500;
const UNREACHABLE = "the server could not be reached";

const form = document.getElementById("search");
const raInput = document.getElementById("ra");
const decInput = document.getElementById("dec");
const detectorSelect = document.getElementById("detector");
const statusLine = document.getElementById("status");
const canvas = document.getElementById("image");
const playButton = document.getElementById("play");
const slider = document.getElementById("slider");
const dateLabel = document.getElementById("date");
const context = canvas.getContext("2d");

let controller = null;
let frames = [];
let stretch = null;
let current = 0;
let timer = null;

function setStatus(text) {
  statusLine.textContent = text;
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
  playButton.disabled = true;
  slider.disabled = true;
  slider.max = "0";
  slider.value = "0";
  dateLabel.textContent = "";
}

function show(index) {
  current = index;
  const frame = frames[index];
  const image = new ImageData(toRGBA(frame.pixels, stretch), frame.width, frame.height);
  context.putImageData(image, 0, 0);
  slider.value = String(index);
  dateLabel.textContent = frame.label;
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
    if (frames.length === 1) {
      playButton.disabled = false;
      slider.disabled = false;
    }
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
  setStatus("Searching the SPHEREx archive…");
  const outcome = await request("api/search?" + new URLSearchParams({ ra, dec, detector }), {},
    signal);
  if (outcome === null || signal.aborted) return;
  if (outcome.reason !== undefined) {
    setStatus(`Error: ${outcome.reason}`);
    return;
  }
  const plan = outcome.body;
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

slider.addEventListener("input", () => {
  show(Number(slider.value));
});

playButton.addEventListener("click", () => {
  if (timer !== null) {
    stopPlayback();
    return;
  }
  playButton.textContent = "Pause";
  timer = setInterval(() => show(nextIndex(current, frames.length)), PLAY_INTERVAL_MS);
});
