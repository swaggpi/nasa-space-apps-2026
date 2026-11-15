// Pure helpers for the SPHEREx viewer page: common brightness stretch, pixel conversion,
// status, date and position texts, frame stepping, marker placement, validation of the
// bundled example and of API answers, the sky-map selection, the retry delay, the difference
// view, result links, zooming and moving the view over the loaded grid, and the order and
// geometry of loading the next area. No DOM access; imported by app.js and by Node tests.

function median(sorted) {
  const n = sorted.length;
  const mid = Math.floor(n / 2);
  return n % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * One asinh stretch shared by all frames: lo = median - 2 sigma (sigma = 1.4826 MAD),
 * hi = nearest-rank 99.9th percentile, soft = max(5 sigma, (hi - lo) / 1000).
 * @param {Array<Array<number|null>>} frames pixel arrays; null = no data
 * @returns {{lo: number, hi: number, soft: number}} in the pixels' unit (MJy/sr)
 */
export function computeStretch(frames) {
  const pool = [];
  for (const pixels of frames) {
    for (const v of pixels) {
      if (v !== null) pool.push(v);
    }
  }
  if (pool.length === 0) return { lo: 0, hi: 1, soft: 1 };
  pool.sort((a, b) => a - b);
  const med = median(pool);
  const deviations = pool.map((v) => Math.abs(v - med)).sort((a, b) => a - b);
  const sigma = 1.4826 * median(deviations);
  const lo = med - 2 * sigma;
  // Nearest-rank 99.9th percentile; integer arithmetic avoids rounding 0.999 * n.
  const rank = Math.max(1, Math.ceil((999 * pool.length) / 1000));
  let hi = pool[rank - 1];
  if (!(hi > lo)) hi = lo + 1;
  const soft = Math.max(5 * sigma, (hi - lo) / 1000);
  return { lo, hi, soft };
}

/**
 * Grey RGBA pixels for a canvas ImageData; null becomes fully transparent.
 * @param {Array<number|null>} pixels row-major values
 * @param {{lo: number, hi: number, soft: number}} stretch from computeStretch
 * @returns {Uint8ClampedArray} length 4 * pixels.length
 */
export function toRGBA(pixels, stretch) {
  const { lo, hi, soft } = stretch;
  const norm = Math.asinh((hi - lo) / soft);
  const out = new Uint8ClampedArray(pixels.length * 4);
  for (let i = 0; i < pixels.length; i++) {
    const v = pixels[i];
    if (v === null) continue;
    const t = Math.min(Math.max(Math.asinh((v - lo) / soft) / norm, 0), 1);
    const grey = Math.round(255 * t);
    out[4 * i] = grey;
    out[4 * i + 1] = grey;
    out[4 * i + 2] = grey;
    out[4 * i + 3] = 255;
  }
  return out;
}

/**
 * A count followed by its noun, singular for exactly 1: plural(1, "frame") -> "1 frame".
 * @param {number} count
 * @param {string} noun singular form; the plural adds "s"
 * @returns {string}
 */
export function plural(count, noun) {
  return `${count} ${count === 1 ? noun : noun + "s"}`;
}

/**
 * Status-line text from parts joined by single spaces; empty parts are left out.
 * @param {...string} parts
 * @returns {string}
 */
export function joinStatus(...parts) {
  return parts.filter((part) => part !== "").join(" ");
}

/**
 * Date-label text for a loaded frame: its date range and the exposures it was built from,
 * e.g. "2026-09-22 \u00b7 1 exposure", or a range such as "2026-09-22 \u00b7 23\u201324
 * exposures" when the fields in view differ.
 * The label alone when no field in view is loaded yet (min null).
 * @param {string} label the frame's date range
 * @param {number|null} min fewest exposures that contributed to a field in view
 * @param {number|null} [max] most exposures that contributed to a field in view
 * @returns {string}
 */
export function frameLabel(label, min, max = min) {
  if (min === null) return label;
  const count = min === max ? plural(min, "exposure") : `${min}\u2013${max} exposures`;
  return `${label} \u00b7 ${count}`;
}

/**
 * Status-line notice for a search plan whose exposure cap applied, else "".
 * @param {{capped: boolean, cap: number, frames: Array<{capped: boolean}>}} plan
 * @returns {string}
 */
export function capNotice(plan) {
  if (!plan.capped) return "";
  const k = plan.frames.filter((f) => f.capped).length;
  const noun = plan.frames.length === 1 ? "frame" : "frames";
  const uses = k === 1 ? "uses" : "use";
  const their = k === 1 ? "its" : "their";
  return `Cap applied: ${k} of ${plan.frames.length} ${noun} ${uses} ${plan.cap} of ${their} `
    + "exposures, evenly spaced in time order.";
}

/**
 * Next frame index during playback and for the next-frame button, wrapping to 0.
 * @param {number} current
 * @param {number} count number of loaded frames (> 0)
 * @returns {number}
 */
export function nextIndex(current, count) {
  return (current + 1) % count;
}


/**
 * Previous frame index for the previous-frame button, wrapping to the last frame.
 * @param {number} current
 * @param {number} count number of loaded frames (> 0)
 * @returns {number}
 */
export function previousIndex(current, count) {
  return (current - 1 + count) % count;
}

/**
 * Position text for the target panel, e.g. "RA 269.4463\u00b0, Dec +4.7682\u00b0 \u00b7 D6".
 * @param {number} raDeg ICRS right ascension in degrees
 * @param {number} decDeg ICRS declination in degrees
 * @param {string} detector
 * @returns {string}
 */
export function formatPosition(raDeg, decDeg, detector) {
  const dec = `${decDeg < 0 ? "\u2212" : "+"}${Math.abs(decDeg).toFixed(4)}`;
  return `RA ${raDeg.toFixed(4)}\u00b0, Dec ${dec}\u00b0 \u00b7 ${detector}`;
}

/**
 * Where a marker sits on the displayed image, as percentages of its width and height.
 * Marker coordinates are image pixels with pixel centres at integers (x right, y down).
 * @param {{x: number, y: number}} marker
 * @param {number} width image width in pixels
 * @param {number} height image height in pixels
 * @returns {{left: number, top: number}} percent from the left and top edges
 */
export function markerPercent(marker, width, height) {
  return { left: (100 * (marker.x + 0.5)) / width, top: (100 * (marker.y + 0.5)) / height };
}

const isString = (v) => typeof v === "string";
const isNumber = (v) => typeof v === "number" && Number.isFinite(v);
const isCount = (v) => Number.isInteger(v) && v >= 0;
const isObject = (v) => typeof v === "object" && v !== null && !Array.isArray(v);
const isPixels = (v, size) => Array.isArray(v) && v.length === size
  && v.every((p) => p === null || isNumber(p));

function validFrame(frame, size) {
  return isObject(frame) && isString(frame.label) && isCount(frame.n_used)
    && isPixels(frame.pixels, size)
    && (frame.marker === undefined
      || (isObject(frame.marker) && isNumber(frame.marker.x) && isNumber(frame.marker.y)));
}

/**
 * Checks the parsed content of example.json and converts it to the page's frame form.
 * Markers must be present in every frame or in none.
 * @param {unknown} data parsed JSON
 * @returns {{name: string, hint: string, position: string,
 *   frames: Array<{pixels: Array<number|null>, width: number, height: number, dates: string,
 *   nUsed: number, nFields: number[], marker?: {x: number, y: number}}>} | null} null if the
 *   content does not match the schema; `nFields` holds the one field's exposure count
 */
export function parseExample(data) {
  if (!isObject(data) || !isString(data.name) || !isString(data.hint) || !isNumber(data.ra_deg)
    || !isNumber(data.dec_deg) || !isString(data.detector)) return null;
  const { width, height, frames } = data;
  if (!(isCount(width) && width > 0 && isCount(height) && height > 0)) return null;
  if (!Array.isArray(frames) || frames.length === 0) return null;
  if (!frames.every((f) => validFrame(f, width * height))) return null;
  const withMarker = frames.filter((f) => f.marker !== undefined).length;
  if (withMarker !== 0 && withMarker !== frames.length) return null;
  return {
    name: data.name,
    hint: data.hint,
    position: formatPosition(data.ra_deg, data.dec_deg, data.detector),
    frames: frames.map((f) => ({
      pixels: f.pixels,
      width,
      height,
      dates: f.label,
      nUsed: f.n_used,
      nFields: [f.n_used],
      ...(f.marker === undefined ? {} : { marker: { x: f.marker.x, y: f.marker.y } }),
    })),
  };
}

/** Pixels per side of the common grid and its pixel scale (src/spherex_viewer/grid.py). */
export const FIELD_PIXELS = 59;
export const PIXEL_SCALE_ARCSEC = 6.15;

/** Largest pointer movement, in CSS pixels, between press and release that is still a click. */
export const CLICK_TOLERANCE_PX = 5;

/** Pixels per side of the wide grid: the 3x3 fields around the searched one. */
export const WIDE_PIXELS = 3 * FIELD_PIXELS;

/** Zoom levels, in screen sizes of one field: views of 18', 12', 6', 3' and 1.5'. */
export const ZOOM_LEVELS = [1 / 3, 1 / 2, 1, 2, 4];

/** Most planned exposures for which the surrounding fields load ahead of their first use. */
export const PRELOAD_MAX_EXPOSURES = 120;

const RAD = Math.PI / 180;

/**
 * Sky position at tangent-plane offsets from a centre on the north-up gnomonic (TAN) plane.
 * @param {number} raDeg
 * @param {number} decDeg
 * @param {number} xi offset towards east, radians
 * @param {number} eta offset towards north, radians
 * @returns {[number, number]} [ra, dec] in degrees, 0 <= ra < 360
 */
function fromTangent(raDeg, decDeg, xi, eta) {
  const dec0 = decDeg * RAD;
  const denom = Math.cos(dec0) - eta * Math.sin(dec0);
  const ra = raDeg + Math.atan2(xi, denom) / RAD;
  const dec = Math.atan2(Math.sin(dec0) + eta * Math.cos(dec0), Math.hypot(xi, denom)) / RAD;
  return [((ra % 360) + 360) % 360, dec];
}

/**
 * Sky corners of the tool's field centred on a position: the outer edges of the 59x59 grid of
 * 6.15" pixels on the north-up gnomonic (TAN) plane, as the server resamples onto.
 * @param {number} raDeg ICRS right ascension of the centre in degrees
 * @param {number} decDeg ICRS declination of the centre in degrees
 * @returns {Array<[number, number]>} [ra, dec] in degrees, 0 <= ra < 360, in the order
 *   north-east, north-west, south-west, south-east
 */
export function fieldCorners(raDeg, decDeg) {
  const half = ((FIELD_PIXELS / 2) * PIXEL_SCALE_ARCSEC / 3600) * RAD;
  return [[half, half], [-half, half], [-half, -half], [half, -half]]
    .map(([xi, eta]) => fromTangent(raDeg, decDeg, xi, eta));
}

/**
 * Sky position a number of grid pixels away from a centre, on the grid's tangent plane.
 * @param {number} raDeg ICRS right ascension of the centre in degrees
 * @param {number} decDeg ICRS declination of the centre in degrees
 * @param {number} dxPixels pixels to the right (west)
 * @param {number} dyPixels pixels down (south)
 * @returns {{ra: number, dec: number}} degrees, 0 <= ra < 360
 */
export function offsetPosition(raDeg, decDeg, dxPixels, dyPixels) {
  const scale = (PIXEL_SCALE_ARCSEC / 3600) * RAD;
  const [ra, dec] = fromTangent(raDeg, decDeg, -dxPixels * scale, -dyPixels * scale);
  return { ra, dec };
}

/**
 * The view moved and zoomed into the loaded grid: zoom within [59 / grid, 4], centre such
 * that the view never leaves the grid.
 * @param {{zoom: number, cx: number, cy: number}} view zoom in screens per field; centre in
 *   grid pixels (pixel centres at integers, x right = west, y down = south)
 * @param {number} grid pixels per side of the loaded grid (59 or 177)
 * @returns {{zoom: number, cx: number, cy: number}}
 */
export function clampView(view, grid) {
  const zoom = Math.min(Math.max(view.zoom, FIELD_PIXELS / grid), ZOOM_LEVELS.at(-1));
  const half = FIELD_PIXELS / zoom / 2;
  const clamp = (c) => Math.min(Math.max(c, half - 0.5), grid - 0.5 - half);
  return { zoom, cx: clamp(view.cx), cy: clamp(view.cy) };
}

/**
 * The neighbouring zoom level in a direction, among those the loaded grid can fill.
 * @param {number} zoom current level
 * @param {number} direction +1 in, -1 out
 * @param {number} grid pixels per side of the loaded grid
 * @returns {number} the new level; the same at either end
 */
export function zoomStep(zoom, direction, grid) {
  const levels = ZOOM_LEVELS.filter((z) => z >= FIELD_PIXELS / grid - 1e-9);
  const i = levels.findIndex((z) => Math.abs(z - zoom) < 1e-9);
  return levels[Math.min(Math.max(i + direction, 0), levels.length - 1)];
}

/**
 * One movement step of the view: an eighth of the view's span, at least one pixel, clamped
 * to the grid.
 * @param {{zoom: number, cx: number, cy: number}} view
 * @param {number} dx -1, 0 or 1 (right = west)
 * @param {number} dy -1, 0 or 1 (down = south)
 * @param {number} grid pixels per side of the loaded grid
 * @returns {{view: {zoom: number, cx: number, cy: number}, pushed: boolean}} pushed: the
 *   view is at the grid's edge and did not move at all
 */
export function panStep(view, dx, dy, grid) {
  const step = Math.max(1, Math.round(FIELD_PIXELS / view.zoom / 8));
  const next = clampView({ zoom: view.zoom, cx: view.cx + dx * step, cy: view.cy + dy * step },
    grid);
  return { view: next, pushed: next.cx === view.cx && next.cy === view.cy };
}

/**
 * Room, in grid pixels, between the view's leading edge and the loaded area's edge within
 * which an arrow press that moved the view loads the area further on ahead of time.
 */
export const AHEAD_PIXELS = 1.5 * FIELD_PIXELS;

/**
 * Where to load ahead after an arrow press moved the view by (mx, my) on the wide grid: the
 * new area's centre in whole fields from the loaded one, or null for no preload. Along the
 * press, the area moves two fields when the view spans at most one field (one when it spans
 * at most two; none when wider): the most that still holds the view once it reaches the
 * loaded edge, so it joins on there. Across the press, it moves to the field row (or column)
 * that holds the view's centre (half a field off centre counts as the next one), unless the
 * area would then not hold the view. With a view of at most one field, the field the view
 * enters past the loaded edge is thus the new area's centre.
 * @param {{zoom: number, cx: number, cy: number}} view
 * @param {number} grid pixels per side of the loaded grid
 * @param {number} mx -1, 0 or 1: the press's movement (right = west)
 * @param {number} my -1, 0 or 1 (down = south)
 * @returns {{dx: number, dy: number} | null} fields right (west) and down (south)
 */
export function aheadShift(view, grid, mx, my) {
  if (grid !== WIDE_PIXELS || (mx === 0 && my === 0)) return null;
  const span = FIELD_PIXELS / view.zoom;
  const along = Math.floor((grid - span + 1e-9) / FIELD_PIXELS);
  if (along < 1) return null;
  const lo = span / 2 - 0.5;
  const hi = grid - 0.5 - span / 2;
  const centre = (grid - 1) / 2;
  const axis = (c, m) => {
    if (m !== 0) return (m > 0 ? hi - c : c - lo) <= AHEAD_PIXELS ? m * Math.min(along, 2) : null;
    const offset = c - centre;
    const fields = Math.floor(Math.abs(offset) / FIELD_PIXELS + 0.5 + 1e-9);
    const nearest = offset < 0 && fields > 0 ? -fields : fields;
    const held = c - FIELD_PIXELS * nearest;
    return held >= lo - 1e-9 && held <= hi + 1e-9 ? nearest : 0;
  };
  const dx = axis(view.cx, mx);
  const dy = axis(view.cy, my);
  if (dx === null || dy === null) return null;
  return { dx, dy };
}

/**
 * Where to load after an arrow key rested while pushing at the edge of the loaded area: the
 * area a preload would load at that view (its centre is the field the view enters when the
 * view spans at most one field), else, zoomed out to the whole area, one field on in the
 * direction of the push.
 * @param {{zoom: number, cx: number, cy: number}} view
 * @param {number} grid pixels per side of the loaded grid (177)
 * @param {number} dx -1, 0 or 1: the push (right = west)
 * @param {number} dy -1, 0 or 1 (down = south)
 * @returns {{dx: number, dy: number}} fields right (west) and down (south)
 */
export function pushShift(view, grid, dx, dy) {
  return aheadShift(view, grid, dx, dy) ?? { dx, dy };
}

/**
 * Whether the centre of the area `shift` fields away lies outside the loaded 3 x 3 fields,
 * so that its own 6' frames add sky that is not loaded yet.
 * @param {{dx: number, dy: number}} shift
 * @returns {boolean}
 */
export function centreOutside(shift) {
  return Math.max(Math.abs(shift.dx), Math.abs(shift.dy)) >= 2;
}

/**
 * Whether two areas hold the same visits: as many frames, with identical date labels in order.
 * @param {Array<string>} a date labels of one area's frames
 * @param {Array<string>} b date labels of the other's
 * @returns {boolean}
 */
export function sameVisits(a, b) {
  return a.length === b.length && a.every((label, i) => label === b[i]);
}

/**
 * Order in which to request the frames of a load: the frame on screen first, then the others
 * in time order.
 * @param {number} count number of frames
 * @param {number} first index of the frame on screen; -1 (or out of range) for none
 * @returns {Array<number>} frame indices
 */
export function requestOrder(count, first) {
  const all = Array.from({ length: count }, (_, i) => i);
  return first >= 0 && first < count ? [first, ...all.filter((i) => i !== first)] : all;
}

/** Largest misalignment, in pixels, allowed at the seam between two areas' fields. */
export const MAX_SEAM_PX = 0.25;

/**
 * Tangent-plane offsets of a sky position from a centre on the north-up gnomonic (TAN) plane;
 * the inverse of fromTangent.
 * @returns {[number, number]} [xi towards east, eta towards north] in radians
 */
function toTangent(raDeg, decDeg, ra, dec) {
  const d0 = decDeg * RAD;
  const d = dec * RAD;
  const da = (ra - raDeg) * RAD;
  const denom = Math.sin(d) * Math.sin(d0) + Math.cos(d) * Math.cos(d0) * Math.cos(da);
  return [
    (Math.cos(d) * Math.sin(da)) / denom,
    (Math.sin(d) * Math.cos(d0) - Math.cos(d) * Math.sin(d0) * Math.cos(da)) / denom,
  ];
}

/**
 * Misalignment at the seam between the loaded area's grid and the grid of the area `shift`
 * fields away: the largest distance, in pixels, over the corners of the new area's central
 * field, between where the new grid puts a point and where the loaded grid, moved by the
 * whole fields of the shift, puts it. Exact TAN arithmetic on both tangent planes; the error
 * grows linearly from the new centre, so the corners bound it along the seam.
 * @param {{ra: number, dec: number}} from centre of the loaded area, ICRS degrees
 * @param {{ra: number, dec: number}} to centre of the new area (as its search answered)
 * @param {{dx: number, dy: number}} shift fields right (west) and down (south)
 * @returns {number} pixels
 */
export function seamOffset(from, to, shift) {
  const scale = (PIXEL_SCALE_ARCSEC / 3600) * RAD;
  const half = FIELD_PIXELS / 2;
  let worst = 0;
  for (const [u, v] of [[-half, -half], [half, -half], [-half, half], [half, half]]) {
    const sky = offsetPosition(from.ra, from.dec,
      FIELD_PIXELS * shift.dx + u, FIELD_PIXELS * shift.dy + v);
    const [xi, eta] = toTangent(to.ra, to.dec, sky.ra, sky.dec);
    worst = Math.max(worst, Math.hypot(-xi / scale - u, -eta / scale - v));
  }
  return worst;
}

/**
 * The view over an area `shift` fields away, when that area holds all of it, else null.
 * @param {{zoom: number, cx: number, cy: number}} view
 * @param {number} grid pixels per side of the loaded grid (that of the new area as well)
 * @param {{dx: number, dy: number}} shift fields right (west) and down (south)
 * @returns {{zoom: number, cx: number, cy: number} | null}
 */
export function shiftedView(view, grid, shift) {
  const moved = {
    zoom: view.zoom,
    cx: view.cx - FIELD_PIXELS * shift.dx,
    cy: view.cy - FIELD_PIXELS * shift.dy,
  };
  const held = clampView(moved, grid);
  return held.cx === moved.cx && held.cy === moved.cy && held.zoom === moved.zoom ? moved : null;
}

/**
 * Size and place of the image stage in percent of the frame that shows the view.
 * @param {{zoom: number, cx: number, cy: number}} view
 * @param {number} grid pixels per side of the loaded grid
 * @returns {{size: number, left: number, top: number}} percent of the frame's edge
 */
export function stageBox(view, grid) {
  const span = FIELD_PIXELS / view.zoom;
  return {
    size: (100 * grid) / span,
    left: (-100 * (view.cx + 0.5 - span / 2)) / span,
    top: (-100 * (view.cy + 0.5 - span / 2)) / span,
  };
}

/**
 * The fields a view overlaps.
 * @param {{zoom: number, cx: number, cy: number}} view
 * @param {number} grid pixels per side of the loaded grid
 * @returns {Array<number>} field indices, row-major, north row first (0..8 on a 177 grid; 0 on
 *   a 59 grid)
 */
export function fieldsInView(view, grid) {
  if (grid === FIELD_PIXELS) return [0];
  const span = FIELD_PIXELS / view.zoom;
  const eps = 1e-6;
  const lo = (c) => Math.max(0, Math.floor((c + 0.5 - span / 2 + eps) / FIELD_PIXELS));
  const hi = (c) => Math.min(2, Math.floor((c + 0.5 + span / 2 - eps) / FIELD_PIXELS));
  const fields = [];
  for (let row = lo(view.cy); row <= hi(view.cy); row++) {
    for (let col = lo(view.cx); col <= hi(view.cx); col++) fields.push(3 * row + col);
  }
  return fields;
}

/**
 * Range of exposure counts over the loaded fields a view overlaps.
 * @param {Array<number|null>} nFields counts per field, row-major, north row first (one on a
 *   59 grid, nine on a 177 grid); null for a field not loaded yet
 * @param {{zoom: number, cx: number, cy: number}} view
 * @param {number} grid pixels per side of the loaded grid
 * @returns {[number|null, number|null]} [min, max]; [null, null] when no field in view is
 *   loaded
 */
export function countRange(nFields, view, grid) {
  const counts = fieldsInView(view, grid).map((f) => nFields[f]).filter((n) => n !== null);
  return counts.length === 0 ? [null, null] : [Math.min(...counts), Math.max(...counts)];
}

/**
 * The frame playback shows after `current`: the next one, wrapping, that has loaded every
 * field in view that the frame on screen has loaded, so playback never turns sky into "not
 * loaded"; frames still missing such a field are skipped (the frame on screen if all are).
 * @param {Array<Array<number|null>>} counts each frame's per-field counts (null: not loaded)
 * @param {number} current index of the frame on screen
 * @param {Array<number>} fields the fields in view, from fieldsInView
 * @returns {number}
 */
export function playbackNext(counts, current, fields) {
  const shown = counts[current];
  for (let k = 1; k < counts.length; k++) {
    const i = (current + k) % counts.length;
    if (fields.every((f) => shown[f] === null || counts[i][f] !== null)) return i;
  }
  return current;
}

/**
 * CSS background layers that draw the not-loaded fields of a wide frame plain, each followed
 * by a comma, to go in front of the no-data checkerboard; "" when every field is loaded.
 * @param {Array<number|null>} nFields per-field counts, row-major, north row first
 * @returns {string}
 */
export function notLoadedLayers(nFields) {
  if (nFields.length !== 9) return "";
  return nFields.map((n, i) => (n !== null ? ""
    : `linear-gradient(var(--panel) 0 0) ${50 * (i % 3)}% ${50 * Math.floor(i / 3)}% `
      + "/ calc(100% / 3) calc(100% / 3) no-repeat, ")).join("");
}

/**
 * A 59x59 frame placed at the centre of the wide grid before its surround has loaded: the
 * eight fields around it hold no pixels (null) and no counts (null), its marker moves with it.
 * @param {{pixels: Array<number|null>, width: number, height: number, nUsed: number,
 *   marker?: {x: number, y: number}}} frame
 * @returns {object} the same frame with width and height WIDE_PIXELS
 */
export function widenFrame(frame) {
  const empty = { ...frame, pixels: new Array(WIDE_PIXELS * WIDE_PIXELS).fill(null),
    width: WIDE_PIXELS, height: WIDE_PIXELS, nFields: new Array(9).fill(null) };
  const widened = withCentre(empty, frame.pixels, frame.nUsed);
  if (frame.marker !== undefined) {
    widened.marker = { x: frame.marker.x + FIELD_PIXELS, y: frame.marker.y + FIELD_PIXELS };
  }
  return widened;
}

/**
 * A wide frame with a 59x59 field put at its centre, with that field's exposure count.
 * @param {{pixels: Array<number|null>, nFields: Array<number|null>}} frame on the 177 grid
 * @param {Array<number|null>} pixels the central field, row-major
 * @param {number} nUsed exposures of the central field
 * @returns {object} a new frame; `frame` is unchanged
 */
export function withCentre(frame, pixels, nUsed) {
  const out = [...frame.pixels];
  for (let y = 0; y < FIELD_PIXELS; y++) {
    for (let x = 0; x < FIELD_PIXELS; x++) {
      out[(y + FIELD_PIXELS) * WIDE_PIXELS + x + FIELD_PIXELS] = pixels[y * FIELD_PIXELS + x];
    }
  }
  const nFields = [...frame.nFields];
  nFields[4] = nUsed;
  return { ...frame, pixels: out, nFields, nUsed };
}

/**
 * A wide frame of the area `shift` fields away, before any of its own pixels: the fields it
 * shares with `frame` (the loaded area's frame of the same visit) copied pixel for pixel,
 * the others not loaded. Marked `copied`: its pixels lie on the loaded area's grid.
 * @param {{pixels: Array<number|null>, nFields: Array<number|null>}} frame on the 177 grid
 * @param {{dx: number, dy: number}} shift fields right (west) and down (south)
 * @returns {object} a new frame without a marker
 */
export function shiftFrame(frame, shift) {
  const pixels = new Array(WIDE_PIXELS * WIDE_PIXELS).fill(null);
  const ox = FIELD_PIXELS * shift.dx;
  const oy = FIELD_PIXELS * shift.dy;
  for (let y = Math.max(0, -oy); y < Math.min(WIDE_PIXELS, WIDE_PIXELS - oy); y++) {
    for (let x = Math.max(0, -ox); x < Math.min(WIDE_PIXELS, WIDE_PIXELS - ox); x++) {
      pixels[y * WIDE_PIXELS + x] = frame.pixels[(y + oy) * WIDE_PIXELS + x + ox];
    }
  }
  const nFields = Array.from({ length: 9 }, (_, i) => {
    const row = Math.floor(i / 3) + shift.dy;
    const col = (i % 3) + shift.dx;
    return row >= 0 && row < 3 && col >= 0 && col < 3 ? frame.nFields[3 * row + col] : null;
  });
  const { marker, ...rest } = frame;
  return { ...rest, pixels, nFields, copied: true };
}

/**
 * Pixel values from base64 little-endian float32; non-finite values become null.
 * @param {string} text
 * @param {number} count expected number of values
 * @returns {Array<number|null> | null} null if the text is not base64 of 4 * count bytes
 */
export function decodePixels(text, count) {
  let binary;
  try {
    binary = atob(text);
  } catch {
    return null;
  }
  if (binary.length !== 4 * count) return null;
  const data = new DataView(Uint8Array.from(binary, (c) => c.charCodeAt(0)).buffer);
  return Array.from({ length: count }, (_, i) => {
    const v = data.getFloat32(4 * i, true);
    return Number.isFinite(v) ? v : null;
  });
}

/**
 * The 59x59 field at the centre of a frame: its own pixels on a 59 grid, else the central
 * 59x59 of its grid.
 * @param {{pixels: Array<number|null>, width: number}} frame square frame
 * @returns {Array<number|null>}
 */
export function centrePixels(frame) {
  if (frame.width === FIELD_PIXELS) return frame.pixels;
  const offset = (frame.width - FIELD_PIXELS) / 2;
  const out = [];
  for (let y = offset; y < offset + FIELD_PIXELS; y++) {
    const start = y * frame.width + offset;
    out.push(...frame.pixels.slice(start, start + FIELD_PIXELS));
  }
  return out;
}

/**
 * Whether the surrounding fields of a search load ahead of their first use.
 * @param {{frames: Array<{uris: Array<string>}>}} plan
 * @returns {boolean} true unless the plan has more than PRELOAD_MAX_EXPOSURES exposures
 */
export function shouldPreload(plan) {
  return plan.frames.reduce((sum, f) => sum + f.uris.length, 0) <= PRELOAD_MAX_EXPOSURES;
}

/**
 * RA and Dec texts for the search fields, decimal degrees with six decimals (0.0036"), which
 * the server reads as degrees.
 * @param {number} raDeg ICRS right ascension in degrees, any value (wrapped into [0, 360))
 * @param {number} decDeg ICRS declination in degrees (clamped to [-90, 90])
 * @returns {{ra: string, dec: string}}
 */
export function fieldTexts(raDeg, decDeg) {
  let ra = (((raDeg % 360) + 360) % 360).toFixed(6);
  if (ra === "360.000000") ra = "0.000000";
  const dec = Math.min(Math.max(decDeg, -90), 90).toFixed(6);
  return { ra, dec: dec === "-0.000000" ? "0.000000" : dec };
}

/**
 * Whether a press and release of the pointer on the map is a click (select) rather than a
 * drag (pan).
 * @param {{x: number, y: number}} press pointer position at press, CSS pixels
 * @param {{x: number, y: number}} release pointer position at release, CSS pixels
 * @returns {boolean}
 */
export function isClick(press, release) {
  return Math.hypot(release.x - press.x, release.y - press.y) <= CLICK_TOLERANCE_PX;
}

/**
 * Seconds to wait before retrying a 429 or 503 answer, from its Retry-After header.
 * A missing or non-numeric value (such as an HTTP date) gives 2; otherwise the value is
 * rounded up and clamped to 1..30.
 * @param {string | null} header
 * @returns {number} whole seconds
 */
export function retryDelay(header) {
  const seconds = header === null || header === "" ? Number.NaN : Number(header);
  if (!Number.isFinite(seconds)) return 2;
  return Math.min(Math.max(Math.ceil(seconds), 1), 30);
}

function validPlanFrame(frame) {
  return isObject(frame) && isString(frame.label) && typeof frame.capped === "boolean"
    && Array.isArray(frame.uris) && frame.uris.length > 0 && frame.uris.every(isString);
}

/**
 * Checks a parsed api/search answer has the fields the page reads.
 * @param {unknown} body parsed JSON
 * @returns {boolean}
 */
export function validPlan(body) {
  return isObject(body) && isNumber(body.ra_deg) && isNumber(body.dec_deg)
    && isString(body.detector) && isCount(body.n_exposures) && isCount(body.cap)
    && typeof body.capped === "boolean" && Array.isArray(body.frames)
    && body.frames.every(validPlanFrame);
}

/**
 * Checks a parsed api/frame answer: positive integer width and height, a non-negative
 * exposure count `n_used`, and exactly width * height pixels, each null or a finite number.
 * @param {unknown} body parsed JSON
 * @returns {boolean}
 */
export function validFrameBody(body) {
  return isObject(body) && isCount(body.width) && body.width > 0
    && isCount(body.height) && body.height > 0 && isCount(body.n_used)
    && isPixels(body.pixels, body.width * body.height);
}

/**
 * Checks a parsed api/frame answer for the wide grid: width and height 177, an exposure
 * count `n_used`, nine per-field counts `n_fields` and the pixels as a string `pixels_b64`.
 * @param {unknown} body parsed JSON
 * @returns {boolean}
 */
export function validWideBody(body) {
  return isObject(body) && body.width === WIDE_PIXELS && body.height === WIDE_PIXELS
    && isCount(body.n_used) && Array.isArray(body.n_fields) && body.n_fields.length === 9
    && body.n_fields.every(isCount) && isString(body.pixels_b64);
}

/**
 * Status-line sentence for loaded frames that contain no-data pixels, else "".
 * @param {Array<{pixels: Array<number|null>}>} frames
 * @returns {string}
 */
export function noDataNote(frames) {
  return frames.some((f) => f.pixels.includes(null)) ? "Blue-grey pixels have no usable data." : "";
}

/**
 * One frame minus the nUsed-weighted mean of the same pixel in the other frames, then
 * averaged over the available pixels of its 3x3 neighbourhood.
 * @param {Array<{pixels: Array<number|null>, width: number, height: number, nUsed: number}>}
 *   frames equal-sized frames; null = no data
 * @param {number} index the frame to compare with the others
 * @returns {Array<number|null>} width * height values (MJy/sr); null where there is no
 *   difference
 */
export function difference(frames, index) {
  const { pixels, width, height } = frames[index];
  const raw = new Array(pixels.length).fill(null);
  for (let p = 0; p < pixels.length; p++) {
    if (pixels[p] === null) continue;
    let sum = 0;
    let weight = 0;
    for (let j = 0; j < frames.length; j++) {
      const v = frames[j].pixels[p];
      if (j === index || v === null) continue;
      sum += frames[j].nUsed * v;
      weight += frames[j].nUsed;
    }
    if (weight > 0) raw[p] = pixels[p] - sum / weight;
  }
  const out = new Array(pixels.length).fill(null);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (raw[y * width + x] === null) continue;
      let sum = 0;
      let count = 0;
      for (let yy = Math.max(0, y - 1); yy <= Math.min(height - 1, y + 1); yy++) {
        for (let xx = Math.max(0, x - 1); xx <= Math.min(width - 1, x + 1); xx++) {
          const v = raw[yy * width + xx];
          if (v === null) continue;
          sum += v;
          count += 1;
        }
      }
      out[y * width + x] = sum / count;
    }
  }
  return out;
}

/**
 * Grey RGBA pixels for a difference: mid-grey for none, white brighter, black fainter, on
 * the asinh scale of the direct image; null becomes fully transparent.
 * @param {Array<number|null>} diff from difference
 * @param {{lo: number, hi: number, soft: number}} stretch from computeStretch
 * @returns {Uint8ClampedArray} length 4 * diff.length
 */
export function toDifferenceRGBA(diff, stretch) {
  const { lo, hi, soft } = stretch;
  const norm = Math.asinh((hi - lo) / soft);
  const out = new Uint8ClampedArray(diff.length * 4);
  for (let i = 0; i < diff.length; i++) {
    const d = diff[i];
    if (d === null) continue;
    const t = Math.min(Math.max((Math.sign(d) * Math.asinh(Math.abs(d) / soft)) / norm, -1), 1);
    const grey = Math.round(127.5 + 127.5 * t);
    out[4 * i] = grey;
    out[4 * i + 1] = grey;
    out[4 * i + 2] = grey;
    out[4 * i + 3] = 255;
  }
  return out;
}

/**
 * Reads a result link from the page's query string.
 * @param {string} search location.search, e.g. "?ra=1&dec=2&detector=D6"
 * @param {Array<string>} detectors valid detector values
 * @param {string} fallback detector used when the parameter is missing or not valid
 * @returns {{ra: string, dec: string, detector: string} | null} ra and dec trimmed; null
 *   unless both are present and non-empty
 */
export function parseLink(search, detectors, fallback) {
  const params = new URLSearchParams(search);
  const ra = (params.get("ra") ?? "").trim();
  const dec = (params.get("dec") ?? "").trim();
  if (ra === "" || dec === "") return null;
  const detector = params.get("detector");
  return { ra, dec, detector: detectors.includes(detector) ? detector : fallback };
}

/**
 * Query string for a result link, e.g. "?ra=08h55m10.831s&dec=-7d14m42.53s&detector=D6".
 * @param {string} ra
 * @param {string} dec
 * @param {string} detector
 * @returns {string}
 */
export function linkQuery(ra, dec, detector) {
  return "?" + new URLSearchParams({ ra: ra.trim(), dec: dec.trim(), detector });
}
