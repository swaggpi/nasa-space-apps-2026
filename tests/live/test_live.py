"""Live checks against the IRSA archive services and the public S3 bucket (opt-in: `pytest -m live`)."""

import csv
import io
import time
import warnings

import httpx
import numpy as np
import pytest
from astropy.wcs import WCS, FITSFixedWarning

from spherex_viewer import remote
from spherex_viewer.discovery import discover
from spherex_viewer.grid import GRID_SHAPE, target_wcs
from spherex_viewer.remote import S3_BASE, HttpRangeReader, read_window, s3_url
from synthetic import TIME_KEYS, assert_same_wcs

pytestmark = pytest.mark.live

TAP_URL = "https://irsa.ipac.caltech.edu/TAP/sync"

WISE_0855 = (133.795129, -7.245147)
DEEP_FIELD = (270.0, 66.56)


class RecordingReader:
    def __init__(self, inner: HttpRangeReader):
        self.inner = inner
        self.bytes_read = 0

    def read(self, url: str, start: int, stop: int) -> bytes:
        data = self.inner.read(url, start, stop)
        self.bytes_read += len(data)
        return data


@pytest.fixture(scope="module")
def statuses() -> list[int]:
    return []


@pytest.fixture(scope="module")
def client(statuses):
    def record(response: httpx.Response) -> None:
        if str(response.request.url).startswith(S3_BASE):
            statuses.append(response.status_code)

    with httpx.Client(event_hooks={"response": [record]}) as client:
        yield client


@pytest.fixture(scope="module")
def wise_exposures(client):
    return discover(client, *WISE_0855, "D2")


@pytest.fixture(scope="module")
def deep_field_exposures(client):
    return discover(client, *DEEP_FIELD, "D2")


def test_wise_0855_discovery_returns_sorted_rows(wise_exposures):
    assert len(wise_exposures) >= 48
    mjds = [e.mjd for e in wise_exposures]
    assert mjds == sorted(mjds)


def tap_exposures(client, ra_deg: float, dec_deg: float, detector: str) -> list[tuple[str, float]]:
    """Run the reference TAP query (a full table scan: 15 s to minutes) and return its rows.

    IRSA intermittently answers with a quick HTTP 502, so a 5xx is retried up to four times.
    """
    query = (
        "SELECT a.uri, p.time_bounds_lower FROM spherex.artifact a JOIN spherex.plane p "
        f"ON a.planeid = p.planeid WHERE 1 = CONTAINS(POINT('ICRS', {ra_deg!r}, {dec_deg!r}), "
        f"p.poly) AND p.energy_bandpassname = 'SPHEREx-{detector}' ORDER BY p.time_bounds_lower"
    )
    for _ in range(5):
        response = client.get(TAP_URL, params={"QUERY": query, "FORMAT": "CSV"}, timeout=300.0)
        if response.status_code < 500:
            break
        time.sleep(5.0)
    assert response.status_code == 200
    rows = list(csv.reader(io.StringIO(response.text)))
    assert rows[0] == ["uri", "time_bounds_lower"]
    return [(uri, float(mjd)) for uri, mjd in rows[1:]]


def test_discovery_matches_tap_query(client, wise_exposures):
    reference = tap_exposures(client, *WISE_0855, "D2")
    assert [e.uri for e in wise_exposures] == [uri for uri, _ in reference]
    assert max(abs(e.mjd - mjd) for e, (_, mjd) in zip(wise_exposures, reference)) < 1e-6


def check_window(client, statuses, uri: str, position: tuple[float, float]) -> None:
    statuses.clear()
    reader = RecordingReader(HttpRangeReader(client))
    window = read_window(reader, s3_url(uri), target_wcs(*position), GRID_SHAPE)

    assert statuses and all(status == 206 for status in statuses)
    assert reader.bytes_read < 2_000_000
    assert window is not None
    assert window.image.size > 0
    assert np.isfinite(window.image).mean() > 0.9


def test_dr1_window_read(client, statuses, wise_exposures):
    uri = next(e.uri for e in wise_exposures if e.uri.startswith("ibe/data/spherex/dr1/"))
    check_window(client, statuses, uri, WISE_0855)


def test_qr3_window_read(client, statuses, deep_field_exposures):
    uri = next(e.uri for e in deep_field_exposures if e.uri.startswith("ibe/data/spherex/qr3/"))
    check_window(client, statuses, uri, DEEP_FIELD)


@pytest.mark.parametrize("release", ["dr1", "qr3"])
def test_celestial_wcs_matches_full_wcs_on_real_headers(request, monkeypatch, client, release):
    exposures = request.getfixturevalue("wise_exposures" if release == "dr1"
                                        else "deep_field_exposures")
    uri = next(e.uri for e in exposures if e.uri.startswith(f"ibe/data/spherex/{release}/"))
    header, _ = remote._read_image_header(HttpRangeReader(client), s3_url(uri))
    with warnings.catch_warnings():
        warnings.simplefilter("ignore", FITSFixedWarning)
        full = WCS(header)
        received = []
        monkeypatch.setattr(remote, "WCS", lambda given: received.append(given) or WCS(given))
        reduced = remote.celestial_wcs(header)
    assert received and received[0] is not header
    assert all(remote._WCS_KEYWORD.fullmatch(card.keyword) for card in received[0].cards)
    assert_same_wcs(reduced, full, size=2040, step=40)
    written = full.to_header(relax=True)
    assert [key for key in written
            if key not in TIME_KEYS and not remote._WCS_KEYWORD.fullmatch(key)] == []
