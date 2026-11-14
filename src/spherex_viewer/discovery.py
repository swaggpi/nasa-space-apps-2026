"""Discovery of SPHEREx spectral-image exposures covering a position via IRSA's SIA v2 service."""

import math
import re
import time
from collections.abc import Iterable, Iterator
from dataclasses import dataclass

import httpx

SIA_URL = "https://irsa.ipac.caltech.edu/SIA"
ARCHIVE_PREFIX = "https://irsa.ipac.caltech.edu/"
DETECTORS = ("D1", "D2", "D3", "D4", "D5", "D6")
URI_PATTERN = re.compile(r"ibe/data/spherex/[a-z0-9]+/level2/[A-Za-z0-9_./-]+\.fits")
MAX_URI_LENGTH = 300
MAX_RESPONSE_BYTES = 64 * 2**20

# A wavelength (m) inside every exposure's [em_min, em_max] of that detector and outside every
# other detector's; adjacent detector ranges overlap, so band edges cannot be used. The server
# filter only saves transfer: rows are still selected by energy_bandpassname.
_BAND_M = {"D1": 0.92e-6, "D2": 1.37e-6, "D3": 2.02e-6, "D4": 3.12e-6, "D5": 4.13e-6,
           "D6": 4.72e-6}
_COLUMNS = ("access_url", "energy_bandpassname", "t_min", "calib_level", "dataproduct_type")
# IRSA's gateway has answered 63-94 % of requests with an immediate HTTP 502 (measured on
# 2026-11-14); the share drifts within an hour and two requests in the same second can get
# different answers, so retries are cheap and effective. About 11 attempts fit the 20 s start
# window (_LAST_START_S).
_RETRY_DELAYS_S = (0.5, 1.0, 1.5) + (2.0,) * 9
# One discover() call ends within _BUDGET_S: an attempt starts only if its pool wait, connect,
# send and header read all fit in the budget, and no body read starts after _STREAM_END_S.
# The deepest field (5,125 rows) answers in 2 s and streams 4.7 MB with gaps below 0.1 s.
_TIMEOUT = httpx.Timeout(connect=5.0, read=10.0, write=5.0, pool=5.0)
_BUDGET_S = 45.0
_LAST_START_S = _BUDGET_S - _TIMEOUT.pool - _TIMEOUT.connect - _TIMEOUT.write - _TIMEOUT.read
_STREAM_END_S = _BUDGET_S - _TIMEOUT.read


@dataclass(frozen=True)
class Exposure:
    """One exposure: archive URI and start time (MJD UTC, ``t_min`` = ``time_bounds_lower``)."""

    uri: str
    mjd: float


class DiscoveryError(RuntimeError):
    """Raised when the archive query fails or returns an unexpected response."""


def is_valid_uri(uri: str) -> bool:
    """Return True if ``uri`` is a SPHEREx level-2 archive URI.

    The whole string must match ``URI_PATTERN``, be at most ``MAX_URI_LENGTH`` characters long
    and contain no ``.`` or ``..`` path segment.
    """
    return (len(uri) <= MAX_URI_LENGTH and URI_PATTERN.fullmatch(uri) is not None
            and not {".", ".."} & set(uri.split("/")))


def sia_params(ra_deg: float, dec_deg: float, detector: str) -> list[tuple[str, str]]:
    """Return the SIA query for all SPHEREx images of ``detector`` containing (ra, dec) in deg.

    A zero-radius circle is a point, so an image matches when its footprint contains the
    position. No collection is named, so every SPHEREx release is searched.
    """
    if detector not in DETECTORS:
        raise ValueError(f"Unknown detector {detector!r}.")
    return [("POS", f"circle {float(ra_deg)!r} {float(dec_deg)!r} 0"),
            ("INSTRUMENT", "SPHEREx"), ("BAND", repr(_BAND_M[detector])),
            ("RESPONSEFORMAT", "TSV")]


def _lines(chunks: Iterable[bytes], end: float) -> Iterator[bytes]:
    """Split a byte stream into lines.

    Raises DiscoveryError once the stream exceeds MAX_RESPONSE_BYTES, or when a read would start
    after ``end`` (a ``time.monotonic()`` value).
    """
    total, buffer = 0, bytearray()
    stream = iter(chunks)
    while True:
        if time.monotonic() > end:
            raise DiscoveryError("The archive answered too slowly.")
        chunk = next(stream, None)
        if chunk is None:
            break
        total += len(chunk)
        if total > MAX_RESPONSE_BYTES:
            raise DiscoveryError("The archive response is too large.")
        start, scan = 0, len(buffer)
        buffer += chunk
        while (end_of_line := buffer.find(b"\n", scan)) >= 0:
            yield bytes(buffer[start:end_of_line])
            start = scan = end_of_line + 1
        del buffer[:start]
    if buffer:
        yield bytes(buffer)


def parse_tsv(lines: Iterable[bytes], detector: str) -> list[Exposure]:
    """Parse the SIA TSV response into the exposures of ``detector``, sorted by MJD.

    Rows of ``detector`` that are not level-2 images are skipped, unless their URI is a level-2
    URI: then the labels contradict the file and ``DiscoveryError`` is raised.
    """
    band = f"SPHEREx-{detector}"
    exposures = []
    header = None
    for raw in lines:
        try:
            line = raw.decode("utf-8").removesuffix("\r")
        except UnicodeDecodeError as exc:
            raise DiscoveryError("Malformed archive response.") from exc
        if not line:
            continue
        fields = line.split("\t")
        if header is None:
            if not set(_COLUMNS) <= set(fields):
                raise DiscoveryError("Unexpected header in the archive response.")
            header = fields
            index = [fields.index(name) for name in _COLUMNS]
            continue
        if len(fields) != len(header):
            raise DiscoveryError("Malformed row in the archive response.")
        url, bandpass, mjd_text, level, kind = (fields[i] for i in index)
        if bandpass != band:
            continue
        uri = url.removeprefix(ARCHIVE_PREFIX)
        valid = uri != url and is_valid_uri(uri)
        if (level, kind) != ("2", "image"):
            if valid:
                raise DiscoveryError(f"Unexpected product type in the archive response: {url!r}.")
            continue
        try:
            mjd = float(mjd_text)
        except ValueError as exc:
            raise DiscoveryError("Malformed time in the archive response.") from exc
        if not math.isfinite(mjd):
            raise DiscoveryError("Malformed time in the archive response.")
        if not valid:
            raise DiscoveryError(f"Unexpected URI in the archive response: {url!r}.")
        exposures.append(Exposure(uri=uri, mjd=mjd))
    if header is None:
        raise DiscoveryError("Unexpected header in the archive response.")
    exposures.sort(key=lambda e: e.mjd)
    return exposures


def discover(client: httpx.Client, ra_deg: float, dec_deg: float, detector: str) -> list[Exposure]:
    """Query the archive for all exposures of ``detector`` covering (ra, dec); never cached.

    A 5xx answer or a transport error is retried after 0.5, 1 and 1.5 s, then every 2 s, as
    long as the attempt starts within 20 s and fits in the 45 s budget; any other failure
    raises ``DiscoveryError`` at once. The call returns or raises within 45 s plus the parsing
    time of one received chunk.
    """
    params = sia_params(ra_deg, dec_deg, detector)
    start = time.monotonic()
    for delay in (*_RETRY_DELAYS_S, None):
        try:
            with client.stream("GET", SIA_URL, params=params, timeout=_TIMEOUT) as response:
                if response.status_code == 200:
                    lines = _lines(response.iter_bytes(), start + _STREAM_END_S)
                    return parse_tsv(lines, detector)
                failure = DiscoveryError(f"The archive answered HTTP {response.status_code}.")
                if response.status_code < 500:
                    raise failure
        except httpx.TransportError as exc:
            failure = DiscoveryError(f"The archive could not be reached: {exc}.")
            failure.__cause__ = exc
        if delay is None or time.monotonic() + delay - start > _LAST_START_S:
            raise failure
        time.sleep(delay)
    raise AssertionError("unreachable")
