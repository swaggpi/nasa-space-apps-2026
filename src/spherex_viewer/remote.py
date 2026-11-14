"""Read a pixel window of the IMAGE and FLAGS extensions of a remote SPHEREx L2 file.

The file is never downloaded whole: the headers are read first and every further byte range
(IMAGE rows, FLAGS row descriptors, FLAGS heap) is computed from them (DESIGN.md 5.3).
"""

import io
import re
import time
from dataclasses import dataclass
from typing import Protocol

import httpx
import numpy as np
from astropy.io import fits
from astropy.wcs import WCS

from spherex_viewer.cutout import FLAG_BITS
from spherex_viewer.discovery import is_valid_uri

S3_BASE = "https://nasa-irsa-spherex.s3.us-east-1.amazonaws.com/"

_URI_PREFIX = "ibe/data/spherex/"
_BLOCK = 2880
_HEAD_READ = 21 * _BLOCK
_FLAGS_READ = 14 * _BLOCK
_MSKN = re.compile(r"^MSKN(\d{4})$")


class RemoteReadError(RuntimeError):
    """A byte-range read failed (transport or HTTP error) after all retries."""


class UnsupportedLayoutError(RuntimeError):
    """The file is not laid out as DESIGN.md section 5.3 describes."""


class RangeReader(Protocol):
    """Source of byte ranges of remote files."""

    def read(self, url: str, start: int, stop: int) -> bytes:
        """Return bytes [start, stop) of the file at ``url``; shorter only at end of file."""
        ...


class HttpRangeReader:
    """RangeReader over HTTP ``Range`` requests that accepts only 206 responses."""

    def __init__(self, client: httpx.Client, attempts: int = 3, backoff_s: float = 0.5) -> None:
        self._client = client
        self._attempts = attempts
        self._backoff_s = backoff_s

    def read(self, url: str, start: int, stop: int) -> bytes:
        """Return bytes [start, stop) of ``url``.

        Transport errors, 429 and 5xx are retried after sleeping ``backoff_s``, then
        ``3 * backoff_s``, ...; any other status other than 206 fails at once. A 200 is an error
        because it means the server ignored the range and would send the whole file.
        """
        if stop <= start:
            raise ValueError(f"empty byte range [{start}, {stop})")
        headers = {"Range": f"bytes={start}-{stop - 1}"}
        last_error = ""
        for attempt in range(self._attempts):
            if attempt:
                time.sleep(self._backoff_s * 3 ** (attempt - 1))
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
            except httpx.TransportError as exc:
                last_error = f"{type(exc).__name__}: {exc}"
                continue
            last_error = f"HTTP {status}"
            if status != 429 and not 500 <= status < 600:
                break
        raise RemoteReadError(f"{url} bytes {start}-{stop - 1}: {last_error}")


@dataclass
class Window:
    """Native-pixel window of one exposure.

    ``image`` is float32 surface brightness in MJy/sr (NaN kept), ``flags`` the int32 flag
    bits, both (ny, nx). ``wcs`` is the full-detector celestial WCS including SIP, and
    ``(x0, y0)`` is the 0-based detector pixel of ``image[0, 0]``.
    """

    image: np.ndarray
    flags: np.ndarray
    wcs: WCS
    x0: int
    y0: int


def s3_url(uri: str) -> str:
    """Map an archive URI (``ibe/data/spherex/...``) to its URL in the public S3 bucket."""
    if not is_valid_uri(uri):
        raise ValueError(f"not a SPHEREx level-2 archive URI: {uri!r}")
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


def footprint_window(wcs: WCS, detector_shape: tuple[int, int], target: WCS,
                     target_shape: tuple[int, int],
                     pad: int = 3) -> tuple[int, int, int, int] | None:
    """Detector pixel box ``(x0, x1, y0, y1)`` (half-open, 0-based) covering the target grid.

    The sky positions of all border-pixel centres of the target grid are mapped to detector
    pixels; their bounding box is padded by ``pad`` pixels and clipped to ``detector_shape``
    (ny, nx). Returns None when the box does not overlap the detector.
    """
    ny, nx = target_shape
    rows, cols = np.mgrid[0:ny, 0:nx]
    border = (rows == 0) | (rows == ny - 1) | (cols == 0) | (cols == nx - 1)
    ra, dec = target.all_pix2world(cols[border], rows[border], 0)
    px, py = wcs.all_world2pix(ra, dec, 0, quiet=True)
    if not (np.all(np.isfinite(px)) and np.all(np.isfinite(py))):
        return None
    x0 = max(int(np.floor(px.min())) - pad, 0)
    x1 = min(int(np.ceil(px.max())) + pad + 1, detector_shape[1])
    y0 = max(int(np.floor(py.min())) - pad, 0)
    y1 = min(int(np.ceil(py.max())) + pad + 1, detector_shape[0])
    if x1 <= x0 or y1 <= y0:
        return None
    return x0, x1, y0, y1


def check_flag_definitions(header: fits.Header) -> None:
    """Raise UnsupportedLayoutError unless every ``MSKNnnnn`` card matches ``FLAG_BITS``."""
    for key in header:
        match = _MSKN.match(key)
        if match is None:
            continue
        bit = int(match.group(1))
        name = str(header[key]).strip()
        if FLAG_BITS.get(name) != bit:
            raise UnsupportedLayoutError(
                f"FLAGS bit {bit} is named {name!r}; expected flag definitions differ"
            )


def decode_flag_rows(header: fits.Header, descriptors: np.ndarray, heap: bytes,
                     heap_start: int) -> np.ndarray:
    """Decode whole FLAGS image rows from their table descriptors and heap bytes.

    ``descriptors`` is (n, 2) (byte count, heap offset) for consecutive image rows, ``heap``
    the heap bytes beginning at heap offset ``heap_start``, ``header`` the FLAGS table header.
    A minimal FITS file holding only these rows is decoded by astropy. Returns int32
    (n, ZNAXIS1).
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
    with fits.open(io.BytesIO(blob)) as hdul:
        return np.array(hdul[1].data, dtype=np.int32)


def _parse_header(buf: bytes, offset: int) -> fits.Header:
    try:
        return fits.Header.fromstring(buf.decode("ascii"))
    except (UnicodeDecodeError, ValueError) as exc:
        raise UnsupportedLayoutError(f"unreadable FITS header at byte {offset}: {exc}") from exc


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
            raise UnsupportedLayoutError(
                f"FLAGS {key} = {header.get(key)!r}, expected {value!r}"
            )
    if not str(header.get("TFORM1", "")).startswith("1PB"):
        raise UnsupportedLayoutError(f"FLAGS TFORM1 = {header.get('TFORM1')!r}, expected 1PB")
    if any(key in header for key in ("BSCALE", "BZERO", "ZSCALE", "ZZERO")):
        raise UnsupportedLayoutError("FLAGS values are scaled")


def read_window(reader: RangeReader, url: str, target: WCS,
                target_shape: tuple[int, int]) -> Window | None:
    """Read the IMAGE and FLAGS pixels of ``url`` that cover the target grid.

    Four range reads (DESIGN.md 5.3); None when the target grid does not overlap the
    detector. Raises UnsupportedLayoutError for an unexpected file layout and passes on the
    reader's RemoteReadError.
    """
    head = reader.read(url, 0, _HEAD_READ)
    primary, primary_len, _ = _read_header(reader, url, 0, head, _HEAD_READ)
    if primary.get("SIMPLE") is not True:
        raise UnsupportedLayoutError("not a FITS file")
    image_offset = primary_len + data_length(primary)
    image_header, image_header_len, _ = _read_header(
        reader, url, image_offset, head[image_offset:], _HEAD_READ)
    _check_image_header(image_header)
    image_data_start = image_offset + image_header_len
    wcs = WCS(image_header)
    detector_shape = (image_header["NAXIS2"], image_header["NAXIS1"])
    box = footprint_window(wcs, detector_shape, target, target_shape)
    if box is None:
        return None
    x0, x1, y0, y1 = box
    ny, nx = y1 - y0, x1 - x0
    row_len = detector_shape[1]

    start = image_data_start + 4 * (y0 * row_len + x0)
    stop = image_data_start + 4 * ((y1 - 1) * row_len + x1)
    raw = np.frombuffer(_read_exact(reader, url, start, stop), dtype=">f4")
    rows = np.empty(ny * row_len, dtype=">f4")
    rows[:raw.size] = raw
    image = rows.reshape(ny, row_len)[:, :nx].astype(np.float32)

    flags_start = image_data_start + data_length(image_header)
    flags_header, flags_header_len, buf = _read_header(
        reader, url, flags_start, reader.read(url, flags_start, flags_start + _FLAGS_READ),
        _FLAGS_READ)
    _check_flags_header(flags_header, detector_shape)
    check_flag_definitions(flags_header)
    table_len = flags_header["NAXIS1"] * flags_header["NAXIS2"]
    needed = flags_header_len + table_len
    if len(buf) < needed:
        buf += _read_exact(reader, url, flags_start + len(buf), flags_start + needed)
    descriptors = np.frombuffer(buf[flags_header_len:needed], dtype=">i4").reshape(-1, 2)
    selected = descriptors[y0:y1].astype(np.int64)
    theap = flags_header.get("THEAP", table_len)
    heap_size = flags_header["PCOUNT"] - (theap - table_len)
    lo = int(selected[:, 1].min())
    hi = int((selected[:, 0] + selected[:, 1]).max())
    if np.any(selected < 0) or hi > heap_size:
        raise UnsupportedLayoutError("FLAGS row descriptors point outside the heap")
    heap_offset = flags_start + flags_header_len + theap
    heap = _read_exact(reader, url, heap_offset + lo, heap_offset + hi)
    flags = decode_flag_rows(flags_header, selected, heap, lo)[:, x0:x1].copy()
    return Window(image=image, flags=flags, wcs=wcs, x0=x0, y0=y0)
