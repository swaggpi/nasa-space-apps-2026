"""Tests of the served static files and the acknowledgement text."""

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
# The one absolute URL the page's own code may hold: the sky map's survey, fetched by the
# visitor's browser only when the map is opened.
SKY_SURVEY_URL = '"https://irsa.ipac.caltech.edu/data/hips/CDS/2MASS/Color"'
VENDOR_FILES = ["aladin.js", "LICENSE", "COPYING", "README.md"]
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
    # Only the page's own files: the vendored library under vendor/ is not scanned.
    paths = sorted(STATIC_DIR.glob("*.html")) + sorted(STATIC_DIR.glob("*.js"))
    assert paths
    for path in paths:
        text = path.read_text(encoding="utf-8")
        if path.name == "app.js":
            assert text.count(SKY_SURVEY_URL) == 1, "app.js must name the sky survey once"
            text = text.replace(SKY_SURVEY_URL, "")
        for forbidden in ("http://", "https://", "localhost"):
            assert forbidden not in text, f"{path.name} contains {forbidden!r}"
        for pattern in ROOT_ABSOLUTE_TARGETS:
            match = pattern.search(text)
            assert match is None, f"{path.name} has a root-absolute URL: {match.group(0)!r}"


@pytest.mark.parametrize("name", VENDOR_FILES)
def test_vendored_map_library_is_served(client, name):
    response = client.get(f"/vendor/{name}")
    assert response.status_code == 200
    assert response.content == (STATIC_DIR / "vendor" / name).read_bytes()
    if name == "aladin.js":
        assert response.headers["content-type"].startswith("text/javascript")


def test_index_html_does_not_load_the_map_library():
    html = (STATIC_DIR / "index.html").read_text(encoding="utf-8").lower()
    assert "vendor" not in html
    assert "aladin" not in html


def test_acknowledgement_in_page_footer():
    html = (STATIC_DIR / "index.html").read_text(encoding="utf-8")
    footer = re.search(r"""<footer[^>]*\bid=["']ack["'][^>]*>(.*?)</footer>""", html, re.DOTALL)
    assert footer is not None, "index.html has no footer#ack"
    assert ACKNOWLEDGEMENT in normalise(footer.group(1))


def test_acknowledgement_in_readme():
    assert README.is_file(), f"{README} does not exist"
    assert ACKNOWLEDGEMENT in normalise(README.read_text(encoding="utf-8"))


def test_static_files_are_not_rate_limited(client):
    assert {client.get("/").status_code for _ in range(80)} == {200}


def test_root_can_be_embedded_in_a_frame(client):
    response = client.get("/")
    assert "x-frame-options" not in response.headers
    assert "frame-ancestors" not in response.headers.get("content-security-policy", "")


def static_paths() -> list[str]:
    """Every served path of the static directory, the page itself as `/`."""
    files_ = sorted(p for p in STATIC_DIR.rglob("*") if p.is_file())
    return ["/"] + ["/" + p.relative_to(STATIC_DIR).as_posix() for p in files_]


def test_static_paths_include_the_page_its_scripts_style_example_and_map_library():
    assert {"/", "/index.html", "/app.js", "/lib.js", "/style.css", "/example.json",
            "/vendor/aladin.js"} <= set(static_paths())


@pytest.mark.parametrize("path", static_paths())
def test_every_static_file_must_be_revalidated_before_reuse(client, path):
    response = client.get(path)
    assert response.status_code == 200
    assert response.headers["cache-control"] == "no-cache"
    assert response.headers["etag"]
    assert response.headers["last-modified"]


@pytest.mark.parametrize("path", ["/", "/app.js", "/lib.js", "/style.css", "/example.json",
                                  "/vendor/aladin.js"])
def test_unchanged_static_file_answers_304_with_the_header(client, path):
    first = client.get(path)
    for condition in ({"If-None-Match": first.headers["etag"]},
                      {"If-Modified-Since": first.headers["last-modified"]}):
        response = client.get(path, headers=condition)
        assert response.status_code == 304
        assert response.content == b""
        assert response.headers["cache-control"] == "no-cache"
        assert response.headers["etag"] == first.headers["etag"]


def test_changed_static_file_is_sent_again(client):
    response = client.get("/app.js", headers={"If-None-Match": '"stale"'})
    assert response.status_code == 200
    assert response.text == (STATIC_DIR / "app.js").read_text(encoding="utf-8")
    assert response.headers["cache-control"] == "no-cache"
