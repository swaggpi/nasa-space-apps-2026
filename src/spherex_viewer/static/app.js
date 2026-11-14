// Page logic for the SPHEREx viewer: search, progressive frame loading and playback.

import { capNotice, computeStretch, nextIndex, toRGBA } from "./lib.js";

const PLAY_INTERVAL_MS = 500;

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

async function loadFrames(plan, signal) {
  const notice = capNotice(plan);
  const n = plan.frames.length;
  let used = 0;
  let failed = 0;
  for (const [i, planned] of plan.frames.entries()) {
    setStatus(`Loading frame ${i + 1} of ${n}… ` + notice);
    try {
      const response = await fetch("api/frame", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ra_deg: plan.ra_deg, dec_deg: plan.dec_deg, uris: planned.uris }),
        signal,
      });
      if (!response.ok) throw new Error(await errorDetail(response));
      const result = await response.json();
      if (signal.aborted) return;
      frames.push({
        pixels: result.pixels,
        width: result.width,
        height: result.height,
        label: planned.label,
      });
      used += result.n_used;
      stretch = computeStretch(frames.map((f) => f.pixels));
      slider.max = String(frames.length - 1);
      if (frames.length === 1) {
        playButton.disabled = false;
        slider.disabled = false;
      }
      show(frames.length === 1 ? 0 : current);
    } catch {
      if (signal.aborted) return;
      failed += 1;
    }
  }
  setStatus(
    `${frames.length} frames from ${used} of ${plan.n_exposures} exposures. ` +
      notice +
      (failed > 0 ? ` ${failed} frames could not be loaded.` : ""),
  );
}

async function search(ra, dec, detector) {
  if (controller) controller.abort();
  controller = new AbortController();
  const { signal } = controller;
  reset();
  setStatus("Searching the SPHEREx archive…");
  let plan;
  try {
    const response = await fetch("api/search?" + new URLSearchParams({ ra, dec, detector }), {
      signal,
    });
    if (!response.ok) {
      const detail = await errorDetail(response);
      if (!signal.aborted) setStatus(`Error: ${detail}`);
      return;
    }
    plan = await response.json();
  } catch (err) {
    if (!signal.aborted) setStatus(`Error: ${err.message}`);
    return;
  }
  if (signal.aborted) return;
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
