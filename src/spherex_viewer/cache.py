"""On-disk cache of aligned per-exposure cutouts."""

import hashlib
import os
import tempfile
from pathlib import Path

import numpy as np

from .cutout import CUTOUT_VERSION
from .grid import GRID_SHAPE


class CutoutCache:
    """Cache of float32 cutouts on the target grid, one ``.npy`` file per exposure and position."""

    def __init__(self, root: Path) -> None:
        self.root = Path(root)
        self.root.mkdir(parents=True, exist_ok=True)

    def path(self, uri: str, ra_deg: float, dec_deg: float) -> Path:
        """Return the cache file of the cutout of ``uri`` centred on (ra, dec) in degrees."""
        key = hashlib.sha256(
            f"v{CUTOUT_VERSION}|{uri}|{ra_deg!r}|{dec_deg!r}".encode()
        ).hexdigest()
        return self.root / key[:2] / f"{key}.npy"

    def get(self, uri: str, ra_deg: float, dec_deg: float) -> np.ndarray | None:
        """Return the cached cutout, or None if it is missing, unreadable or of the wrong shape."""
        try:
            data = np.load(self.path(uri, ra_deg, dec_deg), allow_pickle=False)
        except (OSError, ValueError, EOFError):
            return None
        if not isinstance(data, np.ndarray) or data.shape != GRID_SHAPE:
            return None
        return data

    def put(self, uri: str, ra_deg: float, dec_deg: float, cutout: np.ndarray) -> None:
        """Store a cutout as float32, atomically (temporary file, then ``os.replace``)."""
        target = self.path(uri, ra_deg, dec_deg)
        target.parent.mkdir(parents=True, exist_ok=True)
        fd, tmp = tempfile.mkstemp(dir=target.parent, prefix=target.stem, suffix=".tmp")
        try:
            with os.fdopen(fd, "wb") as f:
                np.save(f, np.asarray(cutout, dtype=np.float32), allow_pickle=False)
            os.replace(tmp, target)
        except BaseException:
            Path(tmp).unlink(missing_ok=True)
            raise
