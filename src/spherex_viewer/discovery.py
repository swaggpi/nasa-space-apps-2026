"""Discovery of SPHEREx spectral-image exposures covering a position via the IRSA TAP service."""

import csv
import io
import math
import re
import time
from dataclasses import dataclass

import httpx

TAP_URL = "https://irsa.ipac.caltech.edu/TAP/sync"
DETECTORS = ("D1", "D2", "D3", "D4", "D5", "D6")
URI_PATTERN = re.compile(r"^ibe/data/spherex/[a-z0-9]+/level2/[A-Za-z0-9_./-]+\.fits$")

_HEADER = ["uri", "time_bounds_lower"]
_ATTEMPTS = 2
_RETRY_DELAY_S = 2.0


@dataclass(frozen=True)
class Exposure:
    """One exposure: archive URI and start time (``plane.time_bounds_lower``, MJD UTC)."""

    uri: str
    mjd: float


class DiscoveryError(RuntimeError):
    """Raised when the archive query fails or returns an unexpected response."""


def is_valid_uri(uri: str) -> bool:
    """Return True if ``uri`` is a SPHEREx level-2 archive URI without a ``..`` segment."""
    return bool(URI_PATTERN.match(uri)) and ".." not in uri.split("/")


def build_adql(ra_deg: float, dec_deg: float, detector: str) -> str:
    """Return the ADQL query for all exposures of ``detector`` covering (ra, dec) in degrees."""
    if detector not in DETECTORS:
        raise ValueError(f"Unknown detector {detector!r}.")
    return (
        "SELECT a.uri, p.time_bounds_lower FROM spherex.artifact a JOIN spherex.plane p "
        "ON a.planeid = p.planeid WHERE 1 = CONTAINS(POINT('ICRS', "
        f"{float(ra_deg)!r}, {float(dec_deg)!r}), p.poly) "
        f"AND p.energy_bandpassname = 'SPHEREx-{detector}' ORDER BY p.time_bounds_lower"
    )


def parse_csv(text: str) -> list[Exposure]:
    """Parse the TAP CSV response into exposures sorted by MJD."""
    rows = [row for row in csv.reader(io.StringIO(text)) if row]
    if not rows or rows[0] != _HEADER:
        raise DiscoveryError("Unexpected header in the archive response.")
    exposures = []
    for row in rows[1:]:
        if len(row) != 2:
            raise DiscoveryError("Malformed row in the archive response.")
        uri, mjd_text = row
        try:
            mjd = float(mjd_text)
        except ValueError as exc:
            raise DiscoveryError("Malformed time in the archive response.") from exc
        if not math.isfinite(mjd):
            raise DiscoveryError("Malformed time in the archive response.")
        if not is_valid_uri(uri):
            raise DiscoveryError(f"Unexpected URI in the archive response: {uri!r}.")
        exposures.append(Exposure(uri=uri, mjd=mjd))
    exposures.sort(key=lambda e: e.mjd)
    return exposures


def discover(client: httpx.Client, ra_deg: float, dec_deg: float, detector: str) -> list[Exposure]:
    """Query the archive for all exposures of ``detector`` covering (ra, dec); never cached."""
    params = {"QUERY": build_adql(ra_deg, dec_deg, detector), "FORMAT": "CSV"}
    timeout = httpx.Timeout(
        connect=10.0, read=120.0, write=client.timeout.write, pool=client.timeout.pool
    )
    for attempt in range(_ATTEMPTS):
        last = attempt == _ATTEMPTS - 1
        try:
            response = client.get(TAP_URL, params=params, timeout=timeout)
        except httpx.TransportError as exc:
            if last:
                raise DiscoveryError(f"The archive could not be reached: {exc}.") from exc
        else:
            if response.status_code == 200:
                return parse_csv(response.text)
            if response.status_code < 500 or last:
                raise DiscoveryError(f"The archive answered HTTP {response.status_code}.")
        time.sleep(_RETRY_DELAY_S)
    raise AssertionError("unreachable")
