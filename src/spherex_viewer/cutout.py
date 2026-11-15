"""Flag semantics, background subtraction, alignment onto the target grid, robust combination.

Flag bits follow the SPHEREx Explanatory Supplement, Table 16.
"""

import re
import warnings
from collections.abc import Sequence
from dataclasses import dataclass

import numpy as np
from astropy.io import fits
from astropy.stats import sigma_clipped_stats
from astropy.wcs import WCS
from reproject import reproject_interp

FLAG_BITS: dict[str, int] = {
    "TRANSIENT": 0, "OVERFLOW": 1, "SUR_ERROR": 2, "NONFUNC": 6, "DICHROIC": 7,
    "MISSING_DATA": 9, "HOT": 10, "COLD": 11, "FULLSAMPLE": 12, "PHANMISS": 14,
    "NONLINEAR": 15, "PERSIST": 17, "OUTLIER": 19, "CROSSTALK": 20, "SOURCE": 21,
    "GHOST": 22, "GHOST_FPA": 23, "GHOST_EXT": 24, "STREAK": 25, "BLOOM": 26,
    "SNOWBALL": 27, "HALO": 28, "SATELLITE_HALO": 29,
}

# The set the SPHEREx Mosaic Tool sets to NaN before co-adding (Supplement 3.4.3):
# bits 0, 2, 6, 7, 9, 10, 11, 14, 15, 17, 20, 22-29.
BAD_FLAGS = 0x3FD2CEC5
# BAD_FLAGS + OVERFLOW + OUTLIER + SOURCE (Supplement 3.3, background estimation masking).
BACKGROUND_EXCLUDE_FLAGS = 0x3FFACEC7
CUTOUT_VERSION = 1

_MIN_BACKGROUND_PIXELS = 50
_MSKN = re.compile(r"MSKN(\d{4})")
_KNOWN_NAMES = {bit: name for name, bit in FLAG_BITS.items()}


class UnsupportedLayoutError(RuntimeError):
    """The file's layout or flag definitions are not the ones this code supports."""


@dataclass
class Window:
    """Native-pixel window of one exposure.

    ``image`` is float32 surface brightness in MJy/sr (NaN kept), ``flags`` the int32 flag
    bits, both (ny, nx). ``wcs`` is the full-detector celestial WCS including SIP, and
    ``(x0, y0)`` is the 0-based detector pixel of ``image[0, 0]``. ``core``, when set, is the
    detector box ``(x0, x1, y0, y1)`` (half-open, inside the window) whose pixels alone give
    the sky level.
    """

    image: np.ndarray
    flags: np.ndarray
    wcs: WCS
    x0: int
    y0: int
    core: tuple[int, int, int, int] | None = None


def check_flag_definitions(header: fits.Header) -> None:
    """Raise UnsupportedLayoutError if a ``MSKNnnnn`` card renames or renumbers a known flag.

    A card is checked when its bit or its name is in ``FLAG_BITS``. Other bits are accepted;
    they are in neither mask, so they are left unmasked.
    """
    for key in header:
        match = _MSKN.fullmatch(key)
        if match is None:
            continue
        bit = int(match.group(1))
        name = str(header[key]).strip()
        if (bit in _KNOWN_NAMES or name in FLAG_BITS) and FLAG_BITS.get(name) != bit:
            raise UnsupportedLayoutError(f"FLAGS mask plane {bit} differs from the known flags")


def estimate_background(image: np.ndarray, flags: np.ndarray) -> float:
    """Sigma-clipped median (3 sigma, 5 iterations) of the window's sky pixels, in MJy/sr.

    Uses finite pixels with no ``BACKGROUND_EXCLUDE_FLAGS`` bit; if fewer than 50 exist,
    finite pixels with no ``BAD_FLAGS`` bit. Returns NaN when no pixel is usable.
    """
    finite = np.isfinite(image)
    usable = finite & ((flags & BACKGROUND_EXCLUDE_FLAGS) == 0)
    if np.count_nonzero(usable) < _MIN_BACKGROUND_PIXELS:
        usable = finite & ((flags & BAD_FLAGS) == 0)
    if not np.any(usable):
        return float("nan")
    return float(sigma_clipped_stats(image[usable], sigma=3.0, maxiters=5)[1])


def align(window: Window, target: WCS, target_shape: tuple[int, int]) -> np.ndarray:
    """Background-subtracted, bad-pixel-masked window resampled onto the target grid.

    Bilinear interpolation through the full pixel-to-sky transform including SIP. Returns
    float32 ``target_shape`` in MJy/sr; NaN where there is no valid data (reproject fills
    target pixels outside the window, or next to a NaN input pixel, with NaN). The sky level
    is estimated on ``window.core`` when set, else on the whole window.
    """
    if window.core is None:
        background = estimate_background(window.image, window.flags)
    else:
        x0, x1, y0, y1 = window.core
        rows = slice(y0 - window.y0, y1 - window.y0)
        cols = slice(x0 - window.x0, x1 - window.x0)
        background = estimate_background(window.image[rows, cols], window.flags[rows, cols])
    if not np.isfinite(background):
        return np.full(target_shape, np.nan, dtype=np.float32)
    image = window.image.astype(np.float64) - background
    image[(window.flags & BAD_FLAGS) != 0] = np.nan
    ny, nx = image.shape
    wcs = window.wcs[window.y0:window.y0 + ny, window.x0:window.x0 + nx]
    data = reproject_interp((image, wcs), target, shape_out=target_shape, order="bilinear",
                            return_footprint=False)
    return data.astype(np.float32)


def combine(cutouts: Sequence[np.ndarray]) -> np.ndarray:
    """Per-pixel NaN-ignoring median of equally shaped cutouts; float32, NaN if no sample."""
    if not cutouts:
        raise ValueError("no cutouts to combine")
    shape = cutouts[0].shape
    if any(cutout.shape != shape for cutout in cutouts):
        raise ValueError("cutouts differ in shape")
    with warnings.catch_warnings():
        warnings.simplefilter("ignore", RuntimeWarning)
        return np.nanmedian(np.stack(cutouts), axis=0).astype(np.float32)
