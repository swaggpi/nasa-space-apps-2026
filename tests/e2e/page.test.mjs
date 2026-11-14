import { after, afterEach, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { computeStretch, toRGBA } from "../../src/spherex_viewer/static/lib.js";

const { chromium } = createRequire(import.meta.url)("playwright");

const REPO = resolve(fileURLToPath(import.meta.url), "../../..");
const SIZE = 59;
// Every element of the body as parent>tag#id, in document order: the complete UI.
const BODY = [
  "body>main#viewer",
  "main>section#player",
  "section>div#frame", "div>canvas#image", "div>div#marker",
  "section>div#controls",
  "div>button#prev", "div>button#play", "div>button#next", "div>input#slider",
  "section>p#date",
  "main>aside#panel",
  "aside>h1#name",
  "aside>p#position",
  "aside>p#hint",
  "aside>label#marker-control", "label>input#show-marker",
  "aside>details#enter", "details>summary",
  "details>form#search",
  "form>label", "label>input#ra",
  "form>label", "label>input#dec",
  "form>button#submit",
  "aside>details#advanced", "details>summary",
  "details>label", "label>select#detector",
  ...Array(6).fill("select>option"),
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

let server;
let cacheDir;
let baseUrl;
let browser;
let context;

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

const exampleOk = () => ({ status: 200, body: EXAMPLE });

/**
 * Opens the page with `example.json`, `api/search` and `api/frame` stubbed. `example()`,
 * `search(url)` and `frame(n)` return {status, body} (body JSON-encoded unless `raw` is
 * given) or {abort: true}. Unless `wait` is false, returns once the example is shown or
 * its failure is reported.
 */
async function openPage({
  search = unusedSearch, frame = () => ({ status: 200, body: {} }), example = exampleOk,
  wait = true,
}) {
  const origin = new URL(baseUrl).origin;
  const log = {
    requests: [], foreign: [], searches: [], frames: [], unexpectedApi: [], errors: [],
    examples: [], inFlight: 0, maxInFlight: 0,
  };
  const page = await context.newPage();
  page.on("request", (request) => log.requests.push(request.url()));
  page.on("pageerror", (error) => log.errors.push(String(error)));
  const reply = (route, { status, body, raw, abort }) => (abort
    ? route.abort("connectionfailed")
    : route.fulfill({
      status,
      contentType: raw === undefined ? "application/json" : "text/plain",
      body: raw ?? JSON.stringify(body),
    }));
  await page.route(() => true, async (route) => {
    const request = route.request();
    const url = new URL(request.url());
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
      return reply(route, await search(url));
    }
    if (url.pathname === "/api/frame" && request.method() === "POST") {
      const n = log.frames.length;
      log.frames.push(JSON.parse(request.postData()));
      log.inFlight += 1;
      log.maxInFlight = Math.max(log.maxInFlight, log.inFlight);
      try {
        return await reply(route, await frame(n));
      } finally {
        log.inFlight -= 1;
      }
    }
    if (url.pathname.startsWith("/api/")) {
      log.unexpectedApi.push(request.url());
      return reply(route, { status: 404, body: { detail: "stub" } });
    }
    return route.continue();
  });
  await page.goto(baseUrl);
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

/** Opens a disclosure through its summary, as a visitor would, unless it is open already. */
async function openDisclosure(page, id) {
  if (!(await page.$eval(`#${id}`, (el) => el.open))) await page.click(`#${id} > summary`);
}

async function submit(page, { ra = RA, dec = DEC, detector = "D2" } = {}) {
  await openDisclosure(page, "enter");
  await page.fill("#ra", ra);
  await page.fill("#dec", dec);
  await openDisclosure(page, "advanced");
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

const finished = (text) => !text.startsWith("Searching") && !text.startsWith("Loading");

async function finalStatus(page) {
  return waitForStatus(page, (text) => text !== "" && finished(text));
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

/** RGBA bytes of the canvas backing store. */
async function canvasPixels(page) {
  return page.$eval("#image", (el) => Array.from(
    el.getContext("2d").getImageData(0, 0, el.width, el.height).data));
}

/** RGBA bytes of the canvas as rendered on screen, with its size in CSS pixels. */
async function renderedCanvas(page) {
  const png = await page.locator("#image").screenshot();
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

function assertCleanRun(log) {
  const origin = new URL(baseUrl).origin;
  assert.deepEqual(log.errors, []);
  assert.deepEqual(log.foreign, []);
  assert.deepEqual(log.unexpectedApi, []);
  for (const url of log.requests) assert.equal(new URL(url).origin, origin, url);
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

test("the body holds exactly the agreed elements, in order, and nothing else", { timeout: TIMEOUT },
  async () => {
    const { page, log } = await openPage({});
    const body = await page.$$eval("body *", (els) => els.map((el) => {
      const id = el.id ? `#${el.id}` : "";
      return `${el.parentElement.tagName.toLowerCase()}>${el.tagName.toLowerCase()}${id}`;
    }));
    assert.deepEqual(body, BODY);

    // A label's text includes its control's; the detector label also lists the options.
    const labels = await page.$$eval("label",
      (els) => els.map((el) => el.textContent.replace(/\s+/g, " ").trim()));
    assert.deepEqual(labels,
      ["Show target marker", "RA", "Dec", "Detector D1 D2 D3 D4 D5 D6"]);
    assert.deepEqual(await page.$$eval("summary", (els) => els.map((el) => el.textContent)),
      ["Enter coordinates", "Advanced settings"]);
    assert.deepEqual(await page.$$eval("button", (els) => els.map((el) => [
      el.id, el.textContent.trim(), el.getAttribute("aria-label")])), [
      ["prev", "\u2039", "Previous frame"],
      ["play", "Play", null],
      ["next", "\u203a", "Next frame"],
      ["submit", "Show", null],
    ]);
    assert.equal(await page.getAttribute("#ra", "type"), "text");
    assert.equal(await page.getAttribute("#dec", "type"), "text");
    assert.equal(await page.getAttribute("#show-marker", "type"), "checkbox");
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

test("the detector selector sits inside the closed Advanced settings disclosure",
  { timeout: TIMEOUT }, async () => {
    const { page, log } = await openPage({});
    assert.equal(await page.$eval("#detector", (el) => el.closest("details")?.id), "advanced");
    assert.equal(await page.$eval("#advanced", (el) => el.open), false);
    assert.equal(await page.isVisible("#detector"), false);
    assert.equal(await page.isVisible("#advanced > summary"), true);
    await page.click("#advanced > summary");
    assert.equal(await page.isVisible("#detector"), true);
    assertCleanRun(log);
  });

test("Enter coordinates is visible on load and reveals the RA/Dec search with RA focused",
  { timeout: TIMEOUT }, async () => {
    const { page, log } = await openPage({});
    assert.equal(await page.isVisible("#enter > summary"), true);
    for (const id of ["#ra", "#dec", "#submit"]) assert.equal(await page.isVisible(id), false, id);
    await page.click("#enter > summary");
    for (const id of ["#ra", "#dec", "#submit"]) assert.equal(await page.isVisible(id), true, id);
    await page.waitForFunction(() => document.activeElement?.id === "ra");
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
      for (const id of ["#prev", "#play", "#next", "#slider"]) {
        assert.equal(await page.isDisabled(id), true, id);
      }
      assert.equal(await text(page, "#name"), "");
      assert.equal(await page.isVisible("#marker-control"), false);
      assert.equal(await page.isVisible("#enter > summary"), true);
      await submit(page);
      assert.equal(await finalStatus(page), "3 frames from 42 of 42 exposures.");
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
      assert.equal(await finalStatus(page), "3 frames from 42 of 42 exposures.");
      gate.release();
      await page.waitForTimeout(500);
      assert.equal(await text(page, "#name"), `RA ${RA}, Dec ${DEC}`);
      assert.equal(await dateText(page), "2025-05-06 \u00b7 8 exposures");
      assert.equal(await statusText(page), "3 frames from 42 of 42 exposures.");
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
    const { rects, width, height } = await layout(page, [...PLAYER, "#panel", "#enter"]);
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
    assert.ok(rects["#enter"].bottom <= height, "Enter coordinates not in view");
    assertCleanRun(log);
  });

test("at 390 px width the target panel is below the player and nothing scrolls sideways",
  { timeout: TIMEOUT }, async () => {
    const { page, log } = await openPage({});
    await page.setViewportSize({ width: 390, height: 844 });
    await openDisclosure(page, "enter");
    await openDisclosure(page, "advanced");
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
      assert.equal(await finalStatus(page), "3 frames from 42 of 42 exposures.");
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
    assert.equal(await finalStatus(page), "1 frame from 1 of 1 exposure.");
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
    assert.equal(await finalStatus(page), "3 frames from 24 of 42 exposures.");
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
      assert.equal(await finalStatus(page), `3 frames from 56 of 400 exposures. ${notice}`);
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
    + "Cap applied: 1 of 1 frame uses 24 of its exposures, evenly spaced in time order.");
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
      "2 frames from 23 of 42 exposures. 1 frame could not be loaded: every exposure failed.");
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
      frame: (n) => [
        reply,
        () => ({ status: 503, raw: "unavailable" }),
        () => ({ status: 429, body: { detail: "Too many requests, try again later." } }),
      ][n](n),
    });
    await submit(page);
    assert.equal(await finalStatus(page), "1 frame from 8 of 42 exposures. "
      + "2 frames could not be loaded: Too many requests, try again later.");
    assertCleanRun(log);
  });

test("when every frame fails the status says so with the reason", { timeout: TIMEOUT },
  async () => {
    const plan = makePlan(THREE_FRAMES.slice(0, 2));
    const { page, log } = await openPage({
      search: () => ({ status: 200, body: plan }),
      frame: (n) => (n === 0 ? { status: 502, body: { detail: "every exposure failed" } }
        : { status: 503, raw: "unavailable" }),
    });
    await submit(page);
    assert.equal(await finalStatus(page), "No frame could be loaded: 503 Service Unavailable.");
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
      const { page, log } = await openPage({ search: () => ({ status, body: { detail } }) });
      await submit(page, { ra: "abc" });
      assert.equal(await finalStatus(page), `Error: ${detail}`);
      assert.equal(log.frames.length, 0);
      assert.equal(await page.isDisabled("#play"), true);
      assert.equal(await page.isDisabled("#slider"), true);
      assertCleanRun(log);
    });
}

test("a search error without a JSON detail shows the HTTP status", { timeout: TIMEOUT },
  async () => {
    const { page, log } = await openPage({ search: () => ({ status: 503, raw: "down" }) });
    await submit(page);
    assert.equal(await finalStatus(page), "Error: 503 Service Unavailable");
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
