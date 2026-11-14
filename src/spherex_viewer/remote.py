"""Read a pixel window of the IMAGE and FLAGS extensions of a remote SPHEREx L2 file.

The file is never downloaded whole. Four byte ranges are read: the first FITS blocks (primary
and IMAGE headers), the IMAGE rows spanning the window, the FLAGS header with its row
descriptors, and the FLAGS heap bytes of the window's rows. Every offset after the first read
is computed from the headers.
"""

import io
import math
import time
from typing import Protocol

import httpx
import numpy as np
from astropy.coordinates import angular_separation
from astropy.io import fits
from astropy.wcs import WCS
from astropy.wcs.utils import proj_plane_pixel_scales

from .cutout import UnsupportedLayoutError, Window, check_flag_definitions
from .discovery import is_valid_uri

S3_BASE = "https://nasa-irsa-spherex.s3.us-east-1.amazonaws.com/"

_URI_PREFIX = "ibe/data/spherex/"
_BLOCK = 2880
_HEAD_READ = 21 * _BLOCK
_FLAGS_READ = 14 * _BLOCK
_ATTEMPTS = 3
_BACKOFF_S = 0.5
# Detector pixels kept beyond the footprint of the grid so bilinear interpolation has neighbours.
_PAD = 3
# What malformed headers or data make the parsing code raise (missing or mistyped keywords,
# impossible sizes, an undecodable WCS).
_MALFORMED = (KeyError, TypeError, ValueError, IndexError, OverflowError)


class RemoteReadError(RuntimeError):
    """A byte-range read failed (transport or HTTP error, unusable URL) after all retries."""


class RangeReader(Protocol):
    """Source of byte ranges of remote files."""

    def read(self, url: str, start: int, stop: int) -> bytes:
        """Return bytes [start, stop) of the file at ``url``; shorter only at end of file."""
        ...


class HttpRangeReader:
    """RangeReader over HTTP ``Range`` requests that accepts only 206 responses."""

    def __init__(self, client: httpx.Client) -> None:
        self._client = client

    def read(self, url: str, start: int, stop: int) -> bytes:
        """Return bytes [start, stop) of ``url``.

        Up to three attempts: transport errors, 429 and 5xx are retried after 0.5 s, then
        1.5 s; any other status except 206 fails at once, as does a URL httpx rejects. A 200
        is an error because it means the server ignored the range and would send the whole
        file; a 206 body longer than the range is an error too.
        """
        if stop <= start:
            raise ValueError(f"empty byte range [{start}, {stop})")
        headers = {"Range": f"bytes={start}-{stop - 1}"}
        last_error = ""
        for attempt in range(_ATTEMPTS):
            if attempt:
                time.sleep(_BACKOFF_S * 3 ** (attempt - 1))
            try:
                with self._client.stream("GET", url, headers=headers) as response:
                    status = response.status_code
                    if status == 206:
                        data = response.read()
                        if len(data) > stop - start:
                            raise RemoteReadError(
                                f"{url}: got {len(data)} bytes for a {stop - start}-byte range"
                            )
                        return data
            except httpx.InvalidURL as exc:
                raise RemoteReadError("the URL cannot be requested") from exc
            except httpx.TransportError as exc:
                last_error = f"{type(exc).__name__}: {exc}"
                continue
            last_error = f"HTTP {status}"
            if status != 429 and not 500 <= status < 600:
                break
        raise RemoteReadError(f"{url} bytes {start}-{stop - 1}: {last_error}")


def s3_url(uri: str) -> str:
    """Map an archive URI (``ibe/data/spherex/...``) to its URL in the public S3 bucket."""
    if not is_valid_uri(uri):
        raise ValueError("not a SPHEREx level-2 archive URI")
    return S3_BASE + uri[len(_URI_PREFIX):]


def header_length(buf: bytes) -> int | None:
    """Padded length in bytes of the FITS header at the start of ``buf``; None if no END card."""
    for pos in range(0, len(buf) - 79, 80):
        if buf[pos:pos + 8] == b"END     ":
            return -(-(pos + 80) // _BLOCK) * _BLOCK
    return None


def data_length(header: fits.Header) -> int:
    """Padded length in bytes of the data unit described by ``header``."""
    naxis = header["NAXIS"]
    n_elements = 0
    if naxis:
        n_elements = 1
        for axis in range(1, naxis + 1):
            n_elements *= header[f"NAXIS{axis}"]
    size = (abs(header["BITPIX"]) // 8 * header.get("GCOUNT", 1)
            * (header.get("PCOUNT", 0) + n_elements))
    return -(-size // _BLOCK) * _BLOCK


def _sky_radius(wcs: WCS, shape: tuple[int, int]) -> tuple[float, float, float]:
    """RA and Dec (radians) of the centre of a ``shape`` (ny, nx) pixel array, and the largest
    separation (radians) of a corner pixel centre from it, all via the pixel-to-sky transform.
    """
    ny, nx = shape
    x = np.array([(nx - 1) / 2, 0, nx - 1, 0, nx - 1])
    y = np.array([(ny - 1) / 2, 0, 0, ny - 1, ny - 1])
    ra, dec = np.radians(wcs.all_pix2world(x, y, 0))
    return ra[0], dec[0], float(np.max(angular_separation(ra[0], dec[0], ra[1:], dec[1:])))


def _within_reach(wcs: WCS, detector_shape: tuple[int, int], target: WCS,
                  target_shape: tuple[int, int]) -> bool:
    """False when the target grid cannot overlap the padded detector box.

    Uses only pixel-to-sky transforms, which cannot diverge. For a nearly linear projection
    the detector point farthest from its centre is a corner, so a grid whose centre is
    farther from the detector centre than the corner radius plus the grid's half diagonal plus
    ``_PAD + 1`` detector pixels cannot touch the box ``footprint_window`` would return.
    """
    ra, dec, radius = _sky_radius(wcs, detector_shape)
    target_ra, target_dec, _ = _sky_radius(target, target_shape)
    grid_radius = math.hypot(*target_shape) / 2 * np.max(proj_plane_pixel_scales(target))
    margin = (_PAD + 1) * np.max(proj_plane_pixel_scales(wcs))
    distance = angular_separation(ra, dec, target_ra, target_dec)
    return bool(distance <= radius + math.radians(grid_radius + margin))


def _max_window_side(wcs: WCS, target: WCS, target_shape: tuple[int, int]) -> int:
    """Largest box side, in detector pixels, the target grid can need.

    The grid's full diagonal (to the pixel edges, so one pixel more per axis than its border
    pixel centres span, which absorbs the < 1 % change of pixel scale across the detector from
    SIP) at the detector's smallest linear pixel scale, plus the padding on both sides and two
    pixels for rounding both box ends outward.
    """
    diagonal = math.hypot(*target_shape) * np.max(proj_plane_pixel_scales(target))
    return math.ceil(diagonal / np.min(proj_plane_pixel_scales(wcs))) + 2 * _PAD + 2


def footprint_window(wcs: WCS, detector_shape: tuple[int, int], target: WCS,
                     target_shape: tuple[int, int]) -> tuple[int, int, int, int] | None:
    """Detector pixel box ``(x0, x1, y0, y1)`` (half-open, 0-based) covering the target grid.

    Returns None without any sky-to-pixel transform when the grid is out of reach of the
    detector (``detector_shape`` is (ny, nx)). Otherwise the sky positions of all border-pixel
    centres of the grid are mapped to detector pixels; their bounding box is padded by 3
    pixels and clipped to the detector. Returns None when that mapping fails, when the box is
    larger than the grid can need (a diverged inversion), or when it misses the detector.
    """
    if not _within_reach(wcs, detector_shape, target, target_shape):
        return None
    ny, nx = target_shape
    rows, cols = np.mgrid[0:ny, 0:nx]
    border = (rows == 0) | (rows == ny - 1) | (cols == 0) | (cols == nx - 1)
    ra, dec = target.all_pix2world(cols[border], rows[border], 0)
    px, py = wcs.all_world2pix(ra, dec, 0, quiet=True)
    if not (np.all(np.isfinite(px)) and np.all(np.isfinite(py))):
        return None
    lo_x, hi_x = int(np.floor(px.min())) - _PAD, int(np.ceil(px.max())) + _PAD + 1
    lo_y, hi_y = int(np.floor(py.min())) - _PAD, int(np.ceil(py.max())) + _PAD + 1
    if max(hi_x - lo_x, hi_y - lo_y) > _max_window_side(wcs, target, target_shape):
        return None
    x0, x1 = max(lo_x, 0), min(hi_x, detector_shape[1])
    y0, y1 = max(lo_y, 0), min(hi_y, detector_shape[0])
    if x1 <= x0 or y1 <= y0:
        return None
    return x0, x1, y0, y1


def decode_flag_rows(header: fits.Header, descriptors: np.ndarray, heap: bytes,
                     heap_start: int) -> np.ndarray:
    """Decode whole FLAGS image rows from their table descriptors and heap bytes.

    ``descriptors`` is (n, 2) (byte count, heap offset) for consecutive image rows, ``heap``
    the heap bytes beginning at heap offset ``heap_start``, ``header`` the FLAGS table header.
    A minimal FITS file holding only these rows is decoded by astropy. Returns int32
    (n, ZNAXIS1); raises UnsupportedLayoutError when the rows cannot be decoded.
    """
    desc = np.asarray(descriptors, dtype=np.int64).reshape(-1, 2).copy()
    desc[:, 1] -= heap_start
    if np.any(desc < 0) or np.any(desc[:, 0] + desc[:, 1] > len(heap)):
        raise ValueError("descriptors point outside the given heap bytes")
    n_rows = desc.shape[0]
    mini = header.copy()
    mini["NAXIS2"] = n_rows
    mini["ZNAXIS2"] = n_rows
    mini["PCOUNT"] = len(heap)
    mini.remove("THEAP", ignore_missing=True)
    body = desc.astype(">i4").tobytes() + heap
    body += b"\0" * (-len(body) % _BLOCK)
    blob = (fits.PrimaryHDU().header.tostring().encode("ascii")
            + mini.tostring().encode("ascii") + body)
    try:
        with fits.open(io.BytesIO(blob)) as hdul:
            return np.array(hdul[1].data, dtype=np.int32)
    # Broad on purpose: astropy's RICE decoder raises its own non-public exception class.
    except Exception as exc:
        raise UnsupportedLayoutError("FLAGS rows cannot be decompressed") from exc


def _parse_header(buf: bytes, offset: int) -> fits.Header:
    try:
        return fits.Header.fromstring(buf.decode("ascii"))
    except (UnicodeDecodeError, ValueError) as exc:
        raise UnsupportedLayoutError(f"unreadable FITS header at byte {offset}") from exc


def _read_header(reader: RangeReader, url: str, offset: int, prefix: bytes,
                 step: int) -> tuple[fits.Header, int, bytes]:
    """Header at file byte ``offset``, its padded length, and the bytes read from ``offset``."""
    buf = prefix
    while (length := header_length(buf)) is None:
        more = reader.read(url, offset + len(buf), offset + len(buf) + step)
        if not more:
            raise UnsupportedLayoutError(f"no END card in the header at byte {offset}")
        buf += more
    return _parse_header(buf[:length], offset), length, buf


def _read_exact(reader: RangeReader, url: str, start: int, stop: int) -> bytes:
    data = reader.read(url, start, stop)
    if len(data) != stop - start:
        raise UnsupportedLayoutError(f"file ends before byte {stop} stated by its headers")
    return data


def _check_image_header(header: fits.Header) -> None:
    if (header.get("XTENSION") != "IMAGE" or header.get("EXTNAME") != "IMAGE"
            or header.get("BITPIX") != -32 or header.get("NAXIS") != 2
            or header.get("BSCALE", 1) != 1 or header.get("BZERO", 0) != 0):
        raise UnsupportedLayoutError("HDU 1 is not an unscaled 2-D float32 IMAGE extension")
    for key in ("NAXIS1", "NAXIS2"):
        value = header.get(key)
        if not isinstance(value, int) or value < 1:
            raise UnsupportedLayoutError(f"IMAGE {key} is not a positive integer")


def _check_flags_header(header: fits.Header, detector_shape: tuple[int, int]) -> None:
    ny, nx = detector_shape
    expected = {
        "XTENSION": "BINTABLE", "EXTNAME": "FLAGS", "NAXIS": 2, "NAXIS1": 8, "NAXIS2": ny,
        "GCOUNT": 1, "TFIELDS": 1, "TTYPE1": "COMPRESSED_DATA", "ZIMAGE": True,
        "ZCMPTYPE": "RICE_1", "ZBITPIX": 32, "ZNAXIS": 2, "ZNAXIS1": nx, "ZNAXIS2": ny,
        "ZTILE1": nx, "ZTILE2": 1,
    }
    for key, value in expected.items():
        if header.get(key) != value:
            raise UnsupportedLayoutError(f"FLAGS {key} is not {value!r}")
    if not str(header.get("TFORM1", "")).startswith("1PB"):
        raise UnsupportedLayoutError("FLAGS TFORM1 is not 1PB")
    if any(key in header for key in ("BSCALE", "BZERO", "ZSCALE", "ZZERO")):
        raise UnsupportedLayoutError("FLAGS values are scaled")


def _read_image_header(reader: RangeReader, url: str) -> tuple[fits.Header, int]:
    """IMAGE header and the file byte where the IMAGE data start, from the first read."""
    head = reader.read(url, 0, _HEAD_READ)
    primary, primary_len, _ = _read_header(reader, url, 0, head, _HEAD_READ)
    if primary.get("SIMPLE") is not True:
        raise UnsupportedLayoutError("not a FITS file")
    offset = primary_len + data_length(primary)
    header, header_len, _ = _read_header(reader, url, offset, head[offset:], _HEAD_READ)
    _check_image_header(header)
    return header, offset + header_len


def _read_image(reader: RangeReader, url: str, data_start: int, row_len: int,
                box: tuple[int, int, int, int]) -> np.ndarray:
    """float32 IMAGE pixels of ``box``, from one read spanning its rows."""
    x0, x1, y0, y1 = box
    start = data_start + 4 * (y0 * row_len + x0)
    stop = data_start + 4 * ((y1 - 1) * row_len + x1)
    raw = np.frombuffer(_read_exact(reader, url, start, stop), dtype=">f4")
    rows = np.empty((y1 - y0) * row_len, dtype=">f4")
    rows[:raw.size] = raw
    return rows.reshape(y1 - y0, row_len)[:, :x1 - x0].astype(np.float32)


def _read_flags(reader: RangeReader, url: str, flags_start: int,
                detector_shape: tuple[int, int], box: tuple[int, int, int, int]) -> np.ndarray:
    """int32 FLAGS pixels of ``box`` from the FLAGS HDU at file byte ``flags_start``.

    One read for the header and row descriptors (rarely a second when they are longer), one
    for the heap bytes of the box's rows.
    """
    x0, x1, y0, y1 = box
    header, header_len, buf = _read_header(
        reader, url, flags_start, reader.read(url, flags_start, flags_start + _FLAGS_READ),
        _FLAGS_READ)
    _check_flags_header(header, detector_shape)
    check_flag_definitions(header)
    table_len = header["NAXIS1"] * header["NAXIS2"]
    needed = header_len + table_len
    if len(buf) < needed:
        buf += _read_exact(reader, url, flags_start + len(buf), flags_start + needed)
    descriptors = np.frombuffer(buf[header_len:needed], dtype=">i4").reshape(-1, 2)
    selected = descriptors[y0:y1].astype(np.int64)
    theap = header.get("THEAP", table_len)
    heap_size = header["PCOUNT"] - (theap - table_len)
    lo = int(selected[:, 1].min())
    hi = int((selected[:, 0] + selected[:, 1]).max())
    if np.any(selected < 0) or hi > heap_size:
        raise UnsupportedLayoutError("FLAGS row descriptors point outside the heap")
    heap_offset = flags_start + header_len + theap
    heap = _read_exact(reader, url, heap_offset + lo, heap_offset + hi)
    return decode_flag_rows(header, selected, heap, lo)[:, x0:x1].copy()


def read_window(reader: RangeReader, url: str, target: WCS,
                target_shape: tuple[int, int]) -> Window | None:
    """Read the IMAGE and FLAGS pixels of ``url`` that cover the target grid.

    Four range reads; only the first when the target grid does not overlap the detector,
    which returns None. Raises UnsupportedLayoutError for an unexpected layout or malformed
    content and passes on the reader's RemoteReadError.
    """
    try:
        header, data_start = _read_image_header(reader, url)
        wcs = WCS(header)
        detector_shape = (header["NAXIS2"], header["NAXIS1"])
        box = footprint_window(wcs, detector_shape, target, target_shape)
        if box is None:
            return None
        image = _read_image(reader, url, data_start, detector_shape[1], box)
        flags = _read_flags(reader, url, data_start + data_length(header), detector_shape, box)
    except _MALFORMED as exc:
        raise UnsupportedLayoutError(f"malformed FITS content ({type(exc).__name__})") from exc
    return Window(image=image, flags=flags, wcs=wcs, x0=box[0], y0=box[2])
