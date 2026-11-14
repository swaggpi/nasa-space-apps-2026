// Checks the page's difference view on real loops of the challenge targets.
//
//   node validation/check_difference.mjs <source>
//
// <source> is a running server (http...: one search per loop, then its frames one at a time,
// as the page loads them) or a JSON file [{name, ra, dec, detector, frames: [{label, n_used,
// width, height, pixels}]}]. Writes Markdown to stdout. Exit status 1 unless every must-show
// frame built from more than 5 exposures draws the target at a grey distance of at least 50
// and at least twice the strongest pixel beyond 9 px, and no frame of any loop built from
// more than 5 exposures has a pixel beyond 9 px at half scale or more (a must-show loop with no
// such frame fails); 2 if a loop is missing. The HD 2811 loops are a control: a constant
// flux standard. A bright unchanging star also leaves a residual at the centre, so the check
// further fails unless every control frame from more than 5 exposures stays below 85 at the
// centre (a control loop with no such frame fails) and the strongest such frame of each
// must-show loop reaches 100. A server answering 429 is asked again after its Retry-After.

import { readFileSync } from "node:fs";

import {
  computeStretch, difference, toDifferenceRGBA,
} from "../src/spherex_viewer/static/lib.js";

const LOOPS = [
  { name: "Barnard's Star", ra: "269.4462683", dec: "4.7682045", detector: "D6", must: true },
  { name: "Epsilon Indi B", ra: "331.0965743", dec: "-56.8010859", detector: "D5", must: true },
  { name: "RW Aurigae", ra: "76.9560812", dec: "30.40120459", detector: "D5", must: true },
  { name: "WISE 0855", ra: "133.795129", dec: "-7.245147", detector: "D6", must: false },
  { name: "WISE 0855", ra: "133.795129", dec: "-7.245147", detector: "D2", must: false },
  { name: "R Draconis", ra: "248.16737837", dec: "66.75500675", detector: "D6", must: false },
  { name: "Epsilon Indi B", ra: "331.0965743", dec: "-56.8010859", detector: "D2", must: false },
  { name: "RW Aurigae", ra: "76.9560812", dec: "30.40120459", detector: "D2", must: false },
  { name: "HD 2811", ra: "7.82704", dec: "-43.60639", detector: "D5", must: false, control: true },
  { name: "HD 2811", ra: "7.82704", dec: "-43.60639", detector: "D6", must: false, control: true },
];
const CENTRE = 29;
const TARGET_RADIUS = 5;
const FIELD_RADIUS = 9;
const HALF_SCALE = 64;
const SPARSE_EXPOSURES = 5; // frames from this many exposures or fewer are not judged
const CONTROL_LIMIT = 85; // every judged control frame: C below this (measured at most 75.5)
const MUST_PEAK = 100; // strongest judged frame of each must-show loop (measured 105.5-121.5)
const MAX_RETRIES = 10;

async function request(url, options) {
  let response = await fetch(url, options);
  for (let retry = 1; response.status === 429 && retry <= MAX_RETRIES; retry++) {
    const wait = Number(response.headers.get("Retry-After")) || 30;
    console.error(`${url}: HTTP 429, waiting ${wait} s (retry ${retry} of ${MAX_RETRIES})`);
    await new Promise((resolve) => setTimeout(resolve, wait * 1000));
    response = await fetch(url, options);
  }
  if (!response.ok) throw new Error(`${options?.method ?? "GET"} ${url}: HTTP ${response.status}`);
  return response.json();
}

async function fromServer(base) {
  const root = base.endsWith("/") ? base : base + "/";
  const loops = [];
  for (const loop of LOOPS) {
    const query = new URLSearchParams({ ra: loop.ra, dec: loop.dec, detector: loop.detector });
    const plan = await request(`${root}api/search?${query}`);
    const frames = [];
    for (const planned of plan.frames) {
      const result = await request(`${root}api/frame`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ra_deg: plan.ra_deg, dec_deg: plan.dec_deg, uris: planned.uris }),
      });
      frames.push({ label: planned.label, ...result });
    }
    loops.push({ ...loop, frames });
  }
  return loops;
}

function fromFile(path) {
  const data = JSON.parse(readFileSync(path, "utf8"));
  return LOOPS.map((loop) => {
    const found = data.find((d) => d.name === loop.name && d.detector === loop.detector);
    if (found === undefined) {
      console.error(`${path} has no loop ${loop.name} ${loop.detector}`);
      process.exit(2);
    }
    return { ...loop, frames: found.frames };
  });
}

/** C, F and H of each frame's difference image, drawn with the loop's common stretch. */
function measure(loop) {
  const frames = loop.frames.map((f) => ({
    pixels: f.pixels, width: f.width, height: f.height, nUsed: f.n_used,
  }));
  const stretch = computeStretch(frames.map((f) => f.pixels));
  return frames.map((f, k) => {
    const rgba = toDifferenceRGBA(difference(frames, k), stretch);
    let centre = 0;
    let field = 0;
    let half = 0;
    for (let i = 0; i < f.pixels.length; i++) {
      if (rgba[4 * i + 3] === 0) continue;
      const distance = Math.abs(rgba[4 * i] - 127.5);
      const r = Math.hypot((i % f.width) - CENTRE, Math.floor(i / f.width) - CENTRE);
      if (r <= TARGET_RADIUS) centre = Math.max(centre, distance);
      if (r > FIELD_RADIUS) {
        field = Math.max(field, distance);
        if (distance >= HALF_SCALE) half += 1;
      }
    }
    return { label: loop.frames[k].label, nUsed: f.nUsed, centre, field, half };
  });
}

const source = process.argv[2];
if (source === undefined) {
  console.error("usage: node validation/check_difference.mjs <server URL or JSON file>");
  process.exit(2);
}
const loops = source.startsWith("http") ? await fromServer(source) : fromFile(source);

const lines = [
  `# Difference view on real data`,
  "",
  `Source: ${source}. Run: ${new Date().toISOString().slice(0, 16).replace("T", " ")} UTC.`,
  "",
  "Each frame minus the exposure-weighted average of the other frames, averaged over 3×3 "
    + "pixels and drawn as the page draws it. Grey distance = |grey − 127.5| on the 0–255 "
    + "scale (127.5 = full scale). C: largest within 5 px of the centre (29, 29); F: largest "
    + "beyond 9 px; H: pixels beyond 9 px at 64 (half scale) or more. Only frames from more than "
    + `${SPARSE_EXPOSURES} exposures are judged. HD 2811 is a control: a constant flux standard, `
    + "whose residual at the centre is that of a bright star that does not change.",
];
const failures = [];
for (const loop of loops) {
  const rows = measure(loop);
  const kind = loop.must ? "must show the target"
    : loop.control ? "control, constant star" : "reported";
  lines.push("", `## ${loop.name} ${loop.detector} (${kind})`, "",
    "| Frame | Exposures | C | F | H |", "|---|---:|---:|---:|---:|");
  for (const row of rows) {
    lines.push(`| ${row.label} | ${row.nUsed} | ${row.centre} | ${row.field} | ${row.half} |`);
    if (row.nUsed <= SPARSE_EXPOSURES) continue;
    const where = `${loop.name} ${loop.detector} ${row.label}`;
    if (loop.must && !(row.centre >= 50 && row.centre >= 2 * row.field)) {
      failures.push(`${where}: C ${row.centre}, F ${row.field}`);
    }
    if (row.half > 0) failures.push(`${where}: H ${row.half}`);
    if (loop.control && row.centre >= CONTROL_LIMIT) {
      failures.push(`${where}: control C ${row.centre}, not below ${CONTROL_LIMIT}`);
    }
  }
  const judged = rows.filter((row) => row.nUsed > SPARSE_EXPOSURES);
  if ((loop.must || loop.control) && judged.length === 0) {
    failures.push(`${loop.name} ${loop.detector}: no frame from more than `
      + `${SPARSE_EXPOSURES} exposures`);
  } else if (loop.must && Math.max(...judged.map((row) => row.centre)) < MUST_PEAK) {
    failures.push(`${loop.name} ${loop.detector}: strongest frame C `
      + `${Math.max(...judged.map((row) => row.centre))}, below ${MUST_PEAK}`);
  }
}
lines.push("", "## Verdict", "");
if (failures.length === 0) {
  lines.push("Pass: every must-show loop has a frame from more than 5 exposures, every such "
    + `frame has C ≥ 50 and C ≥ 2 F, and its strongest such frame has C ≥ ${MUST_PEAK}; `
    + `every control frame from more than 5 exposures has C < ${CONTROL_LIMIT}; and no frame `
    + "from more than 5 exposures has H > 0. C measures how strongly the centre is drawn, "
    + "not whether it changed: a single target frame can be no stronger than the control; "
    + "only the strongest frame of each target loop clearly exceeds it.");
} else {
  lines.push("Fail:", "", ...failures.map((f) => `- ${f}`));
}
console.log(lines.join("\n"));
process.exitCode = failures.length === 0 ? 0 : 1;
