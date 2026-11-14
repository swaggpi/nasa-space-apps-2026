"""Tests of the shipped homepage example ``static/example.json`` (scripts/build_example.py)."""

import json
import math
from importlib.resources import files
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

import synthetic
from spherex_viewer.app import create_app

STATIC_DIR = Path(str(files("spherex_viewer") / "static"))
EXAMPLE = STATIC_DIR / "example.json"
FIELDS = {"name", "hint", "ra_deg", "dec_deg", "detector", "width", "height", "frames"}
FRAME_FIELDS = {"label", "n_used", "pixels"}
# Three 59x59 frames at 4 significant digits are about 85 kB; the page loads this file on
# every visit, so it must stay well below what a phone downloads without noticing.
MAX_BYTES = 200_000


@pytest.fixture(scope="module")
def example() -> dict:
    return json.loads(EXAMPLE.read_text(encoding="utf-8"))


def test_schema_fields(example):
    assert set(example) == FIELDS
    assert isinstance(example["name"], str) and example["name"].strip()
    assert isinstance(example["hint"], str) and example["hint"].strip()
    assert example["detector"] in {"D1", "D2", "D3", "D4", "D5", "D6"}
    assert 0 <= example["ra_deg"] < 360 and -90 <= example["dec_deg"] <= 90
    assert (example["width"], example["height"]) == (59, 59)
    for frame in example["frames"]:
        assert set(frame) in (FRAME_FIELDS, FRAME_FIELDS | {"marker"})


def test_at_least_two_frames(example):
    assert len(example["frames"]) >= 2


def test_frames_have_pixels_label_and_exposures(example):
    for frame in example["frames"]:
        assert isinstance(frame["label"], str) and frame["label"].strip()
        assert isinstance(frame["n_used"], int) and frame["n_used"] > 0
        pixels = frame["pixels"]
        assert len(pixels) == example["width"] * example["height"] == 3481
        assert all(v is None or (type(v) in (int, float) and math.isfinite(v)) for v in pixels)
        assert any(v is not None for v in pixels)


def test_markers_in_all_frames_or_none_and_inside_image(example):
    marked = ["marker" in frame for frame in example["frames"]]
    assert all(marked) or not any(marked)
    for frame in example["frames"]:
        if "marker" not in frame:
            continue
        marker = frame["marker"]
        assert set(marker) == {"x", "y"}
        assert -0.5 <= marker["x"] <= example["width"] - 0.5
        assert -0.5 <= marker["y"] <= example["height"] - 0.5


def test_file_is_small_enough_to_ship():
    assert EXAMPLE.stat().st_size <= MAX_BYTES


def test_example_is_in_the_package_static_directory_and_served(tmp_path):
    assert "example.json" in {p.name for p in STATIC_DIR.iterdir()}
    app = create_app(cache_dir=tmp_path / "cache", reader=synthetic.FakeRangeReader({}),
                     discover=lambda *args: [])
    with TestClient(app) as client:
        response = client.get("/example.json")
    assert response.status_code == 200
    assert response.headers["content-type"].startswith("application/json")
    assert response.content == EXAMPLE.read_bytes()
