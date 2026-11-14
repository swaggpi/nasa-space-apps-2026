"""Tests of the frame builder: cache reuse, skipped exposures and per-exposure failures."""

import errno
import logging

import numpy as np
import pytest

import synthetic
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
