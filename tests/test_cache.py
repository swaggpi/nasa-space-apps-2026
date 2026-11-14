"""Tests for the on-disk cutout cache: round trip, corrupted files, size cap and eviction."""

import io
import logging
import os
import pickle
import threading
from pathlib import Path

import numpy as np
import pytest

from spherex_viewer.cache import CutoutCache

URI = "ibe/data/spherex/dr1/level2/2025W19_1B/l2b-v27-2026-197/3/level2_0116_1D3.fits"
RA, DEC = 133.795129, -7.245147
LARGE = 10**9


def _cutout(seed: int = 0) -> np.ndarray:
    data = np.random.default_rng(seed).normal(0.0, 0.02, (59, 59)).astype(np.float32)
    data[0, :] = np.nan
    data[30, 17] = np.nan
    return data


def _files(root):
    return sorted(p for p in root.rglob("*") if p.is_file())


def _uri(i: int) -> str:
    return URI.replace("0116", f"{i:04d}")


def _entry_size(tmp_path) -> int:
    probe = CutoutCache(tmp_path / "probe", LARGE)
    probe.put(URI, RA, DEC, _cutout())
    return probe.path(URI, RA, DEC).stat().st_size


def test_root_directory_is_created(tmp_path):
    root = tmp_path / "a" / "b"
    CutoutCache(root, LARGE)
    assert root.is_dir()


def test_existing_root_is_accepted(tmp_path):
    CutoutCache(tmp_path, LARGE)
    CutoutCache(tmp_path, LARGE)
    assert tmp_path.is_dir()


def test_root_under_regular_file_raises_os_error(tmp_path):
    blocker = tmp_path / "file"
    blocker.write_text("x")
    with pytest.raises(OSError):
        CutoutCache(blocker / "cache", LARGE)


def test_put_get_round_trip_including_nan(tmp_path):
    cache = CutoutCache(tmp_path / "a" / "b", LARGE)
    cutout = _cutout()
    cache.put(URI, RA, DEC, cutout)
    result = cache.get(URI, RA, DEC)
    assert result is not None
    assert result.dtype == np.float32
    assert result.shape == (59, 59)
    np.testing.assert_array_equal(result, cutout)


def test_float64_and_fortran_ordered_input_round_trip(tmp_path):
    cache = CutoutCache(tmp_path, LARGE)
    cutout = np.asfortranarray(_cutout().astype(np.float64))
    cache.put(URI, RA, DEC, cutout)
    np.testing.assert_array_equal(cache.get(URI, RA, DEC), cutout.astype(np.float32))


def test_all_nan_cutout_round_trips(tmp_path):
    cache = CutoutCache(tmp_path, LARGE)
    cutout = np.full((59, 59), np.nan, dtype=np.float32)
    cache.put(URI, RA, DEC, cutout)
    result = cache.get(URI, RA, DEC)
    assert result is not None
    assert np.isnan(result).all()


def test_put_leaves_no_temp_file(tmp_path):
    root = tmp_path / "a" / "b"
    cache = CutoutCache(root, LARGE)
    cache.put(URI, RA, DEC, _cutout())
    cache.put(URI, RA, DEC, _cutout())
    assert _files(root) == [cache.path(URI, RA, DEC)]


def test_get_missing_is_none(tmp_path):
    assert CutoutCache(tmp_path, LARGE).get(URI, RA, DEC) is None


def _npy(array: np.ndarray, allow_pickle: bool = False) -> bytes:
    buf = io.BytesIO()
    np.save(buf, array, allow_pickle=allow_pickle)
    return buf.getvalue()


def _npz() -> bytes:
    buf = io.BytesIO()
    np.savez(buf, a=_cutout())
    return buf.getvalue()


class Exploding:
    def __reduce__(self):
        return (os.system, ("exit 1",))


CORRUPTED = {
    "empty": b"",
    "garbage": b"not a numpy file",
    "truncated": _npy(_cutout())[:5000],
    "one byte short": _npy(_cutout())[:-1],
    "trailing byte": _npy(_cutout()) + b"\0",
    "zip archive": _npz(),
    "zip magic only": b"PK\x03\x04" + b"\0" * 100,
    "wrong shape": _npy(np.zeros((10, 10), np.float32)),
    "transposed shape": _npy(np.zeros((59, 58), np.float32)),
    "float64": _npy(_cutout().astype(np.float64)),
    "complex64": _npy(_cutout().astype(np.complex64)),
    "int32": _npy(np.zeros((59, 59), np.int32)),
    "big-endian float32": _npy(_cutout().astype(">f4")),
    "fortran order": _npy(np.asfortranarray(_cutout())),
    "pickled object array": _npy(np.array([Exploding()] * 3481, dtype=object).reshape(59, 59),
                                 allow_pickle=True),
    "plain pickle": pickle.dumps(_cutout()),
    "malformed header": _npy(_cutout()).replace(b"(59, 59)", b"(59, 59"),
    "huge declared shape": _npy(_cutout()).replace(b"(59, 59), }", b"(99999, 99999)}"),
}


@pytest.mark.parametrize("name", list(CORRUPTED))
def test_unexpected_file_is_a_miss(tmp_path, name, monkeypatch):
    monkeypatch.setattr(os, "system", lambda command: pytest.fail("unpickled"))
    cache = CutoutCache(tmp_path, LARGE)
    path = cache.path(URI, RA, DEC)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(CORRUPTED[name])
    assert cache.get(URI, RA, DEC) is None


def test_other_ra_uses_other_path(tmp_path):
    cache = CutoutCache(tmp_path, LARGE)
    cache.put(URI, RA, DEC, _cutout())
    other_ra = RA + 1e-6
    assert cache.path(URI, other_ra, DEC) != cache.path(URI, RA, DEC)
    assert cache.get(URI, other_ra, DEC) is None


def test_put_overwrites_existing_entry(tmp_path):
    cache = CutoutCache(tmp_path, LARGE)
    cache.put(URI, RA, DEC, _cutout())
    replacement = np.zeros((59, 59), dtype=np.float32)
    cache.put(URI, RA, DEC, replacement)
    np.testing.assert_array_equal(cache.get(URI, RA, DEC), replacement)


def _fill(cache: CutoutCache, indices) -> None:
    """Put one entry per index, each one second newer than the previous (by mtime)."""
    for i in indices:
        cache.put(_uri(i), RA, DEC, _cutout(i))
        os.utime(cache.path(_uri(i), RA, DEC), (1_000_000 + i, 1_000_000 + i))


def _total_size(root: Path) -> int:
    return sum(p.stat().st_size for p in _files(root))


def test_eviction_keeps_the_newest_entries_within_the_cap(tmp_path):
    size = _entry_size(tmp_path)
    root = tmp_path / "cache"
    cache = CutoutCache(root, int(5.5 * size))
    _fill(cache, range(5))
    assert _total_size(root) == 5 * size

    _fill(cache, [5])

    kept = [i for i in range(6) if cache.get(_uri(i), RA, DEC) is not None]
    assert kept == [2, 3, 4, 5]
    assert _total_size(root) <= 0.9 * 5.5 * size
    np.testing.assert_array_equal(cache.get(_uri(5), RA, DEC), _cutout(5))


def test_size_cap_holds_over_many_puts(tmp_path):
    size = _entry_size(tmp_path)
    root = tmp_path / "cache"
    cache = CutoutCache(root, 10 * size)
    for i in range(40):
        _fill(cache, [i])
        assert _total_size(root) <= 10 * size
    assert cache.get(_uri(39), RA, DEC) is not None
    assert cache.get(_uri(0), RA, DEC) is None


def test_existing_files_count_towards_the_cap(tmp_path):
    size = _entry_size(tmp_path)
    root = tmp_path / "cache"
    _fill(CutoutCache(root, LARGE), range(5))

    reopened = CutoutCache(root, int(5.5 * size))
    _fill(reopened, [5])

    assert [i for i in range(6) if reopened.get(_uri(i), RA, DEC) is not None] == [2, 3, 4, 5]


def test_overwriting_an_entry_does_not_count_twice(tmp_path):
    size = _entry_size(tmp_path)
    root = tmp_path / "cache"
    cache = CutoutCache(root, int(2.5 * size))
    _fill(cache, [0, 1])
    for _ in range(5):
        cache.put(_uri(1), RA, DEC, _cutout(1))
    assert cache.get(_uri(0), RA, DEC) is not None
    assert cache.get(_uri(1), RA, DEC) is not None


def test_concurrent_puts_of_the_same_key_are_safe(tmp_path):
    root = tmp_path / "cache"
    cache = CutoutCache(root, LARGE)
    errors = []

    def worker(seed: int) -> None:
        try:
            for _ in range(20):
                cache.put(URI, RA, DEC, _cutout(seed))
                assert cache.get(URI, RA, DEC) is not None
        except BaseException as exc:
            errors.append(exc)

    threads = [threading.Thread(target=worker, args=(seed,)) for seed in range(8)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()
    assert errors == []
    assert _files(root) == [cache.path(URI, RA, DEC)]
    assert any(np.array_equal(cache.get(URI, RA, DEC), _cutout(seed), equal_nan=True)
               for seed in range(8))


def test_eviction_error_is_logged_not_raised(tmp_path, monkeypatch, caplog):
    size = _entry_size(tmp_path)
    root = tmp_path / "cache"
    cache = CutoutCache(root, int(2.5 * size))
    _fill(cache, range(2))

    def refuse(self, missing_ok=False):
        raise PermissionError(13, "Permission denied")

    monkeypatch.setattr(Path, "unlink", refuse)
    with caplog.at_level(logging.WARNING, logger="spherex_viewer.cache"):
        _fill(cache, [2])
    assert "Permission denied" in caplog.text
    assert cache.get(_uri(2), RA, DEC) is not None


def test_eviction_and_size_count_skip_everything_outside_the_cache_layout(tmp_path):
    size = _entry_size(tmp_path)
    root = tmp_path / "cache"
    outside = tmp_path / "outside"
    outside.mkdir()
    foreign = [outside / "precious.npy", outside / "linked.npy", root / "lost+found" / "x.npy",
               root / "ab" / "notes.txt"]
    (root / "ab").mkdir(parents=True)
    (root / "lost+found").mkdir()
    for path in foreign:
        path.write_bytes(b"\0" * (3 * size))
        os.utime(path, (1, 1))
    (root / "cd").symlink_to(outside, target_is_directory=True)
    (root / "ab" / "link.npy").symlink_to(outside / "linked.npy")
    os.utime(root / "ab" / "link.npy", (1, 1), follow_symlinks=False)

    cache = CutoutCache(root, int(2.5 * size))
    _fill(cache, range(2))
    assert all(cache.get(_uri(i), RA, DEC) is not None for i in range(2))
    _fill(cache, [2])

    assert [i for i in range(3) if cache.get(_uri(i), RA, DEC) is not None] == [1, 2]
    assert all(path.stat().st_size == 3 * size for path in foreign)
    assert (root / "ab" / "link.npy").is_symlink()
    assert (root / "cd").is_symlink()


def _wide(seed: int = 0) -> np.ndarray:
    data = np.random.default_rng(seed).normal(0.0, 0.02, (177, 177)).astype(np.float32)
    data[:, :59] = np.nan
    return data


def test_narrow_key_is_unchanged(tmp_path):
    path = CutoutCache(tmp_path, LARGE).path(URI, RA, DEC)
    assert path.relative_to(tmp_path) == Path(
        "ca", "ca6bc093ee18ee8c0165cf8e2f959e5d9d66f5a41d483303fb05cbcef679a911.npy")
    assert CutoutCache(tmp_path, LARGE).path(URI, RA, DEC, 1) == path


def test_wide_and_narrow_entries_coexist(tmp_path):
    cache = CutoutCache(tmp_path, LARGE)
    cache.put(URI, RA, DEC, _cutout())
    cache.put(URI, RA, DEC, _wide(), 3)
    assert cache.path(URI, RA, DEC, 3) != cache.path(URI, RA, DEC)
    assert cache.path(URI, RA, DEC).stat().st_size == 14_052
    assert cache.path(URI, RA, DEC, 3).stat().st_size == 125_444
    np.testing.assert_array_equal(cache.get(URI, RA, DEC), _cutout())
    np.testing.assert_array_equal(cache.get(URI, RA, DEC, 3), _wide())


@pytest.mark.parametrize("content", [_npy(_cutout()), _npy(_wide())[:-1], _npy(_wide())[:5000],
                                     _npy(_wide()) + b"\0", _npy(_wide().astype(">f4"))])
def test_wide_get_accepts_only_a_wide_file(tmp_path, content):
    cache = CutoutCache(tmp_path, LARGE)
    path = cache.path(URI, RA, DEC, 3)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(content)
    assert cache.get(URI, RA, DEC, 3) is None


def test_narrow_get_rejects_a_wide_file(tmp_path):
    cache = CutoutCache(tmp_path, LARGE)
    path = cache.path(URI, RA, DEC)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(_npy(_wide()))
    assert cache.get(URI, RA, DEC) is None


@pytest.mark.parametrize(("shape", "fields"), [((177, 177), 1), ((59, 59), 3), ((177, 59), 3)])
def test_put_of_a_wrong_shape_raises(tmp_path, shape, fields):
    cache = CutoutCache(tmp_path, LARGE)
    with pytest.raises(ValueError):
        cache.put(URI, RA, DEC, np.zeros(shape, np.float32), fields)
    assert _files(tmp_path) == []


def test_eviction_holds_the_cap_with_mixed_sizes(tmp_path):
    root = tmp_path / "cache"
    cap = 3 * 125_444 + 4 * 14_052
    cache = CutoutCache(root, cap)
    for i in range(30):
        fields = 3 if i % 3 == 0 else 1
        cache.put(_uri(i), RA, DEC, _wide(i) if fields == 3 else _cutout(i), fields)
        os.utime(cache.path(_uri(i), RA, DEC, fields), (1_000_000 + i, 1_000_000 + i))
        assert _total_size(root) <= cap
    assert cache.get(_uri(29), RA, DEC) is not None
    assert cache.get(_uri(27), RA, DEC, 3) is not None
    assert cache.get(_uri(0), RA, DEC, 3) is None
