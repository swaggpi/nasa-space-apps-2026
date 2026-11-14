import { test } from "node:test";
import assert from "node:assert/strict";

import {
  capNotice, computeStretch, difference, fieldCorners, fieldTexts, formatPosition, frameLabel,
  isClick, joinStatus, linkQuery, markerPercent, nextIndex, noDataNote, parseExample, parseLink,
  plural, previousIndex, retryDelay, toDifferenceRGBA, toRGBA, validFrameBody, validPlan,
} from "../../src/spherex_viewer/static/lib.js";

const SOURCE = 12;
const BACKGROUND = [
  0.01, -0.02, 0.03, 0.0, -0.01,
  0.02, 0.05, -0.03, 0.01, 0.04,
  -0.04, 0.02, 0.0, 0.03, -0.02,
  0.01, -0.01, 0.02, -0.05, 0.0,
  0.03, 0.0, -0.02, 0.01, 0.02,
];

function frameWithSource(amplitude) {
  const frame = [...BACKGROUND];
  frame[SOURCE] = amplitude;
  return frame;
}

function greys(pixels, stretch) {
  const rgba = toRGBA(pixels, stretch);
  return Array.from({ length: pixels.length }, (_, i) => rgba[4 * i]);
}

function assertClose(actual, expected, label) {
  assert.ok(Math.abs(actual - expected) <= 1e-9 * Math.max(1, Math.abs(expected)),
    `${label}: expected ${expected}, got ${actual}`);
}

function plan(frames, cap = 24) {
  return {
    ra_deg: 133.795129, dec_deg: -7.245147, detector: "D2",
    n_exposures: frames.reduce((sum, f) => sum + f.n_available, 0),
    cap,
    capped: frames.some((f) => f.capped),
    frames: frames.map((f, index) => ({
      label: `2025-05-0${index + 1}`,
      n_available: f.n_available, n_used: f.n_used, capped: f.capped,
      uris: Array.from({ length: f.n_used },
        (_, j) => `ibe/data/spherex/dr1/level2/x/${index}_${j}.fits`),
    })),
  };
}

const UNCAPPED = { n_available: 8, n_used: 8, capped: false };
const CAPPED = { n_available: 300, n_used: 24, capped: true };

test("a shared stretch keeps equal values equal and a brighter source brighter", () => {
  const a = frameWithSource(3.0);
  const b = frameWithSource(6.0);
  const stretch = computeStretch([a, b]);
  const greyA = greys(a, stretch);
  const greyB = greys(b, stretch);

  for (let i = 0; i < BACKGROUND.length; i++) {
    if (i !== SOURCE) assert.equal(greyA[i], greyB[i], `pixel ${i}`);
  }
  assert.ok(greyB[SOURCE] > greyA[SOURCE], `B ${greyB[SOURCE]} should exceed A ${greyA[SOURCE]}`);

  const perFrameA = greys(a, computeStretch([a]));
  const perFrameB = greys(b, computeStretch([b]));
  assert.equal(perFrameA[SOURCE], perFrameB[SOURCE]);
});

test("computeStretch on a hand-computed pool, ignoring nulls", () => {
  // pool 0,1,2,3,4,5,100: med 3; |v-med| sorted 0,1,1,2,2,3,97 -> MAD 2; sigma 2.9652
  // lo = 3 - 5.9304; hi = rank ceil(0.999*7) = 7 -> 100; soft = max(14.826, 102.9304/1000)
  const stretch = computeStretch([[0, 1, 2, null], [null, 3, 4, 5, 100]]);
  assertClose(stretch.lo, -2.9304, "lo");
  assertClose(stretch.hi, 100, "hi");
  assertClose(stretch.soft, 14.826, "soft");
});

test("computeStretch uses the nearest-rank 99.9th percentile for hi", () => {
  // 1..1001: med 501, MAD 250, sigma 370.65; hi = rank ceil(999.999) = 1000
  const pixels = Array.from({ length: 1001 }, (_, i) => i + 1);
  const stretch = computeStretch([pixels]);
  assertClose(stretch.lo, 501 - 2 * 370.65, "lo");
  assertClose(stretch.hi, 1000, "hi");
  assertClose(stretch.soft, 5 * 370.65, "soft");
});

test("toRGBA maps lo and below to black, hi and above to white, asinh in between", () => {
  // grey = round(255 * asinh(v) / asinh(1)) for lo 0, hi 1, soft 1
  const actual = greys([-1, 0, 0.25, 0.5, 0.75, 1, 3], { lo: 0, hi: 1, soft: 1 });
  assert.deepEqual(actual, [0, 0, 72, 139, 201, 255, 255]);
});

test("an empty pool gives the default stretch", () => {
  assert.deepEqual(computeStretch([]), { lo: 0, hi: 1, soft: 1 });
  assert.deepEqual(computeStretch([[null, null, null]]), { lo: 0, hi: 1, soft: 1 });
});

test("a constant frame gives a finite stretch and finite greys", () => {
  const frame = new Array(3481).fill(0.25);
  const stretch = computeStretch([frame]);
  for (const key of ["lo", "hi", "soft"]) assert.ok(Number.isFinite(stretch[key]), key);
  assert.ok(stretch.hi > stretch.lo);
  assert.ok(stretch.soft > 0);
  assertClose(stretch.lo, 0.25, "lo");
  assertClose(stretch.hi, 1.25, "hi");
  assertClose(stretch.soft, 0.001, "soft");
  const rgba = toRGBA(frame, stretch);
  assert.ok(rgba.every((x) => Number.isFinite(x)));
  assert.equal(rgba[0], 0);
  assert.equal(rgba[3], 255);
});

test("toRGBA returns 4 bytes per pixel, R=G=B with alpha 255, and 0,0,0,0 for null", () => {
  const pixels = [0, null, 0.5, 1, null];
  const rgba = toRGBA(pixels, { lo: 0, hi: 1, soft: 1 });
  assert.ok(rgba instanceof Uint8ClampedArray);
  assert.equal(rgba.length, 4 * pixels.length);
  pixels.forEach((v, i) => {
    const px = Array.from(rgba.slice(4 * i, 4 * i + 4));
    if (v === null) {
      assert.deepEqual(px, [0, 0, 0, 0], `pixel ${i}`);
    } else {
      assert.equal(px[0], px[1], `pixel ${i}`);
      assert.equal(px[1], px[2], `pixel ${i}`);
      assert.equal(px[3], 255, `pixel ${i}`);
    }
  });
  assert.equal(rgba[0], 0);
  assert.equal(rgba[12], 255);
});

test("capNotice names how many frames were capped and the cap, in plural", () => {
  assert.equal(capNotice(plan([UNCAPPED, CAPPED, CAPPED])),
    "Cap applied: 2 of 3 frames use 24 of their exposures, evenly spaced in time order.");
});

test("capNotice uses the singular for one capped frame", () => {
  assert.equal(capNotice(plan([UNCAPPED, CAPPED, UNCAPPED])),
    "Cap applied: 1 of 3 frames uses 24 of its exposures, evenly spaced in time order.");
  assert.equal(capNotice(plan([CAPPED])),
    "Cap applied: 1 of 1 frame uses 24 of its exposures, evenly spaced in time order.");
});

test("capNotice is empty for a plan without a cap and for an empty plan", () => {
  assert.equal(capNotice(plan([UNCAPPED, { n_available: 24, n_used: 24, capped: false }])), "");
  assert.equal(capNotice(plan([])), "");
});

test("plural uses the singular only for exactly one", () => {
  assert.equal(plural(1, "frame"), "1 frame");
  assert.equal(plural(0, "frame"), "0 frames");
  assert.equal(plural(2, "exposure"), "2 exposures");
});

test("joinStatus joins non-empty parts with single spaces and no trailing space", () => {
  assert.equal(joinStatus("Loading frame 1 of 2\u2026", ""), "Loading frame 1 of 2\u2026");
  assert.equal(joinStatus("a.", "", "b.", ""), "a. b.");
  assert.equal(joinStatus("", ""), "");
});

test("frameLabel adds the exposure count after a middle dot with a space on each side", () => {
  assert.equal(frameLabel("2025-11-07 \u2013 2025-11-10", 19),
    "2025-11-07 \u2013 2025-11-10 \u00b7 19 exposures");
  assert.equal(frameLabel("2026-09-22", 1), "2026-09-22 \u00b7 1 exposure");
});

test("nextIndex advances and wraps to the first frame", () => {
  assert.equal(nextIndex(0, 3), 1);
  assert.equal(nextIndex(1, 3), 2);
  assert.equal(nextIndex(2, 3), 0);
  assert.equal(nextIndex(0, 1), 0);
});

test("previousIndex steps back and wraps to the last frame", () => {
  assert.equal(previousIndex(2, 3), 1);
  assert.equal(previousIndex(1, 3), 0);
  assert.equal(previousIndex(0, 3), 2);
  assert.equal(previousIndex(0, 1), 0);
});

test("formatPosition gives four decimals in degrees, a signed Dec and the detector", () => {
  assert.equal(formatPosition(269.4462683, 4.7682045, "D6"),
    "RA 269.4463\u00b0, Dec +4.7682\u00b0 \u00b7 D6");
  assert.equal(formatPosition(133.795129, -7.245147, "D2"),
    "RA 133.7951\u00b0, Dec \u22127.2451\u00b0 \u00b7 D2");
});

test("markerPercent puts pixel centres at integer coordinates", () => {
  assert.deepEqual(markerPercent({ x: 0, y: 0 }, 59, 59),
    { left: 50 / 59, top: 50 / 59 });
  assert.deepEqual(markerPercent({ x: 29, y: 29 }, 59, 59), { left: 50, top: 50 });
  assert.deepEqual(markerPercent({ x: -0.5, y: 58.5 }, 59, 59), { left: 0, top: 100 });
  assert.deepEqual(markerPercent({ x: 1.5, y: 0.5 }, 4, 2), { left: 50, top: 50 });
});

function example({ marker = true, frames = 2 } = {}) {
  return {
    name: "Barnard's Star",
    hint: "Watch the bright star move.",
    ra_deg: 269.4462683,
    dec_deg: 4.7682045,
    detector: "D6",
    width: 2,
    height: 2,
    frames: Array.from({ length: frames }, (_, i) => ({
      label: `2025-0${i + 1}-01`,
      n_used: i + 1,
      pixels: [0.1, null, 0.3, i],
      ...(marker ? { marker: { x: 0.5 + i, y: 1 } } : {}),
    })),
  };
}

test("parseExample converts a valid example to page frames with labels and markers", () => {
  const parsed = parseExample(example());
  assert.deepEqual(parsed, {
    name: "Barnard's Star",
    hint: "Watch the bright star move.",
    position: "RA 269.4463\u00b0, Dec +4.7682\u00b0 \u00b7 D6",
    frames: [
      { pixels: [0.1, null, 0.3, 0], width: 2, height: 2,
        label: "2025-01-01 \u00b7 1 exposure", nUsed: 1, marker: { x: 0.5, y: 1 } },
      { pixels: [0.1, null, 0.3, 1], width: 2, height: 2,
        label: "2025-02-01 \u00b7 2 exposures", nUsed: 2, marker: { x: 1.5, y: 1 } },
    ],
  });
});

test("parseExample accepts an example without markers and leaves the key out", () => {
  const parsed = parseExample(example({ marker: false }));
  assert.ok(parsed !== null);
  for (const frame of parsed.frames) assert.equal("marker" in frame, false);
});

test("parseExample rejects content that does not match the schema", () => {
  const broken = [
    null, [], "x", {},
    { ...example(), name: 3 },
    { ...example(), hint: undefined },
    { ...example(), ra_deg: "269.4" },
    { ...example(), dec_deg: Number.NaN },
    { ...example(), detector: null },
    { ...example(), width: 0 },
    { ...example(), height: 2.5 },
    { ...example(), frames: [] },
    { ...example(), frames: "none" },
  ];
  const withFrame = (change) => {
    const data = example();
    data.frames[1] = { ...data.frames[1], ...change };
    return data;
  };
  broken.push(
    withFrame({ pixels: [0.1, null, 0.3] }),
    withFrame({ pixels: [0.1, null, 0.3, "1"] }),
    withFrame({ label: 5 }),
    withFrame({ n_used: -1 }),
    withFrame({ marker: { x: 1 } }),
    withFrame({ marker: undefined }),
  );
  broken.forEach((data, i) => assert.equal(parseExample(data), null, `case ${i}`));
});

// Outer corners (pixel edges -0.5 and 58.5) of the server's grid, from
// spherex_viewer.grid.target_wcs(ra, dec).wcs_pix2world(..., 0) with astropy:
// north-east, north-west, south-west, south-east.
const GRID_CORNERS = [
  [269.4462683, 4.7682045, [[269.4968428493, 4.818598452], [269.3956937507, 4.818598452],
    [269.3957011713, 4.7178068506], [269.4968354287, 4.7178068506]]],
  [10.0, -89.95, [[36.655346388, -89.8876654333], [343.344653612, -89.8876654333],
    [279.5499949955, -89.9496026447], [100.4500050045, -89.9496026447]]],
  [359.99, 30.0, [[0.0482216421, 30.0503829983], [359.9317783579, 30.0503829983],
    [359.9318374603, 29.9495914096], [0.0481625397, 29.9495914096]]],
];

test("fieldCorners matches the corners of the server's 59 x 6.15 arcsec north-up grid", () => {
  for (const [ra, dec, expected] of GRID_CORNERS) {
    const corners = fieldCorners(ra, dec);
    assert.equal(corners.length, 4);
    corners.forEach(([cRa, cDec], i) => {
      const [eRa, eDec] = expected[i];
      const dRa = (((cRa - eRa + 540) % 360) - 180) * Math.cos((eDec * Math.PI) / 180);
      assert.ok(Math.abs(dRa) < 1e-8 && Math.abs(cDec - eDec) < 1e-8,
        `(${ra}, ${dec}) corner ${i}: ${cRa}, ${cDec} vs ${eRa}, ${eDec}`);
      assert.ok(cRa >= 0 && cRa < 360, `RA ${cRa} not in [0, 360)`);
    });
  }
});

test("the field is 362.85 arcsec (6.05 arcmin) on a side", () => {
  // Angular distance between the two northern and the two eastern corners at the equator.
  const [ne, nw, , se] = fieldCorners(180, 0);
  const sep = ([ra1, dec1], [ra2, dec2]) => {
    const r = Math.PI / 180;
    const c = Math.sin(dec1 * r) * Math.sin(dec2 * r)
      + Math.cos(dec1 * r) * Math.cos(dec2 * r) * Math.cos((ra1 - ra2) * r);
    return (Math.acos(Math.min(1, c)) / r) * 3600;
  };
  assert.ok(Math.abs(sep(ne, nw) - 362.85) < 0.01, `top edge ${sep(ne, nw)}`);
  assert.ok(Math.abs(sep(ne, se) - 362.85) < 0.01, `east edge ${sep(ne, se)}`);
  assert.ok(ne[0] > nw[0] && ne[1] > se[1], "east must be at larger RA, north at larger Dec");
});

test("fieldTexts gives six-decimal degrees the server reads as decimal degrees", () => {
  const decimal = /^[+-]?(\d+\.?\d*|\.\d+)$/;
  const cases = [
    [[269.44626834, 4.76820449], { ra: "269.446268", dec: "4.768204" }],
    [[133.7951294, -7.2451471], { ra: "133.795129", dec: "-7.245147" }],
    [[359.9999996, 0], { ra: "0.000000", dec: "0.000000" }],
    [[-0.5, -0.0000001], { ra: "359.500000", dec: "0.000000" }],
    [[361.25, 90.0000001], { ra: "1.250000", dec: "90.000000" }],
    [[0, -90], { ra: "0.000000", dec: "-90.000000" }],
  ];
  for (const [[ra, dec], expected] of cases) {
    const texts = fieldTexts(ra, dec);
    assert.deepEqual(texts, expected, `${ra}, ${dec}`);
    assert.match(texts.ra, decimal);
    assert.match(texts.dec, decimal);
    assert.ok(Number(texts.ra) >= 0 && Number(texts.ra) < 360);
  }
  // Rounding to six decimals keeps the position to within 0.5e-6 degrees.
  const { ra, dec } = fieldTexts(12.3456789, -45.6789012);
  assert.ok(Math.abs(Number(ra) - 12.3456789) <= 5e-7);
  assert.ok(Math.abs(Number(dec) + 45.6789012) <= 5e-7);
});

test("isClick accepts a release within 5 px of the press and treats more as a drag", () => {
  const press = { x: 100, y: 200 };
  assert.equal(isClick(press, press), true);
  assert.equal(isClick(press, { x: 103, y: 204 }), true);
  assert.equal(isClick(press, { x: 105, y: 200 }), true);
  assert.equal(isClick(press, { x: 104, y: 204 }), false);
  assert.equal(isClick(press, { x: 100, y: 194 }), false);
  assert.equal(isClick(press, { x: 160, y: 230 }), false);
});

test("retryDelay rounds Retry-After up to whole seconds within 1..30, else 2", () => {
  const cases = [
    [null, 2], ["", 2], ["soon", 2], ["Wed, 21 Oct 2026 07:28:00 GMT", 2],
    ["0", 1], ["5", 5], ["2.5", 3], ["600", 30], ["-3", 1], ["2.1", 3],
  ];
  for (const [header, seconds] of cases) assert.equal(retryDelay(header), seconds, `${header}`);
});

test("validPlan accepts a search answer and an answer without frames", () => {
  assert.equal(validPlan(plan([UNCAPPED, CAPPED])), true);
  assert.equal(validPlan(plan([])), true);
});

test("validPlan rejects answers the page cannot use", () => {
  const withFrame = (change) => {
    const data = plan([UNCAPPED, UNCAPPED]);
    data.frames[1] = { ...data.frames[1], ...change };
    return data;
  };
  const noFrames = plan([UNCAPPED]);
  delete noFrames.frames;
  const broken = [
    null, Object.assign([], plan([UNCAPPED])), noFrames,
    withFrame({ uris: undefined }),
    withFrame({ uris: [] }),
    { ...plan([UNCAPPED]), ra_deg: "133.8" },
    { ...plan([UNCAPPED]), dec_deg: null },
    { ...plan([UNCAPPED]), detector: 2 },
    { ...plan([UNCAPPED]), n_exposures: -1 },
    { ...plan([UNCAPPED]), cap: 1.5 },
    { ...plan([UNCAPPED]), capped: "no" },
    withFrame({ label: 5 }),
    withFrame({ capped: undefined }),
    withFrame({ uris: [5] }),
  ];
  broken.forEach((data, i) => assert.equal(validPlan(data), false, `case ${i}`));
});

function frameAnswer(change = {}) {
  const pixels = Array.from({ length: 59 * 59 }, (_, i) => (i % 97 === 0 ? null : i / 100));
  return { width: 59, height: 59, n_used: 8, pixels, ...change };
}

test("validFrameBody accepts a 59x59 frame answer with no-data pixels", () => {
  assert.equal(validFrameBody(frameAnswer()), true);
});

test("validFrameBody rejects frame answers the page cannot draw", () => {
  const pixels = (index, value) => {
    const values = frameAnswer().pixels;
    values[index] = value;
    return values;
  };
  const noCount = frameAnswer();
  delete noCount.n_used;
  const broken = [
    frameAnswer({ pixels: new Array(10).fill(0) }),
    frameAnswer({ pixels: pixels(5, "1") }),
    frameAnswer({ pixels: pixels(5, Number.NaN) }),
    noCount,
    frameAnswer({ width: 0, pixels: [] }),
    frameAnswer({ height: 0, pixels: [] }),
  ];
  broken.forEach((data, i) => assert.equal(validFrameBody(data), false, `case ${i}`));
});

test("noDataNote names blue-grey pixels only when some frame has a null pixel", () => {
  assert.equal(noDataNote([]), "");
  assert.equal(noDataNote([{ pixels: [0, 1] }, { pixels: [2, 3] }]), "");
  assert.equal(noDataNote([{ pixels: [0, 1] }, { pixels: [2, null] }, { pixels: [4, 5] }]),
    "Blue-grey pixels have no usable data.");
});

const DETECTORS = ["D1", "D2", "D3", "D4", "D5", "D6"];

function frame(pixels, nUsed, width = 3, height = 3) {
  return { pixels, width, height, nUsed };
}

function differenceGreys(diff, stretch) {
  const rgba = toDifferenceRGBA(diff, stretch);
  return Array.from({ length: diff.length }, (_, i) => rgba[4 * i]);
}

test("three identical frames give mid-grey everywhere", () => {
  const pixels = Array.from({ length: 3481 }, (_, i) => ((i * 7 + 13) % 50) / 100);
  const frames = Array.from({ length: 3 }, () => frame(pixels, 2, 59, 59));
  const stretch = computeStretch(frames.map((f) => f.pixels));
  for (let k = 0; k < frames.length; k++) {
    const rgba = toDifferenceRGBA(difference(frames, k), stretch);
    for (let i = 0; i < pixels.length; i++) {
      assert.deepEqual(Array.from(rgba.slice(4 * i, 4 * i + 4)), [128, 128, 128, 255],
        `frame ${k} pixel ${i}`);
    }
  }
});

test("difference subtracts the nUsed-weighted mean of the other frames", () => {
  const frames = [1, 2, 4].map((v, k) => frame(new Array(9).fill(v), [1, 3, 0][k]));
  assert.deepEqual(difference(frames, 0), new Array(9).fill(-1));
  assert.deepEqual(difference(frames, 1), new Array(9).fill(1));
  assert.deepEqual(difference(frames, 2), new Array(9).fill(2.25));
});

test("difference is null where the frame or every other frame has no data", () => {
  const zeros = new Array(9).fill(0);
  const nines = new Array(9).fill(9);
  zeros[4] = null;
  nines[0] = null;
  const frames = [frame(zeros, 1), frame(nines, 1)];
  assert.deepEqual(difference(frames, 0), [null, -9, -9, -9, null, -9, -9, -9, -9]);
  assert.deepEqual(difference(frames, 1), [null, 9, 9, 9, null, 9, 9, 9, 9]);
});

test("difference averages over the 3x3 neighbours inside the image", () => {
  const frames = [frame([0, 0, 0, 0, 9, 0, 0, 0, 0], 1), frame(new Array(9).fill(0), 1)];
  assert.deepEqual(difference(frames, 0), [2.25, 1.5, 2.25, 1.5, 1, 1.5, 2.25, 1.5, 2.25]);
  assert.deepEqual(difference([frames[0]], 0), new Array(9).fill(null));
});

test("toDifferenceRGBA is mid-grey at zero, clamps at full scale, transparent for null", () => {
  const rgba = toDifferenceRGBA([null, 0, 1e9, -1e9, 5, -5], { lo: 0, hi: 10, soft: 1 });
  assert.ok(rgba instanceof Uint8ClampedArray);
  assert.equal(rgba.length, 24);
  assert.deepEqual(Array.from(rgba.slice(0, 4)), [0, 0, 0, 0]);
  [128, 255, 0, 226, 29].forEach((grey, k) => {
    assert.deepEqual(Array.from(rgba.slice(4 * (k + 1), 4 * (k + 2))), [grey, grey, grey, 255],
      `value ${k + 1}`);
  });
});

test("a source moved by 2 px is drawn black where it was and white where it is", () => {
  const W = 59;
  const withStar = (cx, cy) => {
    const pixels = Array.from({ length: W * W }, (_, i) => ((i * 7 + 13) % 50) / 100);
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) pixels[(cy + dy) * W + cx + dx] += 20;
    }
    return pixels;
  };
  const frames = [frame(withStar(20, 30), 10, W, W), frame(withStar(22, 30), 10, W, W)];
  const stretch = computeStretch(frames.map((f) => f.pixels));
  const row = differenceGreys(difference(frames, 1), stretch).slice(30 * W + 15, 30 * W + 27);
  assert.deepEqual(row, [128, 128, 128, 38, 15, 15, 128, 240, 240, 217, 128, 128]);
});

test("parseLink reads back what linkQuery writes, trimmed", () => {
  assert.deepEqual(parseLink(linkQuery(" 08h55m10.831s ", "-7d14m42.53s", "D5"), DETECTORS, "D2"),
    { ra: "08h55m10.831s", dec: "-7d14m42.53s", detector: "D5" });
  assert.equal(linkQuery(" 1 ", " 2 ", "D1"), "?ra=1&dec=2&detector=D1");
  const query = linkQuery("269.4462683", "+4.7682045", "D6");
  assert.equal(query, "?ra=269.4462683&dec=%2B4.7682045&detector=D6");
  assert.deepEqual(parseLink(query, DETECTORS, "D2"),
    { ra: "269.4462683", dec: "+4.7682045", detector: "D6" });
});

test("parseLink needs both ra and dec, non-empty after trimming", () => {
  for (const search of ["", "?ra=1", "?dec=1", "?ra=%20&dec=2", "?detector=D6"]) {
    assert.equal(parseLink(search, DETECTORS, "D2"), null, search);
  }
});

test("parseLink uses the fallback for a missing or unknown detector", () => {
  assert.deepEqual(parseLink("?ra=1&dec=2&detector=D9", DETECTORS, "D2"),
    { ra: "1", dec: "2", detector: "D2" });
  assert.deepEqual(parseLink("?ra=1&dec=2", DETECTORS, "D3"),
    { ra: "1", dec: "2", detector: "D3" });
});
