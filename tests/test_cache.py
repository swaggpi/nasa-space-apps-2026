"""Tests for the on-disk cutout cache (DESIGN.md sections 3 and 5.9; test-plan row 23)."""

import hashlib

import numpy as np
import pytest

from spherex_viewer.cache import CutoutCache
from spherex_viewer.cutout import CUTOUT_VERSION

URI = "ibe/data/spherex/dr1/level2/2025W19_1B/l2b-v27-2026-197/3/level2_0116_1D3.fits"
RA, DEC = 133.795129, -7.245147


def _cutout() -> np.ndarray:
    data = np.random.default_rng(0).normal(0.0, 0.02, (59, 59)).astype(np.float32)
    data[0, :] = np.nan
    data[30, 17] = np.nan
    return data


def _files(root):
    return sorted(p for p in root.rglob("*") if p.is_file())


def test_root_directory_is_created(tmp_path):
    root = tmp_path / "a" / "b"
    CutoutCache(root)
    assert root.is_dir()


def test_existing_root_is_accepted(tmp_path):
    CutoutCache(tmp_path)
    CutoutCache(tmp_path)
    assert tmp_path.is_dir()


def test_root_under_regular_file_raises_os_error(tmp_path):
    blocker = tmp_path / "file"
    blocker.write_text("x")
    with pytest.raises(OSError):
        CutoutCache(blocker / "cache")


def test_path_layout_and_key(tmp_path):
    root = tmp_path / "a" / "b"
    cache = CutoutCache(root)
    key = hashlib.sha256(f"v{CUTOUT_VERSION}|{URI}|{RA!r}|{DEC!r}".encode()).hexdigest()
    assert cache.path(URI, RA, DEC) == root / key[:2] / f"{key}.npy"


def test_put_get_round_trip_including_nan(tmp_path):
    cache = CutoutCache(tmp_path / "a" / "b")
    cutout = _cutout()
    cache.put(URI, RA, DEC, cutout)
    result = cache.get(URI, RA, DEC)
    assert result is not None
    assert result.dtype == np.float32
    assert result.shape == (59, 59)
    np.testing.assert_array_equal(result, cutout)


def test_all_nan_cutout_round_trips(tmp_path):
    cache = CutoutCache(tmp_path)
    cutout = np.full((59, 59), np.nan, dtype=np.float32)
    cache.put(URI, RA, DEC, cutout)
    result = cache.get(URI, RA, DEC)
    assert result is not None
    assert np.isnan(result).all()


def test_put_writes_npy_file_of_14052_bytes(tmp_path):
    cache = CutoutCache(tmp_path)
    cache.put(URI, RA, DEC, _cutout())
    path = cache.path(URI, RA, DEC)
    assert path.stat().st_size == 14052
    np.testing.assert_array_equal(np.load(path), _cutout())


def test_put_leaves_no_temp_file(tmp_path):
    root = tmp_path / "a" / "b"
    cache = CutoutCache(root)
    cache.put(URI, RA, DEC, _cutout())
    cache.put(URI, RA, DEC, _cutout())
    assert _files(root) == [cache.path(URI, RA, DEC)]


def test_get_missing_is_none(tmp_path):
    assert CutoutCache(tmp_path).get(URI, RA, DEC) is None


def test_get_truncated_file_is_none(tmp_path):
    cache = CutoutCache(tmp_path)
    cache.put(URI, RA, DEC, _cutout())
    path = cache.path(URI, RA, DEC)
    path.write_bytes(path.read_bytes()[:5000])
    assert cache.get(URI, RA, DEC) is None


def test_get_garbage_file_is_none(tmp_path):
    cache = CutoutCache(tmp_path)
    path = cache.path(URI, RA, DEC)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(b"not a numpy file")
    assert cache.get(URI, RA, DEC) is None


def test_get_wrong_shape_file_is_none(tmp_path):
    cache = CutoutCache(tmp_path)
    path = cache.path(URI, RA, DEC)
    path.parent.mkdir(parents=True, exist_ok=True)
    np.save(path, np.zeros((10, 10), dtype=np.float32))
    assert cache.get(URI, RA, DEC) is None


def test_other_ra_uses_other_path(tmp_path):
    cache = CutoutCache(tmp_path)
    cache.put(URI, RA, DEC, _cutout())
    other_ra = RA + 1e-6
    assert cache.path(URI, other_ra, DEC) != cache.path(URI, RA, DEC)
    assert cache.get(URI, other_ra, DEC) is None


def test_put_overwrites_existing_entry(tmp_path):
    cache = CutoutCache(tmp_path)
    cache.put(URI, RA, DEC, _cutout())
    replacement = np.zeros((59, 59), dtype=np.float32)
    cache.put(URI, RA, DEC, replacement)
    np.testing.assert_array_equal(cache.get(URI, RA, DEC), replacement)
