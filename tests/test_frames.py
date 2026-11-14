"""Tests of the frame builder: cache reuse, skipped exposures and per-exposure failures."""

import errno
import logging
import threading
import time

import numpy as np
import pytest

import synthetic
from spherex_viewer import frames
from spherex_viewer.cache import CutoutCache
from spherex_viewer.frames import FrameBuilder, FrameError
from spherex_viewer.grid import GRID_SHAPE
from spherex_viewer.remote import s3_url

RA, DEC = 150.0, 20.0
STAR = (RA + 5 * 6.15 / 3600 / np.cos(np.radians(DEC)), DEC + 4 * 6.15 / 3600)
ROTATIONS = (0.0, 37.0, -80.0, 201.0, 12.0)
FAR, CORRUPT, ALL_BAD = 100, 200, 300


def make_uri(i: int) -> str:
    return (
        "ibe/data/spherex/dr1/level2/2025W19_1B/l2b-v27-2026-197/2/"
        f"level2_2025W19_1B_{i:04d}_1D2_spx_l2b-v27-2026-197.fits"
    )


@pytest.fixture(scope="module")
def blobs() -> dict[str, bytes]:
    blobs = {
        s3_url(make_uri(i)): synthetic.make_exposure((RA, DEC), STAR, n=100, rot_deg=rot, seed=i)
        for i, rot in enumerate(ROTATIONS)
    }
    blobs[s3_url(make_uri(FAR))] = synthetic.make_exposure(
        (RA + 3.0, DEC), STAR, n=100, rot_deg=0.0, seed=FAR)
    blobs[s3_url(make_uri(CORRUPT))] = synthetic.corrupt_flags_heap(blobs[s3_url(make_uri(0))])
    every_pixel = [(x, y, 10) for y in range(100) for x in range(100)]
    blobs[s3_url(make_uri(ALL_BAD))] = synthetic.make_exposure(
        (RA, DEC), STAR, n=100, rot_deg=0.0, bad=every_pixel, seed=ALL_BAD)
    return blobs


@pytest.fixture(scope="module")
def twelve_blobs() -> dict[str, bytes]:
    return {
        s3_url(make_uri(i)): synthetic.make_exposure((RA, DEC), STAR, n=100, rot_deg=0.0, seed=i)
        for i in range(12)
    }


class BlockingReader:
    """Serves ``blobs``, holding every read until ``release`` is set; records entered URLs."""

    def __init__(self, blobs: dict[str, bytes]) -> None:
        self._inner = synthetic.FakeRangeReader(blobs)
        self.release = threading.Event()
        self.entered: set[str] = set()
        self._lock = threading.Lock()

    def read(self, url: str, start: int, stop: int) -> bytes:
        with self._lock:
            self.entered.add(url)
        self.release.wait(10)
        return self._inner.read(url, start, stop)


@pytest.fixture
def cache(tmp_path) -> CutoutCache:
    return CutoutCache(tmp_path / "cache", 10**8)


@pytest.fixture
def builder_and_reader(cache, blobs):
    reader = synthetic.FakeRangeReader(blobs)
    builder = FrameBuilder(reader, cache)
    yield builder, reader
    builder.close()


def test_second_build_reads_nothing_and_returns_identical_data(builder_and_reader):
    builder, reader = builder_and_reader
    uris = [make_uri(i) for i in range(len(ROTATIONS))]

    first = builder.build(uris, RA, DEC)
    calls_after_first = len(reader.calls)
    second = builder.build(uris, RA, DEC)

    assert calls_after_first > 0
    assert len(reader.calls) == calls_after_first
    assert first.data.shape == GRID_SHAPE
    assert first.data.dtype == np.float32
    assert np.isfinite(first.data).any()
    assert (first.n_used, first.n_failed) == (5, 0)
    assert (second.n_used, second.n_failed) == (5, 0)
    np.testing.assert_array_equal(second.data, first.data)


def test_missing_exposure_is_counted_and_frame_still_built(builder_and_reader):
    builder, _ = builder_and_reader
    uris = [make_uri(i) for i in range(4)] + [make_uri(999)]

    result = builder.build(uris, RA, DEC)

    assert result.n_failed == 1
    assert result.n_used == 4
    assert result.data.shape == GRID_SHAPE
    assert np.isfinite(result.data).any()


def test_malformed_exposure_is_skipped_and_counted(builder_and_reader):
    builder, _ = builder_and_reader
    clean = builder.build([make_uri(i) for i in range(1, 4)], RA, DEC)
    result = builder.build([make_uri(i) for i in range(1, 4)] + [make_uri(CORRUPT)], RA, DEC)
    assert (result.n_used, result.n_failed) == (3, 1)
    np.testing.assert_array_equal(result.data, clean.data)


def test_exposure_off_the_grid_is_neither_used_nor_cached(builder_and_reader, cache):
    builder, _ = builder_and_reader
    result = builder.build([make_uri(0), make_uri(FAR)], RA, DEC)
    assert (result.n_used, result.n_failed) == (1, 0)
    assert cache.path(make_uri(0), RA, DEC).is_file()
    assert not cache.path(make_uri(FAR), RA, DEC).exists()


def test_exposure_without_valid_pixel_is_not_used(builder_and_reader):
    builder, _ = builder_and_reader
    result = builder.build([make_uri(0), make_uri(ALL_BAD)], RA, DEC)
    assert (result.n_used, result.n_failed) == (1, 0)


@pytest.mark.parametrize("uris", [[make_uri(FAR)], [make_uri(ALL_BAD), make_uri(FAR)]])
def test_frame_without_valid_pixel_raises_frame_error(builder_and_reader, uris):
    builder, _ = builder_and_reader
    with pytest.raises(FrameError):
        builder.build(uris, RA, DEC)


def test_all_exposures_missing_raises_frame_error(builder_and_reader):
    builder, _ = builder_and_reader
    with pytest.raises(FrameError):
        builder.build([make_uri(900), make_uri(901)], RA, DEC)


def test_failed_cache_write_does_not_fail_the_frame(builder_and_reader, cache, monkeypatch,
                                                    caplog):
    builder, _ = builder_and_reader

    def disk_full(*args):
        raise OSError(errno.ENOSPC, "No space left on device")

    monkeypatch.setattr(cache, "put", disk_full)
    with caplog.at_level(logging.WARNING, logger="spherex_viewer.frames"):
        result = builder.build([make_uri(i) for i in range(3)], RA, DEC)
    assert (result.n_used, result.n_failed) == (3, 0)
    assert np.isfinite(result.data).any()
    assert "No space left on device" in caplog.text
    assert all(len(record.getMessage()) < 100 for record in caplog.records)


def test_stalled_reads_fail_the_frame_at_the_deadline(cache, twelve_blobs, monkeypatch):
    reader = BlockingReader(twelve_blobs)
    builder = FrameBuilder(reader, cache)
    uris = [make_uri(i) for i in range(12)]
    try:
        monkeypatch.setattr(frames, "FRAME_BUILD_S", 0.3)
        started = time.monotonic()
        with pytest.raises(FrameError):
            builder.build(uris, RA, DEC)
        assert time.monotonic() - started < 1.0
        assert len(reader.entered) <= frames.MAX_WORKERS
        reader.release.set()
        monkeypatch.setattr(frames, "FRAME_BUILD_S", 30.0)
        result = builder.build(uris, RA, DEC)
    finally:
        reader.release.set()
        builder.close()
    assert (result.n_used, result.n_failed) == (12, 0)


def test_exposure_started_after_the_deadline_fails_the_frame(tmp_path, monkeypatch):
    monkeypatch.setattr(frames, "MAX_WORKERS", 2)
    uris = [make_uri(i) for i in range(3)]
    inner = synthetic.FakeRangeReader(
        {s3_url(uri): synthetic.make_exposure((RA, DEC), STAR, n=100, rot_deg=0.0, seed=i)
         for i, uri in enumerate(uris)})
    real_clock = time.monotonic
    offset = [0.0]
    monkeypatch.setattr(frames.time, "monotonic", lambda: real_clock() + offset[0])
    first_may_finish = threading.Event()

    class Reader:
        def read(self, url, start, stop):
            if url == s3_url(uris[0]) and start == 0:
                first_may_finish.wait(10)      # begun before the deadline, finishes after it
            return inner.read(url, start, stop)

    cache = CutoutCache(tmp_path, 10**8)
    put = cache.put

    def put_then_pass_the_deadline(uri, *args):
        put(uri, *args)
        if uri == uris[1]:                     # the third exposure starts next, and is refused
            offset[0] = 1000.0
            threading.Timer(0.3, first_may_finish.set).start()

    monkeypatch.setattr(cache, "put", put_then_pass_the_deadline)
    builder = FrameBuilder(Reader(), cache)
    try:
        with pytest.raises(FrameError):
            builder.build(uris, RA, DEC)
    finally:
        builder.close()
    assert cache.get(uris[0], RA, DEC) is not None
    assert cache.get(uris[1], RA, DEC) is not None
    assert cache.get(uris[2], RA, DEC) is None


def test_pool_reads_eight_exposures_at_once(cache, twelve_blobs):
    reader = BlockingReader(twelve_blobs)
    builder = FrameBuilder(reader, cache)
    outcome = []
    worker = threading.Thread(
        target=lambda: outcome.append(builder.build([make_uri(i) for i in range(12)], RA, DEC)))
    try:
        worker.start()
        waited_until = time.monotonic() + 5.0
        while len(reader.entered) < 8 and time.monotonic() < waited_until:
            time.sleep(0.01)
        time.sleep(0.2)
        entered = len(reader.entered)
    finally:
        reader.release.set()
        worker.join()
        builder.close()
    assert entered == 8
    assert (outcome[0].n_used, outcome[0].n_failed) == (12, 0)
