"""Tests of the HTTP API (rows 6, 26-29)."""

import json
from datetime import UTC, datetime, timedelta

import numpy as np
import pytest
from fastapi.testclient import TestClient

import synthetic
from spherex_viewer.app import create_app
from spherex_viewer.discovery import DiscoveryError, Exposure
from spherex_viewer.remote import s3_url

PIX_DEG = 6.15 / 3600
RA, DEC = 150.0, 20.0
STAR_NE = (RA + 8 * PIX_DEG / np.cos(np.radians(DEC)), DEC + 8 * PIX_DEG)
DETECTOR_CENTRE = (RA, DEC + 30 * PIX_DEG)
ROTATIONS = (0.0, 7.0, -12.0)

SEARCH_KEYS = {"ra_deg", "dec_deg", "detector", "width", "height", "n_exposures", "cap", "capped",
               "frames"}
FRAME_PLAN_KEYS = {"index", "label", "mjd_start", "mjd_end", "n_available", "n_used", "capped",
                   "uris"}
FRAME_KEYS = {"width", "height", "pixels", "n_used", "n_failed"}


def make_uri(i: int) -> str:
    return (
        "ibe/data/spherex/dr1/level2/2025W19_1B/l2b-v27-2026-197/2/"
        f"level2_2025W19_1B_{i:04d}_1D2_spx_l2b-v27-2026-197.fits"
    )


def mjd_date(mjd: float) -> str:
    return (datetime(1858, 11, 17, tzinfo=UTC) + timedelta(days=mjd)).date().isoformat()


def strict_json(text: str):
    def reject(token):
        raise AssertionError(f"invalid JSON constant {token}")

    return json.loads(text, parse_constant=reject)


def no_discovery(ra_deg: float, dec_deg: float, detector: str) -> list[Exposure]:
    raise AssertionError("discover must not be called")


class CountingDiscover:
    def __init__(self, exposures: list[Exposure] | None = None, error: Exception | None = None):
        self.exposures = exposures or []
        self.error = error
        self.calls: list[tuple[float, float, str]] = []

    def __call__(self, ra_deg: float, dec_deg: float, detector: str) -> list[Exposure]:
        self.calls.append((ra_deg, dec_deg, detector))
        if self.error is not None:
            raise self.error
        return list(self.exposures)


BIG_BIN = [Exposure(make_uri(i), 60801.1 + 0.005 * i) for i in range(300)]
SMALL_BIN = [Exposure(make_uri(300 + i), 61000.2 + 0.05 * i) for i in range(5)]


@pytest.fixture(scope="module")
def blobs() -> dict[str, bytes]:
    return {
        s3_url(make_uri(i)): synthetic.make_exposure(
            DETECTOR_CENTRE, STAR_NE, n=100, rot_deg=rot, seed=10 + i
        )
        for i, rot in enumerate(ROTATIONS)
    }


def make_client(tmp_path, blobs=None, discover=no_discovery):
    reader = synthetic.FakeRangeReader(blobs or {})
    app = create_app(cache_dir=tmp_path / "cache", reader=reader, discover=discover)
    return TestClient(app), reader


def test_each_search_queries_discovery_again(tmp_path):
    discover = CountingDiscover(SMALL_BIN)
    client, _ = make_client(tmp_path, discover=discover)
    with client:
        for _ in range(2):
            assert client.get("/api/search", params={"ra": "150", "dec": "20"}).status_code == 200
    assert len(discover.calls) == 2


def test_search_response_schema_and_cap_fields(tmp_path):
    discover = CountingDiscover(BIG_BIN + SMALL_BIN)
    client, reader = make_client(tmp_path, discover=discover)
    with client:
        response = client.get("/api/search", params={"ra": "08h55m10.831s", "dec": "-7d14m42.53s"})

    assert response.status_code == 200
    body = strict_json(response.text)
    assert set(body) == SEARCH_KEYS
    assert body["ra_deg"] == pytest.approx(133.795129, abs=1e-6)
    assert body["dec_deg"] == pytest.approx(-7.245147, abs=1e-6)
    assert body["detector"] == "D2"
    assert (body["width"], body["height"]) == (59, 59)
    assert body["n_exposures"] == 305
    assert body["cap"] == 24
    assert body["capped"] is True
    assert len(discover.calls) == 1
    ra_called, dec_called, detector_called = discover.calls[0]
    assert ra_called == pytest.approx(133.795129, abs=1e-6)
    assert dec_called == pytest.approx(-7.245147, abs=1e-6)
    assert detector_called == "D2"
    assert reader.calls == []

    big, small = body["frames"]
    for frame in (big, small):
        assert set(frame) == FRAME_PLAN_KEYS

    assert big["index"] == 0
    assert big["n_available"] == 300
    assert big["n_used"] == 24
    assert big["capped"] is True
    assert len(big["uris"]) == 24
    assert len(set(big["uris"])) == 24
    assert big["uris"][0] == BIG_BIN[0].uri
    assert big["uris"][-1] == BIG_BIN[-1].uri
    order = {e.uri: i for i, e in enumerate(BIG_BIN)}
    positions = [order[u] for u in big["uris"]]
    assert positions == sorted(positions)
    assert big["mjd_start"] == pytest.approx(BIG_BIN[0].mjd)
    assert big["mjd_end"] == pytest.approx(BIG_BIN[-1].mjd)
    assert big["label"] == "2025-05-06 – 2025-05-07"
    assert big["label"] == f"{mjd_date(BIG_BIN[0].mjd)} – {mjd_date(BIG_BIN[-1].mjd)}"

    assert small["index"] == 1
    assert small["n_available"] == 5
    assert small["n_used"] == 5
    assert small["capped"] is False
    assert small["uris"] == [e.uri for e in SMALL_BIN]
    assert small["mjd_start"] == pytest.approx(SMALL_BIN[0].mjd)
    assert small["mjd_end"] == pytest.approx(SMALL_BIN[-1].mjd)
    assert small["label"] == "2025-11-21"


def test_search_passes_chosen_detector(tmp_path):
    discover = CountingDiscover(SMALL_BIN)
    client, _ = make_client(tmp_path, discover=discover)
    with client:
        response = client.get("/api/search", params={"ra": "150", "dec": "20", "detector": "D4"})
    assert response.status_code == 200
    body = response.json()
    assert body["detector"] == "D4"
    assert body["capped"] is False
    assert body["frames"][0]["capped"] is False
    assert discover.calls[0][2] == "D4"


def test_search_without_exposures_returns_empty_frames(tmp_path):
    client, _ = make_client(tmp_path, discover=CountingDiscover([]))
    with client:
        response = client.get("/api/search", params={"ra": "150", "dec": "20"})
    assert response.status_code == 200
    body = response.json()
    assert set(body) == SEARCH_KEYS
    assert body["frames"] == []
    assert body["n_exposures"] == 0
    assert body["capped"] is False


@pytest.mark.parametrize(
    "params",
    [
        {"ra": "abc", "dec": "20"},
        {"ra": "", "dec": "20"},
        {"ra": "25h0m0s", "dec": "20"},
        {"ra": "360", "dec": "20"},
        {"ra": "150", "dec": "91"},
        {"ra": "150", "dec": "5h"},
        {"ra": "150", "dec": "20", "detector": "D7"},
        {"dec": "20"},
        {"ra": "150"},
    ],
)
def test_search_rejects_bad_input_with_422(tmp_path, params):
    client, _ = make_client(tmp_path, discover=CountingDiscover(SMALL_BIN))
    with client:
        response = client.get("/api/search", params=params)
    assert response.status_code == 422
    assert "detail" in response.json()


def test_search_discovery_error_gives_502(tmp_path):
    discover = CountingDiscover(error=DiscoveryError("TAP service failed"))
    client, _ = make_client(tmp_path, discover=discover)
    with client:
        response = client.get("/api/search", params={"ra": "150", "dec": "20"})
    assert response.status_code == 502
    assert isinstance(response.json()["detail"], str)


def test_frame_is_north_up_east_left_with_null_for_no_data(tmp_path, blobs):
    client, _ = make_client(tmp_path, blobs)
    payload = {"ra_deg": RA, "dec_deg": DEC, "uris": [make_uri(i) for i in range(len(ROTATIONS))]}
    with client:
        response = client.post("/api/frame", json=payload)

    assert response.status_code == 200
    assert "NaN" not in response.text
    body = strict_json(response.text)
    assert set(body) == FRAME_KEYS
    assert (body["width"], body["height"]) == (59, 59)
    assert (body["n_used"], body["n_failed"]) == (3, 0)
    pixels = body["pixels"]
    assert len(pixels) == 3481
    assert all(p is None or isinstance(p, float | int) for p in pixels)

    image = np.array([np.nan if p is None else p for p in pixels], dtype=float).reshape(59, 59)
    row, col = np.unravel_index(np.nanargmax(image), image.shape)
    assert row < 29 and col < 29
    assert all(p is None for p in pixels[-59:])
    assert all(p is not None for p in pixels[:59])
    assert abs(np.nanmedian(image)) < 0.05


def test_frame_rejects_too_many_uris(tmp_path):
    client, reader = make_client(tmp_path)
    payload = {"ra_deg": RA, "dec_deg": DEC, "uris": [make_uri(i) for i in range(25)]}
    with client:
        response = client.post("/api/frame", json=payload)
    assert response.status_code == 422
    assert reader.calls == []


@pytest.mark.parametrize(
    "bad_uri",
    [
        "ibe/data/spherex/dr1/level2/../../secret/x.fits",
        "https://example.org/level2/x.fits",
        "ibe/data/spherex/dr1/level2/x.txt",
    ],
)
def test_frame_rejects_invalid_uri(tmp_path, blobs, bad_uri):
    client, reader = make_client(tmp_path, blobs)
    payload = {"ra_deg": RA, "dec_deg": DEC, "uris": [make_uri(0), bad_uri]}
    with client:
        response = client.post("/api/frame", json=payload)
    assert response.status_code == 422
    assert reader.calls == []


def test_frame_rejects_empty_uri_list(tmp_path):
    client, _ = make_client(tmp_path)
    with client:
        response = client.post("/api/frame", json={"ra_deg": RA, "dec_deg": DEC, "uris": []})
    assert response.status_code == 422


@pytest.mark.parametrize("ra_deg, dec_deg", [(360.0, DEC), (-1.0, DEC), (RA, 91.0), (RA, -90.5)])
def test_frame_rejects_out_of_range_coordinates(tmp_path, ra_deg, dec_deg):
    client, reader = make_client(tmp_path)
    payload = {"ra_deg": ra_deg, "dec_deg": dec_deg, "uris": [make_uri(0)]}
    with client:
        response = client.post("/api/frame", json=payload)
    assert response.status_code == 422
    assert reader.calls == []


def test_frame_with_all_exposures_failing_gives_502(tmp_path):
    client, _ = make_client(tmp_path)
    payload = {"ra_deg": RA, "dec_deg": DEC, "uris": [make_uri(0), make_uri(1)]}
    with client:
        response = client.post("/api/frame", json=payload)
    assert response.status_code == 502
    assert isinstance(response.json()["detail"], str)


def test_healthz_after_startup(tmp_path):
    client, _ = make_client(tmp_path)
    with client:
        response = client.get("/healthz")
    assert response.status_code == 200
    assert response.json() == {"status": "ok"}


def test_cache_dir_from_environment_is_created_at_startup(tmp_path, monkeypatch):
    cache_dir = tmp_path / "x" / "y"
    monkeypatch.setenv("SPHEREX_CACHE_DIR", str(cache_dir))
    app = create_app(reader=synthetic.FakeRangeReader({}), discover=no_discovery)
    assert not cache_dir.exists()
    with TestClient(app) as client:
        assert cache_dir.is_dir()
        assert client.get("/healthz").status_code == 200


def test_startup_fails_when_cache_dir_cannot_be_created(tmp_path):
    blocker = tmp_path / "file"
    blocker.write_text("not a directory")
    app = create_app(
        cache_dir=blocker / "cutouts", reader=synthetic.FakeRangeReader({}), discover=no_discovery
    )
    with pytest.raises(OSError):
        with TestClient(app):
            pass
