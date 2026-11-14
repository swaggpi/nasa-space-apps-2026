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
const PAGE_IDS = ["search", "ra", "dec", "detector", "submit", "status", "image", "play", "slider", "date", "ack"];
const ACK = "This publication makes use of data products from the Spectro-Photometer for the History of "
  + "the Universe, Epoch of Reionization and Ices Explorer (SPHEREx), which is a joint project of "
  + "the Jet Propulsion Laboratory and the California Institute of Technology, and is funded by "
  + "the National Aeronautics and Space Administration.";
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
  return Array.from({ length: 59 * 59 }, (_, i) => (i === 1770 ? null : ((i * 7 + seed * 13) % 50) / 100));
}

function makePlan(frames, { detector = "D2", cap = 24 } = {}) {
  const planFrames = frames.map((f, index) => ({
    index,
    label: f.label,
    mjd_start: 60801 + 30 * index,
    mjd_end: 60801.3 + 30 * index,
    n_available: f.n_available,
    n_used: f.n_used,
    capped: f.n_used < f.n_available,
    uris: Array.from({ length: f.n_used },
      (_, j) => `ibe/data/spherex/dr1/level2/2025W19_1B/f${index}_${j}_1D2_spx.fits`),
  }));
  return {
    ra_deg: 133.795129, dec_deg: -7.245147, detector, width: 59, height: 59,
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

async function openPage({ search, frame = () => ({ status: 200, body: {} }) }) {
  const origin = new URL(baseUrl).origin;
  const log = { requests: [], foreign: [], searches: [], frames: [], unexpectedApi: [], inFlight: 0, maxInFlight: 0 };
  const page = await context.newPage();
  page.on("request", (request) => log.requests.push(request.url()));
  await page.route(() => true, async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin !== origin) {
      log.foreign.push(request.url());
      return route.abort();
    }
    if (url.pathname === "/api/search" && request.method() === "GET") {
      log.searches.push(url);
      const { status, body } = await search(url);
      return route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
    }
    if (url.pathname === "/api/frame" && request.method() === "POST") {
      const n = log.frames.length;
      log.frames.push(JSON.parse(request.postData()));
      log.inFlight += 1;
      log.maxInFlight = Math.max(log.maxInFlight, log.inFlight);
      try {
        const { status, body } = await frame(n);
        return await route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
      } finally {
        log.inFlight -= 1;
      }
    }
    if (url.pathname.startsWith("/api/")) {
      log.unexpectedApi.push(request.url());
      return route.fulfill({ status: 404, contentType: "application/json", body: '{"detail":"stub"}' });
    }
    return route.continue();
  });
  await page.goto(baseUrl);
  return { page, log };
}

function frameOk(plan) {
  return (n) => ({
    status: 200,
    body: { width: 59, height: 59, pixels: pixels(n), n_used: plan.frames[n].n_used, n_failed: 0 },
  });
}

async function submit(page, { ra = RA, dec = DEC, detector = "D2" } = {}) {
  await page.fill("#ra", ra);
  await page.fill("#dec", dec);
  await page.selectOption("#detector", detector);
  await page.click("#submit");
}

const statusText = (page) => page.$eval("#status", (el) => el.textContent.trim());
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

const finished = (count) => (text) => text.startsWith(`${count} frames from`);

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

function assertSameOrigin(log) {
  const origin = new URL(baseUrl).origin;
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
    ["-m", "uvicorn", "spherex_viewer.app:create_app", "--factory", "--host", "127.0.0.1", "--port", String(port)],
    { cwd: REPO, env: { ...process.env, SPHEREX_CACHE_DIR: cacheDir }, stdio: ["ignore", "pipe", "pipe"] });
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

test("the page body holds exactly the elements of section 6, in order, and nothing else", { timeout: TIMEOUT }, async () => {
  const { page, log } = await openPage({ search: () => ({ status: 500, body: { detail: "unused" } }) });
  const ids = await page.$$eval("body [id]", (els) => els.map((el) => el.id));
  assert.deepEqual(ids, PAGE_IDS);

  const controls = await page.$$eval("body input, body select, body button, body textarea",
    (els) => els.map((el) => el.id));
  assert.deepEqual(controls, ["ra", "dec", "detector", "submit", "play", "slider"]);
  assert.equal(await page.locator("h1, h2, h3, h4, h5, h6").count(), 0);
  assert.equal(await page.locator("img, svg, picture, video, iframe, object, embed").count(), 0);
  assert.equal(await page.locator("canvas").count(), 1);
  assert.equal(await page.locator("form").count(), 1);

  const tags = await page.$$eval("body [id]", (els) => els.map((el) => el.tagName.toLowerCase()));
  assert.deepEqual(tags, ["form", "input", "input", "select", "button", "p", "canvas", "button", "input", "span",
    "footer"]);
  assert.equal(await page.locator("#search #ra, #search #dec, #search #detector, #search #submit").count(), 4);
  assert.equal(await page.getAttribute("#ra", "type"), "text");
  assert.equal(await page.getAttribute("#dec", "type"), "text");
  assert.equal(await page.getAttribute("#slider", "type"), "range");
  assert.equal(await page.getAttribute("#status", "aria-live"), "polite");
  assert.deepEqual(await page.$$eval("#detector option", (els) => els.map((el) => el.value)),
    ["D1", "D2", "D3", "D4", "D5", "D6"]);
  assert.equal(await page.inputValue("#detector"), "D2");
  assert.deepEqual(await page.$eval("#image", (el) => [el.width, el.height]), [59, 59]);
  assert.equal(await page.$eval("#ack", (el) => el.textContent.replace(/\s+/g, " ").trim()), ACK);
  assertSameOrigin(log);
});

test("play and slider are disabled before any frame is loaded", { timeout: TIMEOUT }, async () => {
  const { page, log } = await openPage({ search: () => ({ status: 500, body: { detail: "unused" } }) });
  assert.equal(await page.isDisabled("#play"), true);
  assert.equal(await page.isDisabled("#slider"), true);
  assertSameOrigin(log);
});

test("frames are requested one at a time and the slider grows as each arrives", { timeout: TIMEOUT }, async () => {
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
    await waitForStatus(page, (t) => t.startsWith("Loading frame 1 of 3\u2026"));
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
        await waitForStatus(page, (t) => t.startsWith(`Loading frame ${n + 2} of 3\u2026`));
        await page.waitForTimeout(200);
        assert.equal(log.frames.length, n + 2);
      }
    }
    assert.ok(sizes[0] < sizes[1] && sizes[1] < sizes[2], `slider.max sequence ${sizes}`);
    assert.equal(log.maxInFlight, 1);
    assert.equal(await page.isDisabled("#play"), false);

    const search = log.searches[0].searchParams;
    assert.deepEqual([search.get("ra"), search.get("dec"), search.get("detector")], [RA, DEC, "D2"]);
    assert.deepEqual(log.frames, plan.frames.map((f) => ({ ra_deg: plan.ra_deg, dec_deg: plan.dec_deg, uris: f.uris })));
    assert.equal(await waitForStatus(page, finished(3)), "3 frames from 42 of 42 exposures.");
    assertSameOrigin(log);
  } finally {
    gates.forEach((g) => g.release());
  }
});

test("the date label shows the selected frame's label", { timeout: TIMEOUT }, async () => {
  const plan = makePlan(THREE_FRAMES);
  const { page, log } = await openPage({ search: () => ({ status: 200, body: plan }), frame: frameOk(plan) });
  await submit(page);
  await waitForStatus(page, finished(3));
  const { min, value } = await sliderState(page);
  assert.equal(await dateText(page), plan.frames[value - min].label);
  for (const n of [2, 0, 1]) {
    await selectFrame(page, min + n);
    assert.equal(await dateText(page), plan.frames[n].label);
  }
  assertSameOrigin(log);
});

test("the cap notice appears in the status line for a capped plan", { timeout: TIMEOUT }, async () => {
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
    const loading = await waitForStatus(page, (t) => t.startsWith("Loading frame 1 of 3\u2026"));
    assert.ok(loading.includes(notice), loading);
    gate.release();
    assert.equal(await waitForStatus(page, finished(3)), `3 frames from 56 of 400 exposures. ${notice}`);
    assertSameOrigin(log);
  } finally {
    gate.release();
  }
});

test("a failing frame is counted and loading continues", { timeout: TIMEOUT }, async () => {
  const plan = makePlan(THREE_FRAMES);
  const reply = frameOk(plan);
  const { page, log } = await openPage({
    search: () => ({ status: 200, body: plan }),
    frame: (n) => (n === 1 ? { status: 502, body: { detail: "every exposure failed" } } : reply(n)),
  });
  await submit(page);
  const text = await waitForStatus(page, finished(2));
  assert.ok(text.endsWith(" 1 frames could not be loaded."), text);
  assert.equal(log.frames.length, 3);
  const { disabled, min, max } = await sliderState(page);
  assert.equal(disabled, false);
  assert.equal(max - min + 1, 2);
  await selectFrame(page, max);
  assert.equal(await dateText(page), plan.frames[2].label);
  assertSameOrigin(log);
});

test("a search error shows its detail in the status line", { timeout: TIMEOUT }, async () => {
  const { page, log } = await openPage({
    search: () => ({ status: 422, body: { detail: "RA is not a valid angle." } }),
  });
  await submit(page, { ra: "abc" });
  assert.equal(await waitForStatus(page, (t) => t.startsWith("Error")), "Error: RA is not a valid angle.");
  assert.equal(log.frames.length, 0);
  assert.equal(await page.isDisabled("#play"), true);
  assert.equal(await page.isDisabled("#slider"), true);
  assertSameOrigin(log);
});

test("an empty plan reports that no exposures cover the position in the chosen detector", { timeout: TIMEOUT }, async () => {
  const { page, log } = await openPage({
    search: () => ({ status: 200, body: makePlan([], { detector: "D4" }) }),
  });
  await submit(page, { detector: "D4" });
  assert.equal(await waitForStatus(page, (t) => t.startsWith("No SPHEREx")),
    "No SPHEREx exposures cover this position in D4.");
  assert.equal(log.searches[0].searchParams.get("detector"), "D4");
  assert.equal(log.frames.length, 0);
  assertSameOrigin(log);
});

test("play toggles looping playback through the loaded frames", { timeout: TIMEOUT }, async () => {
  const plan = makePlan(THREE_FRAMES);
  const { page, log } = await openPage({ search: () => ({ status: 200, body: plan }), frame: frameOk(plan) });
  await submit(page);
  await waitForStatus(page, finished(3));
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
  assertSameOrigin(log);
});
