"""Synthetic SPHEREx-like multi-extension FITS exposures and an in-memory range reader for tests.

A small detector with a TAN-SIP WCS, a constant background with Gaussian noise, one Gaussian
star, an uncompressed float32 IMAGE HDU, a RICE_1 tile-compressed int32 FLAGS HDU (one tile per
row, like the real files) and a VARIANCE HDU.
"""

import io
import warnings
from collections.abc import Iterable

import numpy as np
from astropy.io import fits
from astropy.modeling import fitting, models
from astropy.wcs import WCS, Sip

from spherex_viewer.remote import RemoteReadError

PIXEL_SCALE_DEG = 6.15 / 3600

FLAG_NAMES = {
    0: "TRANSIENT", 1: "OVERFLOW", 2: "SUR_ERROR", 6: "NONFUNC", 7: "DICHROIC",
    9: "MISSING_DATA", 10: "HOT", 11: "COLD", 12: "FULLSAMPLE", 14: "PHANMISS",
    15: "NONLINEAR", 17: "PERSIST", 19: "OUTLIER", 20: "CROSSTALK", 21: "SOURCE",
    22: "GHOST", 23: "GHOST_FPA", 24: "GHOST_EXT", 25: "STREAK", 26: "BLOOM",
    27: "SNOWBALL", 28: "HALO",
}


def exposure_wcs(center: tuple[float, float], *, n: int, rot_deg: float, sip: bool) -> WCS:
    """Celestial WCS of a synthetic n x n detector centred on ``center`` (ICRS degrees)."""
    w = WCS(naxis=2)
    t = np.radians(rot_deg)
    s = PIXEL_SCALE_DEG
    w.wcs.ctype = ["RA---TAN-SIP", "DEC--TAN-SIP"] if sip else ["RA---TAN", "DEC--TAN"]
    w.wcs.crpix = [n / 2 + 0.5, n / 2 + 0.5]
    w.wcs.crval = list(center)
    w.wcs.cd = s * np.array([[-np.cos(t), np.sin(t)], [np.sin(t), np.cos(t)]])
    if sip:
        a = np.zeros((4, 4))
        b = np.zeros((4, 4))
        a[2, 0] = 2e-5
        a[0, 2] = -1e-5
        b[1, 1] = 1.5e-5
        b[0, 2] = 2e-5
        w.sip = Sip(a, b, None, None, w.wcs.crpix)
    return w


def make_exposure(
    center: tuple[float, float],
    star: tuple[float, float],
    *,
    n: int = 300,
    rot_deg: float,
    sip: bool = True,
    background: float = 0.25,
    noise: float = 0.02,
    star_amp: float = 50.0,
    star_sigma: float = 0.9,
    bad: Iterable[tuple[int, int, int]] = (),
    seed: int,
) -> bytes:
    """Return the bytes of a synthetic exposure (MJy/sr) with a star at sky position ``star``.

    Each ``bad`` entry (x, y, bit) adds 1000 MJy/sr at detector pixel (x, y) and sets that flag bit.
    """
    rng = np.random.default_rng(seed)
    w = exposure_wcs(center, n=n, rot_deg=rot_deg, sip=sip)
    sx, sy = w.all_world2pix(star[0], star[1], 0)
    yy, xx = np.mgrid[0:n, 0:n]
    image = background + rng.normal(0.0, noise, (n, n))
    image += star_amp * np.exp(-((xx - sx) ** 2 + (yy - sy) ** 2) / (2 * star_sigma**2))
    flags = np.zeros((n, n), dtype=np.int32)
    for x, y, bit in bad:
        image[y, x] += 1000.0
        flags[y, x] |= np.int32(1 << bit)

    header = w.to_header(relax=True)
    header["BUNIT"] = "MJy / sr"
    flags_header = header.copy()
    for bit, name in FLAG_NAMES.items():
        flags_header[f"MSKN{bit:04d}"] = (name, f"Name for mask plane {bit}")
        flags_header[f"MSKM{bit:04d}"] = (1 << bit, f"Bitmask for plane n={bit}; always 1<<n")

    primary = fits.PrimaryHDU()
    primary.header["VERSION"] = "synthetic"
    hdul = fits.HDUList([
        primary,
        fits.ImageHDU(image.astype(np.float32), header=header, name="IMAGE"),
        fits.CompImageHDU(flags, header=flags_header, name="FLAGS", compression_type="RICE_1",
                          tile_shape=(1, n)),
        fits.ImageHDU(np.full((n, n), noise**2, dtype=np.float32), name="VARIANCE"),
    ])
    buf = io.BytesIO()
    hdul.writeto(buf)
    return buf.getvalue()


def rewrite_flags(blob: bytes, *, tile_shape: tuple[int, int] | None = None,
                  rename: dict[str, str] | None = None) -> bytes:
    """Return ``blob`` with the FLAGS HDU recompressed with ``tile_shape`` and/or cards renamed."""
    with fits.open(io.BytesIO(blob)) as hdul:
        flags = hdul["FLAGS"].data.copy()
        header = hdul["FLAGS"].header.copy()
        image = hdul["IMAGE"].copy()
        variance = hdul["VARIANCE"].copy()
        primary = hdul[0].copy()
    for key, value in (rename or {}).items():
        header[key] = value
    shape = tile_shape if tile_shape is not None else (1, flags.shape[1])
    out = fits.HDUList([
        primary,
        image,
        fits.CompImageHDU(flags, header=header, name="FLAGS", compression_type="RICE_1",
                          tile_shape=shape),
        variance,
    ])
    buf = io.BytesIO()
    out.writeto(buf)
    return buf.getvalue()


def corrupt_flags_heap(blob: bytes) -> bytes:
    """Return ``blob`` with every byte of the FLAGS heap set to 0xFF (undecodable RICE data)."""
    with fits.open(io.BytesIO(blob), disable_image_compression=True) as hdul:
        info = hdul.fileinfo(2)
        header = hdul[2].header
        heap = info["datLoc"] + header["NAXIS1"] * header["NAXIS2"]
    end = info["datLoc"] + info["datSpan"]
    return blob[:heap] + b"\xff" * (end - heap) + blob[end:]


def fit_centroid(image: np.ndarray, x: float, y: float, half: int = 3) -> tuple[float, float]:
    """Gaussian2D + constant fit to the finite pixels of a box around (x, y); returns (x, y)."""
    xc, yc = int(round(float(x))), int(round(float(y)))
    y0, y1, x0, x1 = yc - half, yc + half + 1, xc - half, xc + half + 1
    cut = image[y0:y1, x0:x1].astype(float)
    ok = np.isfinite(cut)
    yy, xx = np.mgrid[y0:y1, x0:x1]
    model = models.Gaussian2D(np.nanmax(cut), xc, yc, 1.0, 1.0) + models.Const2D(0.0)
    model[0].theta.fixed = True
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        fit = fitting.LevMarLSQFitter()(model, xx[ok], yy[ok], cut[ok])
    return float(fit[0].x_mean.value), float(fit[0].y_mean.value)


class FakeRangeReader:
    """In-memory ``RangeReader``: serves byte slices of ``blobs``, recording every call in order."""

    def __init__(self, blobs: dict[str, bytes]) -> None:
        self.blobs = blobs
        self.calls: list[tuple[str, int, int]] = []

    def read(self, url: str, start: int, stop: int) -> bytes:
        """Return bytes [start, stop) of ``blobs[url]``; ``RemoteReadError`` for an unknown URL."""
        self.calls.append((url, start, stop))
        if url not in self.blobs:
            raise RemoteReadError(f"unknown URL {url}")
        return self.blobs[url][start:stop]
