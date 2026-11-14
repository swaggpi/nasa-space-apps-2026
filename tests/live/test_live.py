"""Live checks against the IRSA TAP service and the public S3 bucket (row 34, opt-in)."""

import httpx
import numpy as np
import pytest

from spherex_viewer.discovery import discover
from spherex_viewer.grid import GRID_SHAPE, target_wcs
from spherex_viewer.remote import S3_BASE, HttpRangeReader, read_window, s3_url

pytestmark = pytest.mark.live

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
