"""Tests of the frame builder: cache reuse and per-exposure failure handling (rows 24-25)."""

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


def make_uri(i: int) -> str:
    return (
        "ibe/data/spherex/dr1/level2/2025W19_1B/l2b-v27-2026-197/2/"
        f"level2_2025W19_1B_{i:04d}_1D2_spx_l2b-v27-2026-197.fits"
    )


@pytest.fixture(scope="module")
def blobs() -> dict[str, bytes]:
    return {
        s3_url(make_uri(i)): synthetic.make_exposure((RA, DEC), STAR, n=100, rot_deg=rot, seed=i)
        for i, rot in enumerate(ROTATIONS)
    }


@pytest.fixture
def builder_and_reader(tmp_path, blobs):
    reader = synthetic.FakeRangeReader(blobs)
    builder = FrameBuilder(reader, CutoutCache(tmp_path / "cache"))
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


def test_all_exposures_missing_raises_frame_error(builder_and_reader):
    builder, _ = builder_and_reader
    with pytest.raises(FrameError):
        builder.build([make_uri(900), make_uri(901)], RA, DEC)
