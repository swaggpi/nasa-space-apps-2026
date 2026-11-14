"""Tests of the served static files and the acknowledgement text (row 30)."""

import re
from importlib.resources import files
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

import synthetic
from spherex_viewer.app import create_app

STATIC_DIR = Path(str(files("spherex_viewer") / "static"))
README = Path(__file__).resolve().parents[1] / "README.md"
ACKNOWLEDGEMENT = (
    "This publication makes use of data products from the Spectro-Photometer for the History of "
    "the Universe, Epoch of Reionization and Ices Explorer (SPHEREx), which is a joint project of "
    "the Jet Propulsion Laboratory and the California Institute of Technology, and is funded by "
    "the National Aeronautics and Space Administration."
)
ROOT_ABSOLUTE_TARGETS = [
    re.compile(r"""\b(?:src|href)\s*=\s*["']?\s*/"""),
    re.compile(r"""\bfetch\(\s*["'`]\s*/"""),
    re.compile(r"""\b(?:from|import)\s*\(?\s*["']\s*/"""),
]


def normalise(text: str) -> str:
    return " ".join(text.split())


def no_discovery(ra_deg, dec_deg, detector):
    raise AssertionError("discover must not be called")


@pytest.fixture
def client(tmp_path):
    app = create_app(
        cache_dir=tmp_path / "cache", reader=synthetic.FakeRangeReader({}), discover=no_discovery
    )
    with TestClient(app) as client:
        yield client


def test_frontend_files_exist():
    names = {p.name for p in STATIC_DIR.iterdir()}
    assert {"index.html", "style.css", "app.js", "lib.js"} <= names


def test_root_serves_index_html(client):
    response = client.get("/")
    assert response.status_code == 200
    assert response.headers["content-type"].startswith("text/html")
    assert response.text == (STATIC_DIR / "index.html").read_text(encoding="utf-8")


@pytest.mark.parametrize("name", ["style.css", "app.js", "lib.js"])
def test_static_assets_are_served(client, name):
    response = client.get(f"/{name}")
    assert response.status_code == 200
    assert response.text == (STATIC_DIR / name).read_text(encoding="utf-8")


def test_frontend_has_no_absolute_urls():
    paths = sorted(STATIC_DIR.glob("*.html")) + sorted(STATIC_DIR.glob("*.js"))
    assert paths
    for path in paths:
        text = path.read_text(encoding="utf-8")
        for forbidden in ("http://", "https://", "localhost"):
            assert forbidden not in text, f"{path.name} contains {forbidden!r}"
        for pattern in ROOT_ABSOLUTE_TARGETS:
            match = pattern.search(text)
            assert match is None, f"{path.name} has a root-absolute URL: {match.group(0)!r}"


def test_acknowledgement_in_page_footer():
    html = (STATIC_DIR / "index.html").read_text(encoding="utf-8")
    footer = re.search(r"""<footer[^>]*\bid=["']ack["'][^>]*>(.*?)</footer>""", html, re.DOTALL)
    assert footer is not None, "index.html has no footer#ack"
    assert ACKNOWLEDGEMENT in normalise(footer.group(1))


def test_acknowledgement_in_readme():
    assert README.is_file(), f"{README} does not exist"
    assert ACKNOWLEDGEMENT in normalise(README.read_text(encoding="utf-8"))
