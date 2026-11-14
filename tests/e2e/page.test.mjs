import { after, afterEach, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const { chromium } = createRequire(import.meta.url)("playwright");

const REPO = resolve(fileURLToPath(import.meta.url), "../../..");
const SIZE = 59;
// Every element of the body as parent>tag#id, in document order: the complete UI.
const BODY = [
  "body>form#search",
  "form>label", "label>input#ra",
  "form>label", "label>input#dec",
  "form>select#detector",
  ...Array(6).fill("select>option"),
  "form>button#submit",
  "body>p#status",
  "body>canvas#image",
  "body>button#play",
  "body>input#slider",
  "body>span#date",
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

/**
 * Opens the page with `api/search` and `api/frame` stubbed. `search(url)` and `frame(n)`
 * return {status, body} (body JSON-encoded unless `raw` is given) or {abort: true}.
 */
async function openPage({ search, frame = () => ({ status: 200, body: {} }) }) {
  const origin = new URL(baseUrl).origin;
  const log = {
    requests: [], foreign: [], searches: [], frames: [], unexpectedApi: [], errors: [],
    inFlight: 0, maxInFlight: 0,
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
  return { page, log };
}

function frameBody(values, nUsed) {
  return { status: 200, body: { width: SIZE, height: SIZE, pixels: values, n_used: nUsed } };
}

function frameOk(plan) {
  return (n) => frameBody(pixels(n), plan.frames[n].n_used);
}

async function submit(page, { ra = RA, dec = DEC, detector = "D2" } = {}) {
  await page.fill("#ra", ra);
  await page.fill("#dec", dec);
  await page.selectOption("#detector", detector);
  await page.click("#submit");
}

const statusText = (page) => page.$eval("#status", (el) => el.textContent);
const dateText = (page) => page.$eval("#date", (el) => el.textContent.trim());

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
    const { page, log } = await openPage({ search: unusedSearch });
    const body = await page.$$eval("body *", (els) => els.map((el) => {
      const id = el.id ? `#${el.id}` : "";
      return `${el.parentElement.tagName.toLowerCase()}>${el.tagName.toLowerCase()}${id}`;
    }));
    assert.deepEqual(body, BODY);

    const labels = await page.$$eval("label", (els) => els.map((el) => el.textContent.trim()));
    assert.deepEqual(labels, ["RA", "Dec"]);
    assert.equal(await page.getAttribute("#ra", "type"), "text");
    assert.equal(await page.getAttribute("#dec", "type"), "text");
    assert.equal(await page.getAttribute("#slider", "type"), "range");
    assert.equal(await page.getAttribute("#status", "aria-live"), "polite");
    assert.equal(await page.getAttribute("#image", "role"), "img");
    assert.ok((await page.getAttribute("#image", "aria-label")).length > 0);
    assert.deepEqual(await page.$$eval("#detector option", (els) => els.map((el) => el.value)),
      ["D1", "D2", "D3", "D4", "D5", "D6"]);
    assert.equal(await page.inputValue("#detector"), "D2");
    assert.deepEqual(await page.$eval("#image", (el) => [el.width, el.height]), [SIZE, SIZE]);
    assert.equal(await page.$eval("#ack", (el) => el.textContent.replace(/\s+/g, " ").trim()),
      ACK);
    assertCleanRun(log);
  });

test("play and slider are disabled before any frame is loaded", { timeout: TIMEOUT }, async () => {
  const { page, log } = await openPage({ search: unusedSearch });
  assert.equal(await page.isDisabled("#play"), true);
  assert.equal(await page.isDisabled("#slider"), true);
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
      assert.equal(await page.isDisabled("#play"), true);
      assert.equal(await page.isDisabled("#slider"), true);

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

test("the date label shows the selected frame's label", { timeout: TIMEOUT }, async () => {
  const plan = makePlan(THREE_FRAMES);
  const { page, log } = await openPage({
    search: () => ({ status: 200, body: plan }), frame: frameOk(plan),
  });
  await submit(page);
  await finalStatus(page);
  const { min, value } = await sliderState(page);
  assert.equal(await dateText(page), plan.frames[value - min].label);
  for (const n of [2, 0, 1]) {
    await selectFrame(page, min + n);
    assert.equal(await dateText(page), plan.frames[n].label);
  }
  assertCleanRun(log);
});

test("the cap notice for several capped frames appears while loading and when finished",
  { timeout: TIMEOUT }, async () => {
    const plan = makePlan([
      { label: "2025-05-06", n_available: 8, n_used: 8 },
      { label: "2025-06-01 \u2013 2025-06-29", n_available: 300, n_used: 24 },
      { label: "2025-07-01 \u2013 2025-07-29", n_available: 92, n_used: 24 },
    ]);
    const notice = "Cap applied: 2 of 3 frames use 24 of their exposures, evenly sampled in time.";
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
    + "Cap applied: 1 of 1 frame uses 24 of its exposures, evenly sampled in time.");
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
    assert.equal(await dateText(page), plan.frames[2].label);
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

test("one stretch for all frames: equal values match, a brighter source stays brighter",
  { timeout: TIMEOUT }, async () => {
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
    const plan = makePlan([
      { label: "2025-05-06", n_available: 8, n_used: 8 },
      { label: "2025-11-07", n_available: 8, n_used: 8 },
    ]);
    const { page, log } = await openPage({
      search: () => ({ status: 200, body: plan }),
      frame: (n) => frameBody(frame(n === 0 ? 6 : 3), 8),
    });
    await submit(page);
    await finalStatus(page);
    const { min } = await sliderState(page);
    await selectFrame(page, min);
    const bright = await canvasPixels(page);
    await selectFrame(page, min + 1);
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
    assert.equal(label, plan.frames[value - min].label);
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
