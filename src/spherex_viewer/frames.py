"""Frame orchestration: cache lookup, byte-range read, alignment and robust combination."""

import logging
from collections.abc import Sequence
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass

import numpy as np

from .cache import CutoutCache
from .cutout import align, combine
from .grid import GRID_SHAPE, target_wcs
from .remote import RangeReader, RemoteReadError, UnsupportedLayoutError, read_window, s3_url

MAX_WORKERS = 4

logger = logging.getLogger(__name__)


@dataclass
class FrameResult:
    """One co-added frame: float32 (59, 59) MJy/sr, row 0 = south, column 0 = east."""

    data: np.ndarray
    n_used: int
    n_failed: int


class FrameError(RuntimeError):
    """Raised when every exposure of a frame failed."""


class FrameBuilder:
    """Builds frames from exposure URIs on one shared pool of `max_workers` threads."""

    def __init__(self, reader: RangeReader, cache: CutoutCache,
                 max_workers: int = MAX_WORKERS) -> None:
        self._reader = reader
        self._cache = cache
        self._executor = ThreadPoolExecutor(max_workers=max_workers,
                                            thread_name_prefix="exposure")

    def cutout(self, uri: str, ra_deg: float, dec_deg: float) -> np.ndarray:
        """Return the aligned cutout of one exposure, from the cache or computed and cached.

        An exposure that does not overlap the grid yields an all-NaN cutout. Raises
        `RemoteReadError` or `UnsupportedLayoutError` when the file cannot be read.
        """
        cached = self._cache.get(uri, ra_deg, dec_deg)
        if cached is not None:
            return cached
        return self._compute(uri, ra_deg, dec_deg)

    def _compute(self, uri: str, ra_deg: float, dec_deg: float) -> np.ndarray:
        target = target_wcs(ra_deg, dec_deg)
        window = read_window(self._reader, s3_url(uri), target, GRID_SHAPE)
        if window is None:
            result = np.full(GRID_SHAPE, np.nan, dtype=np.float32)
        else:
            result = align(window, target, GRID_SHAPE)
        self._cache.put(uri, ra_deg, dec_deg, result)
        return result

    def build(self, uris: Sequence[str], ra_deg: float, dec_deg: float) -> FrameResult:
        """Combine the cutouts of `uris` into one frame centred on (ra_deg, dec_deg).

        Exposures that fail to read are skipped and counted in `n_failed`; raises
        `FrameError` when none yields a cutout.
        """
        cutouts: list[np.ndarray] = []
        misses = []
        for uri in uris:
            cached = self._cache.get(uri, ra_deg, dec_deg)
            if cached is not None:
                cutouts.append(cached)
            else:
                misses.append((uri, self._executor.submit(self._compute, uri, ra_deg, dec_deg)))
        n_failed = 0
        for uri, future in misses:
            try:
                cutouts.append(future.result())
            except (RemoteReadError, UnsupportedLayoutError) as exc:
                logger.warning("Skipping exposure %s: %s", uri, exc)
                n_failed += 1
        if not cutouts:
            raise FrameError(f"All {len(uris)} exposures of this frame failed to load.")
        return FrameResult(data=combine(cutouts), n_used=len(cutouts), n_failed=n_failed)

    def close(self) -> None:
        """Shut down the worker pool, cancelling queued work."""
        self._executor.shutdown(wait=True, cancel_futures=True)
