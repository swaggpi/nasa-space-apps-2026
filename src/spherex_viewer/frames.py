"""Frame orchestration: cache lookup, byte-range read, alignment and robust combination."""

import logging
import time
from collections.abc import Sequence
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass

import numpy as np

from .cache import CutoutCache
from .cutout import UnsupportedLayoutError, align, combine
from .grid import GRID_SHAPE, target_wcs
from .remote import RangeReader, RemoteReadError, read_window, s3_url

# A cold frame is network-bound: rounds of ~0.34 s range reads at ~40 % of a core. Eight
# workers cut a 24-exposure frame from 2.1 to 1.2 s in replay (2.7 s before the header parsing
# was reduced); twelve shorten it by a further 15-22 % but take 70-75 % of a core on a fast
# link (eight: 62-66 %).
MAX_WORKERS = 8
# The longest legitimate build seen took 12.5 s (four deep-field frames at once); a stalled
# upstream must not hold a frame slot and the pool threads for minutes.
FRAME_BUILD_S = 30.0

logger = logging.getLogger(__name__)


@dataclass
class FrameResult:
    """One co-added frame: float32 (59, 59) MJy/sr, row 0 = south, column 0 = east.

    ``n_used`` counts the exposures that contributed at least one valid pixel, ``n_failed``
    those that could not be read.
    """

    data: np.ndarray
    n_used: int
    n_failed: int


class FrameError(RuntimeError):
    """Raised when no exposure of a frame yields a valid pixel or the build runs out of time."""


class _DeadlinePassed(Exception):
    """Raised by an exposure that would start after its frame's deadline."""


class FrameBuilder:
    """Builds frames from exposure URIs on one shared pool of ``MAX_WORKERS`` threads."""

    def __init__(self, reader: RangeReader, cache: CutoutCache) -> None:
        self._reader = reader
        self._cache = cache
        self._executor = ThreadPoolExecutor(max_workers=MAX_WORKERS,
                                            thread_name_prefix="exposure")

    def _compute(self, uri: str, ra_deg: float, dec_deg: float,
                 deadline: float) -> np.ndarray | None:
        """Aligned cutout of one exposure, stored in the cache when possible.

        None, and nothing cached, when the exposure does not overlap the grid. Raises
        ``_DeadlinePassed`` without reading when called after ``deadline`` (monotonic clock).
        """
        if time.monotonic() > deadline:
            raise _DeadlinePassed
        target = target_wcs(ra_deg, dec_deg)
        window = read_window(self._reader, s3_url(uri), target, GRID_SHAPE)
        if window is None:
            return None
        result = align(window, target, GRID_SHAPE)
        try:
            self._cache.put(uri, ra_deg, dec_deg, result)
        except OSError as exc:
            logger.warning("Could not cache a cutout: %s", exc.strerror or type(exc).__name__)
        return result

    def build(self, uris: Sequence[str], ra_deg: float, dec_deg: float) -> FrameResult:
        """Combine the cutouts of ``uris`` into one frame centred on (ra_deg, dec_deg).

        Exposures that fail to read are skipped and counted in ``n_failed``; exposures that
        miss the grid or have no valid pixel are skipped. Raises ``FrameError`` when no
        exposure contributes a valid pixel, and when the frame is not built within
        ``FRAME_BUILD_S`` seconds: no partial frame is returned, exposures not yet started are
        refused, and the cutouts finished so far stay cached for the next attempt.
        """
        deadline = time.monotonic() + FRAME_BUILD_S
        cutouts: list[np.ndarray] = []
        misses = []
        for uri in uris:
            cached = self._cache.get(uri, ra_deg, dec_deg)
            if cached is not None:
                cutouts.append(cached)
            else:
                misses.append((uri, self._executor.submit(self._compute, uri, ra_deg, dec_deg,
                                                          deadline)))
        n_failed = 0
        for uri, future in misses:
            try:
                result = future.result(timeout=max(0.0, deadline - time.monotonic()))
            except (TimeoutError, _DeadlinePassed):
                raise FrameError("The frame was not built in time.") from None
            except (RemoteReadError, UnsupportedLayoutError) as exc:
                logger.warning("Skipping exposure %s: %s", uri, exc)
                n_failed += 1
                continue
            if result is not None:
                cutouts.append(result)
        used = [cutout for cutout in cutouts if np.isfinite(cutout).any()]
        if not used:
            raise FrameError("No exposure of this frame has a valid pixel.")
        return FrameResult(data=combine(used), n_used=len(used), n_failed=n_failed)

    def close(self) -> None:
        """Shut down the worker pool, cancelling queued work."""
        self._executor.shutdown(wait=True, cancel_futures=True)
