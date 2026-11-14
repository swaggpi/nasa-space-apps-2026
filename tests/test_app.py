"""Tests of the HTTP API: schema, validation, errors, limits, concurrency and rate limiting."""

import asyncio
import base64
import json
import threading
import time
from datetime import UTC, datetime, timedelta
from pathlib import Path
from types import SimpleNamespace

import anyio.to_thread
import numpy as np
import pytest
from fastapi.testclient import TestClient

import synthetic
from spherex_viewer import app as app_module
from spherex_viewer.app import (
    BODY_TIMEOUT,
    BODY_TOO_LARGE,
    FRAME_FAILED,
    INVALID_DEC,
    INVALID_RA,
    INVALID_REQUEST,
    MAX_COORD_LENGTH,
    MAX_BODY_BYTES,
    MAX_CONCURRENT_FRAMES,
    MAX_CONCURRENT_SEARCHES,
    SEARCH_FAILED,
    SERVER_BUSY,
    BodyLimit,
    check_rate,
    create_app,
)
from spherex_viewer.cache import CutoutCache
from spherex_viewer.discovery import DiscoveryError, Exposure
from spherex_viewer.frames import FrameBuilder, FrameResult
from spherex_viewer.ratelimit import RateLimiter
from spherex_viewer.remote import s3_url

PIX_DEG = 6.15 / 3600
RA, DEC = 150.0, 20.0
STAR_NE = (RA + 8 * PIX_DEG / np.cos(np.radians(DEC)), DEC + 8 * PIX_DEG)
DETECTOR_CENTRE = (RA, DEC + 30 * PIX_DEG)
ROTATIONS = (0.0, 7.0, -12.0)
WAIT_S = 5.0

SEARCH_KEYS = {"ra_deg", "dec_deg", "detector", "n_exposures", "cap", "capped", "frames"}
FRAME_PLAN_KEYS = {"label", "n_available", "n_used", "capped", "uris"}
FRAME_KEYS = {"width", "height", "pixels", "n_used"}
WIDE_KEYS = {"width", "height", "pixels_b64", "n_used", "n_fields"}


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


class Gate:
    """Blocks callers until opened; counts how many have entered."""

    def __init__(self) -> None:
        self.opened = threading.Event()
        self.entered = threading.Semaphore(0)
        self.lock = threading.Lock()
        self.count = 0

    def block(self) -> None:
        with self.lock:
            self.count += 1
        self.entered.release()
        self.opened.wait(timeout=WAIT_S)

    def wait_entered(self, n: int) -> None:
        for _ in range(n):
            assert self.entered.acquire(timeout=WAIT_S), "callers did not arrive"


class BlockingDiscover(Gate):
    def __call__(self, ra_deg: float, dec_deg: float, detector: str) -> list[Exposure]:
        self.block()
        return list(SMALL_BIN)


class BlockingReader(Gate):
    def __init__(self, inner: synthetic.FakeRangeReader) -> None:
        super().__init__()
        self.inner = inner

    def read(self, url: str, start: int, stop: int) -> bytes:
        self.block()
        return self.inner.read(url, start, stop)


def in_thread(call):
    """Run `call` in a daemon thread; return the thread and a dict that receives its result."""
    result = {}
    thread = threading.Thread(target=lambda: result.setdefault("response", call()), daemon=True)
    thread.start()
    return thread, result


def finished(thread: threading.Thread, result: dict, timeout: float = WAIT_S):
    thread.join(timeout)
    assert not thread.is_alive(), "request did not finish"
    return result["response"]


def limit_worker_threads(client: TestClient, n: int) -> None:
    def set_limit() -> None:
        anyio.to_thread.current_default_thread_limiter().total_tokens = n

    client.portal.call(set_limit)


BIG_BIN = [Exposure(make_uri(i), 60801.1 + 0.005 * i) for i in range(300)]
SMALL_BIN = [Exposure(make_uri(300 + i), 61000.2 + 0.05 * i) for i in range(5)]
SEARCH = {"ra": "150", "dec": "20"}


@pytest.fixture(scope="module")
def blobs() -> dict[str, bytes]:
    return {
        s3_url(make_uri(i)): synthetic.make_exposure(
            DETECTOR_CENTRE, STAR_NE, n=100, rot_deg=rot, seed=10 + i
        )
        for i, rot in enumerate(ROTATIONS)
    }


def make_client(tmp_path, blobs=None, discover=no_discovery, reader=None):
    reader = reader or synthetic.FakeRangeReader(blobs or {})
    app = create_app(cache_dir=tmp_path / "cache", reader=reader, discover=discover)
    return TestClient(app), reader


def frame_payload(uris: list[str]) -> dict:
    return {"ra_deg": RA, "dec_deg": DEC, "uris": uris}


def test_each_search_queries_discovery_again(tmp_path):
    discover = CountingDiscover(SMALL_BIN)
    client, _ = make_client(tmp_path, discover=discover)
    with client:
        for _ in range(2):
            assert client.get("/api/search", params=SEARCH).status_code == 200
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
    assert big["label"] == "2025-05-06 – 2025-05-07"
    assert big["label"] == f"{mjd_date(BIG_BIN[0].mjd)} – {mjd_date(BIG_BIN[-1].mjd)}"

    assert small["n_available"] == 5
    assert small["n_used"] == 5
    assert small["capped"] is False
    assert small["uris"] == [e.uri for e in SMALL_BIN]
    assert small["label"] == "2025-11-21"


def test_search_passes_chosen_detector(tmp_path):
    discover = CountingDiscover(SMALL_BIN)
    client, _ = make_client(tmp_path, discover=discover)
    with client:
        response = client.get("/api/search", params={**SEARCH, "detector": "D4"})
    assert response.status_code == 200
    body = response.json()
    assert body["detector"] == "D4"
    assert body["capped"] is False
    assert body["frames"][0]["capped"] is False
    assert discover.calls[0][2] == "D4"


def test_search_without_exposures_returns_empty_frames(tmp_path):
    client, _ = make_client(tmp_path, discover=CountingDiscover([]))
    with client:
        response = client.get("/api/search", params=SEARCH)
    assert response.status_code == 200
    body = response.json()
    assert set(body) == SEARCH_KEYS
    assert body["frames"] == []
    assert body["n_exposures"] == 0
    assert body["capped"] is False


@pytest.mark.parametrize(
    "params",
    [
        {"ra": "abc<b>", "dec": "20"},
        {"ra": "", "dec": "20"},
        {"ra": "25h0m0s", "dec": "20"},
        {"ra": "360", "dec": "20"},
        {"ra": "150", "dec": "91"},
        {"ra": "150", "dec": "5h"},
        {"ra": "150", "dec": "20", "detector": "D7<b>"},
        {"dec": "20"},
        {"ra": "150"},
    ],
)
def test_search_rejects_bad_input_with_fixed_422(tmp_path, params):
    discover = CountingDiscover(SMALL_BIN)
    client, _ = make_client(tmp_path, discover=discover)
    with client:
        response = client.get("/api/search", params=params)
    assert response.status_code == 422
    body = response.json()
    assert set(body) == {"detail"} and isinstance(body["detail"], str)
    assert "<b>" not in response.text
    assert discover.calls == []


@pytest.mark.parametrize(("field", "detail"), [("ra", INVALID_RA), ("dec", INVALID_DEC)],
                         ids=["ra", "dec"])
def test_search_rejects_over_long_coordinate_without_parsing(tmp_path, monkeypatch, field,
                                                             detail):
    parsed = []

    def recording(parse):
        def wrapper(text):
            parsed.append(text)
            return parse(text)
        return wrapper

    monkeypatch.setattr(app_module, "parse_ra", recording(app_module.parse_ra))
    monkeypatch.setattr(app_module, "parse_dec", recording(app_module.parse_dec))
    discover = CountingDiscover(SMALL_BIN)
    client, _ = make_client(tmp_path, discover=discover)
    long_value = "1" * 60000 + ("h" if field == "ra" else "d")
    with client:
        start = time.monotonic()
        response = client.get("/api/search", params={**SEARCH, field: long_value})
        elapsed = time.monotonic() - start
    assert response.status_code == 422
    assert response.json() == {"detail": detail}
    assert long_value not in parsed
    assert all(len(text) <= MAX_COORD_LENGTH for text in parsed)
    assert elapsed < 1.0
    assert discover.calls == []


def test_search_accepts_30_character_sexagesimal(tmp_path):
    ra, dec = "08h55m10.831" + "0" * 17 + "s", "-7d14m42.53" + "0" * 18 + "s"
    assert len(ra) == len(dec) == 30
    discover = CountingDiscover(SMALL_BIN)
    client, _ = make_client(tmp_path, discover=discover)
    with client:
        response = client.get("/api/search", params={"ra": ra, "dec": dec})
    assert response.status_code == 200
    body = response.json()
    assert body["ra_deg"] == pytest.approx(133.795129, abs=1e-6)
    assert body["dec_deg"] == pytest.approx(-7.245147, abs=1e-6)


def test_search_discovery_error_gives_generic_502(tmp_path):
    cause = "The archive could not be reached: [Errno 111] Connection refused."
    client, _ = make_client(tmp_path, discover=CountingDiscover(error=DiscoveryError(cause)))
    with client:
        response = client.get("/api/search", params=SEARCH)
    assert response.status_code == 502
    assert response.json() == {"detail": SEARCH_FAILED}


def test_frame_is_north_up_east_left_with_null_for_no_data(tmp_path, blobs):
    client, _ = make_client(tmp_path, blobs)
    with client:
        response = client.post("/api/frame",
                               json=frame_payload([make_uri(i) for i in range(len(ROTATIONS))]))

    assert response.status_code == 200
    assert "NaN" not in response.text
    body = strict_json(response.text)
    assert set(body) == FRAME_KEYS
    assert (body["width"], body["height"]) == (59, 59)
    assert body["n_used"] == 3
    pixels = body["pixels"]
    assert len(pixels) == 3481
    assert all(p is None or isinstance(p, float | int) for p in pixels)

    image = np.array([np.nan if p is None else p for p in pixels], dtype=float).reshape(59, 59)
    row, col = np.unravel_index(np.nanargmax(image), image.shape)
    assert row < 29 and col < 29
    assert all(p is None for p in pixels[-59:])
    assert all(p is not None for p in pixels[:59])
    assert abs(np.nanmedian(image)) < 0.05


def test_frame_builds_duplicate_uris_once(tmp_path, blobs):
    single, single_reader = make_client(tmp_path / "a", blobs)
    with single:
        assert single.post("/api/frame", json=frame_payload([make_uri(0)])).status_code == 200
    client, reader = make_client(tmp_path / "b", blobs)
    with client:
        response = client.post("/api/frame", json=frame_payload([make_uri(0)] * 24))
    assert response.status_code == 200
    assert response.json()["n_used"] == 1
    assert reader.calls == single_reader.calls


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
    with client:
        response = client.post("/api/frame", json=frame_payload([make_uri(0), bad_uri]))
    assert response.status_code == 422
    assert bad_uri not in response.text
    assert reader.calls == []


LONG_URI = "ibe/data/spherex/dr1/level2/" + "a" * (301 - len("ibe/data/spherex/dr1/level2/.fits"))
LONG_URI += ".fits"


@pytest.mark.parametrize(
    "raw",
    [
        '{"ra_deg": "\\ud800", "dec_deg": 20.0, "uris": ["x"]}',
        '{"ra_deg": "150", "dec_deg": 20.0, "uris": ["%s"]}' % make_uri(0),
        '{"ra_deg": true, "dec_deg": 20.0, "uris": ["%s"]}' % make_uri(0),
        '{"ra_deg": 150.0, "dec_deg": false, "uris": ["%s"]}' % make_uri(0),
        '{"ra_deg": NaN, "dec_deg": 20.0, "uris": ["%s"]}' % make_uri(0),
        '{"ra_deg": 360.0, "dec_deg": 20.0, "uris": ["%s"]}' % make_uri(0),
        '{"ra_deg": -1.0, "dec_deg": 20.0, "uris": ["%s"]}' % make_uri(0),
        '{"ra_deg": 150.0, "dec_deg": 91.0, "uris": ["%s"]}' % make_uri(0),
        '{"ra_deg": 150.0, "dec_deg": -90.5, "uris": ["%s"]}' % make_uri(0),
        '{"ra_deg": 150.0, "dec_deg": 20.0, "uris": []}',
        '{"ra_deg": 150.0, "dec_deg": 20.0, "uris": "%s"}' % make_uri(0),
        '{"ra_deg": 150.0, "dec_deg": 20.0, "uris": [7]}',
        '{"ra_deg": 150.0, "dec_deg": 20.0, "uris": ["%s"]}' % LONG_URI,
        '{"ra_deg": 150.0, "dec_deg": 20.0, "uris": [%s]}'
        % ", ".join(f'"{make_uri(i)}"' for i in range(25)),
        '{"ra_deg": 150.0, "uris": ["%s"]}' % make_uri(0),
        '{"ra_deg": 150.0, "dec_deg": 20.0, "uris": ["x"]',
    ],
)
def test_frame_validation_errors_are_fixed_form(tmp_path, raw):
    client, reader = make_client(tmp_path)
    with client:
        response = client.post("/api/frame", content=raw.encode(),
                               headers={"content-type": "application/json"})
    assert response.status_code == 422
    assert response.json() == {"detail": INVALID_REQUEST}
    assert reader.calls == []


def test_frame_accepts_integer_coordinates(tmp_path, blobs):
    client, _ = make_client(tmp_path, blobs)
    with client:
        response = client.post("/api/frame", json={"ra_deg": 150, "dec_deg": 20,
                                                   "uris": [make_uri(0)]})
    assert response.status_code == 200


def test_frame_with_all_exposures_failing_gives_generic_502(tmp_path):
    client, _ = make_client(tmp_path)
    with client:
        response = client.post("/api/frame", json=frame_payload([make_uri(0), make_uri(1)]))
    assert response.status_code == 502
    assert response.json() == {"detail": FRAME_FAILED}


@pytest.mark.parametrize("chunked", [False, True])
def test_oversized_body_gives_413(tmp_path, chunked):
    client, reader = make_client(tmp_path)
    raw = json.dumps(frame_payload([make_uri(0)] + ["x" * MAX_BODY_BYTES])).encode()
    content = iter([raw]) if chunked else raw
    with client:
        response = client.post("/api/frame", content=content,
                               headers={"content-type": "application/json"})
    assert response.status_code == 413
    assert response.json() == {"detail": BODY_TOO_LARGE}
    assert reader.calls == []


def run_body_limit(messages: list[dict], headers: list[tuple[bytes, bytes]]):
    """Drive `BodyLimit` around a recording app; return (inner calls, sent messages)."""
    seen = []
    sent = []

    async def inner(scope, receive, send):
        seen.append(await receive())

    async def receive():
        return messages.pop(0) if messages else {"type": "http.disconnect"}

    async def send(message):
        sent.append(message)

    scope = {"type": "http", "method": "POST", "path": "/api/frame", "headers": headers}
    asyncio.run(BodyLimit(inner, max_bytes=10)(scope, receive, send))
    return seen, sent


def test_body_limit_rejects_chunked_body_before_the_app_runs():
    chunks = [{"type": "http.request", "body": b"123456", "more_body": True},
              {"type": "http.request", "body": b"78901", "more_body": True},
              {"type": "http.request", "body": b"", "more_body": False}]
    seen, sent = run_body_limit(chunks, [])
    assert seen == []
    assert sent[0]["status"] == 413


def test_body_limit_rejects_large_content_length_without_reading():
    messages = [{"type": "http.request", "body": b"x" * 11, "more_body": False}]
    seen, sent = run_body_limit(messages, [(b"content-length", b"11")])
    assert seen == []
    assert sent[0]["status"] == 413
    assert len(messages) == 1


def test_body_limit_answers_408_and_skips_the_app_when_the_body_stalls():
    seen = []
    sent = []
    messages = [{"type": "http.request", "body": b"12345", "more_body": True}]

    async def inner(scope, receive, send):
        seen.append(await receive())

    async def stalling_receive():
        if messages:
            return messages.pop(0)
        await asyncio.Event().wait()

    scope = {"type": "http", "method": "POST", "path": "/api/frame",
             "headers": [(b"content-length", b"10")]}
    limited = BodyLimit(inner, max_bytes=10, read_s=0.05)
    asyncio.run(asyncio.wait_for(limited(scope, stalling_receive, sent_to(sent)), 2.0))
    assert seen == []
    assert sent[0]["status"] == 408
    assert (b"connection", b"close") in sent[0]["headers"]
    assert json.loads(sent[1]["body"]) == {"detail": BODY_TIMEOUT}


def sent_to(sent: list):
    async def send(message):
        sent.append(message)

    return send


def test_dockerfile_command_limits_concurrency():
    dockerfile = (Path(__file__).parents[1] / "Dockerfile").read_text()
    command = json.loads(next(line for line in dockerfile.splitlines()
                              if line.startswith("CMD "))[4:])
    assert command[command.index("--limit-concurrency") + 1] == "100"


def test_body_limit_passes_body_at_the_limit_in_one_message():
    chunks = [{"type": "http.request", "body": b"12345", "more_body": True},
              {"type": "http.request", "body": b"67890", "more_body": False}]
    seen, sent = run_body_limit(chunks, [(b"content-length", b"10")])
    assert seen == [{"type": "http.request", "body": b"1234567890", "more_body": False}]
    assert sent == []


@pytest.mark.parametrize("path", ["/docs", "/redoc", "/openapi.json", "/docs/oauth2-redirect"])
def test_framework_docs_routes_do_not_exist(tmp_path, path):
    client, _ = make_client(tmp_path)
    with client:
        assert client.get(path).status_code == 404


def test_healthz_after_startup(tmp_path):
    client, _ = make_client(tmp_path)
    with client:
        response = client.get("/healthz")
    assert response.status_code == 200
    assert response.json() == {"status": "ok"}


def run_while_busy(gate: Gate, held: list, extra) -> tuple[bool, int, object, list]:
    """With `held` requests blocked in `gate`, send `extra`; return whether it answered within
    a second, the gate count at that moment, its response and the held responses."""
    try:
        gate.wait_entered(len(held))
        thread, result = in_thread(extra)
        thread.join(1.0)
        prompt, count = not thread.is_alive(), gate.count
    finally:
        gate.opened.set()
    return prompt, count, finished(thread, result), [finished(*h) for h in held]


def test_healthz_answers_while_searches_hold_every_worker_thread(tmp_path):
    discover = BlockingDiscover()
    client, _ = make_client(tmp_path, discover=discover)
    with client:
        limit_worker_threads(client, MAX_CONCURRENT_SEARCHES)
        searches = [in_thread(lambda: client.get("/api/search", params=SEARCH))
                    for _ in range(MAX_CONCURRENT_SEARCHES)]
        prompt, _, health, held = run_while_busy(discover, searches,
                                                 lambda: client.get("/healthz"))
    assert prompt
    assert health.status_code == 200
    assert [r.status_code for r in held] == [200] * MAX_CONCURRENT_SEARCHES


def test_waiting_searches_hold_no_worker_thread(tmp_path):
    discover = BlockingDiscover()
    client, _ = make_client(tmp_path, discover=discover)
    waiting = []

    def page_while_searches_wait():
        waiting.extend(in_thread(lambda: client.get("/api/search", params=SEARCH))
                       for _ in range(5))
        slots = client.app.state.search_slots
        deadline = time.monotonic() + WAIT_S
        while len(slots._waiters or ()) < 5 and time.monotonic() < deadline:
            time.sleep(0.01)
        return client.get("/")

    with client:
        limit_worker_threads(client, MAX_CONCURRENT_SEARCHES + 1)
        searches = [in_thread(lambda: client.get("/api/search", params=SEARCH))
                    for _ in range(MAX_CONCURRENT_SEARCHES)]
        prompt, _, page, held = run_while_busy(discover, searches, page_while_searches_wait)
        held += [finished(*w) for w in waiting]
    assert prompt
    assert page.status_code == 200
    assert [r.status_code for r in held] == [200] * (MAX_CONCURRENT_SEARCHES + 5)


def test_search_gives_503_when_all_slots_stay_busy(tmp_path, monkeypatch):
    monkeypatch.setattr(app_module, "SEARCH_WAIT_S", 0.05)
    discover = BlockingDiscover()
    client, _ = make_client(tmp_path, discover=discover)
    with client:
        searches = [in_thread(lambda: client.get("/api/search", params=SEARCH))
                    for _ in range(MAX_CONCURRENT_SEARCHES)]
        prompt, count, busy, held = run_while_busy(
            discover, searches, lambda: client.get("/api/search", params=SEARCH))
    assert prompt
    assert busy.status_code == 503
    assert busy.json() == {"detail": SERVER_BUSY}
    assert count == MAX_CONCURRENT_SEARCHES
    assert [r.status_code for r in held] == [200] * MAX_CONCURRENT_SEARCHES


def test_frame_gives_503_when_all_build_slots_stay_busy(tmp_path, blobs, monkeypatch):
    monkeypatch.setattr(app_module, "FRAME_WAIT_S", 0.05)
    reader = BlockingReader(synthetic.FakeRangeReader(blobs))
    client, _ = make_client(tmp_path, reader=reader)
    uris = [make_uri(i) for i in range(len(ROTATIONS))] + [make_uri(7)]
    assert len(uris) == MAX_CONCURRENT_FRAMES
    with client:
        frames = [in_thread(lambda uri=uri: client.post("/api/frame", json=frame_payload([uri])))
                  for uri in uris]
        prompt, count, busy, held = run_while_busy(
            reader, frames, lambda: client.post("/api/frame", json=frame_payload([make_uri(8)])))
    assert prompt
    assert busy.status_code == 503
    assert busy.json() == {"detail": SERVER_BUSY}
    assert count == MAX_CONCURRENT_FRAMES
    assert [r.status_code for r in held] == [200, 200, 200, 502]


def test_search_rate_limit_gives_429_with_retry_after(tmp_path, blobs):
    client, _ = make_client(tmp_path, blobs, discover=CountingDiscover(SMALL_BIN))
    with client:
        statuses = [client.get("/api/search", params=SEARCH).status_code for _ in range(10)]
        limited = client.get("/api/search", params=SEARCH)
        frame = client.post("/api/frame", json=frame_payload([make_uri(0)]))
        health = [client.get("/healthz").status_code for _ in range(30)]
    assert statuses == [200] * 10
    assert limited.status_code == 429
    assert limited.headers["retry-after"] == "30"
    assert limited.json() == {"detail": "Too many requests. Try again in 30 s."}
    assert frame.status_code == 200
    assert health == [200] * 30


def test_frame_rate_limit_gives_429_with_retry_after(tmp_path):
    client, _ = make_client(tmp_path, discover=CountingDiscover(SMALL_BIN))
    payload = frame_payload(["ibe/data/spherex/dr1/level2/x.txt"])
    with client:
        statuses = {client.post("/api/frame", json=payload).status_code for _ in range(60)}
        limited = client.post("/api/frame", json=payload)
        search = client.get("/api/search", params=SEARCH)
    assert statuses == {422}
    assert limited.status_code == 429
    assert limited.headers["retry-after"] == "10"
    assert search.status_code == 200


class RecordingCache:
    def __init__(self, root, max_bytes):
        RecordingCache.max_bytes = max_bytes

    def get(self, uri, ra_deg, dec_deg):
        return None


@pytest.mark.parametrize("value, expected", [(None, 1024 * 2**20), ("2", 2 * 2**20),
                                             (" 0.5 ", 2**19)])
def test_cache_cap_from_environment(tmp_path, monkeypatch, value, expected):
    if value is None:
        monkeypatch.delenv("SPHEREX_CACHE_MAX_MB", raising=False)
    else:
        monkeypatch.setenv("SPHEREX_CACHE_MAX_MB", value)
    monkeypatch.setattr(app_module, "CutoutCache", RecordingCache)
    client, _ = make_client(tmp_path)
    with client:
        assert client.get("/healthz").status_code == 200
    assert RecordingCache.max_bytes == expected


@pytest.mark.parametrize("value", ["abc", "0", "-5", "nan", "inf", "1e400"])
def test_invalid_cache_cap_fails_at_startup(tmp_path, monkeypatch, value):
    monkeypatch.setenv("SPHEREX_CACHE_MAX_MB", value)
    with pytest.raises(ValueError, match="SPHEREX_CACHE_MAX_MB"):
        create_app(cache_dir=tmp_path, reader=synthetic.FakeRangeReader({}),
                   discover=no_discovery)


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


def test_invalid_searches_do_not_use_the_search_budget(tmp_path):
    client, _ = make_client(tmp_path, discover=CountingDiscover(SMALL_BIN))
    invalid = [{"ra": "abc", "dec": "20"}, {"ra": "150", "dec": "91"},
               {"ra": "150", "dec": "20", "detector": "D7"}]
    with client:
        rejected = [client.get("/api/search", params=invalid[i % 3]).status_code
                    for i in range(12)]
        accepted = [client.get("/api/search", params=SEARCH).status_code for _ in range(10)]
        limited = client.get("/api/search", params=SEARCH)
    assert rejected == [422] * 12
    assert accepted == [200] * 10
    assert limited.status_code == 429


def run_disconnected(client: TestClient, method: str, path: str, query: bytes = b"",
                     body: bytes = b"") -> list[dict]:
    """Send one request straight to the ASGI app from a client that is gone after its body."""
    messages = [{"type": "http.request", "body": body, "more_body": False}]
    sent: list[dict] = []

    async def receive():
        return messages.pop(0) if messages else {"type": "http.disconnect"}

    scope = {
        "type": "http", "asgi": {"version": "3.0"}, "http_version": "1.1", "method": method,
        "scheme": "http", "path": path, "raw_path": path.encode(), "query_string": query,
        "root_path": "", "client": ("127.0.0.1", 50000), "server": ("testserver", 80),
        "headers": [(b"host", b"testserver"), (b"content-type", b"application/json"),
                    (b"content-length", str(len(body)).encode())],
    }
    client.portal.call(client.app, scope, receive, sent_to(sent))
    return sent


def test_disconnected_search_does_not_query_the_archive_and_frees_its_slot(tmp_path):
    discover = CountingDiscover(SMALL_BIN)
    client, _ = make_client(tmp_path, discover=discover)
    with client:
        run_disconnected(client, "GET", "/api/search", b"ra=150&dec=20")
        assert discover.calls == []
        assert client.app.state.search_slots._value == MAX_CONCURRENT_SEARCHES
        assert client.get("/api/search", params=SEARCH).status_code == 200
    assert len(discover.calls) == 1


def test_disconnected_frame_reads_nothing_and_frees_its_slot(tmp_path, blobs):
    client, reader = make_client(tmp_path, blobs)
    body = json.dumps(frame_payload([make_uri(0)])).encode()
    with client:
        run_disconnected(client, "POST", "/api/frame", body=body)
        assert reader.calls == []
        assert client.app.state.frame_slots._value == MAX_CONCURRENT_FRAMES
        assert client.post("/api/frame", json=frame_payload([make_uri(0)])).status_code == 200


def rate_request(host: str | None):
    return SimpleNamespace(client=None if host is None else SimpleNamespace(host=host))


@pytest.mark.parametrize(
    ("first", "second", "shared"),
    [
        ("203.0.113.7", "203.0.113.7", True),
        ("203.0.113.7", "203.0.113.8", False),
        ("2001:db8:1:2::1", "2001:db8:1:2:ffff:ffff:ffff:fffe", True),
        ("2001:db8:1:2::1", "2001:db8:1:3::1", False),
        ("not an address", "x" * 16384, True),
        ("unix-socket", None, True),
    ],
)
def test_rate_limit_key_is_the_client_address_or_ipv6_network(first, second, shared):
    limiter = RateLimiter(1, 1.0)
    check_rate(limiter, rate_request(first))
    if shared:
        with pytest.raises(app_module.HTTPException) as exc:
            check_rate(limiter, rate_request(second))
        assert exc.value.status_code == 429
    else:
        check_rate(limiter, rate_request(second))


def test_long_client_string_is_not_stored_as_a_key():
    limiter = RateLimiter(10, 1.0)
    check_rate(limiter, rate_request("x" * 16384))
    assert all(len(key) <= 24 for key in limiter._buckets)


def wide_payload(uris: list[str]) -> dict:
    return frame_payload(uris) | {"fields": 3}


def decode_wide(body: dict) -> np.ndarray:
    raw = base64.b64decode(body["pixels_b64"], validate=True)
    return np.frombuffer(raw, dtype="<f4").reshape(body["height"], body["width"])


def test_default_and_explicit_one_field_answer_exactly_as_before(tmp_path, blobs):
    client, _ = make_client(tmp_path, blobs)
    uris = [make_uri(i) for i in range(len(ROTATIONS))]
    with client:
        default = client.post("/api/frame", json=frame_payload(uris))
        explicit = client.post("/api/frame", json=frame_payload(uris) | {"fields": 1})
    assert default.status_code == explicit.status_code == 200
    assert set(default.json()) == FRAME_KEYS
    assert explicit.content == default.content


def test_wide_frame_is_base64_float32_north_up_with_field_counts(tmp_path, blobs):
    uris = [make_uri(i) for i in range(len(ROTATIONS))]
    client, _ = make_client(tmp_path / "app", blobs)
    with client:
        response = client.post("/api/frame", json=wide_payload(uris))
    builder = FrameBuilder(synthetic.FakeRangeReader(blobs), CutoutCache(tmp_path / "b", 10**8))
    try:
        built = builder.build(uris, RA, DEC, 3)
    finally:
        builder.close()
    assert response.status_code == 200
    body = strict_json(response.text)
    assert set(body) == WIDE_KEYS
    assert (body["width"], body["height"]) == (177, 177)
    assert len(body["pixels_b64"]) == 167_088
    pixels = decode_wide(body)
    assert np.array_equal(pixels, built.data[::-1, :], equal_nan=True)
    assert np.isnan(pixels).any() and np.isfinite(pixels).any()
    assert np.isnan(pixels[-1, :]).all() and np.isfinite(pixels[0, :]).any()
    assert body["n_fields"] == list(built.n_fields) and len(body["n_fields"]) == 9
    assert body["n_fields"][4] == body["n_used"] == 3
    assert body["n_fields"][3:] == [3, 3, 3, 0, 0, 0]


@pytest.mark.parametrize("fields", ["2", "0", '"3"', "null", "[3]", "-3", "9"])
def test_invalid_fields_gives_the_fixed_422(tmp_path, fields):
    client, reader = make_client(tmp_path)
    raw = '{"ra_deg": 150.0, "dec_deg": 20.0, "uris": ["%s"], "fields": %s}' % (make_uri(0),
                                                                              fields)
    with client:
        response = client.post("/api/frame", content=raw.encode(),
                               headers={"content-type": "application/json"})
    assert response.status_code == 422
    assert response.json() == {"detail": INVALID_REQUEST}
    assert reader.calls == []


def test_wide_frames_have_their_own_rate_limit(tmp_path, blobs):
    client, _ = make_client(tmp_path, blobs)
    bad = ["ibe/data/spherex/dr1/level2/x.txt"]
    with client:
        narrow = {client.post("/api/frame", json=frame_payload(bad)).status_code
                  for _ in range(60)}
        wide_after_narrow = client.post("/api/frame", json=wide_payload([make_uri(0)]))
        wide = {client.post("/api/frame", json=wide_payload(bad)).status_code for _ in range(39)}
        limited = client.post("/api/frame", json=wide_payload([make_uri(0)]))
    assert narrow == {422} and wide == {422}
    assert wide_after_narrow.status_code == 200
    assert limited.status_code == 429
    assert limited.headers["retry-after"] == "10"
    assert limited.json() == {"detail": "Too many requests. Try again in 10 s."}

    client, _ = make_client(tmp_path / "second", blobs)
    with client:
        wide = {client.post("/api/frame", json=wide_payload(bad)).status_code for _ in range(40)}
        limited = client.post("/api/frame", json=wide_payload([make_uri(0)]))
        narrow = client.post("/api/frame", json=frame_payload([make_uri(0)]))
    assert wide == {422}
    assert limited.status_code == 429 and limited.headers["retry-after"] == "10"
    assert narrow.status_code == 200


class GatedBuilder(Gate):
    """Fake builder: wide builds wait for the gate; records the most wide builds at once."""

    def __init__(self) -> None:
        super().__init__()
        self.running = 0
        self.most = 0
        self.narrow = 0
        self.count_lock = threading.Lock()

    def build(self, uris, ra_deg, dec_deg, fields=1):
        if fields == 1:
            with self.count_lock:
                self.narrow += 1
            return FrameResult(np.zeros((59, 59), np.float32), 1, 0, (1,))
        with self.count_lock:
            self.running += 1
            self.most = max(self.most, self.running)
        try:
            self.block()
        finally:
            with self.count_lock:
                self.running -= 1
        return FrameResult(np.zeros((177, 177), np.float32), 1, 0, (1,) * 9)


def test_one_wide_build_at_a_time_beside_narrow_builds(tmp_path):
    client, _ = make_client(tmp_path)
    builder = GatedBuilder()
    with client:
        client.app.state.builder = builder
        first = in_thread(lambda: client.post("/api/frame", json=wide_payload([make_uri(0)])))
        builder.wait_entered(1)
        second = in_thread(lambda: client.post("/api/frame", json=wide_payload([make_uri(1)])))
        time.sleep(0.3)
        entered_while_first_ran = builder.count
        narrow = client.post("/api/frame", json=frame_payload([make_uri(2)]))
        builder.opened.set()
        responses = [finished(*first), finished(*second)]
    assert entered_while_first_ran == 1
    assert narrow.status_code == 200 and builder.narrow == 1
    assert [r.status_code for r in responses] == [200, 200]
    assert builder.count == 2 and builder.most == 1


def test_waiting_wide_frame_gives_503_when_the_wide_slot_stays_busy(tmp_path, monkeypatch):
    monkeypatch.setattr(app_module, "FRAME_WAIT_S", 0.2)
    client, _ = make_client(tmp_path)
    builder = GatedBuilder()
    with client:
        client.app.state.builder = builder
        first = in_thread(lambda: client.post("/api/frame", json=wide_payload([make_uri(0)])))
        builder.wait_entered(1)
        busy = client.post("/api/frame", json=wide_payload([make_uri(1)]))
        builder.opened.set()
        held = finished(*first)
    assert busy.status_code == 503
    assert busy.json() == {"detail": SERVER_BUSY}
    assert held.status_code == 200
    assert builder.count == 1


def test_oversized_wide_request_gives_413(tmp_path):
    client, reader = make_client(tmp_path)
    raw = json.dumps(wide_payload([make_uri(0), "x" * 65 * 1024])).encode()
    assert len(raw) > MAX_BODY_BYTES
    with client:
        response = client.post("/api/frame", content=raw,
                               headers={"content-type": "application/json"})
    assert response.status_code == 413
    assert response.json() == {"detail": BODY_TOO_LARGE}
    assert reader.calls == []
