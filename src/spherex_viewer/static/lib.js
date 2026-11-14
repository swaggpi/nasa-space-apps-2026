// Pure helpers for the SPHEREx viewer page: common brightness stretch, pixel conversion,
// status, date and position texts, frame stepping, marker placement and validation of the
// bundled example. No DOM access; imported by app.js and by Node tests.

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

function validFrame(frame, size) {
  return isObject(frame) && isString(frame.label) && isCount(frame.n_used)
    && Array.isArray(frame.pixels) && frame.pixels.length === size
    && frame.pixels.every((v) => v === null || isNumber(v))
    && (frame.marker === undefined
      || (isObject(frame.marker) && isNumber(frame.marker.x) && isNumber(frame.marker.y)));
}

/**
 * Checks the parsed content of example.json and converts it to the page's frame form.
 * Markers must be present in every frame or in none.
 * @param {unknown} data parsed JSON
 * @returns {{name: string, hint: string, position: string,
 *   frames: Array<{pixels: Array<number|null>, width: number, height: number, label: string,
 *   marker?: {x: number, y: number}}>} | null} null if the content does not match the schema
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
      ...(f.marker === undefined ? {} : { marker: { x: f.marker.x, y: f.marker.y } }),
    })),
  };
}
