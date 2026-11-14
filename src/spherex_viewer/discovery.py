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
_COLUMNS = ("access_url", "energy_bandpassname", "t_min")
# IRSA's gateway answers a share of requests (up to 40 % measured) with an immediate HTTP 502,
# independently from one request to the next; a retry is only started within the window, so a
# stalled connection is not waited for repeatedly.
_RETRY_DELAYS_S = (1.0, 2.0, 3.0, 4.0)
_RETRY_WINDOW_S = 30.0


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


def _lines(chunks: Iterable[bytes]) -> Iterator[bytes]:
    """Split a byte stream into lines; DiscoveryError once it exceeds MAX_RESPONSE_BYTES."""
    total, buffer = 0, bytearray()
    for chunk in chunks:
        total += len(chunk)
        if total > MAX_RESPONSE_BYTES:
            raise DiscoveryError("The archive response is too large.")
        start, scan = 0, len(buffer)
        buffer += chunk
        while (end := buffer.find(b"\n", scan)) >= 0:
            yield bytes(buffer[start:end])
            start = scan = end + 1
        del buffer[:start]
    if buffer:
        yield bytes(buffer)


def parse_tsv(lines: Iterable[bytes], detector: str) -> list[Exposure]:
    """Parse the SIA TSV response into the exposures of ``detector``, sorted by MJD."""
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
        url, bandpass, mjd_text = (fields[i] for i in index)
        if bandpass != band:
            continue
        try:
            mjd = float(mjd_text)
        except ValueError as exc:
            raise DiscoveryError("Malformed time in the archive response.") from exc
        if not math.isfinite(mjd):
            raise DiscoveryError("Malformed time in the archive response.")
        uri = url.removeprefix(ARCHIVE_PREFIX)
        if uri == url or not is_valid_uri(uri):
            raise DiscoveryError(f"Unexpected URI in the archive response: {url!r}.")
        exposures.append(Exposure(uri=uri, mjd=mjd))
    if header is None:
        raise DiscoveryError("Unexpected header in the archive response.")
    exposures.sort(key=lambda e: e.mjd)
    return exposures


def discover(client: httpx.Client, ra_deg: float, dec_deg: float, detector: str) -> list[Exposure]:
    """Query the archive for all exposures of ``detector`` covering (ra, dec); never cached.

    A 5xx answer or a transport error is retried after 1, 2, 3 and 4 s while the retry would
    start within 30 s of the first request; any other failure raises ``DiscoveryError`` at once.
    """
    params = sia_params(ra_deg, dec_deg, detector)
    timeout = httpx.Timeout(
        connect=10.0, read=60.0, write=client.timeout.write, pool=client.timeout.pool
    )
    deadline = time.monotonic() + _RETRY_WINDOW_S
    for delay in (*_RETRY_DELAYS_S, None):
        try:
            with client.stream("GET", SIA_URL, params=params, timeout=timeout) as response:
                if response.status_code == 200:
                    return parse_tsv(_lines(response.iter_bytes()), detector)
                failure = DiscoveryError(f"The archive answered HTTP {response.status_code}.")
                if response.status_code < 500:
                    raise failure
        except httpx.TransportError as exc:
            failure = DiscoveryError(f"The archive could not be reached: {exc}.")
            failure.__cause__ = exc
        if delay is None or time.monotonic() + delay > deadline:
            raise failure
        time.sleep(delay)
    raise AssertionError("unreachable")
