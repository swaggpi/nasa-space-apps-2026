import { after, afterEach, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  computeStretch, difference, fieldTexts, formatPosition, offsetPosition, stageBox,
  toDifferenceRGBA, toRGBA,
} from "../../src/spherex_viewer/static/lib.js";

const { chromium } = createRequire(import.meta.url)("playwright");

const REPO = resolve(fileURLToPath(import.meta.url), "../../..");
const SIZE = 59;
const WIDE = 3 * SIZE;
// Every element of the body as parent>tag#id, in document order: the complete UI.
const BODY = [
  "body>main#viewer",
  "main>section#player",
  "section>div#frame", "div>div#stage", "div>canvas#image", "div>div#marker",
  "section>div#controls",
  "div>button#prev", "div>button#play", "div>button#next", "div>input#slider",
  "div>button#zoom-out", "div>button#zoom-in",
  "section>p#date",
  "section>div#sky", "div>div#sky-view", "div>div#sky-map", "div>p#sky-credit",
  "div>div#sky-bar", "div>p#sky-selection", "div>button#sky-search", "div>button#sky-close",
  "main>aside#panel",
  "aside>h1#name",
  "aside>p#position",
  "aside>p#hint",
  "aside>label#marker-control", "label>input#show-marker",
  "aside>label#difference-control", "label>input#difference",
  "aside>button#pick",
  "aside>form#search",
  "form>label", "label>input#ra",
  "form>label", "label>input#dec",
  "form>label", "label>select#detector",
  ...Array(6).fill("select>option"),
  "form>button#submit",
  "aside>p#status",
  "body>footer#ack",
];
const ACK = "This publication makes use of data products from the Spectro-Photometer for the "
  + "History of the Universe, Epoch of Reionization and Ices Explorer (SPHEREx), which is a "
  + "joint project of the Jet Propulsion Laboratory and the California Institute of "
  + "Technology, and is funded by the National Aeronautics and Space Administration.";
const RA = "08h55m10.831s";
const DEC = "-7d14m42.53s";
const TIMEOUT = 30_000;
const SKY_SURVEY = "https://irsa.ipac.caltech.edu/data/hips/CDS/2MASS/Color";
// The keys Aladin needs from the survey's properties file, values as served by IRSA.
const SKY_PROPERTIES = [
  "creator_did = ivo://CDS/P/2MASS/color", "obs_title = 2MASS color J, H, K",
  "dataproduct_type = image", "hips_frame = equatorial", "hips_order = 9",
  "hips_order_min = 0", "hips_tile_width = 512", "hips_tile_format = jpeg",
].join("\n");
const MAP_HINT = "Click the map to select a position.";
const MAP_FAILED = "The sky map could not be loaded; enter coordinates to search.";
// The server's grid (src/spherex_viewer/grid.py): 59 pixels of 6.15 arcseconds per side.
const FIELD_ARCSEC = 59 * 6.15;
const IMAGE_LABEL = "SPHEREx image of the selected frame, north up, east left";
const DIFFERENCE_LABEL =
  "Difference between the selected frame and the other frames, north up, east left";
const INVALID_RA =
  "Invalid RA: use degrees from 0 to 360 or sexagesimal hours such as 08h55m10.831s.";

let server;
let cacheDir;
let baseUrl;
let browser;
let context;
// A grey 512x512 JPEG with scattered stars, served for every stub sky tile.
let skyTile;

function freePort() {
  return new Promise((ok, fail) => {
    const probe = createServer();
    probe.once("error", fail);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => ok(port));
    });
  });
}

async function waitForHealth(url, child, output) {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`server exited early:\n${output.join("")}`);
    try {
      const response = await fetch(url);
      if (response.status === 200) return;
    } catch {
      // not listening yet
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`server did not answer /healthz within 60 s:\n${output.join("")}`);
}

function stopServer(child) {
  if (!child || child.exitCode !== null) return Promise.resolve();
  return new Promise((ok) => {
    const kill = setTimeout(() => child.kill("SIGKILL"), 10_000);
    child.once("exit", () => {
      clearTimeout(kill);
      ok();
    });
    child.kill("SIGTERM");
  });
}

function deferred() {
  let release;
  const promise = new Promise((r) => { release = r; });
  return { promise, release };
}

function pixels(seed) {
  return Array.from({ length: SIZE * SIZE },
    (_, i) => (i === 1770 ? null : ((i * 7 + seed * 13) % 50) / 100));
}

function makePlan(frames, { detector = "D2", cap = 24 } = {}) {
  const planFrames = frames.map((f, index) => ({
    label: f.label,
    n_available: f.n_available,
    n_used: f.n_used,
    capped: f.n_used < f.n_available,
    uris: Array.from({ length: f.n_used },
      (_, j) => `ibe/data/spherex/dr1/level2/2025W19_1B/f${index}_${j}_1D2_spx.fits`),
  }));
  return {
    ra_deg: 133.795129, dec_deg: -7.245147, detector,
    n_exposures: frames.reduce((sum, f) => sum + f.n_available, 0),
    cap,
    capped: planFrames.some((f) => f.capped),
    frames: planFrames,
  };
}

const THREE_FRAMES = [
  { label: "2025-05-06", n_available: 8, n_used: 8 },
  { label: "2025-11-07 \u2013 2025-11-10", n_available: 19, n_used: 19 },
  { label: "2026-04-20", n_available: 15, n_used: 15 },
];

// The stub example: a bright 3x3 star moving across a textured background, with markers.
const EXAMPLE_MARKERS = [{ x: 20, y: 30 }, { x: 26.4, y: 27 }, { x: 33, y: 24.5 }];
const EXAMPLE_DATES = ["2025-04-28 \u2013 2025-05-02", "2025-10-20", "2026-04-27 \u2013 2026-04-30"];
const EXAMPLE_USED = [12, 1, 7];
const EXAMPLE_LABELS = [
  "2025-04-28 \u2013 2025-05-02 \u00b7 12 exposures",
  "2025-10-20 \u00b7 1 exposure",
  "2026-04-27 \u2013 2026-04-30 \u00b7 7 exposures",
];
const EXAMPLE_FAILED = "The example could not be loaded; enter coordinates to search.";
const NO_DATA = "Blue-grey pixels have no usable data.";
const UNEXPECTED = "the server sent an unexpected answer";

function starPixels(marker, seed) {
  const cx = Math.round(marker.x);
  const cy = Math.round(marker.y);
  return Array.from({ length: SIZE * SIZE }, (_, i) => {
    const x = i % SIZE;
    const y = Math.floor(i / SIZE);
    if (i === 100 + seed) return null;
    if (Math.abs(x - cx) <= 1 && Math.abs(y - cy) <= 1) return 8;
    return ((i * 7 + seed * 13) % 50) / 100;
  });
}

const EXAMPLE = {
  name: "Test Star",
  hint: "Watch the ringed star move to the upper right.",
  ra_deg: 269.4462683,
  dec_deg: 4.7682045,
  detector: "D6",
  width: SIZE,
  height: SIZE,
  frames: EXAMPLE_MARKERS.map((marker, i) => ({
    label: EXAMPLE_DATES[i], n_used: EXAMPLE_USED[i], pixels: starPixels(marker, i), marker,
  })),
};

/** RGBA bytes the page must draw for example frame n (one stretch over all example frames). */
function exampleRGBA(n) {
  const stretch = computeStretch(EXAMPLE.frames.map((f) => f.pixels));
  return Array.from(toRGBA(EXAMPLE.frames[n].pixels, stretch));
}

const MUTED = "rgb(156, 163, 175)"; // --muted, #9ca3af

/** Text colour and cursor of the Difference label, which must look inactive while disabled. */
function differenceLook(page) {
  return page.$eval("#difference-control", (el) => {
    const style = getComputedStyle(el);
    return [style.color, style.cursor];
  });
}

/** RGBA bytes of frame n drawn as its difference from the others, on their common stretch. */
function differenceRGBA(frames, n) {
  const stretch = computeStretch(frames.map((f) => f.pixels));
  return Array.from(toDifferenceRGBA(difference(frames, n), stretch));
}

const EXAMPLE_FRAMES = EXAMPLE.frames.map((f) => ({
  pixels: f.pixels, width: SIZE, height: SIZE, nUsed: f.n_used,
}));

const exampleOk = () => ({ status: 200, body: EXAMPLE });

/**
 * Stub sky survey: its properties file and one image for every tile; no coverage map
 * (Moc.fits) and no all-sky preview (Allsky.jpg, a mosaic of a different size).
 */
function skyOk(url) {
  if (url.endsWith("/properties")) return { status: 200, raw: SKY_PROPERTIES };
  if (/\/Npix\d+\.jpg$/.test(url)) return { status: 200, jpeg: skyTile };
  return { status: 404, raw: "Not Found" };
}

/** Base64 of little-endian float32 values; null becomes NaN (no data). */
function float32Base64(values) {
  return Buffer.from(new Float32Array(values.map((v) => v ?? NaN)).buffer).toString("base64");
}

/**
 * Wide-grid pixels: `narrow` (59x59) at the centre and `around(x, y)` in the eight fields
 * around it, x and y in wide-grid pixels.
 */
function widePixels(narrow, around) {
  return Array.from({ length: WIDE * WIDE }, (_, i) => {
    const x = i % WIDE;
    const y = Math.floor(i / WIDE);
    const inside = x >= SIZE && x < 2 * SIZE && y >= SIZE && y < 2 * SIZE;
    return inside ? narrow[(y - SIZE) * SIZE + x - SIZE] : around(x, y);
  });
}

/** A wide frame answer; `nFields` defaults to `nUsed` in every field. */
function wideBody(values, nUsed, nFields = Array(9).fill(nUsed)) {
  return {
    status: 200,
    body: { width: WIDE, height: WIDE, pixels_b64: float32Base64(values), n_used: nUsed,
      n_fields: nFields },
  };
}

/**
 * The default wide answer: the narrow answer served for the same exposures at the centre and
 * no data around it, so that the 6' field looks and compares exactly as before.
 */
function wideAsServed(n, payload, served) {
  const narrow = served.get(payload.uris.join());
  return wideBody(widePixels(narrow.pixels, () => null), narrow.n_used,
    [0, 0, 0, 0, narrow.n_used, 0, 0, 0, 0]);
}

/**
 * Opens the page at `query` with `example.json`, `api/search`, `api/frame` and the sky survey
 * stubbed. `example()`, `search(url)`, `frame(n, body)` (n counts frame requests, body is the
 * parsed request), `wide(n, body, served)` (the same for requests with `fields: 3`, logged in
 * `log.wides`; `served` maps the joined URIs to the last narrow answer body) and `sky(url)`
 * return {status, body, headers} (body JSON-encoded unless `raw` or `jpeg` is given, headers
 * optional) or {abort: true}; `search: null` sends searches to the real server; any other
 * foreign request is aborted and logged. `aladin` false fails the request for the map script.
 * Unless `wait` is false, returns once a frame, the example's failure or a status is shown.
 */
async function openPage({
  search = unusedSearch, frame = () => ({ status: 200, body: {} }), wide = wideAsServed,
  example = exampleOk, sky = skyOk, aladin = true, wait = true, query = "",
}) {
  const origin = new URL(baseUrl).origin;
  const log = {
    requests: [], foreign: [], sky: [], scripts: [], searches: [], frames: [], unexpectedApi: [],
    errors: [], examples: [], frameTimes: [], inFlight: 0, maxInFlight: 0, wides: [],
  };
  const served = new Map();
  const page = await context.newPage();
  page.on("request", (request) => log.requests.push(request.url()));
  page.on("pageerror", (error) => log.errors.push(String(error)));
  page.on("dialog", (dialog) => {
    log.errors.push(`dialog: ${dialog.message()}`);
    dialog.dismiss();
  });
  const reply = (route, { status, body, raw, jpeg, abort, headers }) => {
    if (abort) return route.abort("connectionfailed");
    if (jpeg !== undefined) {
      return route.fulfill({
        status, contentType: "image/jpeg", body: jpeg,
        headers: { "Access-Control-Allow-Origin": "*" },
      });
    }
    return route.fulfill({
      status,
      contentType: raw === undefined ? "application/json" : "text/plain",
      body: raw ?? JSON.stringify(body),
      headers: { "Access-Control-Allow-Origin": "*", ...headers },
    });
  };
  await page.route(() => true, async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (request.url().startsWith(`${SKY_SURVEY}/`)) {
      log.sky.push(request.url());
      return reply(route, await sky(request.url()));
    }
    if (url.origin !== origin) {
      log.foreign.push(request.url());
      return route.abort();
    }
    if (url.pathname === "/example.json" && request.method() === "GET") {
      log.examples.push(request.url());
      // A search may abort the example request while the stub is still waiting.
      return reply(route, await example()).catch(() => {});
    }
    if (url.pathname === "/api/search" && request.method() === "GET") {
      log.searches.push(url);
      if (search === null) return route.continue();
      return reply(route, await search(url));
    }
    if (url.pathname === "/api/frame" && request.method() === "POST"
      && JSON.parse(request.postData()).fields === 3) {
      const payload = JSON.parse(request.postData());
      log.wides.push(payload);
      return reply(route, await wide(log.wides.length - 1, payload, served));
    }
    if (url.pathname === "/api/frame" && request.method() === "POST") {
      const n = log.frames.length;
      const payload = JSON.parse(request.postData());
      log.frames.push(payload);
      const times = { sent: Date.now(), answered: null };
      log.frameTimes.push(times);
      log.inFlight += 1;
      log.maxInFlight = Math.max(log.maxInFlight, log.inFlight);
      try {
        const answer = await frame(n, payload);
        if (answer.status === 200 && Array.isArray(answer.body?.pixels)) {
          served.set(payload.uris.join(), answer.body);
        }
        return await reply(route, answer);
      } finally {
        times.answered = Date.now();
        log.inFlight -= 1;
      }
    }
    if (url.pathname.startsWith("/api/")) {
      log.unexpectedApi.push(request.url());
      return reply(route, { status: 404, body: { detail: "stub" } });
    }
    if (url.pathname.startsWith("/vendor/")) {
      log.scripts.push(request.url());
      if (!aladin) return route.abort("connectionfailed");
    }
    return route.continue();
  });
  await page.goto(new URL(query, baseUrl).href);
  if (wait) {
    await page.waitForFunction(() => document.querySelector("#date").textContent !== ""
      || document.querySelector("#status").textContent !== "");
  }
  return { page, log };
}

function frameBody(values, nUsed) {
  return { status: 200, body: { width: SIZE, height: SIZE, pixels: values, n_used: nUsed } };
}

function frameOk(plan) {
  return (n) => frameBody(pixels(n), plan.frames[n].n_used);
}

/** Index in `plan` of the frame a request asks for. */
function planIndex(plan, payload) {
  return plan.frames.findIndex((f) => f.uris.join() === payload.uris.join());
}

/** Indices in `plan` of every frame request, in the order sent. */
function requestedFrames(plan, log) {
  return log.frames.map((payload) => planIndex(plan, payload));
}

async function submit(page, { ra = RA, dec = DEC, detector = "D2" } = {}) {
  await page.fill("#ra", ra);
  await page.fill("#dec", dec);
  await page.selectOption("#detector", detector);
  await page.click("#submit");
}

const statusText = (page) => page.$eval("#status", (el) => el.textContent);
const dateText = (page) => page.$eval("#date", (el) => el.textContent.trim());
const text = (page, selector) => page.$eval(selector, (el) => el.textContent.trim());

async function waitForStatus(page, predicate) {
  const deadline = Date.now() + 15_000;
  let text;
  while (Date.now() < deadline) {
    text = await statusText(page);
    if (predicate(text)) return text;
    await page.waitForTimeout(50);
  }
  throw new Error(`status never matched; last value: ${JSON.stringify(text)}`);
}

const finished = (text) => !text.startsWith("Searching") && !text.startsWith("Loading")
  && !text.includes("Waiting") && !text.includes("Loading the surrounding area");

async function finalStatus(page) {
  return waitForStatus(page, (text) => text !== "" && finished(text));
}

/** Starts recording every text the status line is given; read them with `statusHistory`. */
async function recordStatuses(page) {
  await page.evaluate(() => {
    window.statusHistory = [];
    new MutationObserver((records) => {
      for (const r of records) window.statusHistory.push(r.addedNodes[0]?.textContent ?? "");
    }).observe(document.querySelector("#status"), { childList: true });
  });
}

/** Status texts after a search's `done`: the surround loads for its n frames, then `done`. */
function surroundStatuses(done, n) {
  return [done, ...Array.from({ length: n },
    (_, i) => `${done} Loading the surrounding area: frame ${i + 1} of ${n}\u2026`), done];
}

/** Recorded status texts, consecutive repeats merged. */
async function statusHistory(page) {
  const all = await page.evaluate(() => window.statusHistory);
  return all.filter((t, i) => t !== all[i - 1]);
}

async function sliderState(page) {
  return page.$eval("#slider", (el) => ({
    disabled: el.disabled, min: Number(el.min), max: Number(el.max), value: Number(el.value),
  }));
}

async function selectFrame(page, value) {
  await page.$eval("#slider", (el, v) => {
    el.value = String(v);
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }, value);
}

/** RGBA bytes of the canvas backing store's central 59x59 field (all of it on a 59 grid). */
async function canvasPixels(page) {
  return page.$eval("#image", (el, size) => {
    const offset = (el.width - size) / 2;
    return Array.from(el.getContext("2d").getImageData(offset, offset, size, size).data);
  }, SIZE);
}

/** RGBA bytes of an element as rendered on screen, with its size in CSS pixels. */
async function renderedCanvas(page, selector = "#frame") {
  const png = await page.locator(selector).screenshot();
  return page.evaluate(async (b64) => {
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const bitmap = await createImageBitmap(new Blob([bytes], { type: "image/png" }));
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const ctx = canvas.getContext("2d");
    ctx.drawImage(bitmap, 0, 0);
    const { data } = ctx.getImageData(0, 0, bitmap.width, bitmap.height);
    return { width: bitmap.width, height: bitmap.height, data: Array.from(data) };
  }, png.toString("base64"));
}

/** No page error, no unexpected API call, and requests only to the page's origin. */
function assertCleanRun(log) {
  assertCleanMapRun(log);
  assert.deepEqual(log.sky, []);
  assert.deepEqual(log.scripts, []);
}

/** As assertCleanRun, but the sky survey at IRSA and the map script may be requested. */
function assertCleanMapRun(log) {
  const origin = new URL(baseUrl).origin;
  assert.deepEqual(log.errors, []);
  assert.deepEqual(log.foreign, []);
  assert.deepEqual(log.unexpectedApi, []);
  for (const url of log.requests) {
    assert.ok(new URL(url).origin === origin || url.startsWith(`${SKY_SURVEY}/`), url);
  }
}

/** A grey JPEG sky tile (512x512, a few hundred stars), drawn by the browser. */
async function makeSkyTile(chromiumBrowser) {
  const page = await chromiumBrowser.newPage();
  try {
    const b64 = await page.evaluate(async () => {
      const canvas = new OffscreenCanvas(512, 512);
      const ctx = canvas.getContext("2d");
      ctx.fillStyle = "rgb(12, 12, 12)";
      ctx.fillRect(0, 0, 512, 512);
      for (let i = 0; i < 400; i++) {
        const grey = 90 + ((i * 37) % 160);
        ctx.fillStyle = `rgb(${grey}, ${grey}, ${grey})`;
        ctx.fillRect((i * 97) % 512, (i * 211) % 512, 2 + (i % 3), 2 + (i % 3));
      }
      const blob = await canvas.convertToBlob({ type: "image/jpeg", quality: 0.9 });
      const bytes = new Uint8Array(await blob.arrayBuffer());
      return btoa(Array.from(bytes, (b) => String.fromCharCode(b)).join(""));
    });
    return Buffer.from(b64, "base64");
  } finally {
    await page.close();
  }
}

before(async () => {
  cacheDir = await mkdtemp(join(tmpdir(), "spherex-e2e-"));
  const port = await freePort();
  baseUrl = `http://127.0.0.1:${port}/`;
  const output = [];
  server = spawn(join(REPO, ".venv/bin/python"),
    ["-m", "uvicorn", "spherex_viewer.app:create_app", "--factory",
      "--host", "127.0.0.1", "--port", String(port)],
    {
      cwd: REPO,
      env: { ...process.env, SPHEREX_CACHE_DIR: cacheDir },
      stdio: ["ignore", "pipe", "pipe"],
    });
  server.stdout.on("data", (d) => output.push(String(d)));
  server.stderr.on("data", (d) => output.push(String(d)));
  try {
    await waitForHealth(`${baseUrl}healthz`, server, output);
    browser = await chromium.launch();
    skyTile = await makeSkyTile(browser);
  } catch (error) {
    await stopServer(server);
    await rm(cacheDir, { recursive: true, force: true });
    throw error;
  }
});

after(async () => {
  await browser?.close();
  await stopServer(server);
  if (cacheDir) await rm(cacheDir, { recursive: true, force: true });
});

beforeEach(async () => {
  context = await browser.newContext();
});

afterEach(async () => {
  await context?.close();
});

const unusedSearch = () => ({ status: 500, body: { detail: "unused" } });

/** Every element of the body as parent>tag#id, in document order. */
function bodyElements(page) {
  return page.$$eval("body *", (els) => els.map((el) => {
    const id = el.id ? `#${el.id}` : "";
    return `${el.parentElement.tagName.toLowerCase()}>${el.tagName.toLowerCase()}${id}`;
  }));
}

test("the body holds exactly the agreed elements, in order, and nothing else", { timeout: TIMEOUT },
  async () => {
    const { page, log } = await openPage({});
    assert.deepEqual(await bodyElements(page), BODY);

    // A label's text includes its control's; the detector label also lists the options.
    const labels = await page.$$eval("label",
      (els) => els.map((el) => el.textContent.replace(/\s+/g, " ").trim()));
    assert.deepEqual(labels, [
      "Show target marker",
      "Difference from the other frames (white: brighter, black: fainter; bright stars always "
        + "leave some)",
      "RA", "Dec", "Detector D1 · 0.75–1.1 µm "
        + "D2 · 1.1–1.6 µm D3 · 1.6–2.4 µm "
        + "D4 · 2.4–3.8 µm D5 · 3.8–4.4 µm "
        + "D6 · 4.4–5.0 µm",
    ]);
    assert.deepEqual(await page.$$("summary, details"), []);
    assert.deepEqual(await page.$$eval("button", (els) => els.map((el) => [
      el.id, el.textContent.trim(), el.getAttribute("aria-label")])), [
      ["prev", "\u2039", "Previous frame"],
      ["play", "Play", null],
      ["next", "\u203a", "Next frame"],
      ["zoom-out", "\u2212", "Zoom out"],
      ["zoom-in", "+", "Zoom in"],
      ["sky-search", "Search here", null],
      ["sky-close", "Close map", null],
      ["pick", "Pick on sky map", null],
      ["submit", "Show", null],
    ]);
    assert.equal(await page.isVisible("#pick"), true);
    assert.equal(await page.isVisible("#sky"), false);
    assert.equal(await page.getAttribute("#pick", "aria-expanded"), "false");
    assert.equal(await page.getAttribute("#pick", "aria-controls"), "sky");
    assert.ok((await page.getAttribute("#sky-map", "aria-label")).length > 0);
    assert.equal(await page.getAttribute("#ra", "type"), "text");
    assert.equal(await page.getAttribute("#dec", "type"), "text");
    assert.equal(await page.getAttribute("#show-marker", "type"), "checkbox");
    assert.equal(await page.getAttribute("#difference", "type"), "checkbox");
    assert.equal(await page.getAttribute("#slider", "type"), "range");
    assert.ok((await page.getAttribute("#slider", "aria-label")).length > 0);
    assert.equal(await page.getAttribute("#status", "aria-live"), "polite");
    assert.equal(await page.getAttribute("#image", "role"), "img");
    assert.ok((await page.getAttribute("#image", "aria-label")).length > 0);
    assert.equal(await page.getAttribute("#marker", "aria-hidden"), "true");
    assert.deepEqual(await page.$$eval("#detector option", (els) => els.map((el) => el.value)),
      ["D1", "D2", "D3", "D4", "D5", "D6"]);
    assert.equal(await page.inputValue("#detector"), "D2");
    assert.deepEqual(await page.$eval("#image", (el) => [el.width, el.height]), [SIZE, SIZE]);
    assert.equal(await page.$eval("#ack", (el) => el.textContent.replace(/\s+/g, " ").trim()),
      ACK);
    assertCleanRun(log);
  });

test("the search controls are all visible on a fresh load without a click, in panel order",
  { timeout: TIMEOUT }, async () => {
    const { page, log } = await openPage({});
    const order = ["#name", "#position", "#hint", "#difference-control", "#pick", "#ra", "#dec",
      "#detector", "#submit", "#status"];
    for (const id of order.slice(3, 9)) assert.equal(await page.isVisible(id), true, id);
    const tops = await page.$$eval(order.join(", "),
      (els) => els.map((el) => [`#${el.id}`, el.getBoundingClientRect().top]));
    assert.deepEqual(tops.map(([id]) => id), order);
    for (let i = 1; i < tops.length; i++) {
      assert.ok(tops[i][1] > tops[i - 1][1], `${tops[i][0]} not below ${tops[i - 1][0]}`);
    }
    assert.equal(await page.$eval("#detector", (el) => el.form?.id), "search");
    assert.notEqual(await page.evaluate(() => document.activeElement?.id), "ra");
    assertCleanRun(log);
  });

test("typing RA and Dec, choosing a detector and pressing Enter searches with no other click",
  { timeout: TIMEOUT }, async () => {
    const plan = makePlan(THREE_FRAMES, { detector: "D4" });
    const { page, log } = await openPage({
      search: () => ({ status: 200, body: plan }), frame: frameOk(plan),
    });
    await page.click("#ra");
    await page.keyboard.type(RA);
    await page.click("#dec");
    await page.keyboard.type(DEC);
    await page.selectOption("#detector", "D4");
    await page.focus("#dec");
    await page.keyboard.press("Enter");
    assert.equal(await finalStatus(page), `3 frames from 42 of 42 exposures. ${NO_DATA}`);
    const params = log.searches[0].searchParams;
    assert.deepEqual([params.get("ra"), params.get("dec"), params.get("detector")],
      [RA, DEC, "D4"]);
    assert.equal(await page.evaluate(() => location.search), `?ra=${RA}&dec=${DEC}&detector=D4`);
    assertCleanRun(log);
  });

test("a fresh load shows the example's first frame, name, position and hint without playing",
  { timeout: TIMEOUT }, async () => {
    const { page, log } = await openPage({});
    assert.deepEqual(log.examples, [new URL("example.json", baseUrl).href]);
    assert.deepEqual(await canvasPixels(page), exampleRGBA(0));
    assert.equal(await text(page, "#name"), "Test Star");
    assert.equal(await text(page, "#position"), "RA 269.4463\u00b0, Dec +4.7682\u00b0 \u00b7 D6");
    assert.equal(await text(page, "#hint"), EXAMPLE.hint);
    assert.equal(await page.isVisible("#hint"), true);
    assert.equal(await dateText(page), EXAMPLE_LABELS[0]);
    assert.equal(await statusText(page), "");
    assert.deepEqual(await sliderState(page), { disabled: false, min: 0, max: 2, value: 0 });
    for (const id of ["#prev", "#play", "#next"]) assert.equal(await page.isDisabled(id), false);

    await page.waitForTimeout(1500);
    assert.equal(await text(page, "#play"), "Play");
    assert.equal((await sliderState(page)).value, 0);
    assert.equal(await dateText(page), EXAMPLE_LABELS[0]);
    assert.deepEqual(await canvasPixels(page), exampleRGBA(0));
    assert.deepEqual(log.searches, []);
    assert.deepEqual(log.frames, []);
    assert.equal(log.requests.filter((u) => new URL(u).pathname.startsWith("/api/")).length, 0);
    assertCleanRun(log);
  });

test("Play plays the example in a loop, the date label follows, Pause stops it",
  { timeout: TIMEOUT }, async () => {
    const { page, log } = await openPage({});
    await page.click("#play");
    assert.equal(await text(page, "#play"), "Pause");
    const seen = [0];
    for (let t = 0; t < 25; t++) {
      const { value, label } = await page.evaluate(() => ({
        value: Number(document.querySelector("#slider").value),
        label: document.querySelector("#date").textContent.trim(),
      }));
      assert.equal(label, EXAMPLE_LABELS[value]);
      if (seen.at(-1) !== value) seen.push(value);
      await page.waitForTimeout(100);
    }
    assert.ok(seen.length >= 4, `playback sequence ${seen}`);
    for (let i = 1; i < seen.length; i++) {
      assert.equal(seen[i], (seen[i - 1] + 1) % 3, `playback sequence ${seen}`);
    }
    await page.click("#play");
    assert.equal(await text(page, "#play"), "Play");
    const stopped = (await sliderState(page)).value;
    assert.deepEqual(await canvasPixels(page), exampleRGBA(stopped));
    await page.waitForTimeout(1200);
    assert.equal((await sliderState(page)).value, stopped);
    assert.deepEqual(log.searches, []);
    assertCleanRun(log);
  });

test("previous and next step exactly one frame, wrap at both ends and pause playback",
  { timeout: TIMEOUT }, async () => {
    const { page, log } = await openPage({});
    const expectFrame = async (n) => {
      assert.equal((await sliderState(page)).value, n);
      assert.equal(await dateText(page), EXAMPLE_LABELS[n]);
      assert.deepEqual(await canvasPixels(page), exampleRGBA(n));
    };
    for (const n of [1, 2, 0]) {
      await page.click("#next");
      await expectFrame(n);
    }
    for (const n of [2, 1, 0]) {
      await page.click("#prev");
      await expectFrame(n);
    }
    await page.click("#play");
    await page.waitForFunction(() => document.querySelector("#slider").value !== "0");
    await page.click("#next");
    assert.equal(await text(page, "#play"), "Play");
    const value = (await sliderState(page)).value;
    await page.waitForTimeout(1200);
    await expectFrame(value);
    assertCleanRun(log);
  });

test("the timeline scrubs to any frame and updates image and date", { timeout: TIMEOUT },
  async () => {
    const { page, log } = await openPage({});
    for (const n of [2, 0, 1]) {
      await selectFrame(page, n);
      assert.equal(await dateText(page), EXAMPLE_LABELS[n]);
      assert.deepEqual(await canvasPixels(page), exampleRGBA(n));
    }
    // The real control, by keyboard.
    await page.focus("#slider");
    await page.keyboard.press("ArrowRight");
    assert.equal(await dateText(page), EXAMPLE_LABELS[2]);
    assertCleanRun(log);
  });

/** The marker's centre and the canvas rectangle, in CSS pixels of the viewport. */
async function markerGeometry(page) {
  return page.evaluate(() => {
    const image = document.querySelector("#image").getBoundingClientRect();
    const marker = document.querySelector("#marker");
    const box = marker.getBoundingClientRect();
    return {
      visible: !marker.hidden && box.width > 0 && getComputedStyle(marker).display !== "none",
      cx: box.left + box.width / 2,
      cy: box.top + box.height / 2,
      image: { left: image.left, top: image.top, width: image.width, height: image.height },
    };
  });
}

async function assertMarkerAt(page, marker) {
  const g = await markerGeometry(page);
  assert.equal(g.visible, true, "marker hidden");
  const x = g.image.left + ((marker.x + 0.5) / SIZE) * g.image.width;
  const y = g.image.top + ((marker.y + 0.5) / SIZE) * g.image.height;
  assert.ok(Math.abs(g.cx - x) <= 1 && Math.abs(g.cy - y) <= 1,
    `marker at ${g.cx},${g.cy}, expected ${x},${y}`);
}

test("the marker toggle shows and hides a marker that follows the target from frame to frame",
  { timeout: TIMEOUT }, async () => {
    const { page, log } = await openPage({});
    assert.equal(await page.isVisible("#marker-control"), true);
    assert.equal(await page.isChecked("#show-marker"), true);
    await assertMarkerAt(page, EXAMPLE_MARKERS[0]);
    await page.click("#next");
    await assertMarkerAt(page, EXAMPLE_MARKERS[1]);
    await selectFrame(page, 2);
    await assertMarkerAt(page, EXAMPLE_MARKERS[2]);

    await page.click("#marker-control");
    assert.equal(await page.isChecked("#show-marker"), false);
    assert.equal((await markerGeometry(page)).visible, false);
    await page.click("#prev");
    assert.equal((await markerGeometry(page)).visible, false);
    await page.click("#marker-control");
    await assertMarkerAt(page, EXAMPLE_MARKERS[1]);

    await page.setViewportSize({ width: 390, height: 844 });
    await assertMarkerAt(page, EXAMPLE_MARKERS[1]);
    assertCleanRun(log);
  });

test("an example without markers has no marker toggle", { timeout: TIMEOUT }, async () => {
  const frames = EXAMPLE.frames.map(({ marker, ...rest }) => rest);
  const { page, log } = await openPage({
    example: () => ({ status: 200, body: { ...EXAMPLE, frames } }),
  });
  assert.equal(await dateText(page), EXAMPLE_LABELS[0]);
  assert.equal(await page.isVisible("#marker-control"), false);
  assert.equal((await markerGeometry(page)).visible, false);
  assertCleanRun(log);
});

for (const [name, reply] of [
  ["a missing file", () => ({ status: 404, raw: "Not Found" })],
  ["a file that is not JSON", () => ({ status: 200, raw: "{\"name\": " })],
  ["a file without frames", () => ({ status: 200, body: { ...EXAMPLE, frames: [] } })],
  ["an unreachable server", () => ({ abort: true })],
]) {
  test(`${name} for the example is reported once and manual search still works`,
    { timeout: TIMEOUT }, async () => {
      const plan = makePlan(THREE_FRAMES);
      const { page, log } = await openPage({
        example: reply, search: () => ({ status: 200, body: plan }), frame: frameOk(plan),
      });
      assert.equal(await statusText(page), EXAMPLE_FAILED);
      for (const id of ["#prev", "#play", "#next", "#slider", "#difference"]) {
        assert.equal(await page.isDisabled(id), true, id);
      }
      assert.equal(await text(page, "#name"), "");
      assert.equal(await page.isVisible("#marker-control"), false);
      for (const id of ["#ra", "#dec", "#detector", "#submit"]) {
        assert.equal(await page.isVisible(id), true, id);
      }
      await submit(page);
      assert.equal(await finalStatus(page), `3 frames from 42 of 42 exposures. ${NO_DATA}`);
      assert.equal(await page.isDisabled("#play"), false);
      assert.equal(log.examples.length, 1);
      assertCleanRun(log);
    });
}

test("a search started while the example plays stops playback and replaces the example",
  { timeout: TIMEOUT }, async () => {
    const plan = makePlan(THREE_FRAMES);
    const gate = deferred();
    const reply = frameOk(plan);
    const { page, log } = await openPage({
      search: () => ({ status: 200, body: plan }),
      frame: async (n) => {
        await gate.promise;
        return reply(n);
      },
    });
    try {
      await page.click("#play");
      await page.waitForFunction(() => document.querySelector("#slider").value !== "0");
      await submit(page);
      await waitForStatus(page, (t) => t.startsWith("Loading frame 1"));
      assert.equal(await text(page, "#play"), "Play");
      assert.equal(await page.isDisabled("#play"), true);
      assert.equal(await dateText(page), "");
      assert.ok((await canvasPixels(page)).every((v) => v === 0), "canvas not cleared");
      assert.equal(await page.isVisible("#marker-control"), false);
      assert.equal((await markerGeometry(page)).visible, false);
      gate.release();
      await finalStatus(page);
      await page.waitForTimeout(1200);
      assert.equal((await sliderState(page)).value, 0);
      assert.equal(await text(page, "#play"), "Play");
      assertCleanRun(log);
    } finally {
      gate.release();
    }
  });

test("a search started before the example has loaded wins over the late example",
  { timeout: TIMEOUT }, async () => {
    const plan = makePlan(THREE_FRAMES);
    const gate = deferred();
    const { page, log } = await openPage({
      wait: false,
      example: async () => {
        await gate.promise;
        return exampleOk();
      },
      search: () => ({ status: 200, body: plan }),
      frame: frameOk(plan),
    });
    try {
      await page.waitForFunction(() => document.querySelector("#search") !== null);
      await submit(page);
      assert.equal(await finalStatus(page), `3 frames from 42 of 42 exposures. ${NO_DATA}`);
      gate.release();
      await page.waitForTimeout(500);
      assert.equal(await text(page, "#name"), `RA ${RA}, Dec ${DEC}`);
      assert.equal(await dateText(page), "2025-05-06 \u00b7 8 exposures");
      assert.equal(await statusText(page), `3 frames from 42 of 42 exposures. ${NO_DATA}`);
      assertCleanRun(log);
    } finally {
      gate.release();
    }
  });

/** Bounding rectangles of the given elements and the viewport size. */
async function layout(page, selectors) {
  return page.evaluate((list) => ({
    rects: Object.fromEntries(list.map((s) => {
      const r = document.querySelector(s).getBoundingClientRect();
      return [s, { left: r.left, top: r.top, right: r.right, bottom: r.bottom }];
    })),
    width: document.documentElement.clientWidth,
    height: document.documentElement.clientHeight,
    scrollWidth: document.documentElement.scrollWidth,
  }), selectors);
}

const PLAYER = ["#image", "#prev", "#play", "#next", "#slider", "#date"];

test("at 1366x768 the image and all player controls fit in the initial view, panel beside",
  { timeout: TIMEOUT }, async () => {
    const { page, log } = await openPage({});
    await page.setViewportSize({ width: 1366, height: 768 });
    const { rects, width, height } = await layout(page, [...PLAYER, "#panel", "#submit"]);
    for (const s of PLAYER) {
      const r = rects[s];
      assert.ok(r.left >= 0 && r.top >= 0 && r.right <= width && r.bottom <= height,
        `${s} at ${JSON.stringify(r)} outside ${width}x${height}`);
    }
    const image = rects["#image"];
    assert.ok(image.right - image.left >= 500, `image only ${image.right - image.left} px wide`);
    for (const s of ["#prev", "#play", "#next", "#slider"]) {
      assert.ok(rects[s].top >= image.bottom, `${s} not below the image`);
    }
    assert.ok(rects["#panel"].left >= image.right, "panel not beside the image");
    assert.ok(rects["#panel"].top >= 0 && rects["#panel"].bottom <= height,
      `panel at ${JSON.stringify(rects["#panel"])} not in view`);
    assert.ok(rects["#submit"].bottom <= height, "Show not in view");
    assertCleanRun(log);
  });

test("at 390 px width the target panel is below the player and nothing scrolls sideways",
  { timeout: TIMEOUT }, async () => {
    const { page, log } = await openPage({});
    await page.setViewportSize({ width: 390, height: 844 });
    const { rects, width, scrollWidth } = await layout(page, [...PLAYER, "#panel", "#submit"]);
    for (const s of PLAYER) {
      assert.ok(rects["#panel"].top >= rects[s].bottom, `panel not below ${s}`);
      assert.ok(rects[s].left >= 0 && rects[s].right <= width, `${s} wider than the screen`);
    }
    assert.ok(rects["#panel"].right <= width && rects["#submit"].right <= width);
    assert.ok(scrollWidth <= width, `page scrolls to ${scrollWidth} of ${width}`);
    assertCleanRun(log);
  });

test("frames are requested one at a time and the slider grows as each arrives",
  { timeout: TIMEOUT }, async () => {
    const plan = makePlan(THREE_FRAMES);
    const gates = plan.frames.map(() => deferred());
    const reply = frameOk(plan);
    const { page, log } = await openPage({
      search: () => ({ status: 200, body: plan }),
      frame: async (n) => {
        await gates[n].promise;
        return reply(n);
      },
    });
    try {
      await submit(page);
      assert.equal(await waitForStatus(page, (t) => t.startsWith("Loading frame 1")),
        "Loading frame 1 of 3\u2026");
      await page.waitForTimeout(300);
      assert.equal(log.frames.length, 1);
      for (const id of ["#prev", "#play", "#next", "#slider"]) {
        assert.equal(await page.isDisabled(id), true, id);
      }
      // The example is gone: blank image, no date, no hint, no marker, the search as name.
      assert.ok((await canvasPixels(page)).every((v) => v === 0), "example still drawn");
      assert.equal(await dateText(page), "");
      assert.equal(await text(page, "#name"), `RA ${RA}, Dec ${DEC}`);
      assert.equal(await text(page, "#position"),
        "RA 133.7951°, Dec −7.2451° · D2");
      assert.equal(await page.isVisible("#hint"), false);
      assert.equal(await page.isVisible("#marker-control"), false);
      assert.equal(await page.isVisible("#marker"), false);

      const sizes = [];
      for (let n = 0; n < 3; n++) {
        gates[n].release();
        await page.waitForFunction((k) => {
          const s = document.querySelector("#slider");
          return !s.disabled && Number(s.max) - Number(s.min) + 1 === k;
        }, n + 1);
        sizes.push((await sliderState(page)).max);
        if (n < 2) {
          await waitForStatus(page, (t) => t === `Loading frame ${n + 2} of 3\u2026`);
          await page.waitForTimeout(200);
          assert.equal(log.frames.length, n + 2);
        }
      }
      assert.ok(sizes[0] < sizes[1] && sizes[1] < sizes[2], `slider.max sequence ${sizes}`);
      assert.equal(log.maxInFlight, 1);
      assert.equal(await page.isDisabled("#play"), false);
      const loaded = [0, 1, 2].map((n) => pixels(n));
      assert.deepEqual(await canvasPixels(page),
        Array.from(toRGBA(loaded[0], computeStretch(loaded))));
      assert.equal(await page.isVisible("#marker"), false);

      const search = log.searches[0].searchParams;
      assert.deepEqual([search.get("ra"), search.get("dec"), search.get("detector")],
        [RA, DEC, "D2"]);
      assert.deepEqual(log.frames,
        plan.frames.map((f) => ({ ra_deg: plan.ra_deg, dec_deg: plan.dec_deg, uris: f.uris })));
      assert.equal(await finalStatus(page), `3 frames from 42 of 42 exposures. ${NO_DATA}`);
      assertCleanRun(log);
    } finally {
      gates.forEach((g) => g.release());
    }
  });

test("a single frame from a single exposure is reported in the singular", { timeout: TIMEOUT },
  async () => {
    const plan = makePlan([{ label: "2025-05-06", n_available: 1, n_used: 1 }]);
    const { page, log } = await openPage({
      search: () => ({ status: 200, body: plan }), frame: frameOk(plan),
    });
    await submit(page);
    assert.equal(await finalStatus(page), `1 frame from 1 of 1 exposure. ${NO_DATA}`);
    assertCleanRun(log);
  });

test("the date label shows the selected frame's date and the exposures it was built from",
  { timeout: TIMEOUT }, async () => {
    const plan = makePlan(THREE_FRAMES);
    // Frame 1 was planned with 19 exposures, but only one contributed.
    const used = [8, 1, 15];
    const { page, log } = await openPage({
      search: () => ({ status: 200, body: plan }),
      frame: (n) => frameBody(pixels(n), used[n]),
    });
    await submit(page);
    assert.equal(await finalStatus(page), `3 frames from 24 of 42 exposures. ${NO_DATA}`);
    const expected = [
      "2025-05-06 \u00b7 8 exposures",
      "2025-11-07 \u2013 2025-11-10 \u00b7 1 exposure",
      "2026-04-20 \u00b7 15 exposures",
    ];
    const { min, value } = await sliderState(page);
    assert.equal(await dateText(page), expected[value - min]);
    for (const n of [2, 0, 1]) {
      await selectFrame(page, min + n);
      assert.equal(await dateText(page), expected[n]);
    }
    assertCleanRun(log);
  });

test("the longest date label fits on a phone-width screen", { timeout: TIMEOUT }, async () => {
  const plan = makePlan([{ label: "2025-11-07 \u2013 2025-11-10", n_available: 19, n_used: 19 }]);
  const { page, log } = await openPage({
    search: () => ({ status: 200, body: plan }), frame: frameOk(plan),
  });
  await page.setViewportSize({ width: 320, height: 800 });
  await submit(page);
  await finalStatus(page);
  assert.equal(await dateText(page), "2025-11-07 \u2013 2025-11-10 \u00b7 19 exposures");
  const fit = await page.evaluate(() => {
    const date = document.querySelector("#date").getBoundingClientRect();
    return {
      right: date.right,
      viewport: document.documentElement.clientWidth,
      scroll: document.documentElement.scrollWidth,
    };
  });
  assert.ok(fit.right <= fit.viewport, `date ends at ${fit.right} of ${fit.viewport}`);
  assert.ok(fit.scroll <= fit.viewport, `page scrolls to ${fit.scroll} of ${fit.viewport}`);
  assertCleanRun(log);
});

test("the cap notice for several capped frames appears while loading and when finished",
  { timeout: TIMEOUT }, async () => {
    const plan = makePlan([
      { label: "2025-05-06", n_available: 8, n_used: 8 },
      { label: "2025-06-01 \u2013 2025-06-29", n_available: 300, n_used: 24 },
      { label: "2025-07-01 \u2013 2025-07-29", n_available: 92, n_used: 24 },
    ]);
    const notice = "Cap applied: 2 of 3 frames use 24 of their exposures, "
      + "evenly spaced in time order.";
    const gate = deferred();
    const reply = frameOk(plan);
    const { page, log } = await openPage({
      search: () => ({ status: 200, body: plan }),
      frame: async (n) => {
        if (n === 0) await gate.promise;
        return reply(n);
      },
    });
    try {
      await submit(page);
      assert.equal(await waitForStatus(page, (t) => t.startsWith("Loading frame 1")),
        `Loading frame 1 of 3\u2026 ${notice}`);
      gate.release();
      assert.equal(await finalStatus(page),
        `3 frames from 56 of 400 exposures. ${notice} ${NO_DATA}`);
      assertCleanRun(log);
    } finally {
      gate.release();
    }
  });

test("the cap notice for one capped frame is in the singular", { timeout: TIMEOUT }, async () => {
  const plan = makePlan([{ label: "2025-06-01 \u2013 2025-06-29", n_available: 30, n_used: 24 }]);
  const { page, log } = await openPage({
    search: () => ({ status: 200, body: plan }), frame: frameOk(plan),
  });
  await submit(page);
  assert.equal(await finalStatus(page), "1 frame from 24 of 30 exposures. "
    + "Cap applied: 1 of 1 frame uses 24 of its exposures, evenly spaced in time order. "
    + NO_DATA);
  assertCleanRun(log);
});

test("one failing frame is reported with its reason and loading continues",
  { timeout: TIMEOUT }, async () => {
    const plan = makePlan(THREE_FRAMES);
    const reply = frameOk(plan);
    const { page, log } = await openPage({
      search: () => ({ status: 200, body: plan }),
      frame: (n) => (n === 1
        ? { status: 502, body: { detail: "every exposure failed" } }
        : reply(n)),
    });
    await submit(page);
    assert.equal(await finalStatus(page),
      "2 frames from 23 of 42 exposures. 1 frame could not be loaded: every exposure failed. "
      + NO_DATA);
    assert.equal(log.frames.length, 3);
    const { disabled, min, max } = await sliderState(page);
    assert.equal(disabled, false);
    assert.equal(max - min + 1, 2);
    await selectFrame(page, max);
    assert.equal(await dateText(page), "2026-04-20 \u00b7 15 exposures");
    assertCleanRun(log);
  });

test("several failing frames are counted in the plural with the last reason",
  { timeout: TIMEOUT }, async () => {
    const plan = makePlan(THREE_FRAMES);
    const reply = frameOk(plan);
    const { page, log } = await openPage({
      search: () => ({ status: 200, body: plan }),
      frame: (n, payload) => [
        reply,
        () => ({ status: 503, raw: "unavailable", headers: { "Retry-After": "1" } }),
        () => ({
          status: 429,
          body: { detail: "Too many requests, try again later." },
          headers: { "Retry-After": "1" },
        }),
      ][planIndex(plan, payload)](n),
    });
    await submit(page);
    assert.equal(await finalStatus(page), "1 frame from 8 of 42 exposures. "
      + `2 frames could not be loaded: Too many requests, try again later. ${NO_DATA}`);
    assert.deepEqual(requestedFrames(plan, log), [0, 1, 1, 2, 2]);
    assertCleanRun(log);
  });

test("when every frame fails the status says so with the reason", { timeout: TIMEOUT },
  async () => {
    const plan = makePlan(THREE_FRAMES.slice(0, 2));
    const { page, log } = await openPage({
      search: () => ({ status: 200, body: plan }),
      frame: (n, payload) => (planIndex(plan, payload) === 0
        ? { status: 502, body: { detail: "every exposure failed" } }
        : { status: 503, raw: "unavailable", headers: { "Retry-After": "1" } }),
    });
    await submit(page);
    assert.equal(await finalStatus(page), "No frame could be loaded: 503 Service Unavailable.");
    assert.deepEqual(requestedFrames(plan, log), [0, 1, 1]);
    assert.equal(await page.isDisabled("#play"), true);
    assert.equal(await page.isDisabled("#slider"), true);
    assertCleanRun(log);
  });

test("a frame request that cannot reach the server counts as failed", { timeout: TIMEOUT },
  async () => {
    const plan = makePlan(THREE_FRAMES.slice(0, 1));
    const { page, log } = await openPage({
      search: () => ({ status: 200, body: plan }), frame: () => ({ abort: true }),
    });
    await submit(page);
    assert.equal(await finalStatus(page),
      "No frame could be loaded: the server could not be reached.");
    assertCleanRun(log);
  });

for (const [status, detail] of [
  [422, "RA is not a valid angle."],
  [429, "Too many requests, try again later."],
  [502, "The IRSA archive did not answer."],
]) {
  test(`a ${status} search error shows its detail in the status line`, { timeout: TIMEOUT },
    async () => {
      const { page, log } = await openPage({
        search: () => ({ status, body: { detail }, headers: { "Retry-After": "1" } }),
      });
      await submit(page, { ra: "abc" });
      assert.equal(await finalStatus(page), `Error: ${detail}`);
      // Only a 429 or 503 refusal is asked again, once.
      assert.equal(log.searches.length, status === 429 ? 2 : 1);
      assert.equal(log.frames.length, 0);
      assert.equal(await page.isDisabled("#play"), true);
      assert.equal(await page.isDisabled("#slider"), true);
      assertCleanRun(log);
    });
}

test("a search error without a JSON detail shows the HTTP status", { timeout: TIMEOUT },
  async () => {
    const { page, log } = await openPage({
      search: () => ({ status: 503, raw: "down", headers: { "Retry-After": "1" } }),
    });
    await submit(page);
    assert.equal(await finalStatus(page), "Error: 503 Service Unavailable");
    assert.equal(log.searches.length, 2);
    assertCleanRun(log);
  });

test("an empty plan reports that no exposures cover the position in the chosen detector",
  { timeout: TIMEOUT }, async () => {
    const { page, log } = await openPage({
      search: () => ({ status: 200, body: makePlan([], { detector: "D4" }) }),
    });
    await submit(page, { detector: "D4" });
    assert.equal(await finalStatus(page), "No SPHEREx exposures cover this position in D4.");
    assert.equal(log.searches[0].searchParams.get("detector"), "D4");
    assert.equal(log.frames.length, 0);
    assertCleanRun(log);
  });

// Both orders: a stretch frozen at the first loaded frame fails the dim-first order.
for (const brightFirst of [true, false]) {
  test(`one stretch for all frames: equal values match, a brighter source stays brighter `
    + `(${brightFirst ? "bright" : "dim"} frame first)`, { timeout: TIMEOUT }, async () => {
    const equal = 100;
    const blank = 101;
    const source = new Set();
    for (let row = 20; row < 23; row++) {
      for (let col = 20; col < 23; col++) source.add(row * SIZE + col);
    }
    // The source covers 9 pixels, so it sets each frame's own 99.9th percentile:
    // drawing a frame with its own stretch would make the source white in both.
    const frame = (amplitude) => Array.from({ length: SIZE * SIZE }, (_, i) => {
      if (i === blank) return null;
      if (source.has(i)) return amplitude;
      return ((i * 7) % 50) / 100;
    });
    const sourcePixel = 21 * SIZE + 21;
    const amplitudes = brightFirst ? [6, 3] : [3, 6];
    const plan = makePlan([
      { label: "2025-05-06", n_available: 8, n_used: 8 },
      { label: "2025-11-07", n_available: 8, n_used: 8 },
    ]);
    const { page, log } = await openPage({
      search: () => ({ status: 200, body: plan }),
      frame: (n) => frameBody(frame(amplitudes[n]), 8),
    });
    await submit(page);
    await finalStatus(page);
    const { min } = await sliderState(page);
    const brightIndex = amplitudes.indexOf(6);
    await selectFrame(page, min + brightIndex);
    const bright = await canvasPixels(page);
    await selectFrame(page, min + 1 - brightIndex);
    const dim = await canvasPixels(page);

    assert.equal(bright[4 * equal + 3], 255);
    assert.equal(dim[4 * equal], bright[4 * equal]);
    assert.ok(bright[4 * sourcePixel] > dim[4 * sourcePixel],
      `source grey ${bright[4 * sourcePixel]} (bright) vs ${dim[4 * sourcePixel]} (dim)`);
    assert.ok(dim[4 * sourcePixel] > dim[4 * equal]);
    assert.equal(bright[4 * blank + 3], 0);
    assert.equal(dim[4 * blank + 3], 0);
    assertCleanRun(log);
  });
}

test("the first pixel value (north-east) is drawn at the canvas's top-left corner",
  { timeout: TIMEOUT }, async () => {
    // A bright 5x5 block at the start of the array on a constant (black) background.
    const values = Array.from({ length: SIZE * SIZE },
      (_, i) => (Math.floor(i / SIZE) < 5 && i % SIZE < 5 ? 5 : 0.1));
    const plan = makePlan([{ label: "2025-05-06", n_available: 8, n_used: 8 }]);
    const { page, log } = await openPage({
      search: () => ({ status: 200, body: plan }), frame: () => frameBody(values, 8),
    });
    await page.setViewportSize({ width: 1280, height: 1400 });
    await submit(page);
    await finalStatus(page);

    const backing = await canvasPixels(page);
    const grey = (x, y) => backing[4 * (y * SIZE + x)];
    assert.deepEqual([grey(0, 0), grey(SIZE - 1, 0), grey(0, SIZE - 1), grey(SIZE - 1, SIZE - 1)],
      [255, 0, 0, 0]);

    const shown = await renderedCanvas(page);
    const at = (fx, fy) => {
      const x = Math.floor(fx * shown.width);
      const y = Math.floor(fy * shown.height);
      return shown.data[4 * (y * shown.width + x)];
    };
    assert.ok(at(0.04, 0.04) > 200, `top-left ${at(0.04, 0.04)}`);
    for (const [fx, fy] of [[0.96, 0.04], [0.04, 0.96], [0.96, 0.96]]) {
      assert.ok(at(fx, fy) < 50, `corner ${fx},${fy}: ${at(fx, fy)}`);
    }
    assertCleanRun(log);
  });

test("play toggles looping playback through the loaded frames", { timeout: TIMEOUT }, async () => {
  const plan = makePlan(THREE_FRAMES);
  const { page, log } = await openPage({
    search: () => ({ status: 200, body: plan }), frame: frameOk(plan),
  });
  await submit(page);
  await finalStatus(page);
  const { min, max } = await sliderState(page);
  await selectFrame(page, min);

  await page.click("#play");
  const seen = [];
  for (let t = 0; t < 30; t++) {
    const { value, label } = await page.evaluate(() => ({
      value: Number(document.querySelector("#slider").value),
      label: document.querySelector("#date").textContent.trim(),
    }));
    const { label: date, n_used: n } = plan.frames[value - min];
    assert.equal(label, `${date} \u00b7 ${n} exposures`);
    if (seen.at(-1) !== value) seen.push(value);
    await page.waitForTimeout(100);
  }
  for (let i = 1; i < seen.length; i++) {
    const expected = seen[i - 1] === max ? min : seen[i - 1] + 1;
    assert.equal(seen[i], expected, `playback sequence ${seen}`);
  }
  assert.ok(seen.length >= 4, `playback sequence ${seen}`);
  assert.ok(seen.includes(max) && seen.indexOf(min, seen.indexOf(max)) > 0, `no wrap in ${seen}`);

  await page.click("#play");
  const stopped = (await sliderState(page)).value;
  await page.waitForTimeout(1200);
  assert.equal((await sliderState(page)).value, stopped);
  assertCleanRun(log);
});

// --- The sky map ---------------------------------------------------------------------------

const SELECTION = /^RA (\d+\.\d{6})°, Dec (-?\d+\.\d{6})°$/;

/** Opens the sky map with its button and waits until it accepts a selection. */
async function openMap(page) {
  await page.click("#pick");
  await page.waitForFunction((hint) => document.querySelector("#sky-selection").textContent
    === hint, MAP_HINT, { timeout: 20_000 });
}

/** The selected position shown under the map, in degrees, or null if none is selected. */
async function selected(page) {
  const match = SELECTION.exec(await text(page, "#sky-selection"));
  return match === null ? null : { ra: Number(match[1]), dec: Number(match[2]), text: match };
}

/** The map's rectangle in CSS pixels of the viewport. */
const mapRect = (page) => page.$eval("#sky-map", (el) => {
  const r = el.getBoundingClientRect();
  return { left: r.left, top: r.top, width: r.width, height: r.height };
});

const isAmber = (data, i) => data[i] > 220 && data[i + 1] > 140 && data[i + 1] < 220
  && data[i + 2] < 100;

/** Bounding box (viewport CSS pixels) of the drawn selection's amber pixels, or null. */
async function selectionBox(page) {
  const rect = await mapRect(page);
  const shot = await renderedCanvas(page, "#sky-map");
  let box = null;
  for (let y = 0; y < shot.height; y++) {
    for (let x = 0; x < shot.width; x++) {
      if (!isAmber(shot.data, 4 * (y * shot.width + x))) continue;
      box ??= { left: x, right: x, top: y, bottom: y };
      box.left = Math.min(box.left, x);
      box.right = Math.max(box.right, x);
      box.top = Math.min(box.top, y);
      box.bottom = Math.max(box.bottom, y);
    }
  }
  if (box === null) return null;
  return {
    cx: rect.left + (box.left + box.right + 1) / 2,
    cy: rect.top + (box.top + box.bottom + 1) / 2,
    width: box.right - box.left + 1,
    height: box.bottom - box.top + 1,
  };
}

async function waitForSelectionBox(page) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const box = await selectionBox(page);
    if (box !== null) return box;
    await page.waitForTimeout(100);
  }
  throw new Error("no selection drawn on the map");
}

/** Clicks the map at an offset (CSS pixels) from its centre and returns the selection. */
async function clickMap(page, dx, dy) {
  const rect = await mapRect(page);
  const x = rect.left + rect.width / 2 + dx;
  const y = rect.top + rect.height / 2 + dy;
  await page.mouse.click(x, y);
  await page.waitForFunction((re) => new RegExp(re).test(
    document.querySelector("#sky-selection").textContent), SELECTION.source);
  return { x, y, ...(await selected(page)) };
}

test("the homepage requests neither the map script nor anything from another origin",
  { timeout: TIMEOUT }, async () => {
    const { page, log } = await openPage({});
    await page.waitForTimeout(1500);
    assert.ok(log.requests.every((u) => !u.includes("/vendor/")), log.requests.join(" "));
    assert.ok(log.requests.length > 0);
    assertCleanRun(log);
  });

test("opening the map loads the script from the page's origin and tiles only from IRSA",
  { timeout: TIMEOUT }, async () => {
    const { page, log } = await openPage({});
    await openMap(page);
    await page.waitForFunction(() => document.querySelector("#sky-map canvas") !== null);
    const deadline = Date.now() + 10_000;
    while (!log.sky.some((u) => u.endsWith(".jpg")) && Date.now() < deadline) {
      await page.waitForTimeout(100);
    }
    assert.deepEqual(log.scripts, [new URL("vendor/aladin.js", baseUrl).href]);
    assert.ok(log.sky.some((u) => u.endsWith(".jpg")), `no tile requested: ${log.sky}`);
    assert.equal(await page.isVisible("#sky-map"), true);
    assert.equal(await page.isVisible("#image"), false);
    assert.equal(await page.isDisabled("#pick"), true);
    assert.equal(await page.getAttribute("#pick", "aria-expanded"), "true");
    assert.equal(await page.isDisabled("#sky-search"), true);
    assertCleanMapRun(log);
  });

test("a click selects: the position under it is shown and the 6' field is outlined around it, "
  + "without a search", { timeout: TIMEOUT }, async () => {
  const { page, log } = await openPage({});
  await openMap(page);
  const rect = await mapRect(page);
  // Two clicks 200 px apart give the map's scale; it opens at a 1.5 degree field of view.
  const a = await clickMap(page, -100, 0);
  const b = await clickMap(page, 100, 0);
  const cosDec = Math.cos((EXAMPLE.dec_deg * Math.PI) / 180);
  const degPerPx = Math.hypot((a.ra - b.ra) * cosDec, a.dec - b.dec) / 200;
  assert.ok(Math.abs(degPerPx * rect.width - 1.5) < 0.05, `field of view ${degPerPx * rect.width}`);
  // North up, east left, centred on the example.
  assert.ok(a.ra > EXAMPLE.ra_deg && b.ra < EXAMPLE.ra_deg, `RA ${a.ra}, ${b.ra}`);
  for (const p of [a, b]) {
    assert.ok(Math.abs(p.dec - EXAMPLE.dec_deg) < 1.5 * degPerPx, `Dec ${p.dec}`);
    assert.ok(Math.abs(Math.abs(p.ra - EXAMPLE.ra_deg) * cosDec - 100 * degPerPx)
      < 1.5 * degPerPx, `RA ${p.ra}`);
  }
  const c = await clickMap(page, 30, -40);
  assert.ok(Math.abs((EXAMPLE.ra_deg - c.ra) * cosDec - 30 * degPerPx) < 1.5 * degPerPx);
  assert.ok(Math.abs(c.dec - EXAMPLE.dec_deg - 40 * degPerPx) < 1.5 * degPerPx);

  const box = await waitForSelectionBox(page);
  const side = FIELD_ARCSEC / 3600 / degPerPx;
  assert.ok(Math.abs(box.cx - c.x) <= 1.5 && Math.abs(box.cy - c.y) <= 1.5,
    `outline centred at ${box.cx},${box.cy}, click at ${c.x},${c.y}`);
  for (const size of [box.width, box.height]) {
    assert.ok(Math.abs(size - side) <= 2.5, `outline ${box.width}x${box.height}, field ${side}`);
  }
  assert.equal(await page.isDisabled("#sky-search"), false);
  await page.waitForTimeout(500);
  assert.deepEqual(log.searches, []);
  assert.deepEqual(log.frames, []);
  assert.equal(await page.inputValue("#ra"), "");
  assert.equal(await page.isVisible("#sky"), true);
  assertCleanMapRun(log);
});

test("dragging the map pans it and does not select", { timeout: TIMEOUT }, async () => {
  const { page, log } = await openPage({});
  await openMap(page);
  const rect = await mapRect(page);
  const x = rect.left + rect.width / 2;
  const y = rect.top + rect.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + 40, y + 25, { steps: 6 });
  await page.mouse.up();
  await page.waitForTimeout(500);
  assert.equal(await text(page, "#sky-selection"), MAP_HINT);
  assert.equal(await page.isDisabled("#sky-search"), true);
  assert.equal(await selectionBox(page), null);
  // The sky moved with the pointer: the centre now shows a position east and north of before.
  const after = await clickMap(page, 0, 0);
  assert.ok(after.ra > EXAMPLE.ra_deg && after.dec > EXAMPLE.dec_deg,
    `centre after drag ${after.ra}, ${after.dec}`);
  assert.deepEqual(log.searches, []);
  assertCleanMapRun(log);
});

test("zoomed out to the whole sky, a click off the sky selects nothing and a click on it does",
  { timeout: TIMEOUT }, async () => {
    const { page, log } = await openPage({});
    await openMap(page);
    const rect = await mapRect(page);
    await page.mouse.move(rect.left + rect.width / 2, rect.top + rect.height / 2);
    for (let i = 0; i < 30; i++) {
      await page.mouse.wheel(0, 400);
      await page.waitForTimeout(50);
    }
    await page.waitForTimeout(1000);
    await page.mouse.click(rect.left + 5, rect.top + 5);
    await page.waitForTimeout(300);
    assert.equal(await text(page, "#sky-selection"), MAP_HINT);
    assert.equal(await page.isDisabled("#sky-search"), true);
    const centre = await clickMap(page, 0, 0);
    assert.ok(Math.abs(centre.dec - EXAMPLE.dec_deg) < 1, `centre ${centre.ra}, ${centre.dec}`);
    await waitForSelectionBox(page);
    assert.deepEqual(log.searches, []);
    assertCleanMapRun(log);
  });

test("Search here searches the selection with the current detector, closes the map and loads "
  + "the frames", { timeout: TIMEOUT }, async () => {
  const plan = makePlan(THREE_FRAMES, { detector: "D4" });
  const { page, log } = await openPage({
    search: () => ({ status: 200, body: plan }), frame: frameOk(plan),
  });
  await page.selectOption("#detector", "D4");
  await openMap(page);
  const pick = await clickMap(page, 25, 15);
  assert.deepEqual(log.searches, []);
  await page.click("#sky-search");
  assert.equal(await finalStatus(page), `3 frames from 42 of 42 exposures. ${NO_DATA}`);
  assert.equal(log.searches.length, 1);
  const params = log.searches[0].searchParams;
  assert.deepEqual([params.get("ra"), params.get("dec"), params.get("detector")],
    [pick.text[1], pick.text[2], "D4"]);
  assert.equal(await page.inputValue("#ra"), pick.text[1]);
  assert.equal(await page.inputValue("#dec"), pick.text[2]);
  assert.equal(await page.isVisible("#sky"), false);
  assert.equal(await page.isVisible("#image"), true);
  assert.equal(await page.isDisabled("#pick"), false);
  assert.equal(await text(page, "#name"), `RA ${pick.text[1]}, Dec ${pick.text[2]}`);
  assert.equal(log.frames.length, 3);
  const loaded = [0, 1, 2].map((n) => pixels(n));
  assert.deepEqual(await canvasPixels(page),
    Array.from(toRGBA(loaded[0], computeStretch(loaded))));
  assertCleanMapRun(log);
});

test("a click on a challenge target's marker selects the target with its detector; Search here "
  + "searches it", { timeout: TIMEOUT }, async () => {
  const plan = makePlan(THREE_FRAMES, { detector: "D6" });
  const { page, log } = await openPage({
    search: () => ({ status: 200, body: plan }), frame: frameOk(plan),
  });
  // The map opens centred on the example, Barnard's Star, where its marker is. A plain click
  // 8 px away would select a position about 0.002 degrees off.
  await openMap(page);
  const barnard = fieldTexts(269.4462683, 4.7682045);
  const pick = await clickMap(page, 6, -5);
  assert.deepEqual([pick.text[1], pick.text[2]], [barnard.ra, barnard.dec]);
  assert.equal(await page.inputValue("#detector"), "D6");
  await page.waitForTimeout(300);
  assert.deepEqual(log.searches, []);
  await page.click("#sky-search");
  assert.equal(await finalStatus(page), `3 frames from 42 of 42 exposures. ${NO_DATA}`);
  const params = log.searches[0].searchParams;
  assert.deepEqual([params.get("ra"), params.get("dec"), params.get("detector")],
    [barnard.ra, barnard.dec, "D6"]);

  // The stub plan is centred on WISE 0855 (08h55m10.831s, -7d14m42.53s), where the map reopens.
  await page.selectOption("#detector", "D1");
  await openMap(page);
  // A click in the same instant as reopening can reach the map before it has moved.
  await page.waitForTimeout(500);
  const wise = await clickMap(page, -5, 6);
  assert.deepEqual([wise.text[1], wise.text[2]], ["133.795129", "-7.245147"]);
  assert.equal(await page.inputValue("#detector"), "D6");
  assert.equal(log.searches.length, 1);
  assertCleanMapRun(log);
});

test("closing the map without searching leaves the page as it was; reopening starts afresh",
  { timeout: TIMEOUT }, async () => {
    const { page, log } = await openPage({});
    await openMap(page);
    await clickMap(page, 20, 20);
    await page.click("#sky-close");
    assert.equal(await page.isVisible("#sky"), false);
    for (const id of ["#image", "#play", "#slider", "#date"]) {
      assert.equal(await page.isVisible(id), true, id);
    }
    assert.deepEqual(await canvasPixels(page), exampleRGBA(0));
    assert.equal(await text(page, "#name"), "Test Star");
    assert.equal(await dateText(page), EXAMPLE_LABELS[0]);
    assert.equal(await statusText(page), "");
    assert.equal(await page.inputValue("#ra"), "");
    assert.equal(await page.inputValue("#dec"), "");
    assert.equal(await page.getAttribute("#pick", "aria-expanded"), "false");
    assert.equal(await page.evaluate(() => document.activeElement?.id), "pick");

    await page.click("#pick");
    assert.equal(await text(page, "#sky-selection"), MAP_HINT);
    assert.equal(await page.isDisabled("#sky-search"), true);
    await page.waitForTimeout(300);
    assert.equal(await selectionBox(page), null);
    assert.equal(log.scripts.length, 1);
    assert.deepEqual(log.searches, []);
    assertCleanMapRun(log);
  });

for (const [name, options] of [
  ["map script", { aladin: false }],
  ["sky survey", { sky: () => ({ abort: true }) }],
]) {
  test(`a ${name} that cannot be loaded is reported once and typed search still works`,
    { timeout: TIMEOUT }, async () => {
      const plan = makePlan(THREE_FRAMES);
      const { page, log } = await openPage({
        ...options, search: () => ({ status: 200, body: plan }), frame: frameOk(plan),
      });
      await page.click("#pick");
      assert.equal(await waitForStatus(page, (t) => t !== ""), MAP_FAILED);
      assert.equal(await page.isVisible("#sky"), false);
      assert.equal(await page.isVisible("#image"), true);
      assert.equal(await page.isDisabled("#pick"), false);
      await page.waitForTimeout(500);
      assert.equal(await statusText(page), MAP_FAILED);
      assert.deepEqual(await canvasPixels(page), exampleRGBA(0));
      await submit(page);
      assert.equal(await finalStatus(page), `3 frames from 42 of 42 exposures. ${NO_DATA}`);
      assert.equal(log.searches[0].searchParams.get("ra"), RA);
      assertCleanMapRun(log);
    });
}

test("at 1366x768 the open map and both of its buttons are in view, the panel beside it",
  { timeout: TIMEOUT }, async () => {
    const { page, log } = await openPage({});
    await page.setViewportSize({ width: 1366, height: 768 });
    await openMap(page);
    await clickMap(page, 0, 0);
    const parts = ["#sky-map", "#sky-selection", "#sky-search", "#sky-close"];
    const { rects, width, height, scrollWidth } = await layout(page, [...parts, "#panel"]);
    for (const s of parts) {
      const r = rects[s];
      assert.ok(r.left >= 0 && r.top >= 0 && r.right <= width && r.bottom <= height,
        `${s} at ${JSON.stringify(r)} outside ${width}x${height}`);
    }
    const map = rects["#sky-map"];
    assert.ok(map.right - map.left >= 500 && map.bottom - map.top >= 500,
      `map only ${map.right - map.left}x${map.bottom - map.top}`);
    assert.ok(rects["#sky-search"].top >= map.bottom, "buttons not below the map");
    assert.ok(rects["#panel"].left >= map.right, "panel not beside the map");
    assert.ok(scrollWidth <= width);
    assertCleanMapRun(log);
  });

test("at 390x844 the map spans the width, a tap selects and nothing scrolls sideways",
  { timeout: TIMEOUT }, async () => {
    await context.close();
    context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true });
    const { page, log } = await openPage({});
    await page.tap("#pick");
    await page.waitForFunction((hint) => document.querySelector("#sky-selection").textContent
      === hint, MAP_HINT, { timeout: 20_000 });
    const rect = await mapRect(page);
    await page.touchscreen.tap(rect.left + rect.width / 2 + 20, rect.top + rect.height / 2);
    await page.waitForFunction((re) => new RegExp(re).test(
      document.querySelector("#sky-selection").textContent), SELECTION.source);
    await waitForSelectionBox(page);
    const parts = ["#sky-map", "#sky-selection", "#sky-search", "#sky-close"];
    const { rects, width, scrollWidth } = await layout(page, [...parts, "#panel"]);
    for (const s of parts) {
      assert.ok(rects[s].left >= 0 && rects[s].right <= width, `${s} wider than the screen`);
    }
    assert.equal(rects["#sky-map"].right - rects["#sky-map"].left, width - 32);
    assert.ok(rects["#panel"].top >= rects["#sky-close"].bottom, "panel not below the map");
    assert.ok(scrollWidth <= width, `page scrolls to ${scrollWidth} of ${width}`);
    assert.deepEqual(log.searches, []);
    assertCleanMapRun(log);
  });

for (const [name, reply] of [
  ["a body that is not JSON", () => ({ status: 200, raw: "<html>" })],
  ["a body of the wrong shape", () => ({ status: 200, body: {} })],
]) {
  test(`a search answered with ${name} ends with an error instead of hanging`,
    { timeout: TIMEOUT }, async () => {
      const { page, log } = await openPage({ search: reply });
      await submit(page);
      assert.equal(await finalStatus(page), `Error: ${UNEXPECTED}`);
      assert.equal(log.searches.length, 1);
      assert.equal(log.frames.length, 0);
      assert.equal(await page.isDisabled("#play"), true);
      assertCleanRun(log);
    });
}

test("a frame answer of the wrong shape counts as a failed frame and loading continues",
  { timeout: TIMEOUT }, async () => {
    const plan = makePlan(THREE_FRAMES);
    const reply = frameOk(plan);
    const { page, log } = await openPage({
      search: () => ({ status: 200, body: plan }),
      frame: (n) => (n === 1 ? frameBody(pixels(1).slice(0, 10), 19) : reply(n)),
    });
    await submit(page);
    assert.equal(await finalStatus(page), "2 frames from 23 of 42 exposures. "
      + `1 frame could not be loaded: ${UNEXPECTED}. ${NO_DATA}`);
    assert.equal(log.frames.length, 3);
    const { min, max } = await sliderState(page);
    assert.equal(max - min + 1, 2);
    assertCleanRun(log);
  });

for (const { status, headers, seconds } of [
  { status: 429, headers: { "Retry-After": "1" }, seconds: 1 },
  { status: 503, headers: undefined, seconds: 2 },
]) {
  test(`a frame refused once with ${status} is asked again after ${seconds} s and loads`,
    { timeout: TIMEOUT }, async () => {
      const plan = makePlan(THREE_FRAMES);
      const reply = frameOk(plan);
      const { page, log } = await openPage({
        search: () => ({ status: 200, body: plan }),
        frame: (n, payload) => (n === 1
          ? { status, body: { detail: "Too many requests, try again later." }, headers }
          : reply(planIndex(plan, payload))),
      });
      await recordStatuses(page);
      await submit(page);
      const done = `3 frames from 42 of 42 exposures. ${NO_DATA}`;
      assert.equal(await finalStatus(page), done);
      assert.deepEqual(await statusHistory(page), [
        "Searching the SPHEREx archive\u2026",
        "Loading frame 1 of 3\u2026",
        "Loading frame 2 of 3\u2026",
        `Waiting ${seconds} s before continuing.`,
        "Loading frame 2 of 3\u2026",
        "Loading frame 3 of 3\u2026",
        ...surroundStatuses(done, 3),
      ]);
      assert.deepEqual(requestedFrames(plan, log), [0, 1, 1, 2]);
      const gap = log.frameTimes[2].sent - log.frameTimes[1].answered;
      assert.ok(gap >= seconds * 1000 - 100, `asked again ${gap} ms after the refusal`);
      assert.equal(log.maxInFlight, 1);
      assertCleanRun(log);
    });
}

test("a frame refused twice is reported as failed and later frames still load",
  { timeout: TIMEOUT }, async () => {
    const plan = makePlan(THREE_FRAMES);
    const reply = frameOk(plan);
    const { page, log } = await openPage({
      search: () => ({ status: 200, body: plan }),
      frame: (n, payload) => (planIndex(plan, payload) === 1
        ? {
          status: 429,
          body: { detail: "Too many requests, try again later." },
          headers: { "Retry-After": "1" },
        }
        : reply(planIndex(plan, payload))),
    });
    await submit(page);
    assert.equal(await finalStatus(page), "2 frames from 23 of 42 exposures. "
      + `1 frame could not be loaded: Too many requests, try again later. ${NO_DATA}`);
    assert.deepEqual(requestedFrames(plan, log), [0, 1, 1, 2]);
    const { max } = await sliderState(page);
    await selectFrame(page, max);
    assert.equal(await dateText(page), "2026-04-20 \u00b7 15 exposures");
    assertCleanRun(log);
  });

test("a search refused once with 429 is asked again and its frames load",
  { timeout: TIMEOUT }, async () => {
    const plan = makePlan(THREE_FRAMES);
    let searches = 0;
    const { page, log } = await openPage({
      search: () => (searches++ === 0
        ? {
          status: 429,
          body: { detail: "Too many requests, try again later." },
          headers: { "Retry-After": "1" },
        }
        : { status: 200, body: plan }),
      frame: frameOk(plan),
    });
    await recordStatuses(page);
    await submit(page);
    assert.equal(await finalStatus(page), `3 frames from 42 of 42 exposures. ${NO_DATA}`);
    assert.deepEqual((await statusHistory(page)).slice(0, 4), [
      "Searching the SPHEREx archive\u2026",
      "Waiting 1 s before continuing.",
      "Searching the SPHEREx archive\u2026",
      "Loading frame 1 of 3\u2026",
    ]);
    assert.equal(log.searches.length, 2);
    assert.equal(log.frames.length, 3);
    assertCleanRun(log);
  });

test("a new search during a wait cancels the old retry and its result stays",
  { timeout: TIMEOUT }, async () => {
    const first = makePlan(THREE_FRAMES);
    const second = {
      ...makePlan([{ label: "2026-05-01", n_available: 5, n_used: 5 }]), ra_deg: 10,
    };
    const { page, log } = await openPage({
      search: (url) => ({ status: 200, body: url.searchParams.get("ra") === RA ? first : second }),
      frame: (n, payload) => (payload.ra_deg === first.ra_deg
        ? { status: 429, body: { detail: "later" }, headers: { "Retry-After": "2" } }
        : frameBody(pixels(0), 5)),
    });
    await submit(page);
    await waitForStatus(page, (t) => t === "Waiting 2 s before continuing.");
    await recordStatuses(page);
    await submit(page, { ra: "10", dec: "-7.245147" });
    const done = `1 frame from 5 of 5 exposures. ${NO_DATA}`;
    assert.equal(await finalStatus(page), done);
    await page.waitForTimeout(2500);
    assert.deepEqual(log.frames.map((f) => f.ra_deg), [first.ra_deg, second.ra_deg]);
    assert.deepEqual(await statusHistory(page),
      ["Searching the SPHEREx archive\u2026", "Loading frame 1 of 1\u2026",
        ...surroundStatuses(done, 1)]);
    assert.equal(await text(page, "#name"), "RA 10, Dec -7.245147");
    assert.equal(await dateText(page), "2026-05-01 \u00b7 5 exposures");
    assertCleanRun(log);
  });

for (const nullFrame of [null, 2]) {
  test(`the no-data sentence ends the status only when a loaded frame lacks data `
    + `(${nullFrame === null ? "none does" : "one does"})`, { timeout: TIMEOUT }, async () => {
    const plan = makePlan(THREE_FRAMES);
    const clean = (n) => pixels(n).map((v) => v ?? 0.2);
    const { page, log } = await openPage({
      search: () => ({ status: 200, body: plan }),
      frame: (n) => frameBody(n === nullFrame ? pixels(n) : clean(n), plan.frames[n].n_used),
    });
    await recordStatuses(page);
    await submit(page);
    const done = nullFrame === null ? "3 frames from 42 of 42 exposures."
      : `3 frames from 42 of 42 exposures. ${NO_DATA}`;
    assert.equal(await finalStatus(page), done);
    assert.deepEqual(await statusHistory(page), [
      "Searching the SPHEREx archive\u2026",
      "Loading frame 1 of 3\u2026",
      "Loading frame 2 of 3\u2026",
      "Loading frame 3 of 3\u2026",
      ...surroundStatuses(done, 3),
    ]);
    assertCleanRun(log);
  });
}

test("the no-data sentence follows the cap notice and the failed-frame sentence",
  { timeout: TIMEOUT }, async () => {
    const plan = makePlan([
      { label: "2025-05-06", n_available: 8, n_used: 8 },
      { label: "2025-06-01 \u2013 2025-06-29", n_available: 300, n_used: 24 },
      { label: "2025-07-01 \u2013 2025-07-29", n_available: 92, n_used: 24 },
    ]);
    const reply = frameOk(plan);
    const { page, log } = await openPage({
      search: () => ({ status: 200, body: plan }),
      frame: (n) => (n === 2 ? { status: 502, body: { detail: "every exposure failed" } }
        : reply(n)),
    });
    await submit(page);
    assert.equal(await finalStatus(page), "2 frames from 32 of 400 exposures. "
      + "Cap applied: 2 of 3 frames use 24 of their exposures, evenly spaced in time order. "
      + `1 frame could not be loaded: every exposure failed. ${NO_DATA}`);
    assertCleanRun(log);
  });

test("moving the timeline during playback pauses on the chosen frame", { timeout: TIMEOUT },
  async () => {
    const { page, log } = await openPage({});
    await page.click("#play");
    assert.equal(await text(page, "#play"), "Pause");
    await page.focus("#slider");
    await page.keyboard.press("End");
    assert.equal(await text(page, "#play"), "Play");
    await page.waitForTimeout(1300);
    assert.equal((await sliderState(page)).value, 2);
    assert.equal(await dateText(page), EXAMPLE_LABELS[2]);
    assert.deepEqual(await canvasPixels(page), exampleRGBA(2));
    assertCleanRun(log);
  });

test("the timeline announces the shown frame's label and nothing while no frame is shown",
  { timeout: TIMEOUT }, async () => {
    const plan = makePlan(THREE_FRAMES);
    const gate = deferred();
    const reply = frameOk(plan);
    const { page, log } = await openPage({
      search: () => ({ status: 200, body: plan }),
      frame: async (n) => {
        await gate.promise;
        return reply(n);
      },
    });
    const announced = () => page.getAttribute("#slider", "aria-valuetext");
    try {
      assert.equal(await announced(), EXAMPLE_LABELS[0]);
      await selectFrame(page, 2);
      assert.equal(await announced(), EXAMPLE_LABELS[2]);
      await page.click("#play");
      await page.waitForFunction(() => document.querySelector("#slider").value !== "2");
      await page.click("#play");
      assert.equal(await announced(), await dateText(page));
      assert.notEqual(await announced(), EXAMPLE_LABELS[2]);

      await submit(page);
      await waitForStatus(page, (t) => t.startsWith("Loading frame 1"));
      assert.equal(await announced(), null);
      gate.release();
      await finalStatus(page);
      assert.equal(await announced(), "2025-05-06 \u00b7 8 exposures");
      await selectFrame(page, 2);
      assert.equal(await announced(), "2026-04-20 \u00b7 15 exposures");
      assertCleanRun(log);
    } finally {
      gate.release();
    }
  });

test("at phone widths the date row and the panel keep their place for short and long labels",
  { timeout: TIMEOUT }, async () => {
    const plan = makePlan([
      { label: "2025-05-06", n_available: 8, n_used: 8 },
      { label: "2025-11-07 \u2013 2025-11-10", n_available: 24, n_used: 24 },
    ]);
    const { page, log } = await openPage({
      search: () => ({ status: 200, body: plan }), frame: frameOk(plan),
    });
    await submit(page);
    await finalStatus(page);
    for (const width of [320, 360, 390]) {
      await page.setViewportSize({ width, height: 800 });
      const boxes = [];
      for (const n of [0, 1]) {
        await selectFrame(page, n);
        boxes.push(await page.evaluate(() => ({
          date: document.querySelector("#date").getBoundingClientRect().height,
          panel: document.querySelector("#panel").getBoundingClientRect().top,
        })));
      }
      assert.equal(await dateText(page), "2025-11-07 \u2013 2025-11-10 \u00b7 24 exposures");
      assert.deepEqual(boxes[1], boxes[0], `at ${width} px`);
    }
    assertCleanRun(log);
  });

test("the Difference box draws each example frame minus the others, unticking restores it",
  { timeout: TIMEOUT }, async () => {
    const { page, log } = await openPage({});
    assert.equal(await page.isEnabled("#difference"), true);
    assert.equal(await page.isChecked("#difference"), false);
    const [color, cursor] = await differenceLook(page);
    assert.notEqual(color, MUTED);
    assert.equal(cursor, "pointer");
    assert.equal(await page.getAttribute("#image", "aria-label"), IMAGE_LABEL);

    await page.click("#difference-control");
    assert.equal(await page.isChecked("#difference"), true);
    for (const n of [0, 1, 2]) {
      if (n > 0) await page.click("#next");
      assert.equal((await sliderState(page)).value, n);
      assert.deepEqual(await canvasPixels(page), differenceRGBA(EXAMPLE_FRAMES, n));
      assert.notDeepEqual(await canvasPixels(page), exampleRGBA(n));
      assert.equal(await dateText(page), EXAMPLE_LABELS[n]);
      await assertMarkerAt(page, EXAMPLE_MARKERS[n]);
      assert.equal(await page.getAttribute("#image", "aria-label"), DIFFERENCE_LABEL);
    }
    await selectFrame(page, 1);
    assert.deepEqual(await canvasPixels(page), differenceRGBA(EXAMPLE_FRAMES, 1));

    await page.click("#difference-control");
    assert.equal(await page.isChecked("#difference"), false);
    assert.deepEqual(await canvasPixels(page), exampleRGBA(1));
    assert.equal(await dateText(page), EXAMPLE_LABELS[1]);
    await assertMarkerAt(page, EXAMPLE_MARKERS[1]);
    assert.equal(await page.getAttribute("#image", "aria-label"), IMAGE_LABEL);
    assert.equal(await text(page, "#play"), "Play");
    assertCleanRun(log);
  });

test("with Difference ticked, frames that are all equal are drawn mid-grey",
  { timeout: TIMEOUT }, async () => {
    const plan = makePlan(THREE_FRAMES);
    const { page, log } = await openPage({
      search: () => ({ status: 200, body: plan }),
      frame: (n) => frameBody(pixels(1), plan.frames[n].n_used),
    });
    await submit(page);
    await finalStatus(page);
    await page.click("#difference-control");
    const rgba = await canvasPixels(page);
    for (let i = 0; i < SIZE * SIZE; i++) {
      const expected = i === 1770 ? [0, 0, 0, 0] : [128, 128, 128, 255];
      assert.deepEqual(rgba.slice(4 * i, 4 * i + 4), expected, `pixel ${i}`);
    }
    assertCleanRun(log);
  });

test("the timeline is at least 24 px high on a phone and on a desktop", { timeout: TIMEOUT },
  async () => {
    const { page, log } = await openPage({});
    for (const width of [360, 1366]) {
      await page.setViewportSize({ width, height: 800 });
      const { height } = await page.locator("#slider").boundingBox();
      assert.ok(height >= 24, `timeline ${height} px high at ${width} px`);
    }
    assertCleanRun(log);
  });

test("the detector options state their wavelength range and fit at 320 px width",
  { timeout: TIMEOUT }, async () => {
    const { page, log } = await openPage({});
    assert.deepEqual(await page.$$eval("#detector option", (els) => els.map((el) => el.text)), [
      "D1 \u00b7 0.75\u20131.1 \u00b5m",
      "D2 \u00b7 1.1\u20131.6 \u00b5m",
      "D3 \u00b7 1.6\u20132.4 \u00b5m",
      "D4 \u00b7 2.4\u20133.8 \u00b5m",
      "D5 \u00b7 3.8\u20134.4 \u00b5m",
      "D6 \u00b7 4.4\u20135.0 \u00b5m",
    ]);
    await page.setViewportSize({ width: 320, height: 800 });
    const { scroll, client } = await page.evaluate(() => ({
      scroll: document.documentElement.scrollWidth,
      client: document.documentElement.clientWidth,
    }));
    assert.ok(scroll <= client, `page scrolls to ${scroll} of ${client}`);
    assertCleanRun(log);
  });

// --- Interactions of the sky map with the loading and player rules -------------------------

test("Search here follows the loading rules: a refused search waits once, a frame answer of "
  + "the wrong shape counts as failed", { timeout: TIMEOUT }, async () => {
  const plan = makePlan(THREE_FRAMES);
  const reply = frameOk(plan);
  let searches = 0;
  const { page, log } = await openPage({
    search: () => (searches++ === 0
      ? {
        status: 429,
        body: { detail: "Too many requests, try again later." },
        headers: { "Retry-After": "1" },
      }
      : { status: 200, body: plan }),
    frame: (n) => (n === 1 ? frameBody(pixels(1).slice(0, 10), 19) : reply(n)),
  });
  await openMap(page);
  const pick = await clickMap(page, 25, 15);
  await recordStatuses(page);
  await page.click("#sky-search");
  const done = "2 frames from 23 of 42 exposures. "
    + `1 frame could not be loaded: ${UNEXPECTED}. ${NO_DATA}`;
  assert.equal(await finalStatus(page), done);
  assert.deepEqual(await statusHistory(page), [
    "Searching the SPHEREx archive\u2026",
    "Waiting 1 s before continuing.",
    "Searching the SPHEREx archive\u2026",
    "Loading frame 1 of 3\u2026",
    "Loading frame 2 of 3\u2026",
    "Loading frame 3 of 3\u2026",
    ...surroundStatuses(done, 2),
  ]);
  assert.equal(log.searches.length, 2);
  for (const url of log.searches) assert.equal(url.searchParams.get("ra"), pick.text[1]);
  assert.equal(log.frames.length, 3);
  assertCleanMapRun(log);
});

test("a map-started search answered with a body that is not JSON ends with an error",
  { timeout: TIMEOUT }, async () => {
    const { page, log } = await openPage({ search: () => ({ status: 200, raw: "<html>" }) });
    await openMap(page);
    await clickMap(page, 25, 15);
    await page.click("#sky-search");
    assert.equal(await finalStatus(page), `Error: ${UNEXPECTED}`);
    assert.equal(log.frames.length, 0);
    assert.equal(await page.isDisabled("#play"), true);
    assertCleanMapRun(log);
  });

test("opening and closing the map while playing leaves playback running; the timeline then "
  + "pauses it and Search here stops it", { timeout: TIMEOUT }, async () => {
  const plan = makePlan(THREE_FRAMES);
  const { page, log } = await openPage({
    search: () => ({ status: 200, body: plan }), frame: frameOk(plan),
  });
  await page.click("#play");
  await openMap(page);
  assert.equal(await page.isVisible("#slider"), false);
  await page.click("#sky-close");
  assert.equal(await text(page, "#play"), "Pause");
  const before = (await sliderState(page)).value;
  await page.waitForFunction((v) => document.querySelector("#slider").value !== String(v),
    before);
  await selectFrame(page, 2);
  assert.equal(await text(page, "#play"), "Play");
  await page.waitForTimeout(1300);
  assert.equal((await sliderState(page)).value, 2);
  assert.deepEqual(await canvasPixels(page), exampleRGBA(2));

  await page.click("#play");
  await openMap(page);
  // Reopened, Aladin redraws its sky canvas a moment later; a click before that misses it.
  await page.waitForTimeout(300);
  await clickMap(page, 25, 15);
  await page.click("#sky-search");
  assert.equal(await text(page, "#play"), "Play");
  assert.equal(await finalStatus(page), `3 frames from 42 of 42 exposures. ${NO_DATA}`);
  await page.waitForTimeout(1300);
  assert.equal((await sliderState(page)).value, 0);
  assert.equal(await text(page, "#play"), "Play");
  assertCleanMapRun(log);
});

test("Difference is enabled from a search's second frame, follows new frames and a new "
  + "search unticks it", { timeout: TIMEOUT }, async () => {
  const plan = makePlan(THREE_FRAMES);
  const gates = Array.from({ length: 6 }, () => deferred());
  const reply = frameOk(plan);
  const { page, log } = await openPage({
    search: () => ({ status: 200, body: plan }),
    frame: async (n) => {
      await gates[n].promise;
      return reply(n % 3);
    },
  });
  const state = () => page.$eval("#difference", (el) => [el.disabled, el.checked]);
  const loaded = (n) => [0, 1, 2].slice(0, n).map((k) => ({
    pixels: pixels(k), width: SIZE, height: SIZE, nUsed: plan.frames[k].n_used,
  }));
  try {
    await submit(page);
    await waitForStatus(page, (t) => t.startsWith("Loading frame 1"));
    assert.deepEqual(await state(), [true, false]);
    gates[0].release();
    await waitForStatus(page, (t) => t.startsWith("Loading frame 2"));
    assert.deepEqual(await state(), [true, false]);
    gates[1].release();
    await waitForStatus(page, (t) => t.startsWith("Loading frame 3"));
    assert.deepEqual(await state(), [false, false]);

    await page.click("#difference-control");
    assert.deepEqual(await canvasPixels(page), differenceRGBA(loaded(2), 0));
    gates[2].release();
    await finalStatus(page);
    assert.deepEqual(await canvasPixels(page), differenceRGBA(loaded(3), 0));
    assert.equal(await page.getAttribute("#image", "aria-label"), DIFFERENCE_LABEL);

    await submit(page, { detector: "D5" });
    await waitForStatus(page, (t) => t.startsWith("Loading frame 1"));
    assert.deepEqual(await state(), [true, false]);
    assert.equal(await page.getAttribute("#image", "aria-label"), IMAGE_LABEL);
    assertCleanRun(log);
  } finally {
    gates.forEach((g) => g.release());
  }
});

test("a one-frame result leaves Difference disabled", { timeout: TIMEOUT }, async () => {
  const plan = makePlan([{ label: "2025-05-06", n_available: 8, n_used: 8 }]);
  const { page, log } = await openPage({
    search: () => ({ status: 200, body: plan }), frame: frameOk(plan),
  });
  await submit(page);
  assert.equal(await finalStatus(page), `1 frame from 8 of 8 exposures. ${NO_DATA}`);
  assert.equal(await page.isDisabled("#difference"), true);
  assert.equal(await page.isChecked("#difference"), false);
  assert.deepEqual(await differenceLook(page), [MUTED, "default"]);
  assertCleanRun(log);
});

test("at 360 px width nothing scrolls sideways", { timeout: TIMEOUT }, async () => {
  const { page, log } = await openPage({});
  await page.setViewportSize({ width: 360, height: 800 });
  const { width, scrollWidth } = await layout(page, ["#difference-control"]);
  assert.ok(scrollWidth <= width, `page scrolls to ${scrollWidth} of ${width}`);
  // The label wraps here; the checkbox must keep its size instead of being squeezed.
  assert.deepEqual(await page.$eval("#difference", (el) => [el.offsetWidth, el.offsetHeight]),
    [18, 18]);
  assertCleanRun(log);
});

const LINK = `?ra=${RA}&dec=${DEC}&detector=D6`;

test("a link with ra, dec and detector runs that search on load without the example",
  { timeout: TIMEOUT }, async () => {
    const plan = makePlan(THREE_FRAMES, { detector: "D6" });
    const { page, log } = await openPage({
      query: LINK, search: () => ({ status: 200, body: plan }), frame: frameOk(plan),
    });
    assert.equal(await finalStatus(page), `3 frames from 42 of 42 exposures. ${NO_DATA}`);
    assert.equal(log.searches.length, 1);
    const search = log.searches[0].searchParams;
    assert.deepEqual([search.get("ra"), search.get("dec"), search.get("detector")],
      [RA, DEC, "D6"]);
    assert.equal(log.frames.length, 3);
    assert.equal(await dateText(page), "2025-05-06 · 8 exposures");
    assert.equal(await text(page, "#name"), `RA ${RA}, Dec ${DEC}`);
    assert.equal(await page.inputValue("#ra"), RA);
    assert.equal(await page.inputValue("#dec"), DEC);
    assert.equal(await page.inputValue("#detector"), "D6");
    assert.deepEqual(log.examples, []);
    assert.equal(await page.evaluate(() => location.search), LINK);
    assertCleanRun(log);
  });

for (const query of ["?detector=D6", "?ra=1"]) {
  test(`an incomplete link (${query}) shows the example`, { timeout: TIMEOUT }, async () => {
    const { page, log } = await openPage({ query });
    assert.deepEqual(log.examples, [new URL("example.json", baseUrl).href]);
    assert.deepEqual(await canvasPixels(page), exampleRGBA(0));
    assert.equal(await text(page, "#name"), "Test Star");
    assert.equal(await dateText(page), EXAMPLE_LABELS[0]);
    assert.deepEqual(log.searches, []);
    assertCleanRun(log);
  });
}

test("a submitted search leaves its link in the address bar and a reload repeats it",
  { timeout: TIMEOUT }, async () => {
    const plan = makePlan(THREE_FRAMES, { detector: "D5" });
    const reply = frameOk(plan);
    const { page, log } = await openPage({
      search: () => ({ status: 200, body: plan }), frame: (n) => reply(n % 3),
    });
    const historyLength = await page.evaluate(() => history.length);
    await submit(page, { detector: "D5" });
    await finalStatus(page);
    assert.equal(await page.evaluate(() => location.search),
      `?ra=${RA}&dec=${DEC}&detector=D5`);
    assert.equal(await page.evaluate(() => history.length), historyLength);
    await page.reload();
    await waitForStatus(page, (t) => t === `3 frames from 42 of 42 exposures. ${NO_DATA}`);
    assert.equal(log.searches.length, 2);
    assert.equal(log.searches[1].href, log.searches[0].href);
    assert.equal(log.examples.length, 1);
    assertCleanRun(log);
  });

test("a link with an unknown detector searches the default detector", { timeout: TIMEOUT },
  async () => {
    const plan = makePlan(THREE_FRAMES);
    const { page, log } = await openPage({
      query: `?ra=${RA}&dec=${DEC}&detector=D9`,
      search: () => ({ status: 200, body: plan }), frame: frameOk(plan),
    });
    await finalStatus(page);
    assert.equal(log.searches[0].searchParams.get("detector"), "D2");
    assert.equal(await page.inputValue("#detector"), "D2");
    assert.equal(await page.evaluate(() => location.search), `?ra=${RA}&dec=${DEC}&detector=D9`);
    assertCleanRun(log);
  });

test("markup in a link reaches the page only as text and the server rejects it",
  { timeout: TIMEOUT }, async () => {
    const ra = "<img src=x onerror=alert(1)>";
    const { page, log } = await openPage({
      query: `?ra=${encodeURIComponent(ra)}&dec=${encodeURIComponent(DEC)}&detector=D6`,
      search: null,
    });
    assert.equal(await finalStatus(page), `Error: ${INVALID_RA}`);
    assert.equal(log.searches[0].searchParams.get("ra"), ra);
    assert.equal(await text(page, "#name"), `RA ${ra}, Dec ${DEC}`);
    assert.equal(await page.inputValue("#ra"), ra);
    assert.equal((await page.$$("img")).length, 0);
    assert.deepEqual(await bodyElements(page), BODY);
    assertCleanRun(log);
  });

// --- Interactions of the sky map with the difference view and result links -----------------

test("Search here leaves its link in the address bar like a typed search and a reload "
  + "repeats it", { timeout: TIMEOUT }, async () => {
  const plan = makePlan(THREE_FRAMES, { detector: "D5" });
  const reply = frameOk(plan);
  const { page, log } = await openPage({
    search: () => ({ status: 200, body: plan }), frame: (n) => reply(n % 3),
  });
  await page.selectOption("#detector", "D5");
  const historyLength = await page.evaluate(() => history.length);
  await openMap(page);
  const pick = await clickMap(page, 25, 15);
  await page.click("#sky-search");
  const done = `3 frames from 42 of 42 exposures. ${NO_DATA}`;
  assert.equal(await finalStatus(page), done);
  assert.equal(await page.evaluate(() => location.search),
    `?ra=${pick.text[1]}&dec=${pick.text[2]}&detector=D5`);
  assert.equal(await page.evaluate(() => history.length), historyLength);
  await page.reload();
  await waitForStatus(page, (t) => t === done);
  assert.equal(log.searches.length, 2);
  assert.equal(log.searches[1].href, log.searches[0].href);
  assert.equal(log.examples.length, 1);
  assert.equal(await page.inputValue("#ra"), pick.text[1]);
  assert.equal(await page.inputValue("#dec"), pick.text[2]);
  assertCleanMapRun(log);
});

test("a page opened with a link opens the sky map centred on the linked result",
  { timeout: TIMEOUT }, async () => {
    const plan = makePlan(THREE_FRAMES, { detector: "D6" });
    const { page, log } = await openPage({
      query: `?ra=${encodeURIComponent(RA)}&dec=${encodeURIComponent(DEC)}&detector=D6`,
      search: () => ({ status: 200, body: plan }), frame: frameOk(plan),
    });
    assert.equal(await finalStatus(page), `3 frames from 42 of 42 exposures. ${NO_DATA}`);
    await openMap(page);
    const centre = await clickMap(page, 0, 0);
    const cosDec = Math.cos((plan.dec_deg * Math.PI) / 180);
    assert.ok(Math.abs((centre.ra - plan.ra_deg) * cosDec) < 0.01
      && Math.abs(centre.dec - plan.dec_deg) < 0.01, `centre ${centre.ra}, ${centre.dec}`);
    assert.deepEqual(log.examples, []);
    assert.equal(log.searches.length, 1);
    assertCleanMapRun(log);
  });

test("Difference applies to a map-started search's frames; opening the map keeps it, Search "
  + "here unticks it", { timeout: TIMEOUT }, async () => {
  const plan = makePlan(THREE_FRAMES);
  const reply = frameOk(plan);
  const gate = deferred();
  const { page, log } = await openPage({
    search: () => ({ status: 200, body: plan }),
    frame: async (n) => {
      if (n >= 3) await gate.promise;
      return reply(n % 3);
    },
  });
  const state = () => page.$eval("#difference", (el) => [el.disabled, el.checked]);
  const loaded = [0, 1, 2].map((k) => ({
    pixels: pixels(k), width: SIZE, height: SIZE, nUsed: plan.frames[k].n_used,
  }));
  await openMap(page);
  await clickMap(page, 25, 15);
  await page.click("#sky-search");
  await finalStatus(page);
  assert.deepEqual(await state(), [false, false]);
  await page.click("#difference-control");
  assert.deepEqual(await canvasPixels(page), differenceRGBA(loaded, 0));
  assert.equal(await page.getAttribute("#image", "aria-label"), DIFFERENCE_LABEL);

  await openMap(page);
  await page.click("#sky-close");
  assert.deepEqual(await state(), [false, true]);
  assert.deepEqual(await canvasPixels(page), differenceRGBA(loaded, 0));

  await openMap(page);
  await page.waitForTimeout(300);
  await clickMap(page, -25, 15);
  await page.click("#sky-search");
  await waitForStatus(page, (t) => t.startsWith("Loading frame 1"));
  assert.deepEqual(await state(), [true, false]);
  assert.equal(await page.getAttribute("#image", "aria-label"), IMAGE_LABEL);
  gate.release();
  await finalStatus(page);
  assert.deepEqual(await state(), [false, false]);
  assert.deepEqual(await canvasPixels(page), Array.from(toRGBA(loaded[0].pixels,
    computeStretch(loaded.map((f) => f.pixels)))));
  assertCleanMapRun(log);
});

test("with Difference ticked, the map opened during playback leaves both running; the "
  + "timeline then pauses on the chosen difference frame", { timeout: TIMEOUT }, async () => {
  const { page, log } = await openPage({});
  await page.click("#difference-control");
  await page.click("#play");
  await openMap(page);
  await page.click("#sky-close");
  assert.equal(await text(page, "#play"), "Pause");
  assert.equal(await page.isChecked("#difference"), true);
  const before = (await sliderState(page)).value;
  await page.waitForFunction((v) => document.querySelector("#slider").value !== String(v),
    before);
  await selectFrame(page, 2);
  assert.equal(await text(page, "#play"), "Play");
  await page.waitForTimeout(1300);
  assert.equal((await sliderState(page)).value, 2);
  assert.deepEqual(await canvasPixels(page), differenceRGBA(EXAMPLE_FRAMES, 2));
  assert.equal(await page.getAttribute("#image", "aria-label"), DIFFERENCE_LABEL);
  assertCleanMapRun(log);
});

// --- Zooming and moving ----------------------------------------------------------------------

/** A wide answer with the narrow answer served for the same exposures at its centre. */
function texturedWide(n, payload, served) {
  const narrow = served.get(payload.uris.join());
  return wideBody(widePixels(narrow.pixels, (x, y) => ((x * 5 + y * 3) % 40) / 100),
    narrow.n_used);
}

// More than 120 planned exposures: a deep field, whose surround loads only when first used and
// which never loads ahead.
const DEEP_FRAMES = [
  { label: "2025-05-06", n_available: 40, n_used: 40 },
  { label: "2025-11-07", n_available: 40, n_used: 40 },
  { label: "2026-04-20", n_available: 41, n_used: 41 },
];

/**
 * Waits until the surround's pixels have replaced the "not loaded" fields of the wide grid and
 * nothing loads any more (the frame on screen gets its surround before the others).
 */
async function waitForSurround(page) {
  await page.waitForFunction((n) => {
    const image = document.querySelector("#image");
    return image.width === n && !image.classList.contains("pending")
      && !document.querySelector("#status").textContent.includes("Loading");
  }, WIDE);
}

/**
 * Searches `plan` and waits until its surround has replaced the narrow frames; for a deep
 * field it zooms out once to load it and back in. The view is then at 1x on the centre.
 */
async function openWithSurround({ plan = makePlan(THREE_FRAMES), ...options } = {}) {
  const { page, log } = await openPage({
    search: () => ({ status: 200, body: plan }), frame: frameOk(plan), wide: texturedWide,
    ...options,
  });
  await submit(page);
  await finalStatus(page);
  if (plan.frames.reduce((n, f) => n + f.uris.length, 0) > 120) {
    await page.click("#zoom-out");
    await page.click("#zoom-in");
  }
  await waitForSurround(page);
  await finalStatus(page);
  await page.evaluate(() => document.activeElement.blur());
  return { page, log, plan };
}

/** The stage's size and offset in percent of the frame, as on screen. */
async function stageGeometry(page) {
  return page.evaluate(() => {
    const frame = document.querySelector("#frame").getBoundingClientRect();
    const stage = document.querySelector("#stage").getBoundingClientRect();
    return {
      size: (100 * stage.width) / frame.width,
      left: (100 * (stage.left - frame.left)) / frame.width,
      top: (100 * (stage.top - frame.top)) / frame.height,
    };
  });
}

async function assertStage(page, view, grid) {
  const actual = await stageGeometry(page);
  const expected = stageBox(view, grid);
  for (const key of ["size", "left", "top"]) {
    assert.ok(Math.abs(actual[key] - expected[key]) < 0.05,
      `${key}: ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`);
  }
}

const press = async (page, key, times = 1) => {
  for (let i = 0; i < times; i++) await page.keyboard.press(key);
};

const apiRequests = (log) => log.requests.filter((u) => new URL(u).pathname.startsWith("/api/"));

test("zooming during playback steps through every level without stopping playback",
  { timeout: TIMEOUT }, async () => {
    const { page, log } = await openWithSurround();
    await page.click("#play");
    await page.evaluate(() => document.activeElement.blur());
    const centre = { cx: 88, cy: 88 };
    await assertStage(page, { zoom: 1, ...centre }, WIDE);
    for (const zoom of [2, 4]) {
      await page.keyboard.type("+");
      await assertStage(page, { zoom, ...centre }, WIDE);
    }
    assert.equal(await page.isDisabled("#zoom-in"), true);
    await page.keyboard.type("+");
    await assertStage(page, { zoom: 4, ...centre }, WIDE);
    for (const zoom of [2, 1, 1 / 2]) {
      await page.click("#zoom-out");
      await assertStage(page, { zoom, ...centre }, WIDE);
    }
    await page.evaluate(() => document.activeElement.blur());
    await page.keyboard.type("-");
    await assertStage(page, { zoom: 1 / 3, ...centre }, WIDE);
    assert.equal(await page.isDisabled("#zoom-out"), true);
    await page.click("#zoom-in");
    await assertStage(page, { zoom: 1 / 2, ...centre }, WIDE);
    await page.evaluate(() => document.activeElement.blur());
    await page.keyboard.press("Equal");
    await assertStage(page, { zoom: 1, ...centre }, WIDE);

    assert.equal(await text(page, "#play"), "Pause");
    const before = (await sliderState(page)).value;
    await page.waitForFunction((v) => document.querySelector("#slider").value !== String(v),
      before, { timeout: 2000 });
    assert.equal(await text(page, "#play"), "Pause");
    assertCleanRun(log);
  });

test("the surround replaces the frames with the picture unchanged and enables zooming out",
  { timeout: TIMEOUT }, async () => {
    const plan = makePlan(THREE_FRAMES);
    const gate = deferred();
    const { page, log } = await openPage({
      search: () => ({ status: 200, body: plan }), frame: frameOk(plan),
      wide: async (n, payload, served) => {
        await gate.promise;
        return texturedWide(n, payload, served);
      },
    });
    try {
      await page.setViewportSize({ width: 1366, height: 768 });
      await submit(page);
      const done = `3 frames from 42 of 42 exposures. ${NO_DATA}`;
      assert.equal(await waitForStatus(page, (t) => t.includes("surrounding")),
        `${done} Loading the surrounding area: frame 1 of 3…`);
      await selectFrame(page, 1);
      assert.equal(await page.isDisabled("#zoom-out"), false);
      assert.equal(await page.isDisabled("#zoom-in"), false);
      assert.deepEqual(await page.$eval("#image", (el) => [el.width, el.height]), [WIDE, WIDE]);
      assert.equal(await page.$eval("#image", (el) => el.classList.contains("pending")), true);
      const before = await page.locator("#frame").screenshot();
      gate.release();
      await waitForSurround(page);
      assert.equal(await finalStatus(page), done);
      assert.deepEqual(await page.$eval("#image", (el) => [el.width, el.height]), [WIDE, WIDE]);
      assert.ok(before.equals(await page.locator("#frame").screenshot()), "picture changed");
      assert.equal((await sliderState(page)).value, 1);
      assert.equal(await page.isDisabled("#zoom-out"), false);
      assert.deepEqual(log.wides.map((p) => [p.fields, planIndex(plan, p), p.ra_deg, p.dec_deg]),
        [0, 1, 2].map((i) => [3, i, plan.ra_deg, plan.dec_deg]));
      assert.equal(log.frames.length, 3);
      assert.equal(log.searches.length, 1);

      await page.click("#zoom-out");
      await assertStage(page, { zoom: 1 / 2, cx: 88, cy: 88 }, WIDE);
      assertCleanRun(log);
    } finally {
      gate.release();
    }
  });

test("in a deep field moving and zooming inside the loaded area sends no request",
  { timeout: TIMEOUT }, async () => {
    const { page, log } = await openWithSurround({ plan: makePlan(DEEP_FRAMES) });
    const sent = apiRequests(log).length;
    await page.keyboard.type("+");
    await press(page, "ArrowLeft", 6);
    await press(page, "ArrowUp", 6);
    await assertStage(page, { zoom: 2, cx: 88 - 24, cy: 88 - 24 }, WIDE);
    await page.keyboard.type("-");
    await press(page, "ArrowRight", 8);
    await press(page, "ArrowDown", 8);
    await page.keyboard.type("-");
    await assertStage(page, { zoom: 1 / 2, cx: 117.5, cy: 117.5 }, WIDE);
    await page.waitForTimeout(800);
    assert.equal(apiRequests(log).length, sent);
    assert.deepEqual([log.searches.length, log.frames.length, log.wides.length], [1, 3, 3]);
    assertCleanRun(log);
  });

test("in a deep field a key held at the edge searches the next area once, only after it rests",
  { timeout: TIMEOUT }, async () => {
    const plan = makePlan(DEEP_FRAMES);
    const gate = deferred();
    const { page, log } = await openWithSurround({
      plan,
      search: async (url) => {
        if (url.searchParams.get("ra") === RA) return { status: 200, body: plan };
        await gate.promise;
        return { status: 500, body: { detail: "unused" } };
      },
    });
    try {
      await press(page, "ArrowLeft", 9);
      await assertStage(page, { zoom: 1, cx: 29, cy: 88 }, WIDE);
      // Held for longer than the rest time: every push restarts it, so nothing is searched.
      for (let i = 0; i < 16; i++) {
        await page.keyboard.down("ArrowLeft");
        await page.waitForTimeout(60);
      }
      assert.equal(log.searches.length, 1);
      await page.keyboard.up("ArrowLeft");
      await page.waitForTimeout(300);
      assert.equal(log.searches.length, 1);
      await waitForStatus(page, (t) => t === "Searching the next area…");
      assert.equal(log.searches.length, 2);
      const params = log.searches[1].searchParams;
      // Two fields on: the field the view enters is the new area's centre.
      const east = offsetPosition(plan.ra_deg, plan.dec_deg, -2 * SIZE, 0);
      assert.deepEqual([params.get("ra"), params.get("dec"), params.get("detector")],
        [fieldTexts(east.ra, east.dec).ra, fieldTexts(east.ra, east.dec).dec, "D2"]);

      for (let i = 0; i < 10; i++) await page.keyboard.down("ArrowLeft");
      await page.keyboard.up("ArrowLeft");
      await press(page, "ArrowUp", 3);
      await press(page, "ArrowLeft", 3);
      await page.waitForTimeout(900);
      assert.equal(log.searches.length, 2);
      assertCleanRun(log);
    } finally {
      gate.release();
    }
  });

/** Records, for every key press on the page, the key and whether the page used it. */
async function recordKeyDefaults(page) {
  await page.evaluate(() => {
    window.keyDefaults = [];
    window.addEventListener("keydown", (e) => window.keyDefaults.push([e.key, e.defaultPrevented]));
  });
}

const keyDefaults = (page) => page.evaluate(() => window.keyDefaults.splice(0));

test("a push at the edge is cancelled by a move, a zoom or the sky map within the rest time",
  { timeout: TIMEOUT }, async () => {
    const { page, log } = await openWithSurround({ plan: makePlan(DEEP_FRAMES) });
    await recordKeyDefaults(page);
    await press(page, "ArrowLeft", 9);
    await assertStage(page, { zoom: 1, cx: 29, cy: 88 }, WIDE);
    await press(page, "ArrowLeft");
    // The push is used (a load is scheduled), so the page keeps the key.
    assert.deepEqual((await keyDefaults(page)).at(-1), ["ArrowLeft", true]);
    await page.waitForTimeout(100);
    // North: the view stays at the eastern edge, so only the cancelled timer prevents a search.
    await press(page, "ArrowUp");
    await assertStage(page, { zoom: 1, cx: 29, cy: 81 }, WIDE);
    await page.waitForTimeout(900);
    assert.equal(log.searches.length, 1);

    // A zoom within the rest time: zoomed in, the view is no longer at the edge.
    await press(page, "ArrowLeft");
    await page.keyboard.type("+");
    await assertStage(page, { zoom: 2, cx: 29, cy: 81 }, WIDE);
    await page.waitForTimeout(900);
    assert.equal(log.searches.length, 1);

    // The sky map opened and closed within the rest time.
    await page.keyboard.type("-");
    await press(page, "ArrowLeft");
    await assertStage(page, { zoom: 1, cx: 29, cy: 81 }, WIDE);
    await page.click("#pick");
    await page.click("#sky-close");
    await page.evaluate(() => document.activeElement?.blur());
    await page.waitForTimeout(900);
    assert.equal(log.searches.length, 1);
    assertCleanMapRun(log);
  });

test("a push at the edge while the surround loads is not used and loads nothing after it",
  { timeout: TIMEOUT }, async () => {
    const plan = makePlan(THREE_FRAMES);
    const gate = deferred();
    const { page, log } = await openPage({
      search: () => ({ status: 200, body: plan }), frame: frameOk(plan),
      wide: async (n, payload, served) => {
        if (n === 2) await gate.promise;
        return texturedWide(n, payload, served);
      },
    });
    try {
      await submit(page);
      // The last wide frame is held, so the surround is still loading during the presses.
      await page.waitForFunction(() => document.querySelector("#status").textContent
        .includes("Loading the surrounding area: frame 3 of 3"));
      await page.evaluate(() => document.activeElement.blur());
      await page.setViewportSize({ width: 700, height: 400 });
      await page.evaluate(() => window.scrollTo(0, 0));
      await recordKeyDefaults(page);
      await press(page, "ArrowDown", 9);
      await assertStage(page, { zoom: 1, cx: 88, cy: 147 }, WIDE);
      assert.equal(await page.evaluate(() => window.scrollY), 0);
      await press(page, "ArrowDown");
      assert.deepEqual((await keyDefaults(page)).at(-1), ["ArrowDown", false]);
      gate.release();
      await waitForSurround(page);
      await page.waitForTimeout(900);
      assert.equal(log.searches.length, 1);
      assert.equal(log.wides.length, 3);
      assert.equal(await finalStatus(page), `3 frames from 42 of 42 exposures. ${NO_DATA}`);
      assert.ok(await page.evaluate(() => window.scrollY) > 0, "ArrowDown did not scroll");
      assertCleanRun(log);
    } finally {
      gate.release();
    }
  });

test("the next area keeps the loaded detector, clamps the frame, unticks Difference for one "
  + "frame, leaves a focused RA field alone and moves the map's centre", { timeout: TIMEOUT },
  async () => {
    const first = makePlan(THREE_FRAMES);
    // Loaded ahead, two fields on.
    const east = offsetPosition(first.ra_deg, first.dec_deg, -2 * SIZE, 0);
    const eastTexts = fieldTexts(east.ra, east.dec);
    const second = {
      ...makePlan([{ label: "2025-06-01", n_available: 9, n_used: 9 }]),
      ra_deg: east.ra, dec_deg: east.dec,
    };
    const gate = deferred();
    const { page, log } = await openWithSurround({
      plan: first,
      search: (url) => ({ status: 200, body: url.searchParams.get("ra") === RA ? first : second }),
      wide: async (n, payload, served) => {
        if (payload.ra_deg === first.ra_deg) return texturedWide(n, payload, served);
        await gate.promise;
        return wideBody(widePixels(pixels(n), () => 0.3), payload.uris.length);
      },
    });
    try {
      await selectFrame(page, 2);
      await page.check("#difference");
      await page.selectOption("#detector", "D6");
      await page.evaluate(() => document.activeElement.blur());
      await press(page, "ArrowLeft", 10);
      await page.waitForFunction(() => document.querySelector("#status").textContent
        .startsWith("Loading the next area"));
      assert.equal(log.searches.length, 2);
      assert.equal(log.searches[1].searchParams.get("detector"), "D2");
      const typed = (await page.inputValue("#ra")) + "9";
      await page.focus("#ra");
      await page.keyboard.type("9");
      gate.release();
      await page.waitForFunction((ra) => location.search.includes(ra), eastTexts.ra);
      assert.equal(await finalStatus(page), `1 frame from 9 of 9 exposures. ${NO_DATA}`);
      const slider = await sliderState(page);
      assert.deepEqual([slider.value, slider.max], [0, 0]);
      assert.equal(await page.isChecked("#difference"), false);
      assert.equal(await page.isDisabled("#difference"), true);
      assert.equal(await page.inputValue("#ra"), typed);
      assert.equal(await page.inputValue("#dec"), DEC);
      assert.equal(await page.inputValue("#detector"), "D6");

      await openMap(page);
      const centre = await clickMap(page, 0, 0);
      const cosDec = Math.cos((east.dec * Math.PI) / 180);
      assert.ok(Math.abs((centre.ra - east.ra) * cosDec) < 0.01
        && Math.abs(centre.dec - east.dec) < 0.01, `centre ${centre.ra}, ${centre.dec}`);
      assertCleanMapRun(log);
    } finally {
      gate.release();
    }
  });

test("the next area replaces the frames with the view, zoom and playback kept and a new link",
  { timeout: TIMEOUT }, async () => {
    const first = makePlan(DEEP_FRAMES);
    const east = offsetPosition(first.ra_deg, first.dec_deg, -2 * SIZE, 0);
    const eastTexts = fieldTexts(east.ra, east.dec);
    const second = {
      ...makePlan([
        { label: "2025-06-01", n_available: 90, n_used: 90 },
        { label: "2025-12-01", n_available: 60, n_used: 60 },
      ]),
      ra_deg: east.ra, dec_deg: east.dec,
    };
    let searches = 0;
    // Central fields of the next area's frames, by plan index; its surround has a bright patch
    // that must not enter the stretch.
    const centres = [];
    const { page, log } = await openWithSurround({
      plan: first,
      search: () => {
        searches += 1;
        if (searches === 1) return { status: 200, body: first };
        if (searches === 2) return { status: 200, body: second };
        return { status: 502, body: { detail: "The archive could not be reached." } };
      },
      wide: (n, payload, served) => {
        if (payload.ra_deg === first.ra_deg) return texturedWide(n, payload, served);
        centres[planIndex(second, payload)] = pixels(n);
        return wideBody(widePixels(pixels(n), (x, y) => (x < 12 && y < 12 ? 80 : 0.3)),
          payload.uris.length);
      },
    });
    await page.click("#play");
    await page.evaluate(() => document.activeElement.blur());
    await page.keyboard.type("+");
    await press(page, "ArrowLeft", 25);
    await page.waitForFunction((ra) => location.search.includes(ra), eastTexts.ra);
    assert.equal(await finalStatus(page), `2 frames from 150 of 150 exposures. ${NO_DATA}`);
    const link = `?ra=${eastTexts.ra}&dec=${eastTexts.dec}&detector=D2`;
    assert.equal(await page.evaluate(() => location.search), link);
    assert.deepEqual([await page.inputValue("#ra"), await page.inputValue("#dec")],
      [eastTexts.ra, eastTexts.dec]);
    assert.equal(await text(page, "#name"), `RA ${eastTexts.ra}, Dec ${eastTexts.dec}`);
    assert.equal(await text(page, "#position"), formatPosition(east.ra, east.dec, "D2"));
    await assertStage(page, { zoom: 2, cx: 14.25 + 2 * SIZE, cy: 88 }, WIDE);
    assert.equal((await sliderState(page)).max, 1);
    assert.equal(log.wides.filter((p) => p.ra_deg === east.ra).length, 2);
    assert.equal(log.frames.length, 3);
    assert.equal(await text(page, "#play"), "Pause");
    const value = (await sliderState(page)).value;
    await page.waitForFunction((v) => document.querySelector("#slider").value !== String(v),
      value, { timeout: 2000 });
    await page.click("#play");
    await page.evaluate(() => document.activeElement.blur());
    const shownFrame = (await sliderState(page)).value;
    assert.deepEqual(await canvasPixels(page),
      Array.from(toRGBA(centres[shownFrame], computeStretch(centres))));

    const summary = `2 frames from 150 of 150 exposures. ${NO_DATA}`;
    await press(page, "ArrowLeft", 35);
    assert.equal(await waitForStatus(page, (t) => t.includes("The next area")),
      `${summary} The next area could not be loaded: The archive could not be reached.`);
    assert.equal(log.searches.length, 3);
    assert.equal(await page.evaluate(() => location.search), link);
    assert.deepEqual([await page.inputValue("#ra"), await page.inputValue("#dec")],
      [eastTexts.ra, eastTexts.dec]);
    assert.equal((await sliderState(page)).max, 1);
    assert.equal(await text(page, "#position"), formatPosition(east.ra, east.dec, "D2"));
    await assertStage(page, { zoom: 2, cx: 14.25, cy: 88 }, WIDE);
    assertCleanRun(log);
  });

test("zoom and arrow keys typed in a text field or the detector list leave the view alone",
  { timeout: TIMEOUT }, async () => {
    const { page, log } = await openWithSurround();
    const view = { zoom: 1, cx: 88, cy: 88 };
    await page.fill("#ra", "12");
    await page.focus("#ra");
    await page.keyboard.type("-+=");
    await press(page, "ArrowLeft", 2);
    await page.keyboard.type("3");
    await press(page, "ArrowUp");
    assert.equal(await page.inputValue("#ra"), "12-3+=");
    await assertStage(page, view, WIDE);
    await page.focus("#detector");
    await press(page, "ArrowDown");
    await page.keyboard.type("+");
    await assertStage(page, view, WIDE);
    await page.waitForTimeout(700);
    assert.equal(log.searches.length, 1);
    assertCleanRun(log);
  });

test("arrows on the focused timeline step frames; on the Difference box they move the view",
  { timeout: TIMEOUT }, async () => {
    const { page, log } = await openWithSurround();
    const view = { zoom: 1, cx: 88, cy: 88 };
    await page.focus("#slider");
    await press(page, "ArrowRight");
    assert.equal((await sliderState(page)).value, 1);
    assert.equal(await dateText(page), "2025-11-07 – 2025-11-10 · 19 exposures");
    await assertStage(page, view, WIDE);
    // The zoom keys have no meaning of their own on the timeline, so they zoom there.
    await page.keyboard.type("+");
    await assertStage(page, { ...view, zoom: 2 }, WIDE);
    await page.keyboard.type("-");
    await assertStage(page, view, WIDE);
    assert.equal((await sliderState(page)).value, 1);
    await page.focus("#difference");
    await press(page, "ArrowLeft");
    await assertStage(page, { ...view, cx: 81 }, WIDE);
    assert.equal(await page.isChecked("#difference"), false);

    // On the page itself an arrow that moves the view does not scroll the page.
    await page.setViewportSize({ width: 700, height: 400 });
    await page.evaluate(() => {
      document.activeElement.blur();
      window.scrollTo(0, 0);
    });
    assert.ok(await page.evaluate(() => document.documentElement.scrollHeight > innerHeight + 100));
    await press(page, "ArrowDown", 2);
    await page.waitForTimeout(300);
    const moved = { ...view, cx: 81, cy: 102 };
    await assertStage(page, moved, WIDE);
    assert.equal(await page.evaluate(() => window.scrollY), 0);
    // These moves loaded ahead; the keys below must send nothing more.
    const sent = log.searches.length;
    // Keys with Ctrl, Alt or Meta belong to the browser (Ctrl+- and Ctrl++ zoom the page).
    for (const key of ["Control+ArrowLeft", "Alt+ArrowLeft", "Meta+ArrowLeft", "Control+ArrowUp",
      "Control+Minus", "Control+Equal", "Alt+Minus", "Meta+Equal"]) await press(page, key);
    await page.waitForTimeout(700);
    await assertStage(page, moved, WIDE);
    assert.equal(log.searches.length, sent);
    assertCleanRun(log);
  });

test("on the example the arrow keys move the view and scroll the page only where the view "
  + "cannot use them; a zoom key at its limit keeps its default", { timeout: TIMEOUT },
async () => {
  const { plan } = examplePlan();
  const gate = deferred();
  const { page, log } = await openPage({
    search: async () => {
      await gate.promise;
      return { status: 200, body: plan };
    },
    frame: (n) => frameBody(pixels(n), plan.frames[n].n_used), wide: texturedWide,
  });
  try {
    await page.setViewportSize({ width: 700, height: 400 });
    assert.ok(await page.evaluate(() => document.documentElement.scrollHeight > innerHeight + 100));
    await page.evaluate(() => document.activeElement.blur());
    await recordKeyDefaults(page);
    await page.keyboard.type("++");
    await page.keyboard.type("+");
    assert.deepEqual(await keyDefaults(page), [["+", true], ["+", true], ["+", false]]);
    await page.keyboard.type("--");
    // The first move past the example's field widens the grid and searches its surroundings.
    await press(page, "ArrowDown", 9);
    await assertStage(page, { zoom: 1, cx: 88, cy: 147 }, WIDE);
    assert.equal(await page.evaluate(() => window.scrollY), 0);
    assert.equal(log.searches.length, 1);
    // At the edge, with the search held, the view cannot use the key: the page scrolls.
    await press(page, "ArrowDown", 2);
    await page.waitForTimeout(300);
    const scrolled = await page.evaluate(() => window.scrollY);
    assert.ok(scrolled > 0, "ArrowDown did not scroll the page");
    // Away from the edge the key moves the view again and the page stays.
    await press(page, "ArrowUp");
    await assertStage(page, { zoom: 1, cx: 88, cy: 140 }, WIDE);
    assert.equal(await page.evaluate(() => window.scrollY), scrolled);
    assert.equal(log.searches.length, 1);
    assertCleanRun(log);
  } finally {
    gate.release();
  }
});

test("the example zooms in and moves inside its field without any request; the marker stays",
  { timeout: TIMEOUT }, async () => {
    const { page, log } = await openPage({});
    const assertMarker = async (view) => {
      const g = await page.evaluate(() => {
        const frame = document.querySelector("#frame").getBoundingClientRect();
        const box = document.querySelector("#marker").getBoundingClientRect();
        return { frame: { left: frame.left, top: frame.top, width: frame.width },
          cx: box.left + box.width / 2, cy: box.top + box.height / 2, width: box.width };
      });
      const pixel = (g.frame.width * view.zoom) / SIZE;
      const { left, top } = stageBox(view, SIZE);
      const x = g.frame.left + (left / 100) * g.frame.width + (EXAMPLE_MARKERS[0].x + 0.5) * pixel;
      const y = g.frame.top + (top / 100) * g.frame.width + (EXAMPLE_MARKERS[0].y + 0.5) * pixel;
      assert.ok(Math.abs(g.cx - x) <= 1 && Math.abs(g.cy - y) <= 1,
        `marker at ${g.cx},${g.cy}, expected ${x},${y}`);
      assert.ok(Math.abs(g.width - 6 * pixel) <= 1, `marker ${g.width} px, pixel ${pixel} px`);
    };
    assert.equal(await page.isDisabled("#zoom-out"), false);
    assert.equal(await page.isDisabled("#zoom-in"), false);
    await assertMarker({ zoom: 1, cx: 29, cy: 29 });
    await page.keyboard.type("+");
    await page.click("#zoom-in");
    await page.click("#zoom-out");
    await page.click("#zoom-in");
    await page.evaluate(() => document.activeElement.blur());
    await assertMarker({ zoom: 4, cx: 29, cy: 29 });
    await press(page, "ArrowLeft", 3);
    await assertStage(page, { zoom: 4, cx: 23, cy: 29 }, SIZE);
    await assertMarker({ zoom: 4, cx: 23, cy: 29 });
    await press(page, "ArrowLeft", 7);
    await press(page, "ArrowUp", 11);
    await page.waitForTimeout(700);
    await assertStage(page, { zoom: 4, cx: 9, cy: 7 }, SIZE);
    assert.deepEqual(apiRequests(log), []);
    assert.equal(await page.$eval("#image", (el) => el.width), SIZE);
    assertCleanRun(log);
  });

/** The live search at the example's position: the stub example's coordinates, detector D6. */
function examplePlan() {
  const texts = fieldTexts(EXAMPLE.ra_deg, EXAMPLE.dec_deg);
  return {
    texts,
    plan: { ...makePlan([...THREE_FRAMES, { label: "2026-08-01", n_available: 5, n_used: 5 }],
      { detector: "D6" }), ra_deg: Number(texts.ra), dec_deg: Number(texts.dec) },
  };
}

test("on the example the first arrow press past its field moves at once and loads the real "
  + "surroundings with one search there; the example plays until they replace it",
{ timeout: TIMEOUT }, async () => {
  const { texts, plan } = examplePlan();
  const frameGate = deferred();
  const { page, log } = await openPage({
    search: () => ({ status: 200, body: plan }),
    frame: async (n) => {
      await frameGate.promise;
      return frameBody(pixels(n), plan.frames[n].n_used);
    },
    wide: texturedWide,
  });
  try {
    await page.setViewportSize({ width: 1366, height: 768 });
    await page.waitForTimeout(500);
    assert.deepEqual(apiRequests(log), []);
    await page.click("#play");
    await page.evaluate(() => document.activeElement.blur());
    await press(page, "ArrowLeft");
    await assertStage(page, { zoom: 1, cx: 81, cy: 88 }, WIDE);
    assert.equal(await page.$eval("#image", (el) => el.classList.contains("pending")), true);
    // East of the example's field nothing is loaded yet: drawn plain (--panel), not checkered.
    const shot = await renderedCanvas(page);
    const i = 4 * (Math.round(shot.height / 2) * shot.width + 2);
    assert.deepEqual(shot.data.slice(i, i + 3), [21, 25, 34]);
    await waitForStatus(page, (t) => t.startsWith("Loading the example's surroundings"));
    assert.equal(log.searches.length, 1);
    const params = log.searches[0].searchParams;
    assert.deepEqual([params.get("ra"), params.get("dec"), params.get("detector")],
      [texts.ra, texts.dec, "D6"]);
    await press(page, "ArrowLeft", 12);
    await page.click("#zoom-out");
    await page.evaluate(() => document.activeElement.blur());
    assert.equal(log.searches.length, 1);
    assert.equal(await text(page, "#play"), "Pause");
    const playing = (await sliderState(page)).value;
    await page.waitForFunction((v) => document.querySelector("#slider").value !== String(v),
      playing, { timeout: 2000 });
    assert.equal((await sliderState(page)).max, 2);
    assert.equal(await text(page, "#name"), EXAMPLE.name);
    assert.equal(await page.isVisible("#marker-control"), true);
    const view = { zoom: 1 / 2, cx: 58.5, cy: 88 };
    await assertStage(page, view, WIDE);

    frameGate.release();
    await waitForSurround(page);
    assert.equal(await finalStatus(page), `4 frames from 47 of 47 exposures. ${NO_DATA}`);
    await assertStage(page, view, WIDE);
    assert.equal((await sliderState(page)).max, 3);
    assert.equal(log.searches.length, 1);
    assert.equal(log.frames.length, 4);
    assert.deepEqual(log.wides.map((p) => [p.ra_deg, p.dec_deg]),
      Array(4).fill([plan.ra_deg, plan.dec_deg]));
    assert.equal(await page.evaluate(() => location.search),
      `?ra=${texts.ra}&dec=${texts.dec}&detector=D6`);
    assert.deepEqual([await page.inputValue("#ra"), await page.inputValue("#dec"),
      await page.inputValue("#detector")], [texts.ra, texts.dec, "D6"]);
    assert.equal(await text(page, "#position"), formatPosition(plan.ra_deg, plan.dec_deg, "D6"));
    assert.equal(await page.isVisible("#marker-control"), false);
    assert.equal(await text(page, "#play"), "Pause");
    assertCleanRun(log);
  } finally {
    frameGate.release();
  }
});

test("on the example the first zoom-out zooms out at once and loads the surroundings with one "
  + "search", { timeout: TIMEOUT }, async () => {
  const { texts, plan } = examplePlan();
  const { page, log } = await openPage({
    search: () => ({ status: 200, body: plan }), frame: frameOk(plan), wide: texturedWide,
  });
  await page.waitForTimeout(300);
  assert.deepEqual(apiRequests(log), []);
  await page.click("#zoom-out");
  await assertStage(page, { zoom: 1 / 2, cx: 88, cy: 88 }, WIDE);
  await waitForSurround(page);
  assert.equal(await finalStatus(page), `4 frames from 47 of 47 exposures. ${NO_DATA}`);
  assert.equal(log.searches.length, 1);
  assert.deepEqual([log.searches[0].searchParams.get("ra"),
    log.searches[0].searchParams.get("dec")], [texts.ra, texts.dec]);
  assert.deepEqual([log.frames.length, log.wides.length], [4, 4]);
  await page.click("#zoom-out");
  await assertStage(page, { zoom: 1 / 3, cx: 88, cy: 88 }, WIDE);
  assert.equal(await page.isDisabled("#zoom-out"), true);
  assertCleanRun(log);
});

test("on the example an unavailable archive is reported and the example stays usable",
  { timeout: TIMEOUT }, async () => {
    const down = "The archive search failed. Try again later.";
    const { page, log } = await openPage({
      search: () => ({ status: 502, body: { detail: down } }),
    });
    await page.click("#play");
    await page.evaluate(() => document.activeElement.blur());
    await press(page, "ArrowRight");
    assert.equal(await waitForStatus(page, (t) => t.startsWith("The surroundings")),
      `The surroundings of the example could not be loaded from the archive: ${down}`);
    assert.equal(log.searches.length, 1);
    await assertStage(page, { zoom: 1, cx: 95, cy: 88 }, WIDE);
    await press(page, "ArrowLeft", 2);
    await assertStage(page, { zoom: 1, cx: 81, cy: 88 }, WIDE);
    assert.equal(await text(page, "#play"), "Pause");
    const value = (await sliderState(page)).value;
    await page.waitForFunction((v) => document.querySelector("#slider").value !== String(v),
      value, { timeout: 2000 });
    await page.click("#play");
    assert.equal(await text(page, "#name"), EXAMPLE.name);
    assert.equal(await page.evaluate(() => location.search), "");
    assert.deepEqual(await canvasPixels(page), exampleRGBA((await sliderState(page)).value));
    await page.waitForTimeout(700);
    assert.equal(log.searches.length, 1);
    // A deliberate zoom-out tries again.
    await page.click("#zoom-out");
    const deadline = Date.now() + 5000;
    while (log.searches.length < 2 && Date.now() < deadline) await page.waitForTimeout(50);
    assert.equal(log.searches.length, 2);
    await waitForStatus(page, (t) => t.startsWith("The surroundings"));
    assertCleanRun(log);
  });

test("arrows and zoom-out act at once while the surround loads; it fills in without a jump",
  { timeout: TIMEOUT }, async () => {
    const plan = makePlan(THREE_FRAMES);
    const gate = deferred();
    const { page, log } = await openPage({
      search: (url) => (url.searchParams.get("ra") === RA
        ? { status: 200, body: plan } : { status: 500, body: { detail: "unexpected" } }),
      frame: frameOk(plan),
      wide: async (n, payload, served) => {
        await gate.promise;
        return texturedWide(n, payload, served);
      },
    });
    try {
      await page.setViewportSize({ width: 1366, height: 768 });
      await submit(page);
      await waitForStatus(page, (t) => t.includes("Loading the surrounding area"));
      await page.evaluate(() => document.activeElement.blur());
      await press(page, "ArrowLeft", 3);
      await assertStage(page, { zoom: 1, cx: 67, cy: 88 }, WIDE);
      await page.click("#zoom-out");
      await assertStage(page, { zoom: 1 / 2, cx: 67, cy: 88 }, WIDE);
      assert.ok((await statusText(page)).includes("Loading the surrounding area: frame 1 of 3"));
      const before = await renderedCanvas(page);
      const left = 4 * (Math.round(before.height / 2) * before.width + 2);
      assert.deepEqual(before.data.slice(left, left + 3), [21, 25, 34]);
      await page.evaluate(() => document.activeElement.blur());
      await press(page, "ArrowUp");
      await assertStage(page, { zoom: 1 / 2, cx: 67, cy: 73 }, WIDE);
      await page.waitForTimeout(700);
      assert.equal(log.searches.length, 1);
      assert.equal(log.wides.length, 1);

      gate.release();
      await waitForSurround(page);
      await assertStage(page, { zoom: 1 / 2, cx: 67, cy: 73 }, WIDE);
      const after = await renderedCanvas(page);
      assert.notDeepEqual(after.data.slice(left, left + 3), [21, 25, 34]);
      assert.equal(log.searches.length, 1);
      assertCleanRun(log);
    } finally {
      gate.release();
    }
  });

test("a surround refused twice leaves the loop as it was and Zoom out tries again",
  { timeout: TIMEOUT }, async () => {
    const plan = makePlan(THREE_FRAMES);
    const busy = "The server is busy; try again shortly.";
    const { page, log } = await openPage({
      search: () => ({ status: 200, body: plan }), frame: frameOk(plan),
      wide: (n, payload, served) => (n < 2
        ? { status: 503, body: { detail: busy }, headers: { "Retry-After": "1" } }
        : texturedWide(n, payload, served)),
    });
    await recordStatuses(page);
    await submit(page);
    const done = `3 frames from 42 of 42 exposures. ${NO_DATA}`;
    const failed = `${done} The surrounding area could not be loaded: ${busy}`;
    assert.equal(await waitForStatus(page, (t) => t.includes("could not")), failed);
    // The wait for the refused surround keeps the summary of the shown frames in front.
    const history = await statusHistory(page);
    assert.deepEqual(history.slice(history.indexOf(done)), [done,
      `${done} Loading the surrounding area: frame 1 of 3…`,
      `${done} Waiting 1 s before continuing.`,
      `${done} Loading the surrounding area: frame 1 of 3…`, failed]);
    assert.equal(log.wides.length, 2);
    assert.equal(await page.$eval("#image", (el) => el.classList.contains("pending")), true);
    assert.deepEqual(await canvasPixels(page),
      Array.from(toRGBA(pixels(0), computeStretch([0, 1, 2].map((n) => pixels(n))))));
    await page.click("#play");
    const before = (await sliderState(page)).value;
    await page.waitForFunction((v) => document.querySelector("#slider").value !== String(v),
      before, { timeout: 2000 });
    assert.equal(await page.isDisabled("#zoom-out"), false);
    await page.click("#zoom-out");
    await waitForSurround(page);
    assert.equal(await finalStatus(page), done);
    assert.equal(log.wides.length, 5);
    await assertStage(page, { zoom: 1 / 2, cx: 88, cy: 88 }, WIDE);
    assert.equal(await text(page, "#play"), "Pause");
    assertCleanRun(log);
  });

test("a search of more than 120 exposures loads its surround only when first used, and the "
  + "first zoom-out or arrow past the field acts at once", { timeout: TIMEOUT }, async () => {
  const plan = makePlan(DEEP_FRAMES);
  for (const action of ["zoom-out", "arrow"]) {
    const gate = deferred();
    const { page, log } = await openPage({
      search: () => ({ status: 200, body: plan }), frame: frameOk(plan),
      wide: async (n, payload, served) => {
        await gate.promise;
        return texturedWide(n, payload, served);
      },
    });
    await page.setViewportSize({ width: 1366, height: 768 });
    await submit(page);
    assert.equal(await finalStatus(page), `3 frames from 121 of 121 exposures. ${NO_DATA}`);
    await page.waitForTimeout(800);
    assert.equal(log.wides.length, 0);
    const narrow = await page.locator("#frame").screenshot();
    await page.click("#zoom-in");
    await page.evaluate(() => document.activeElement.blur());
    await press(page, "ArrowUp", 2);
    await press(page, "ArrowDown", 2);
    await page.click("#zoom-out");
    await page.evaluate(() => document.activeElement.blur());
    await page.waitForTimeout(300);
    assert.equal(log.wides.length, 0);
    assert.equal(await page.$eval("#image", (el) => el.width), SIZE);
    if (action === "zoom-out") {
      await page.click("#zoom-out");
      await assertStage(page, { zoom: 1 / 2, cx: 88, cy: 88 }, WIDE);
    } else {
      await press(page, "ArrowRight");
      await assertStage(page, { zoom: 1, cx: 95, cy: 88 }, WIDE);
    }
    // The first wide frame is held: the surround is provably still loading here.
    assert.ok((await statusText(page)).includes("Loading the surrounding area: frame 1 of 3"));
    gate.release();
    await waitForSurround(page);
    assert.equal(log.wides.length, 3);
    if (action === "zoom-out") await page.click("#zoom-in");
    else await press(page, "ArrowLeft");
    await assertStage(page, { zoom: 1, cx: 88, cy: 88 }, WIDE);
    await page.mouse.move(0, 0);
    assert.ok(narrow.equals(await page.locator("#frame").screenshot()), "picture changed");
    assert.equal(log.searches.length, 1);
    assertCleanRun(log);
    await page.close();
  }
});

test("the date label gives the range of exposures over the fields in view",
  { timeout: TIMEOUT }, async () => {
    const plan = makePlan([
      { label: "2025-05-06", n_available: 61, n_used: 61 },
      { label: "2025-11-07", n_available: 61, n_used: 61 },
    ]);
    const counts = [23, 23, 23, 24, 24, 24, 23, 23, 23];
    const { page, log } = await openWithSurround({
      plan,
      wide: (n, payload, served) => wideBody(
        widePixels(served.get(payload.uris.join()).pixels, () => 0.2), 24, counts),
    });
    assert.equal(await dateText(page), "2025-05-06 · 24 exposures");
    await press(page, "ArrowUp");
    const range = "2025-05-06 · 23–24 exposures";
    assert.equal(await dateText(page), range);
    assert.equal(await page.getAttribute("#slider", "aria-valuetext"), range);
    await page.click("#next");
    assert.equal(await dateText(page), "2025-11-07 · 23–24 exposures");
    await page.evaluate(() => document.activeElement.blur());
    await press(page, "ArrowDown");
    assert.equal(await dateText(page), "2025-11-07 · 24 exposures");
    assert.equal(await statusText(page), `2 frames from 122 of 122 exposures. ${NO_DATA}`);
    assertCleanRun(log);
  });

test("keys do nothing while the sky map is open; on a phone the timeline keeps its width",
  { timeout: TIMEOUT }, async () => {
    const { page, log } = await openWithSurround({ plan: makePlan(DEEP_FRAMES) });
    await openMap(page);
    await page.evaluate(() => document.activeElement?.blur());
    await page.keyboard.type("+-");
    await press(page, "ArrowLeft", 12);
    await page.waitForTimeout(700);
    await page.click("#sky-close");
    await assertStage(page, { zoom: 1, cx: 88, cy: 88 }, WIDE);
    assert.equal(log.searches.length, 1);
    // A push at the edge whose rest ends while the map is open loads nothing.
    await page.evaluate(() => document.activeElement?.blur());
    await press(page, "ArrowLeft", 10);
    await assertStage(page, { zoom: 1, cx: 29, cy: 88 }, WIDE);
    await page.click("#pick");
    await page.waitForTimeout(900);
    await page.click("#sky-close");
    assert.equal(log.searches.length, 1);

    await page.setViewportSize({ width: 360, height: 740 });
    const { rects, width, scrollWidth } = await layout(page,
      ["#slider", "#prev", "#zoom-in", "#frame"]);
    const slider = rects["#slider"];
    assert.ok(slider.right - slider.left >= 150, `slider ${slider.right - slider.left} px`);
    assert.ok(rects["#zoom-in"].bottom <= slider.top, "zoom buttons not above the timeline");
    assert.ok(rects["#zoom-in"].right <= width && scrollWidth <= width);
    assertCleanMapRun(log);
  });

/** The id of the focused element, "" for the page itself. */
const focused = (page) => page.evaluate(() => document.activeElement?.id ?? "");

test("after Play, a frame button or a zoom button the arrow keys move the view",
  { timeout: TIMEOUT }, async () => {
    const { page, log } = await openWithSurround({ plan: makePlan(DEEP_FRAMES) });
    await page.click("#play");
    await press(page, "ArrowLeft");
    await assertStage(page, { zoom: 1, cx: 81, cy: 88 }, WIDE);
    await page.click("#next");
    assert.equal(await focused(page), "next");
    await press(page, "ArrowLeft");
    await assertStage(page, { zoom: 1, cx: 74, cy: 88 }, WIDE);
    await page.click("#prev");
    await press(page, "ArrowUp");
    await assertStage(page, { zoom: 1, cx: 74, cy: 81 }, WIDE);
    await page.click("#zoom-in");
    await page.click("#zoom-in");
    assert.equal(await page.isDisabled("#zoom-in"), true);
    await press(page, "ArrowRight");
    await assertStage(page, { zoom: 4, cx: 76, cy: 81 }, WIDE);
    await page.click("#zoom-out");
    await press(page, "ArrowDown");
    await assertStage(page, { zoom: 2, cx: 76, cy: 85 }, WIDE);
    assert.equal(await page.evaluate(() => window.scrollY), 0);
    assert.equal(log.searches.length, 1);
    assertCleanRun(log);
  });

test("Enter in a coordinate field searches and, once the search is accepted, leaves the field "
  + "for Show so that the arrow keys look around", { timeout: TIMEOUT }, async () => {
  const plan = makePlan(DEEP_FRAMES);
  const { page, log } = await openPage({
    search: (url) => (url.searchParams.get("ra") === "abc"
      ? { status: 422, body: { detail: INVALID_RA } } : { status: 200, body: plan }),
    frame: frameOk(plan), wide: texturedWide,
  });
  await page.fill("#ra", "abc");
  await page.fill("#dec", DEC);
  await page.press("#dec", "Enter");
  assert.equal(await waitForStatus(page, (t) => t.startsWith("Error")), `Error: ${INVALID_RA}`);
  assert.equal(await focused(page), "dec");
  await page.fill("#ra", RA);
  await page.press("#ra", "Enter");
  await finalStatus(page);
  assert.equal(await focused(page), "submit");
  await press(page, "ArrowLeft");
  await assertStage(page, { zoom: 1, cx: 81, cy: 88 }, WIDE);
  assert.equal(await page.inputValue("#ra"), RA);
  await waitForSurround(page);
  assert.equal(log.searches.length, 2);
  assertCleanRun(log);
});

test("after Search here the arrow keys move the view at once", { timeout: TIMEOUT }, async () => {
  const plan = makePlan(DEEP_FRAMES);
  const gate = deferred();
  const { page, log } = await openPage({
    search: () => ({ status: 200, body: plan }),
    frame: async (n) => {
      if (n === 1) await gate.promise;
      return frameBody(pixels(n), plan.frames[n].n_used);
    },
    wide: texturedWide,
  });
  try {
    await openMap(page);
    await clickMap(page, 25, 15);
    await page.click("#sky-search");
    // The second frame is held, so the first is shown and the search is still loading.
    await page.waitForFunction(() => document.querySelector("#date").textContent !== "");
    assert.equal(await statusText(page), "Loading frame 2 of 3…");
    assert.equal(await focused(page), "pick");
    await press(page, "ArrowRight");
    await assertStage(page, { zoom: 1, cx: 95, cy: 88 }, WIDE);
    assert.equal(await statusText(page), "Loading frame 2 of 3…");
    assert.equal(log.wides.length, 0);
  } finally {
    gate.release();
  }
  await finalStatus(page);
  await waitForSurround(page);
  await press(page, "ArrowRight");
  await assertStage(page, { zoom: 1, cx: 102, cy: 88 }, WIDE);
  assert.equal(log.searches.length, 1);
  assertCleanMapRun(log);
});

/** A field of 59 x 59 values; every field of a wide grid repeats it, so all fields look alike. */
// Multiples of 1/64 are exact in float32, so wide and narrow answers give the same stretch.
const tiled = (x, y) => (((x % SIZE) * 7 + (y % SIZE) * 3) % 50) / 64;

/** The search answer for any position: THREE_FRAMES at the position asked for. */
function planAt(url) {
  return { ...makePlan(THREE_FRAMES), ra_deg: Number(url.searchParams.get("ra")),
    dec_deg: Number(url.searchParams.get("dec")) };
}

/** Stubs for searches anywhere, with every frame the tiled field (narrow) or its 3 x 3 tiling. */
function tiledStubs(search) {
  return {
    search,
    frame: (n, payload) => frameBody(Array.from({ length: SIZE * SIZE },
      (_, i) => tiled(i % SIZE, Math.floor(i / SIZE))), payload.uris.length),
    wide: (n, payload) => wideBody(Array.from({ length: WIDE * WIDE },
      (_, i) => tiled(i % WIDE, Math.floor(i / WIDE))), payload.uris.length),
  };
}

async function waitForCount(list, n, ms = 5000) {
  const deadline = Date.now() + ms;
  while (list.length < n && Date.now() < deadline) await new Promise((r) => setTimeout(r, 25));
  assert.equal(list.length, n);
}

function assertSamePicture(a, b) {
  assert.deepEqual([a.width, a.height], [b.width, b.height]);
  let differing = 0;
  for (let i = 0; i < a.data.length; i += 4) {
    const d = Math.max(...[0, 1, 2].map((k) => Math.abs(a.data[i + k] - b.data[i + k])));
    assert.ok(d <= 16, `pixel ${i / 4} differs by ${d}`);
    if (d > 0) differing += 1;
  }
  assert.ok(differing <= a.width * a.height / 1000, `${differing} pixels differ`);
}

const searchedAt = (url) => [url.searchParams.get("ra"), url.searchParams.get("dec"),
  url.searchParams.get("detector")];

test("moving left loads the area two fields further left ahead with one search; at the old "
  + "edge the view runs on into it with no blank and no further search", { timeout: TIMEOUT },
async () => {
  const plan = makePlan(THREE_FRAMES);
  const gate = deferred();
  const { page, log } = await openWithSurround({
    plan,
    ...tiledStubs(async (url) => {
      if (url.searchParams.get("ra") === RA) return { status: 200, body: plan };
      await gate.promise;
      return { status: 200, body: planAt(url) };
    }),
  });
  try {
    await page.setViewportSize({ width: 1366, height: 768 });
    const start = await renderedCanvas(page);
    await press(page, "ArrowLeft");
    await waitForCount(log.searches, 2);
    const east = offsetPosition(plan.ra_deg, plan.dec_deg, -2 * SIZE, 0);
    const eastTexts = fieldTexts(east.ra, east.dec);
    assert.deepEqual(searchedAt(log.searches[1]), [eastTexts.ra, eastTexts.dec, "D2"]);
    await assertStage(page, { zoom: 1, cx: 81, cy: 88 }, WIDE);
    for (let i = 0; i < 5; i++) await page.keyboard.down("ArrowLeft");
    await page.keyboard.up("ArrowLeft");
    await assertStage(page, { zoom: 1, cx: 46, cy: 88 }, WIDE);
    await page.waitForTimeout(700);
    assert.equal(log.searches.length, 2);

    gate.release();
    await waitForCount(log.wides, 6);
    assert.equal(await finalStatus(page), `3 frames from 42 of 42 exposures.`);
    assert.equal(await page.evaluate(() => location.search),
      `?ra=${encodeURIComponent(RA)}&dec=${encodeURIComponent(DEC)}&detector=D2`);
    await assertStage(page, { zoom: 1, cx: 46, cy: 88 }, WIDE);
    await press(page, "ArrowLeft", 2);
    await assertStage(page, { zoom: 1, cx: 32, cy: 88 }, WIDE);
    await press(page, "ArrowLeft");
    await assertStage(page, { zoom: 1, cx: 147, cy: 88 }, WIDE);
    assert.equal(await page.$eval("#image", (el) => el.classList.contains("pending")), false);
    // The same sky, drawn at another place of the grid: the browser's resampling may differ in
    // a few pixels by a few levels; a blank or another stretch would differ everywhere.
    assertSamePicture(start, await renderedCanvas(page));
    assert.equal(await page.evaluate(() => location.search),
      `?ra=${eastTexts.ra}&dec=${eastTexts.dec}&detector=D2`);
    assert.deepEqual([await page.inputValue("#ra"), await page.inputValue("#dec")],
      [eastTexts.ra, eastTexts.dec]);
    await press(page, "ArrowLeft", 2);
    await assertStage(page, { zoom: 1, cx: 133, cy: 88 }, WIDE);
    await page.waitForTimeout(700);
    assert.equal(log.searches.length, 2);
    await press(page, "ArrowLeft", 3);
    await waitForCount(log.searches, 3);
    const further = offsetPosition(east.ra, east.dec, -2 * SIZE, 0);
    assert.deepEqual(searchedAt(log.searches[2]).slice(0, 2),
      [fieldTexts(further.ra, further.dec).ra, fieldTexts(further.ra, further.dec).dec]);
    assertCleanRun(log);
  } finally {
    gate.release();
  }
});

test("no preload starts while frames are loading; the first move after they are in starts one",
  { timeout: TIMEOUT }, async () => {
    const plan = makePlan(THREE_FRAMES);
    const gate = deferred();
    const stubs = tiledStubs((url) => (url.searchParams.get("ra") === RA
      ? { status: 200, body: plan } : { status: 200, body: planAt(url) }));
    const { page, log } = await openPage({
      ...stubs,
      frame: async (n, payload) => {
        if (n === 2) await gate.promise;
        return stubs.frame(n, payload);
      },
    });
    try {
      await submit(page);
      await waitForStatus(page, (t) => t.startsWith("Loading frame 3"));
      await page.evaluate(() => document.activeElement.blur());
      await press(page, "ArrowLeft", 4);
      await assertStage(page, { zoom: 1, cx: 60, cy: 88 }, WIDE);
      await page.waitForTimeout(700);
      assert.deepEqual([log.searches.length, log.wides.length], [1, 0]);
      gate.release();
      await waitForSurround(page);
      await page.waitForTimeout(300);
      assert.equal(log.searches.length, 1);
      await press(page, "ArrowRight");
      await waitForCount(log.searches, 2);
      const west = offsetPosition(plan.ra_deg, plan.dec_deg, 2 * SIZE, 0);
      assert.deepEqual(searchedAt(log.searches[1]),
        [fieldTexts(west.ra, west.dec).ra, fieldTexts(west.ra, west.dec).dec, "D2"]);
      assertCleanRun(log);
    } finally {
      gate.release();
    }
  });

test("a preload refused with 429 is reported once, moving keeps working, and it is tried again "
  + "by itself only when the limit allows", { timeout: TIMEOUT }, async () => {
  const plan = makePlan(THREE_FRAMES);
  let refused = null;
  const { page, log } = await openWithSurround({
    plan,
    ...tiledStubs((url) => {
      if (url.searchParams.get("ra") === RA) return { status: 200, body: plan };
      if (refused === null) {
        refused = Date.now();
        return { status: 429, body: { detail: "Too many requests. Try again in 2 s." },
          headers: { "Retry-After": "2" } };
      }
      return { status: 200, body: planAt(url) };
    }),
  });
  await recordStatuses(page);
  const done = "3 frames from 42 of 42 exposures.";
  await press(page, "ArrowLeft");
  const limit = `${done} The search limit is reached; loading further on continues in 2 s.`;
  assert.equal(await waitForStatus(page, (t) => t.includes("limit")), limit);
  await press(page, "ArrowLeft", 3);
  await press(page, "ArrowUp", 2);
  await assertStage(page, { zoom: 1, cx: 60, cy: 74 }, WIDE);
  for (let i = 0; i < 10; i++) await page.keyboard.down("ArrowLeft");
  await page.keyboard.up("ArrowLeft");
  await page.waitForTimeout(500);
  assert.ok(Date.now() - refused < 1900, "test too slow");
  assert.equal(log.searches.length, 2);
  await waitForCount(log.searches, 3);
  assert.ok(Date.now() - refused >= 1900, `retried after ${Date.now() - refused} ms`);
  await waitForCount(log.wides, 6);
  await finalStatus(page);
  const history = await statusHistory(page);
  assert.equal(history.filter((t) => t === limit).length, 1, JSON.stringify(history));
  await page.waitForTimeout(500);
  assert.equal(log.searches.length, 3);
  assertCleanRun(log);
});

test("each direction loads its own neighbour ahead; off centre across the move it goes diagonal",
  { timeout: TIMEOUT }, async () => {
    const plan = makePlan(THREE_FRAMES);
    const cases = { ArrowLeft: [-2, 0], ArrowRight: [2, 0], ArrowUp: [0, -2], ArrowDown: [0, 2] };
    for (const [key, [dx, dy]] of Object.entries(cases)) {
      const { page, log } = await openWithSurround({
        plan,
        ...tiledStubs((url) => (url.searchParams.get("ra") === RA
          ? { status: 200, body: plan }
          : { status: 502, body: { detail: "The archive search failed. Try again later." } })),
      });
      await press(page, key);
      await waitForCount(log.searches, 2);
      const c = offsetPosition(plan.ra_deg, plan.dec_deg, SIZE * dx, SIZE * dy);
      assert.deepEqual(searchedAt(log.searches[1]),
        [fieldTexts(c.ra, c.dec).ra, fieldTexts(c.ra, c.dec).dec, "D2"], key);
      if (key === "ArrowUp") {
        // The failure follows the summary of the frames still shown.
        assert.equal(await waitForStatus(page, (t) => t.includes("The next area")),
          "3 frames from 42 of 42 exposures. "
          + "The next area could not be loaded: The archive search failed. Try again later.");
        await press(page, "ArrowUp", 4);
        await assertStage(page, { zoom: 1, cx: 88, cy: 53 }, WIDE);
        await page.waitForTimeout(300);
        assert.equal(log.searches.length, 2);
        await press(page, "ArrowLeft");
        await waitForCount(log.searches, 3);
        const ne = offsetPosition(plan.ra_deg, plan.dec_deg, -2 * SIZE, -SIZE);
        assert.deepEqual(searchedAt(log.searches[2]),
          [fieldTexts(ne.ra, ne.dec).ra, fieldTexts(ne.ra, ne.dec).dec, "D2"]);
      }
      assertCleanRun(log);
      await page.close();
    }
  });

/** As renderedCanvas, with the bytes passed as base64 (fast enough to sample during playback). */
async function renderedImage(page) {
  const png = await page.locator("#frame").screenshot();
  const { width, height, b64 } = await page.evaluate(async (data) => {
    const bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
    const bitmap = await createImageBitmap(new Blob([bytes], { type: "image/png" }));
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const ctx = canvas.getContext("2d");
    ctx.drawImage(bitmap, 0, 0);
    const rgba = ctx.getImageData(0, 0, bitmap.width, bitmap.height).data;
    let text = "";
    for (let i = 0; i < rgba.length; i += 0x8000) {
      text += String.fromCharCode(...rgba.subarray(i, i + 0x8000));
    }
    return { width: bitmap.width, height: bitmap.height, b64: btoa(text) };
  }, png.toString("base64"));
  return { width, height, data: Buffer.from(b64, "base64") };
}

const PANEL = [21, 25, 34]; // --panel, #151922: fields not loaded yet
const isPanel = (data, i) => data[i] === PANEL[0] && data[i + 1] === PANEL[1]
  && data[i + 2] === PANEL[2];
const isSky = (data, i) => data[i] === data[i + 1] && data[i + 1] === data[i + 2];

/** Rendered pixels drawn as not loaded. */
function notLoaded(render) {
  let n = 0;
  for (let i = 0; i < render.data.length; i += 4) if (isPanel(render.data, i)) n += 1;
  return n;
}

/** Rendered pixels that showed sky in `before` and are drawn as not loaded in `after`. */
function turnedGrey(before, after) {
  assert.deepEqual([before.width, before.height], [after.width, after.height]);
  let n = 0;
  for (let i = 0; i < before.data.length; i += 4) {
    if (isSky(before.data, i) && isPanel(after.data, i)) n += 1;
  }
  return n;
}

/**
 * Stubs as tiledStubs, every search answering THREE_FRAMES at its position, with the 6' and
 * wide frame answers of areas other than `plan`'s held until the test releases them:
 * `narrow[i]` and `wide[i]` per plan index. Logs the plan indices of those requests.
 */
function heldNextArea(plan, nextPlan = planAt) {
  const stubs = tiledStubs((url) => (url.searchParams.get("ra") === RA
    ? { status: 200, body: plan } : { status: 200, body: nextPlan(url) }));
  const gates = { narrow: [0, 1, 2, 3].map(deferred), wide: [0, 1, 2, 3].map(deferred) };
  const next = { narrow: [], wide: [] };
  const elsewhere = (p) => p.ra_deg !== plan.ra_deg || p.dec_deg !== plan.dec_deg;
  return {
    gates, next,
    release: () => [...gates.narrow, ...gates.wide].forEach((g) => g.release()),
    stubs: {
      search: stubs.search,
      frame: async (n, payload) => {
        if (elsewhere(payload)) {
          const i = visitIndex(payload);
          next.narrow.push(i);
          await gates.narrow[i].promise;
        }
        return stubs.frame(n, payload);
      },
      wide: async (n, payload) => {
        if (elsewhere(payload)) {
          const i = visitIndex(payload);
          next.wide.push(i);
          await gates.wide[i].promise;
        }
        return stubs.wide(n, payload);
      },
    },
  };
}

/** Index of the visit a frame request asks for, in any plan from makePlan. */
const visitIndex = (payload) => Number(/\/f(\d+)_/.exec(payload.uris[0])[1]);

/** Renders the image until `done(render)` holds, for at most 10 s. */
async function renderUntil(page, done) {
  const deadline = Date.now() + 10_000;
  let render;
  do {
    render = await renderedImage(page);
    if (done(render)) return render;
    await page.waitForTimeout(50);
  } while (Date.now() < deadline);
  throw new Error("the picture never reached the expected state");
}

test("moving into the next area shows the field ahead as soon as the frame on screen's 6' "
  + "frame is in, before any of its wide frames, sky never turning grey, with one search",
{ timeout: 60_000 }, async () => {
  const plan = makePlan(THREE_FRAMES);
  const held = heldNextArea(plan);
  const { page, log } = await openWithSurround({ plan, ...held.stubs });
  try {
    await page.setViewportSize({ width: 1366, height: 768 });
    await selectFrame(page, 1);
    await page.evaluate(() => document.activeElement.blur());
    await press(page, "ArrowLeft");
    // The frame on screen's 6' frame of the next area's centre is asked for first.
    await waitForCount(held.next.narrow, 1);
    assert.deepEqual(held.next.narrow, [1]);
    const east = offsetPosition(plan.ra_deg, plan.dec_deg, -2 * SIZE, 0);
    const eastTexts = fieldTexts(east.ra, east.dec);
    assert.deepEqual(searchedAt(log.searches[1]), [eastTexts.ra, eastTexts.dec, "D2"]);
    // At the old edge the area joins on, with the fields it shares: nothing turns grey.
    await press(page, "ArrowLeft", 8);
    await assertStage(page, { zoom: 1, cx: 147, cy: 88 }, WIDE);
    assert.equal(await page.evaluate(() => location.search),
      `?ra=${eastTexts.ra}&dec=${eastTexts.dec}&detector=D2`);
    assert.equal(notLoaded(await renderedImage(page)), 0);
    // On into the field ahead: not loaded yet, drawn plain.
    await press(page, "ArrowLeft", 4);
    await assertStage(page, { zoom: 1, cx: 119, cy: 88 }, WIDE);
    const entered = await renderedImage(page);
    assert.ok(notLoaded(entered) > entered.width * entered.height / 5, "field ahead not plain");
    assert.ok(isPanel(entered.data, 4 * (Math.round(entered.height / 2) * entered.width + 2)));

    held.gates.narrow[1].release();
    const shownSky = await renderUntil(page, (r) => notLoaded(r) === 0);
    assert.equal(turnedGrey(entered, shownSky), 0);
    // Shown before any wide frame of the next area was even asked for.
    assert.deepEqual(held.next.wide, []);
    await waitForCount(held.next.narrow, 2);
    assert.deepEqual(held.next.narrow, [1, 0]);

    // Playback skips the frames whose field ahead is not in yet, so it never shows grey.
    await page.click("#play");
    await page.evaluate(() => document.activeElement.blur());
    for (let i = 0; i < 8; i++) {
      assert.equal(turnedGrey(shownSky, await renderedImage(page)), 0);
      assert.equal((await sliderState(page)).value, 1);
      await page.waitForTimeout(150);
    }
    held.gates.narrow[0].release();
    const seen = new Set();
    const deadline = Date.now() + 5000;
    while (seen.size < 2 && Date.now() < deadline) {
      assert.equal(turnedGrey(shownSky, await renderedImage(page)), 0);
      seen.add((await sliderState(page)).value);
    }
    assert.deepEqual([...seen].sort(), [0, 1]);
    await page.click("#play");
    await page.evaluate(() => document.activeElement.blur());
    const paused = (await sliderState(page)).value;
    const before = await renderedImage(page);
    held.gates.narrow[2].release();
    // Then the wide frames, the frame on screen first.
    await waitForCount(held.next.wide, 1);
    assert.deepEqual(held.next.wide, [paused]);
    assert.equal(turnedGrey(before, await renderedImage(page)), 0);
    for (const gate of held.gates.wide) gate.release();
    await waitForSurround(page);
    assert.equal(await finalStatus(page), "3 frames from 42 of 42 exposures.");
    assert.deepEqual(held.next.wide, requestOrderOf(paused, 3));
    assert.equal(turnedGrey(before, await renderedImage(page)), 0);
    await assertStage(page, { zoom: 1, cx: 119, cy: 88 }, WIDE);
    assert.equal(log.searches.length, 2);
    assert.equal(log.frames.length, 6);
    assert.equal(log.wides.length, 6);
    assertCleanRun(log);
  } finally {
    held.release();
  }
});

/** The frame on screen first, then the others in time order. */
function requestOrderOf(first, n) {
  return [first, ...Array.from({ length: n }, (_, i) => i).filter((i) => i !== first)];
}

test("when the next area's visits differ, or its grid would meet the loaded one off by more "
  + "than 0.25 px, nothing of it shows before all its wide frames are in", { timeout: 60_000 },
async () => {
  const cases = {
    "other visits": [makePlan(THREE_FRAMES), (url) => ({
      ...makePlan([...THREE_FRAMES, { label: "2026-10-01", n_available: 5, n_used: 5 }]),
      ra_deg: Number(url.searchParams.get("ra")), dec_deg: Number(url.searchParams.get("dec")),
    })],
    // Two fields east at Dec 70 the grids are 0.41 px apart at the seam.
    "Dec 70": [{ ...makePlan(THREE_FRAMES), dec_deg: 70 }, planAt],
  };
  for (const [name, [plan, nextPlan]] of Object.entries(cases)) {
    const held = heldNextArea(plan, nextPlan);
    const { page, log } = await openWithSurround({ plan, ...held.stubs });
    try {
      await page.setViewportSize({ width: 1366, height: 768 });
      await selectFrame(page, 2);
      await page.evaluate(() => document.activeElement.blur());
      const link = await page.evaluate(() => location.search);
      await press(page, "ArrowLeft");
      await waitForCount(held.next.wide, 1);
      // No 6' frame there; the frame on screen's wide frame first.
      assert.deepEqual(held.next.wide, [2], name);
      await press(page, "ArrowLeft", 8);
      await recordKeyDefaults(page);
      await press(page, "ArrowLeft", 3);
      // The view waits at the old edge, the pushes not used, the old area unchanged.
      await assertStage(page, { zoom: 1, cx: 29, cy: 88 }, WIDE);
      assert.deepEqual(await keyDefaults(page), Array(3).fill(["ArrowLeft", false]), name);
      const atEdge = await renderedImage(page);
      assert.equal(notLoaded(atEdge), 0, name);
      assert.equal(await page.evaluate(() => location.search), link, name);
      held.gates.wide[2].release();
      await waitForCount(held.next.wide, 2);
      held.gates.wide[0].release();
      await waitForCount(held.next.wide, 3);
      await page.waitForTimeout(300);
      assert.equal(await page.evaluate(() => location.search), link, name);
      assert.equal(turnedGrey(atEdge, await renderedImage(page)), 0, name);
      for (const gate of held.gates.wide) gate.release();
      await page.waitForFunction((old) => location.search !== old, link);
      await assertStage(page, { zoom: 1, cx: 147, cy: 88 }, WIDE);
      await finalStatus(page);
      assert.deepEqual(held.next.narrow, [], name);
      const n = name === "other visits" ? 4 : 3;
      assert.deepEqual(held.next.wide, requestOrderOf(2, n), name);
      assert.equal(log.searches.length, 2, name);
      assertCleanRun(log);
    } finally {
      held.release();
      await page.close();
    }
  }
});

test("the surround loads the frame on screen first, each frame's as soon as it is in; playback "
  + "skips frames still without it, so the picture never flashes grey", { timeout: 60_000 },
async () => {
  const plan = makePlan(THREE_FRAMES);
  const last = deferred();
  const gates = [0, 1, 2].map(deferred);
  const order = [];
  const { page, log } = await openPage({
    search: () => ({ status: 200, body: plan }),
    frame: async (n, payload) => {
      if (n === 2) await last.promise;
      return frameOk(plan)(n, payload);
    },
    wide: async (n, payload, served) => {
      const i = planIndex(plan, payload);
      order.push(i);
      await gates[i].promise;
      return texturedWide(n, payload, served);
    },
  });
  try {
    await page.setViewportSize({ width: 1366, height: 768 });
    await submit(page);
    await waitForStatus(page, (t) => t.startsWith("Loading frame 3"));
    await selectFrame(page, 1);
    last.release();
    await waitForCount(order, 1);
    assert.deepEqual(order, [1]);
    await page.evaluate(() => document.activeElement.blur());
    await page.keyboard.type("-");
    await page.keyboard.type("-");
    await assertStage(page, { zoom: 1 / 3, cx: 88, cy: 88 }, WIDE);
    const plain = await renderedImage(page);
    assert.ok(notLoaded(plain) > plain.width * plain.height / 2);
    gates[1].release();
    const surround = await renderUntil(page, (r) => notLoaded(r) === 0);
    assert.equal(turnedGrey(plain, surround), 0);
    await waitForCount(order, 2);
    assert.deepEqual(order, [1, 0]);
    await page.click("#play");
    await page.evaluate(() => document.activeElement.blur());
    for (let i = 0; i < 8; i++) {
      assert.equal(notLoaded(await renderedImage(page)), 0);
      assert.equal((await sliderState(page)).value, 1);
      await page.waitForTimeout(150);
    }
    gates[0].release();
    const seen = new Set();
    const deadline = Date.now() + 5000;
    while (seen.size < 2 && Date.now() < deadline) {
      assert.equal(notLoaded(await renderedImage(page)), 0);
      seen.add((await sliderState(page)).value);
    }
    assert.deepEqual([...seen].sort(), [0, 1]);
    // The frame buttons still reach a frame without its surround.
    await page.click("#play");
    await selectFrame(page, 2);
    assert.ok(notLoaded(await renderedImage(page)) > 0);
    gates[2].release();
    await waitForSurround(page);
    assert.equal(await finalStatus(page), `3 frames from 42 of 42 exposures. ${NO_DATA}`);
    assert.deepEqual(order, [1, 0, 2]);
    assert.equal(log.searches.length, 1);
    assertCleanRun(log);
  } finally {
    last.release();
    gates.forEach((g) => g.release());
  }
});

test("while the next area loads after joining on, a push at its edge is not used and nothing "
  + "loads after it; a key held there queues nothing", { timeout: 60_000 }, async () => {
  const plan = makePlan(THREE_FRAMES);
  const held = heldNextArea(plan);
  const { page, log } = await openWithSurround({ plan, ...held.stubs });
  try {
    await page.setViewportSize({ width: 700, height: 400 });
    await page.evaluate(() => window.scrollTo(0, 0));
    await press(page, "ArrowDown");
    await waitForCount(held.next.narrow, 1);
    await press(page, "ArrowDown", 8);
    await assertStage(page, { zoom: 1, cx: 88, cy: 29 }, WIDE);
    held.gates.narrow[0].release();
    await press(page, "ArrowDown", 17);
    await assertStage(page, { zoom: 1, cx: 88, cy: 147 }, WIDE);
    assert.equal(await page.evaluate(() => window.scrollY), 0);
    await recordKeyDefaults(page);
    for (let i = 0; i < 6; i++) await page.keyboard.down("ArrowDown");
    await page.keyboard.up("ArrowDown");
    assert.deepEqual(await keyDefaults(page), Array(6).fill(["ArrowDown", false]));
    held.release();
    await waitForSurround(page);
    await page.waitForTimeout(900);
    assert.ok(await page.evaluate(() => window.scrollY) > 0, "ArrowDown did not scroll");
    assert.equal(log.searches.length, 2);
    assert.deepEqual([held.next.narrow, held.next.wide], [[0, 1, 2], [0, 1, 2]]);
    assertCleanRun(log);
  } finally {
    held.release();
  }
});
