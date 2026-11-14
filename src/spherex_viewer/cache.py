"""On-disk cache of aligned per-exposure cutouts, capped in total size."""

import hashlib
import io
import logging
import os
import re
import stat
import tempfile
import threading
from pathlib import Path

import numpy as np

from .cutout import CUTOUT_VERSION
from .grid import GRID_SHAPE

_EVICT_TO_FRACTION = 0.9
_CUTOUT_BYTES = 4 * GRID_SHAPE[0] * GRID_SHAPE[1]
_SUBDIR = re.compile(r"[0-9a-f]{2}")


def _npy_header() -> bytes:
    buf = io.BytesIO()
    np.save(buf, np.zeros(GRID_SHAPE, dtype=np.float32), allow_pickle=False)
    return buf.getvalue()[:-_CUTOUT_BYTES]


# The exact header np.save writes for a C-ordered float32 grid-shaped array.
_NPY_HEADER = _npy_header()

logger = logging.getLogger(__name__)


class CutoutCache:
    """Cache of float32 cutouts on the target grid, one ``.npy`` file per exposure and position.

    The total size of the cache files is kept at or below ``max_bytes``: when a ``put`` takes
    it above, the oldest files by modification time are deleted until it is at most 90 % of
    ``max_bytes``. The total is counted once at construction and then tracked in memory.
    Only regular ``.npy`` files in real two-hex-digit subdirectories count and are evicted;
    symbolic links are never followed.
    """

    def __init__(self, root: Path, max_bytes: int) -> None:
        self.root = Path(root)
        self.root.mkdir(parents=True, exist_ok=True)
        self._max_bytes = max_bytes
        self._lock = threading.Lock()
        self._total = sum(size for _, size, _ in self._files())

    def path(self, uri: str, ra_deg: float, dec_deg: float) -> Path:
        """Return the cache file of the cutout of ``uri`` centred on (ra, dec) in degrees."""
        key = hashlib.sha256(
            f"v{CUTOUT_VERSION}|{uri}|{ra_deg!r}|{dec_deg!r}".encode()
        ).hexdigest()
        return self.root / key[:2] / f"{key}.npy"

    def get(self, uri: str, ra_deg: float, dec_deg: float) -> np.ndarray | None:
        """Return the cached cutout; None unless the file is exactly what ``put`` writes.

        The ``.npy`` header is compared byte for byte, never parsed, so nothing is unpickled.
        """
        try:
            with open(self.path(uri, ra_deg, dec_deg), "rb") as f:
                raw = f.read(len(_NPY_HEADER) + _CUTOUT_BYTES + 1)
        except OSError:
            return None
        if len(raw) != len(_NPY_HEADER) + _CUTOUT_BYTES or not raw.startswith(_NPY_HEADER):
            return None
        return np.frombuffer(raw, dtype=np.float32, offset=len(_NPY_HEADER)).reshape(
            GRID_SHAPE).copy()

    def put(self, uri: str, ra_deg: float, dec_deg: float, cutout: np.ndarray) -> None:
        """Store a cutout as float32, atomically (temporary file, then ``os.replace``).

        Raises OSError when the file cannot be written. Evicts old files when the cache is
        over its size cap; errors while evicting are logged, never raised.
        """
        target = self.path(uri, ra_deg, dec_deg)
        target.parent.mkdir(parents=True, exist_ok=True)
        fd, tmp = tempfile.mkstemp(dir=target.parent, prefix=target.stem, suffix=".tmp")
        try:
            with os.fdopen(fd, "wb") as f:
                np.save(f, np.ascontiguousarray(cutout, dtype=np.float32), allow_pickle=False)
            size = os.path.getsize(tmp)
            with self._lock:
                try:
                    replaced = target.stat().st_size
                except FileNotFoundError:
                    replaced = 0
                os.replace(tmp, target)
                self._total += size - replaced
                if self._total > self._max_bytes:
                    self._evict()
        except BaseException:
            Path(tmp).unlink(missing_ok=True)
            raise

    def _files(self) -> list[tuple[float, int, Path]]:
        """(modification time, size, path) of every cache file; vanished files are skipped."""
        files = []
        for subdir in self._entries(self.root):
            if not (_SUBDIR.fullmatch(subdir.name) and subdir.is_dir(follow_symlinks=False)):
                continue
            for entry in self._entries(Path(subdir.path)):
                if not entry.name.endswith(".npy"):
                    continue
                try:
                    info = entry.stat(follow_symlinks=False)
                except OSError:
                    continue
                if stat.S_ISREG(info.st_mode):
                    files.append((info.st_mtime, info.st_size, Path(entry.path)))
        return files

    @staticmethod
    def _entries(directory: Path) -> list[os.DirEntry]:
        try:
            with os.scandir(directory) as entries:
                return list(entries)
        except OSError:
            return []

    def _evict(self) -> None:
        """Delete the oldest files until the total is at most 90 % of the cap (lock held)."""
        files = sorted(self._files())
        self._total = sum(size for _, size, _ in files)
        for _, size, path in files:
            if self._total <= _EVICT_TO_FRACTION * self._max_bytes:
                break
            try:
                path.unlink(missing_ok=True)
            except OSError as exc:
                logger.warning("Could not evict a cache file: %s",
                               exc.strerror or type(exc).__name__)
                continue
            self._total -= size
