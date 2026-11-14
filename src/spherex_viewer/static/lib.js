// Pure helpers for the SPHEREx viewer page: common brightness stretch, pixel conversion,
// cap notice text and playback index. No DOM access; imported by app.js and by Node tests.

function median(sorted) {
  const n = sorted.length;
  const mid = Math.floor(n / 2);
  return n % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * One asinh stretch shared by all frames (DESIGN.md 5.12).
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
 * Status-line notice for a search plan whose exposure cap applied, else "".
 * @param {{capped: boolean, cap: number, frames: Array<{capped: boolean}>}} plan
 * @returns {string}
 */
export function capNotice(plan) {
  if (!plan.capped) return "";
  const k = plan.frames.filter((f) => f.capped).length;
  const n = plan.frames.length;
  return `Cap applied: ${k} of ${n} frames use ${plan.cap} of their exposures, evenly sampled in time.`;
}

/**
 * Next frame index during playback, wrapping to 0.
 * @param {number} current
 * @param {number} count number of loaded frames (> 0)
 * @returns {number}
 */
export function nextIndex(current, count) {
  return (current + 1) % count;
}
