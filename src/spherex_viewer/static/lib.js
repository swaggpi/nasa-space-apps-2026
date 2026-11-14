// Pure helpers for the SPHEREx viewer page: common brightness stretch, pixel conversion,
// status, date and position texts, frame stepping, marker placement, validation of the
// bundled example and of API answers, the sky-map selection, the retry delay, the difference
// view and result links. No DOM access; imported by app.js and by Node tests.

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
 * e.g. "2026-09-22 \u00b7 1 exposure".
 * @param {string} label the frame's date range
 * @param {number} nUsed exposures that contributed, from the frame response
 * @returns {string}
 */
export function frameLabel(label, nUsed) {
  return `${label} \u00b7 ${plural(nUsed, "exposure")}`;
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
 *   frames: Array<{pixels: Array<number|null>, width: number, height: number, label: string,
 *   nUsed: number, marker?: {x: number, y: number}}>} | null} null if the content does not
 *   match the schema
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
      label: frameLabel(f.label, f.n_used),
      nUsed: f.n_used,
      ...(f.marker === undefined ? {} : { marker: { x: f.marker.x, y: f.marker.y } }),
    })),
  };
}

/** Pixels per side of the common grid and its pixel scale (src/spherex_viewer/grid.py). */
export const FIELD_PIXELS = 59;
export const PIXEL_SCALE_ARCSEC = 6.15;

/** Largest pointer movement, in CSS pixels, between press and release that is still a click. */
export const CLICK_TOLERANCE_PX = 5;

const RAD = Math.PI / 180;

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
  const dec0 = decDeg * RAD;
  // (xi, eta): tangent-plane offsets, xi towards east, eta towards north.
  return [[half, half], [-half, half], [-half, -half], [half, -half]].map(([xi, eta]) => {
    const denom = Math.cos(dec0) - eta * Math.sin(dec0);
    const ra = raDeg + Math.atan2(xi, denom) / RAD;
    const dec = Math.atan2(Math.sin(dec0) + eta * Math.cos(dec0), Math.hypot(xi, denom)) / RAD;
    return [((ra % 360) + 360) % 360, dec];
  });
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
