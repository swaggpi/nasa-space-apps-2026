// Page logic for the SPHEREx viewer: the bundled example, search, progressive frame loading,
// playback, the target marker, the difference view, result links, the sky map for picking
// a search position, and zooming and moving the view over the surrounding fields.

import {
  FIELD_PIXELS, WIDE_PIXELS, ZOOM_LEVELS, aheadShift, capNotice, centrePixels, clampView,
  computeStretch, countRange, decodePixels, difference, fieldCorners, fieldTexts,
  formatPosition, frameLabel, isClick, joinStatus, linkQuery, markerPercent, nextIndex,
  noDataNote, offsetPosition, panStep, parseExample, parseLink, plural, previousIndex,
  retryDelay, shiftedView, shouldPreload, stageBox, toDifferenceRGBA, toRGBA, validFrameBody,
  validPlan, validWideBody, widenFrame, zoomStep,
} from "./lib.js";

const PLAY_INTERVAL_MS = 500;
const UNREACHABLE = "the server could not be reached";
const UNEXPECTED = "the server sent an unexpected answer";
const RETRIED_STATUSES = [429, 503];
const EXAMPLE_URL = "./example.json";
const EXAMPLE_FAILED = "The example could not be loaded; enter coordinates to search.";
const ALADIN_URL = "./vendor/aladin.js";
const SKY_SURVEY = "https://irsa.ipac.caltech.edu/data/hips/CDS/2MASS/Color";
const MAP_FAILED = "The sky map could not be loaded; enter coordinates to search.";
const MAP_HINT = "Click the map to select a position.";
const MAP_FOV_DEG = 1.5;
// Zoom range: 2' up to the whole sky (in Aladin 3.8.2's Aitoff projection a field of view of
// 360 degrees shows the sky at half the map's width, 359 fills it).
const MAP_MIN_FOV_DEG = 1 / 30;
const MAP_MAX_FOV_DEG = 359;
// Shown when no position is known yet (the example failed): the Galactic centre, whole sky.
const MAP_FALLBACK = { ra: 266.405, dec: -28.936, fov: MAP_MAX_FOV_DEG };
const SELECTION_COLOR = "rgb(255, 184, 28)";
const DIFFERENCE_LABEL =
  "Difference between the selected frame and the other frames, north up, east left";
// How long an arrow key must rest at the edge of the loaded area before the next one loads.
const REST_MS = 500;
const DEFAULT_VIEW = { zoom: 1, cx: (FIELD_PIXELS - 1) / 2, cy: (FIELD_PIXELS - 1) / 2 };
// Arrow keys as grid steps: left is east, up is north.
const ARROWS = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };

const form = document.getElementById("search");
const raInput = document.getElementById("ra");
const decInput = document.getElementById("dec");
const detectorSelect = document.getElementById("detector");
const submitButton = document.getElementById("submit");
const statusLine = document.getElementById("status");
const canvas = document.getElementById("image");
const marker = document.getElementById("marker");
const stage = document.getElementById("stage");
const zoomOutButton = document.getElementById("zoom-out");
const zoomInButton = document.getElementById("zoom-in");
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
const pickButton = document.getElementById("pick");
const sky = document.getElementById("sky");
const skyMap = document.getElementById("sky-map");
const skySelection = document.getElementById("sky-selection");
const skySearch = document.getElementById("sky-search");
const skyClose = document.getElementById("sky-close");
const differenceToggle = document.getElementById("difference");
const context = canvas.getContext("2d");
const IMAGE_LABEL = canvas.getAttribute("aria-label");

let controller = null;
let frames = [];
let stretch = null;
let current = 0;
let timer = null;
// ICRS degrees of the position shown (example or last search), where the map opens.
let shown = null;
let map = null;
let mapLoading = null;
let selection = null;
// The search answer behind the shown frames (null for the example), the example's position
// and detector while it is shown, the loaded grid's size, whether the fields around the
// centre of a wide grid hold data (until then they are drawn as not loaded), the view over
// the grid, whether a search, the surround or the next area is loading, and the status text
// of the shown frames.
let plan = null;
let example = null;
let grid = FIELD_PIXELS;
let surroundLoaded = false;
let view = DEFAULT_VIEW;
let loading = false;
let summary = "";
let restTimer = null;
// Loading ahead: the next area once loaded but not yet joined on (the view not inside it), the
// shift of a preload that failed (not tried again by itself), the time (ms) before which no
// preload starts after the search limit was reached, its timer, and the last arrow press.
let ahead = null;
let aheadFailed = null;
let aheadPausedUntil = 0;
let aheadTimer = null;
let lastMove = [0, 0];

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
  clearTimeout(restTimer);
  clearTimeout(aheadTimer);
  ahead = null;
  aheadFailed = null;
  aheadPausedUntil = 0;
  frames = [];
  stretch = null;
  current = 0;
  plan = null;
  example = null;
  grid = FIELD_PIXELS;
  surroundLoaded = false;
  view = DEFAULT_VIEW;
  summary = "";
  canvas.width = grid;
  canvas.height = grid;
  context.clearRect(0, 0, canvas.width, canvas.height);
  applyView();
  enablePlayer(false);
  slider.max = "0";
  slider.value = "0";
  slider.removeAttribute("aria-valuetext");
  dateLabel.textContent = "";
  marker.hidden = true;
  markerControl.hidden = true;
  differenceToggle.checked = false;
  differenceToggle.disabled = true;
  canvas.setAttribute("aria-label", IMAGE_LABEL);
}

function placeMarker(frame) {
  marker.hidden = frame.marker === undefined || !markerToggle.checked;
  if (marker.hidden) return;
  const { left, top } = markerPercent(frame.marker, frame.width, frame.height);
  marker.style.left = `${left}%`;
  marker.style.top = `${top}%`;
}

/** Whether the shown frames (a search's or the example's) can still be put on the wide grid. */
function widenable() {
  return frames.length > 0 && grid === FIELD_PIXELS && (plan !== null || example !== null);
}

/** Whether the wide grid's surrounding fields are missing and nothing is loading them. */
function retryable() {
  return frames.length > 0 && grid === WIDE_PIXELS && !surroundLoaded && !loading;
}

const atLowestZoom = () => view.zoom <= FIELD_PIXELS / grid;

/** Places the stage for the view and updates the zoom buttons and the date label. */
function applyView() {
  const box = stageBox(view, grid);
  stage.style.width = `${box.size}%`;
  stage.style.height = `${box.size}%`;
  stage.style.left = `${box.left}%`;
  stage.style.top = `${box.top}%`;
  stage.style.setProperty("--grid", String(grid));
  canvas.classList.toggle("pending", grid === WIDE_PIXELS && !surroundLoaded);
  const loaded = frames.length > 0;
  zoomInButton.disabled = !loaded || view.zoom >= ZOOM_LEVELS.at(-1);
  zoomOutButton.disabled = !loaded || (atLowestZoom() && !widenable() && !retryable());
  if (!loaded) return;
  const frame = frames[current];
  const label = frameLabel(frame.dates, ...countRange(frame.nFields, view, grid));
  slider.setAttribute("aria-valuetext", label);
  dateLabel.textContent = label;
}

function show(index) {
  current = index;
  const frame = frames[index];
  const drawDifference = differenceToggle.checked;
  const rgba = drawDifference
    ? toDifferenceRGBA(difference(frames, index), stretch)
    : toRGBA(frame.pixels, stretch);
  context.putImageData(new ImageData(rgba, frame.width, frame.height), 0, 0);
  canvas.setAttribute("aria-label", drawDifference ? DIFFERENCE_LABEL : IMAGE_LABEL);
  slider.value = String(index);
  placeMarker(frame);
  applyView();
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

/** Resolves after `seconds`. */
function pause(seconds) {
  return new Promise((done) => { setTimeout(done, seconds * 1000); });
}

/**
 * Sends one request and reads its JSON body, which `valid` must accept. A 429 or 503 answer
 * is retried once after its Retry-After delay, with `step` restored as the status, unless
 * `wait` is false: then it is a failure carrying that delay as `retryAfter` (seconds) and the
 * HTTP `status`.
 * Returns {body} on success, {reason} on a network, HTTP or content failure, null once
 * aborted; any other error propagates.
 */
async function request(url, options, signal, valid, step, wait = true) {
  try {
    let response = await fetch(url, { ...options, signal });
    if (!wait && RETRIED_STATUSES.includes(response.status)) {
      const retryAfter = retryDelay(response.headers.get("Retry-After"));
      return { reason: await errorDetail(response), retryAfter, status: response.status };
    }
    if (RETRIED_STATUSES.includes(response.status)) {
      const delay = retryDelay(response.headers.get("Retry-After"));
      setStatus(`Waiting ${delay} s before continuing.`);
      await pause(delay);
      if (signal.aborted) return null;
      setStatus(step);
      response = await fetch(url, { ...options, signal });
    }
    if (!response.ok) return { reason: await errorDetail(response) };
    const body = await response.json();
    return valid(body) ? { body } : { reason: UNEXPECTED };
  } catch (err) {
    if (signal.aborted) return null;
    // fetch and body reads reject with TypeError when the network fails.
    if (err instanceof TypeError) return { reason: UNREACHABLE };
    if (err instanceof SyntaxError) return { reason: UNEXPECTED };
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
  const parsed = data === null ? null : parseExample(data);
  if (parsed === null) {
    setStatus(EXAMPLE_FAILED);
    return;
  }
  shown = { ra: data.ra_deg, dec: data.dec_deg };
  example = { ra: data.ra_deg, dec: data.dec_deg, detector: data.detector };
  frames = parsed.frames.map((f, i) => ({
    ...f, dates: data.frames[i].label, nFields: [f.nUsed],
  }));
  stretch = computeStretch(frames.map(centrePixels));
  slider.max = String(frames.length - 1);
  markerControl.hidden = frames[0].marker === undefined;
  showTarget(parsed.name, parsed.position, parsed.hint);
  enablePlayer(true);
  differenceToggle.disabled = frames.length < 2;
  show(0);
}

function sentence(text) {
  return text.endsWith(".") ? text : `${text}.`;
}

/** Status text for the loaded frames of a search, counting the central field's exposures. */
function summarise(searched, used, failed, reason) {
  return joinStatus(
    `${plural(frames.length, "frame")} from ${used} of `
      + `${plural(searched.n_exposures, "exposure")}.`,
    capNotice(searched),
    failed > 0 ? sentence(`${plural(failed, "frame")} could not be loaded: ${reason}`) : "",
    noDataNote(frames.map((f) => ({ pixels: centrePixels(f) }))),
  );
}

/** Asks for one frame of the 59 grid; returns {body}, {reason} or null if aborted. */
function requestNarrow(searched, uris, signal, step) {
  return request("api/frame", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ra_deg: searched.ra_deg, dec_deg: searched.dec_deg, uris }),
  }, signal, validFrameBody, step);
}

/** A loaded frame of the 59 grid from its api/frame answer and its planned frame. */
function narrowFrame(result, planned) {
  return {
    pixels: result.pixels,
    width: result.width,
    height: result.height,
    dates: planned.label,
    nUsed: result.n_used,
    nFields: [result.n_used],
    uris: planned.uris,
  };
}

/** Asks for one frame of the wide grid; returns {result, pixels}, {reason} or null if aborted. */
async function requestWide(searched, uris, signal, step) {
  const outcome = await request("api/frame", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ra_deg: searched.ra_deg, dec_deg: searched.dec_deg, uris, fields: 3 }),
  }, signal, validWideBody, step);
  if (outcome === null || outcome.reason !== undefined) return outcome;
  const pixels = decodePixels(outcome.body.pixels_b64, WIDE_PIXELS * WIDE_PIXELS);
  return pixels === null ? { reason: UNEXPECTED } : { result: outcome.body, pixels };
}

async function loadFrames(signal) {
  const notice = capNotice(plan);
  const n = plan.frames.length;
  let used = 0;
  let failed = 0;
  let reason = "";
  for (const [i, planned] of plan.frames.entries()) {
    const step = joinStatus(`Loading frame ${i + 1} of ${n}…`, notice);
    setStatus(step);
    const outcome = await requestNarrow(plan, planned.uris, signal, step);
    if (outcome === null || signal.aborted) return;
    if (outcome.reason !== undefined) {
      failed += 1;
      reason = outcome.reason;
      continue;
    }
    const frame = narrowFrame(outcome.body, planned);
    // The visitor may already have moved or zoomed out onto the wide grid.
    frames.push(grid === WIDE_PIXELS ? widenFrame(frame) : frame);
    used += frame.nUsed;
    stretch = computeStretch(frames.map(centrePixels));
    slider.max = String(frames.length - 1);
    if (frames.length === 1) enablePlayer(true);
    if (frames.length === 2) differenceToggle.disabled = false;
    show(frames.length === 1 ? 0 : current);
  }
  loading = false;
  if (frames.length === 0) {
    setStatus(sentence(`No frame could be loaded: ${reason}`));
    return;
  }
  summary = summarise(plan, used, failed, reason);
  setStatus(summary);
  applyView();
  if (grid === WIDE_PIXELS || shouldPreload(plan)) loadSurround(signal);
}

/**
 * Puts the shown frames on the wide grid with the view and the picture in place; the fields
 * around the centre are drawn as not loaded until their pixels arrive.
 */
function widen() {
  frames = frames.map(widenFrame);
  grid = WIDE_PIXELS;
  surroundLoaded = false;
  view = { ...view, cx: view.cx + FIELD_PIXELS, cy: view.cy + FIELD_PIXELS };
  canvas.width = grid;
  canvas.height = grid;
  show(current);
}

/** Loads what the wide grid lacks: the search's surround, or the example's live search. */
function loadAround() {
  if (plan !== null) loadSurround(controller.signal);
  else loadExampleArea(controller.signal);
}

/** Widens the grid at once and starts loading it, unless something else is loading. */
function expand() {
  widen();
  // A search still loading its frames starts the surround once they are in.
  if (!loading) loadAround();
}

/**
 * Loads the eight fields around the shown frames, one wide frame per loaded frame, and swaps
 * them in at once with the picture on screen unchanged; on any failure the fields stay not
 * loaded.
 */
async function loadSurround(signal) {
  if (grid === FIELD_PIXELS) widen();
  loading = true;
  applyView();
  const wide = [];
  for (const [i, frame] of frames.entries()) {
    const step = joinStatus(summary,
      `Loading the surrounding area: frame ${i + 1} of ${frames.length}…`);
    setStatus(step);
    const outcome = await requestWide(plan, frame.uris, signal, step);
    if (outcome === null || signal.aborted) return;
    if (outcome.reason !== undefined) {
      loading = false;
      setStatus(joinStatus(summary,
        sentence(`The surrounding area could not be loaded: ${outcome.reason}`)));
      applyView();
      return;
    }
    wide.push(outcome);
  }
  frames = frames.map((frame, i) => ({
    ...frame, pixels: wide[i].pixels, nFields: wide[i].result.n_fields,
  }));
  surroundLoaded = true;
  loading = false;
  setStatus(summary);
  show(current);
}

/**
 * Replaces the bundled example by a search at its position and detector, as if the visitor
 * had searched there: one search, its frames, then their surround. The example keeps showing
 * and playing, the sky in place, until the search's frames are in; on a failure it stays.
 */
async function loadExampleArea(signal) {
  loading = true;
  applyView();
  const fail = (text) => {
    loading = false;
    setStatus(text);
    applyView();
  };
  const failed = (reason) => sentence(`The surroundings of the example could not be loaded `
    + `from the archive: ${reason}`);
  const texts = fieldTexts(example.ra, example.dec);
  let step = "Searching the SPHEREx archive for the example's surroundings…";
  setStatus(step);
  const query = new URLSearchParams({ ra: texts.ra, dec: texts.dec, detector: example.detector });
  const outcome = await request("api/search?" + query, {}, signal, validPlan, step);
  if (outcome === null || signal.aborted) return;
  if (outcome.reason !== undefined) {
    fail(failed(outcome.reason));
    return;
  }
  const searched = outcome.body;
  if (searched.frames.length === 0) {
    fail(`No SPHEREx exposures cover the example's surroundings in ${searched.detector}.`);
    return;
  }
  const loaded = [];
  let used = 0;
  let lost = 0;
  let reason = "";
  for (const [i, planned] of searched.frames.entries()) {
    step = `Loading the example's surroundings: frame ${i + 1} of ${searched.frames.length}…`;
    setStatus(step);
    const answer = await requestNarrow(searched, planned.uris, signal, step);
    if (answer === null || signal.aborted) return;
    if (answer.reason !== undefined) {
      lost += 1;
      reason = answer.reason;
      continue;
    }
    loaded.push(widenFrame(narrowFrame(answer.body, planned)));
    used += answer.body.n_used;
  }
  if (loaded.length === 0) {
    fail(failed(reason));
    return;
  }
  frames = loaded;
  plan = searched;
  example = null;
  stretch = computeStretch(frames.map(centrePixels));
  current = Math.min(current, frames.length - 1);
  slider.max = String(frames.length - 1);
  if (frames.length < 2) differenceToggle.checked = false;
  differenceToggle.disabled = frames.length < 2;
  markerControl.hidden = true;
  positionLine.textContent = formatPosition(searched.ra_deg, searched.dec_deg, searched.detector);
  shown = { ra: searched.ra_deg, dec: searched.dec_deg };
  if (![raInput, decInput, detectorSelect].includes(document.activeElement)) {
    raInput.value = texts.ra;
    decInput.value = texts.dec;
    detectorSelect.value = searched.detector;
  }
  history.replaceState(null, "", linkQuery(texts.ra, texts.dec, searched.detector));
  loading = false;
  summary = summarise(searched, used, lost, reason);
  setStatus(summary);
  show(current);
  loadSurround(signal);
}

/**
 * Searches the area `shift` whole fields away ({dx, dy}: right = west, down = south) and
 * loads its wide frames; the frames shown stay on screen and keep playing meanwhile. With
 * `early` it is a preload: answered 429 or 503, it waits for the server's delay and tries again
 * by itself; once loaded it joins on as soon as the view lies inside it. Otherwise (the view
 * rests at the edge) it joins on at once.
 */
async function loadNextArea(shift, early, signal) {
  loading = true;
  ahead = null;
  applyView();
  const fail = (text) => {
    loading = false;
    if (early) aheadFailed = shift;
    setStatus(text);
    applyView();
  };
  const centre = offsetPosition(plan.ra_deg, plan.dec_deg,
    FIELD_PIXELS * shift.dx, FIELD_PIXELS * shift.dy);
  const texts = fieldTexts(centre.ra, centre.dec);
  let step = "Searching the next area…";
  setStatus(step);
  const query = new URLSearchParams({ ra: texts.ra, dec: texts.dec, detector: plan.detector });
  const outcome = await request("api/search?" + query, {}, signal, validPlan, step, !early);
  if (outcome === null || signal.aborted) return;
  if (outcome.retryAfter !== undefined) {
    loading = false;
    pauseAhead(outcome.retryAfter, outcome.status === 429);
    return;
  }
  if (outcome.reason !== undefined) {
    fail(sentence(`The next area could not be loaded: ${outcome.reason}`));
    return;
  }
  const next = outcome.body;
  if (next.frames.length === 0) {
    fail(`No SPHEREx exposures cover the next area in ${next.detector}.`);
    return;
  }
  const loaded = [];
  let used = 0;
  let failed = 0;
  let reason = "";
  for (const [i, planned] of next.frames.entries()) {
    step = `Loading the next area: frame ${i + 1} of ${next.frames.length}…`;
    setStatus(step);
    const answer = await requestWide(next, planned.uris, signal, step);
    if (answer === null || signal.aborted) return;
    if (answer.reason !== undefined) {
      failed += 1;
      reason = answer.reason;
      continue;
    }
    loaded.push({
      pixels: answer.pixels, width: WIDE_PIXELS, height: WIDE_PIXELS, dates: planned.label,
      nUsed: answer.result.n_used, nFields: answer.result.n_fields, uris: planned.uris,
    });
    used += answer.result.n_used;
  }
  if (loaded.length === 0) {
    fail(sentence(`The next area could not be loaded: ${reason}`));
    return;
  }
  loading = false;
  const area = { shift, plan: next, frames: loaded, texts, used, failed, reason };
  if (!early) {
    join(area);
    return;
  }
  ahead = area;
  setStatus(summary);
  applyView();
  joinAhead();
}

/**
 * Replaces the frames by those of a loaded next area with the sky under the view in place
 * (the view clamped into the area), and makes the link and RA/Dec fields name its centre.
 */
function join(area) {
  const { shift, texts } = area;
  const next = area.plan;
  ahead = null;
  aheadFailed = null;
  frames = area.frames;
  plan = next;
  stretch = computeStretch(frames.map(centrePixels));
  view = clampView({
    zoom: view.zoom, cx: view.cx - FIELD_PIXELS * shift.dx, cy: view.cy - FIELD_PIXELS * shift.dy,
  }, grid);
  current = Math.min(current, frames.length - 1);
  slider.max = String(frames.length - 1);
  if (frames.length < 2) differenceToggle.checked = false;
  differenceToggle.disabled = frames.length < 2;
  showTarget(`RA ${texts.ra}, Dec ${texts.dec}`,
    formatPosition(next.ra_deg, next.dec_deg, next.detector), "");
  shown = { ra: next.ra_deg, dec: next.dec_deg };
  if (document.activeElement !== raInput && document.activeElement !== decInput) {
    raInput.value = texts.ra;
    decInput.value = texts.dec;
  }
  history.replaceState(null, "", linkQuery(texts.ra, texts.dec, next.detector));
  summary = summarise(next, area.used, area.failed, area.reason);
  setStatus(summary);
  show(current);
}

/** Joins the preloaded area on once the view lies entirely inside it. */
function joinAhead() {
  if (ahead !== null && shiftedView(view, grid, ahead.shift) !== null) join(ahead);
}

/**
 * Starts loading ahead after an arrow press moved the view by (mx, my), when the view nears
 * an edge of the loaded area and nothing else loads (one preload at a time; none in deep
 * fields, none after a failure in the same direction, none before the search limit allows).
 */
function considerAhead(mx, my) {
  lastMove = [mx, my];
  if (loading || plan === null || !surroundLoaded || !shouldPreload(plan) || !sky.hidden
    || Date.now() < aheadPausedUntil) return;
  const shift = aheadShift(view, grid, mx, my);
  if (shift === null || (shift.dx === 0 && shift.dy === 0)) return;
  const same = (other) => other !== null && other.dx === shift.dx && other.dy === shift.dy;
  if (same(ahead?.shift ?? null) || same(aheadFailed)) return;
  loadNextArea(shift, true, controller.signal);
}

/**
 * Says once that the search limit is reached (or the server is busy) and tries again, by
 * itself, after the server's delay.
 */
function pauseAhead(seconds, limited) {
  aheadPausedUntil = Date.now() + seconds * 1000;
  const cause = limited ? "The search limit is reached" : "The server is busy";
  setStatus(joinStatus(summary, `${cause}; loading further on continues in ${seconds} s.`));
  applyView();
  clearTimeout(aheadTimer);
  aheadTimer = setTimeout(() => {
    aheadPausedUntil = 0;
    if (!loading) setStatus(summary);
    considerAhead(...lastMove);
  }, seconds * 1000);
}

/**
 * Zooms the view one level in (+1) or out (-1). Zooming out of the 6' field widens the grid
 * at once and starts loading it; a zoom-out press (not a held key) while the surround is
 * missing tries again.
 */
function zoom(direction, repeated = false) {
  if (direction < 0 && atLowestZoom() && widenable()) expand();
  else if (direction < 0 && !repeated && retryable()) loadAround();
  view = clampView({ ...view, zoom: zoomStep(view.zoom, direction, grid) }, grid);
  applyView();
  joinAhead();
}

/**
 * Moves the view one step. Leaving the 6' field widens the grid at once and starts loading
 * it; nearing the wide grid's edge loads the area further on ahead; pushing at the edge until
 * the key has rested loads the missing surround again or, if none was loaded ahead, the next
 * area.
 */
function move(dx, dy) {
  clearTimeout(restTimer);
  let step = panStep(view, dx, dy, grid);
  if (step.pushed && widenable()) {
    expand();
    step = panStep(view, dx, dy, grid);
  }
  if (!step.pushed) {
    view = step.view;
    applyView();
    joinAhead();
    considerAhead(dx, dy);
    return;
  }
  restTimer = setTimeout(() => {
    if (loading || !sky.hidden || frames.length === 0 || Date.now() < aheadPausedUntil) return;
    if (retryable()) loadAround();
    else if (plan !== null && grid === WIDE_PIXELS) {
      loadNextArea({ dx, dy }, false, controller.signal);
    }
  }, REST_MS);
}

async function search(ra, dec, detector) {
  closeMap();
  if (controller) controller.abort();
  controller = new AbortController();
  const { signal } = controller;
  reset();
  loading = true;
  showTarget(`RA ${ra.trim()}, Dec ${dec.trim()}`, "", "");
  const step = "Searching the SPHEREx archive…";
  setStatus(step);
  const outcome = await request("api/search?" + new URLSearchParams({ ra, dec, detector }), {},
    signal, validPlan, step);
  if (outcome === null || signal.aborted) return;
  if (outcome.reason !== undefined) {
    loading = false;
    setStatus(`Error: ${outcome.reason}`);
    return;
  }
  plan = outcome.body;
  // The search is accepted: leave the coordinate field so that the arrow keys look around.
  if (document.activeElement === raInput || document.activeElement === decInput) {
    submitButton.focus({ preventScroll: true });
  }
  shown = { ra: plan.ra_deg, dec: plan.dec_deg };
  positionLine.textContent = formatPosition(plan.ra_deg, plan.dec_deg, plan.detector);
  if (plan.frames.length === 0) {
    loading = false;
    setStatus(`No SPHEREx exposures cover this position in ${plan.detector}.`);
    return;
  }
  await loadFrames(signal);
}

/**
 * Loads Aladin Lite and checks that the sky survey answers.
 * Returns the Aladin namespace, or null when either failed; errors of other kinds propagate.
 */
async function loadAladin() {
  const [aladin, survey] = await Promise.all([
    import(ALADIN_URL).then(async (module) => {
      await module.default.init;
      return module.default;
    }).catch(() => null),
    fetch(`${SKY_SURVEY}/properties`).then((response) => response.ok).catch((err) => {
      if (err instanceof TypeError) return false;
      throw err;
    }),
  ]);
  return survey ? aladin : null;
}

function createMap(A, view) {
  // Only the survey given here, no default survey list, start-up logging, SAMP or name
  // resolver: nothing is fetched from CDS. (Aladin falls back to a CDS survey if the given one
  // fails to load, which is why loadAladin checks it first.)
  const survey = A.HiPS(SKY_SURVEY, { name: "2MASS colour" });
  const aladin = A.aladin(skyMap, {
    survey, hipsList: [], target: `${view.ra} ${view.dec}`, fov: view.fov, cooFrame: "ICRS",
    projection: "AIT", mode: "dark", log: false, samp: false, showReticle: false,
    showZoomControl: true, showLayersControl: false, showFullscreenControl: false,
    showSimbadPointerControl: false, showCooGridControl: false, showSettingsControl: false,
    showColorPickerControl: false, showShareControl: false, showProjectionControl: false,
    showFrame: false, showFov: false, showCooLocation: false, showStatusBar: false,
    showContextMenu: false,
  });
  aladin.setFoVRange(MAP_MIN_FOV_DEG, MAP_MAX_FOV_DEG);
  // Aladin recolours objects it considers clicked or hovered; keep the selection one colour.
  const colors = { color: SELECTION_COLOR, selectionColor: SELECTION_COLOR,
    hoverColor: SELECTION_COLOR };
  const field = A.graphicOverlay({ ...colors, lineWidth: 2 });
  aladin.addOverlay(field);
  const centre = A.catalog({ ...colors, shape: "cross", sourceSize: 14 });
  aladin.addCatalog(centre);
  return { A, aladin, field, centre };
}

function clearSelection() {
  selection = null;
  skySearch.disabled = true;
  skySelection.textContent = MAP_HINT;
  map.field.removeAll();
  map.centre.removeAll();
}

function select(raDeg, decDeg) {
  selection = fieldTexts(raDeg, decDeg);
  map.field.removeAll();
  map.field.add(map.A.polygon(fieldCorners(raDeg, decDeg)));
  map.centre.removeAll();
  map.centre.addSources([map.A.source(raDeg, decDeg)]);
  skySelection.textContent = `RA ${selection.ra}\u00b0, Dec ${selection.dec}\u00b0`;
  skySearch.disabled = false;
}

function showMap(open) {
  sky.hidden = !open;
  document.body.classList.toggle("picking", open);
  pickButton.disabled = open;
  pickButton.setAttribute("aria-expanded", String(open));
}

function closeMap() {
  if (!sky.hidden) showMap(false);
}

async function openMap() {
  showMap(true);
  sky.scrollIntoView({ block: "nearest" });
  const view = shown === null ? MAP_FALLBACK : { ...shown, fov: MAP_FOV_DEG };
  if (map === null) {
    skySearch.disabled = true;
    skySelection.textContent = "Loading the sky map\u2026";
    mapLoading ??= loadAladin();
    const A = await mapLoading;
    if (A === null) {
      mapLoading = null;
      showMap(false);
      setStatus(MAP_FAILED);
      return;
    }
    if (sky.hidden) return;
    if (statusLine.textContent === MAP_FAILED) setStatus("");
    map ??= createMap(A, view);
  } else {
    map.aladin.gotoRaDec(view.ra, view.dec);
    map.aladin.setFoV(view.fov);
  }
  clearSelection();
}

// A press and release on the map's sky (not on its zoom buttons) that hardly moved selects;
// a drag pans; a second finger (pinch zoom) cancels the selection.
let press = null;

skyMap.addEventListener("pointerdown", (event) => {
  press = event.isPrimary && event.button === 0 && event.target instanceof HTMLCanvasElement
    ? { x: event.clientX, y: event.clientY }
    : null;
}, true);

skyMap.addEventListener("pointercancel", () => {
  press = null;
}, true);

skyMap.addEventListener("pointerup", (event) => {
  const start = press;
  press = null;
  if (start === null || !event.isPrimary || map === null) return;
  const release = { x: event.clientX, y: event.clientY };
  if (!isClick(start, release)) return;
  const rect = skyMap.getBoundingClientRect();
  const x = release.x - rect.left;
  const y = release.y - rect.top;
  const { aladin } = map;
  let position;
  try {
    position = aladin.pix2world(x, y, "ICRS");
  } catch (err) {
    // Aladin 3.8.2 throws this TypeError for a point off the sky (outside the projection).
    if (err instanceof TypeError) return;
    throw err;
  }
  const [ra, dec] = position;
  if (Number.isFinite(ra) && Number.isFinite(dec)) select(ra, dec);
}, true);

pickButton.addEventListener("click", () => {
  openMap();
});

skyClose.addEventListener("click", () => {
  closeMap();
  pickButton.focus();
});

skySearch.addEventListener("click", () => {
  raInput.value = selection.ra;
  decInput.value = selection.dec;
  history.replaceState(null, "", linkQuery(raInput.value, decInput.value, detectorSelect.value));
  search(raInput.value, decInput.value, detectorSelect.value);
  // The map, and this button in it, are now hidden; the keys act from where the map was opened.
  pickButton.focus({ preventScroll: true });
});

form.addEventListener("submit", (event) => {
  event.preventDefault();
  history.replaceState(null, "", linkQuery(raInput.value, decInput.value, detectorSelect.value));
  search(raInput.value, decInput.value, detectorSelect.value);
});

slider.addEventListener("input", () => {
  stopPlayback();
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

differenceToggle.addEventListener("change", () => {
  if (frames.length > 0) show(current);
});

zoomInButton.addEventListener("click", () => zoom(1));
zoomOutButton.addEventListener("click", () => zoom(-1));

// Zoom and arrow keys act on the page, buttons and checkboxes, never while typing, choosing a
// detector, stepping the timeline or using the sky map.
document.addEventListener("keydown", (event) => {
  if (frames.length === 0 || !sky.hidden || event.ctrlKey || event.altKey || event.metaKey
    || event.defaultPrevented) return;
  const target = event.target;
  if (target instanceof HTMLElement && (target.isContentEditable || target.closest(
    "input:not([type=checkbox]), select, textarea, #sky") !== null)) return;
  if (event.key === "+" || event.key === "=") zoom(1);
  else if (event.key === "-") zoom(-1, event.repeat);
  else if (event.key in ARROWS) move(...ARROWS[event.key]);
  else return;
  event.preventDefault();
});

const detectors = Array.from(detectorSelect.options, (option) => option.value);
const link = parseLink(location.search, detectors, detectorSelect.value);
if (link === null) {
  controller = new AbortController();
  loadExample(controller.signal);
} else {
  raInput.value = link.ra;
  decInput.value = link.dec;
  detectorSelect.value = link.detector;
  search(link.ra, link.dec, link.detector);
}
