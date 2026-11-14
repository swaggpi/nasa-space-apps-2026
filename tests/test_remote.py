"""Tests of byte-range reading of FITS windows (DESIGN.md 3, 5.3; test-plan rows 13-17)."""

import io
import struct
import warnings

import httpx
import numpy as np
import pytest
from astropy.io import fits
from astropy.wcs import WCS, FITSFixedWarning

from spherex_viewer import remote
from spherex_viewer.remote import RemoteReadError, UnsupportedLayoutError
from synthetic import FLAG_NAMES, FakeRangeReader, make_exposure, rewrite_flags

URL = "https://example.invalid/exposure.fits"
TARGET_RA, TARGET_DEC = 150.0, 20.0
TARGET_SHAPE = (59, 59)
N = 300
NAN_PIXEL = (150, 160)


def spec_target_wcs(ra: float, dec: float) -> WCS:
    w = WCS(naxis=2)
    w.wcs.ctype = ["RA---TAN", "DEC--TAN"]
    w.wcs.crval = [ra, dec]
    w.wcs.crpix = [30, 30]
    w.wcs.cdelt = [-6.15 / 3600, 6.15 / 3600]
    return w


def hdu_spans(blob: bytes) -> list[dict]:
    with fits.open(io.BytesIO(blob), disable_image_compression=True) as hdul:
        return [dict(hdul.fileinfo(i)) for i in range(len(hdul))]


def raw_header(blob: bytes, info: dict) -> fits.Header:
    return fits.Header.fromstring(blob[info["hdrLoc"]:info["datLoc"]].decode("ascii"))


def full_read(blob: bytes) -> tuple[np.ndarray, np.ndarray, WCS]:
    with warnings.catch_warnings():
        warnings.simplefilter("ignore", FITSFixedWarning)
        with fits.open(io.BytesIO(blob)) as hdul:
            return (np.array(hdul["IMAGE"].data, dtype=np.float32),
                    np.array(hdul["FLAGS"].data, dtype=np.int32),
                    WCS(hdul["IMAGE"].header))


def patch_nan(blob: bytes, x: int, y: int) -> bytes:
    info = hdu_spans(blob)[1]
    offset = info["datLoc"] + 4 * (y * N + x)
    return blob[:offset] + struct.pack(">f", float("nan")) + blob[offset + 4:]


def dense_bad(seed: int, fraction: float = 0.05) -> list[tuple[int, int, int]]:
    rng = np.random.default_rng(seed)
    bits = list(FLAG_NAMES)
    idx = rng.choice(N * N, int(fraction * N * N), replace=False)
    return [(int(i % N), int(i // N), int(rng.choice(bits))) for i in idx]


@pytest.fixture(scope="module")
def target() -> WCS:
    return spec_target_wcs(TARGET_RA, TARGET_DEC)


@pytest.fixture(scope="module")
def exposure() -> bytes:
    blob = make_exposure((TARGET_RA + 0.03, TARGET_DEC + 0.02), (TARGET_RA, TARGET_DEC),
                         rot_deg=37.0, bad=dense_bad(5), seed=11)
    return patch_nan(blob, *NAN_PIXEL)


@pytest.fixture(scope="module")
def edge_exposure() -> bytes:
    return make_exposure((TARGET_RA + 0.22, TARGET_DEC - 0.20), (TARGET_RA, TARGET_DEC),
                         rot_deg=-80.0, bad=dense_bad(6), seed=12)


# Row 13

def test_header_length_matches_astropy_offsets(exposure):
    for info in hdu_spans(exposure):
        assert remote.header_length(exposure[info["hdrLoc"]:]) == info["datLoc"] - info["hdrLoc"]


def test_header_length_none_without_end(exposure):
    flags_info = hdu_spans(exposure)[2]
    assert flags_info["datLoc"] - flags_info["hdrLoc"] > 2880
    assert remote.header_length(exposure[flags_info["hdrLoc"]:flags_info["hdrLoc"] + 2880]) is None
    assert remote.header_length(b"") is None


def test_data_length_matches_astropy_offsets(exposure):
    spans = hdu_spans(exposure)
    for i, info in enumerate(spans):
        length = remote.data_length(raw_header(exposure, info))
        assert length == info["datSpan"]
        if i + 1 < len(spans):
            assert info["datLoc"] + length == spans[i + 1]["hdrLoc"]
        else:
            assert info["datLoc"] + length == len(exposure)


# Row 14

def window_reads(blob: bytes, target: WCS):
    reader = FakeRangeReader({URL: blob})
    window = remote.read_window(reader, URL, target, TARGET_SHAPE)
    return window, reader.calls


def border_positions(wcs: WCS, target: WCS) -> tuple[np.ndarray, np.ndarray]:
    ny, nx = TARGET_SHAPE
    yy, xx = np.mgrid[0:ny, 0:nx]
    edge = (yy == 0) | (yy == ny - 1) | (xx == 0) | (xx == nx - 1)
    ra, dec = target.all_pix2world(xx[edge], yy[edge], 0)
    return wcs.all_world2pix(ra, dec, 0)


@pytest.mark.parametrize("blob_name", ["exposure", "edge_exposure"])
def test_window_equals_full_read(request, blob_name, target):
    blob = request.getfixturevalue(blob_name)
    image, flags, wcs = full_read(blob)
    window, _ = window_reads(blob, target)
    ny, nx = window.image.shape
    assert window.flags.shape == (ny, nx)
    assert window.image.dtype == np.float32
    assert window.flags.dtype == np.int32
    x0, y0 = window.x0, window.y0
    np.testing.assert_array_equal(window.image, image[y0:y0 + ny, x0:x0 + nx])
    np.testing.assert_array_equal(window.flags, flags[y0:y0 + ny, x0:x0 + nx])
    assert np.count_nonzero(window.flags) > 0

    px, py = border_positions(wcs, target)
    lo_x, hi_x = max(px.min() - 2, 0), min(px.max() + 2, N - 1)
    lo_y, hi_y = max(py.min() - 2, 0), min(py.max() + 2, N - 1)
    assert x0 <= lo_x and x0 + nx - 1 >= hi_x
    assert y0 <= lo_y and y0 + ny - 1 >= hi_y
    assert x0 >= px.min() - 5 and x0 + nx <= px.max() + 6
    assert y0 >= py.min() - 5 and y0 + ny <= py.max() + 6
    assert 0 <= x0 and 0 <= y0 and x0 + nx <= N and y0 + ny <= N


def test_edge_window_is_clipped_to_detector(edge_exposure, target):
    _, _, wcs = full_read(edge_exposure)
    px, py = border_positions(wcs, target)
    assert px.max() > N - 1 or py.max() > N - 1 or px.min() < 0 or py.min() < 0
    window, _ = window_reads(edge_exposure, target)
    ny, nx = window.image.shape
    assert window.x0 == 0 or window.y0 == 0 or window.x0 + nx == N or window.y0 + ny == N


def test_window_keeps_nan(exposure, target):
    window, _ = window_reads(exposure, target)
    x, y = NAN_PIXEL
    assert window.x0 <= x < window.x0 + window.image.shape[1]
    assert window.y0 <= y < window.y0 + window.image.shape[0]
    assert np.isnan(window.image[y - window.y0, x - window.x0])
    assert np.isnan(window.image).sum() == 1


def test_window_wcs_is_full_detector_wcs_with_sip(exposure, target):
    _, _, wcs = full_read(exposure)
    window, _ = window_reads(exposure, target)
    assert window.wcs.sip is not None
    xs = np.array([0.0, 17.3, 150.0, 299.0])
    ys = np.array([5.0, 260.1, 150.0, 299.0])
    np.testing.assert_allclose(window.wcs.all_pix2world(xs, ys, 0), wcs.all_pix2world(xs, ys, 0),
                               rtol=0, atol=1e-10)


def test_byte_accounting(exposure, target):
    spans = hdu_spans(exposure)
    image_info, flags_info, variance_info = spans[1], spans[2], spans[3]
    flags_header = raw_header(exposure, flags_info)
    assert variance_info["hdrLoc"] > flags_info["hdrLoc"] + 40320

    window, calls = window_reads(exposure, target)
    assert len(calls) == 4
    assert all(url == URL for url, _, _ in calls)
    ny, nx = window.image.shape
    x0, y0, x1, y1 = window.x0, window.y0, window.x0 + nx, window.y0 + ny

    assert calls[0][1:] == (0, 60480)
    image_start = image_info["datLoc"]
    assert calls[1][1:] == (image_start + 4 * (y0 * N + x0), image_start + 4 * ((y1 - 1) * N + x1))
    assert calls[2][1:] == (flags_info["hdrLoc"], flags_info["hdrLoc"] + 40320)

    table_start = flags_info["datLoc"]
    n_rows = flags_header["NAXIS2"]
    descriptors = np.frombuffer(exposure[table_start:table_start + 8 * n_rows],
                                dtype=">i4").reshape(-1, 2)[y0:y1]
    heap_start = table_start + flags_header.get("THEAP", 8 * n_rows)
    assert calls[3][1:] == (heap_start + int(descriptors[:, 1].min()),
                            heap_start + int((descriptors[:, 0] + descriptors[:, 1]).max()))

    assert sum(stop - start for _, start, stop in calls) < 0.4 * len(exposure)
    variance_start = variance_info["hdrLoc"]
    variance_stop = variance_info["datLoc"] + variance_info["datSpan"]
    for _, start, stop in calls:
        assert stop <= variance_start or start >= variance_stop


# Row 15

def test_far_target_returns_none(exposure):
    assert remote.read_window(FakeRangeReader({URL: exposure}), URL,
                              spec_target_wcs(10.0, -30.0), TARGET_SHAPE) is None


def test_square_flag_tiles_are_unsupported(exposure, target):
    blob = rewrite_flags(exposure, tile_shape=(N, N))
    with pytest.raises(UnsupportedLayoutError):
        remote.read_window(FakeRangeReader({URL: blob}), URL, target, TARGET_SHAPE)


def test_renamed_flag_bit_is_unsupported(exposure, target):
    blob = rewrite_flags(exposure, rename={"MSKN0010": "HOTPIX"})
    with pytest.raises(UnsupportedLayoutError):
        remote.read_window(FakeRangeReader({URL: blob}), URL, target, TARGET_SHAPE)


def test_check_flag_definitions(exposure):
    header = raw_header(exposure, hdu_spans(exposure)[2])
    remote.check_flag_definitions(header)
    header["MSKN0010"] = "HOTPIX"
    with pytest.raises(UnsupportedLayoutError):
        remote.check_flag_definitions(header)


# Row 16

def http_reader(handler, attempts: int = 3) -> tuple[remote.HttpRangeReader, list[httpx.Request]]:
    requests: list[httpx.Request] = []

    def record(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        return handler(request, len(requests))

    client = httpx.Client(transport=httpx.MockTransport(record))
    return remote.HttpRangeReader(client, attempts=attempts), requests


@pytest.fixture
def sleeps(monkeypatch) -> list[float]:
    recorded: list[float] = []
    monkeypatch.setattr("time.sleep", recorded.append)
    return recorded


def test_http_range_header_and_body(sleeps):
    body = bytes(range(100))
    reader, requests = http_reader(lambda request, i: httpx.Response(206, content=body))
    assert reader.read(URL, 100, 200) == body
    assert len(requests) == 1
    assert requests[0].headers["Range"] == "bytes=100-199"
    assert str(requests[0].url) == URL
    assert sleeps == []


def test_http_full_response_is_an_error(sleeps):
    reader, _ = http_reader(lambda request, i: httpx.Response(200, content=b"x" * 1000))
    with pytest.raises(RemoteReadError):
        reader.read(URL, 0, 10)


@pytest.mark.parametrize("status", [503, 429])
def test_http_retries_then_succeeds(sleeps, status):
    def handler(request, i):
        return httpx.Response(status) if i < 3 else httpx.Response(206, content=b"abc")

    reader, requests = http_reader(handler)
    assert reader.read(URL, 5, 8) == b"abc"
    assert len(requests) == 3
    assert sleeps == pytest.approx([0.5, 1.5])


def test_http_client_error_fails_at_once(sleeps):
    reader, requests = http_reader(lambda request, i: httpx.Response(404))
    with pytest.raises(RemoteReadError):
        reader.read(URL, 0, 10)
    assert len(requests) == 1
    assert sleeps == []


def test_http_timeouts_exhaust_attempts(sleeps):
    def handler(request, i):
        raise httpx.ReadTimeout("timed out", request=request)

    reader, requests = http_reader(handler)
    with pytest.raises(RemoteReadError):
        reader.read(URL, 0, 10)
    assert len(requests) == 3
    assert sleeps == pytest.approx([0.5, 1.5])


# Row 17

def test_s3_url_dr1():
    uri = ("ibe/data/spherex/dr1/level2/2025W19_1B/l2b-v27-2026-197/3/"
           "level2_2025W19_1B_0116_1D3_spx_l2b-v27-2026-197.fits")
    assert remote.s3_url(uri) == (
        "https://nasa-irsa-spherex.s3.us-east-1.amazonaws.com/dr1/level2/2025W19_1B/"
        "l2b-v27-2026-197/3/level2_2025W19_1B_0116_1D3_spx_l2b-v27-2026-197.fits")


def test_s3_url_qr3():
    uri = ("ibe/data/spherex/qr3/level2/2026W20_2A/l2b-v27-2026-267/2/"
           "level2_2026W20_2A_0047_1D2_spx_l2b-v27-2026-267.fits")
    assert remote.s3_url(uri) == (
        "https://nasa-irsa-spherex.s3.us-east-1.amazonaws.com/qr3/level2/2026W20_2A/"
        "l2b-v27-2026-267/2/level2_2026W20_2A_0047_1D2_spx_l2b-v27-2026-267.fits")


@pytest.mark.parametrize("uri", [
    "ibe/data/spherex/dr1/level2/../../../secret/x.fits",
    "https://evil.example/ibe/data/spherex/dr1/level2/a.fits",
])
def test_s3_url_rejects_invalid_uri(uri):
    with pytest.raises(ValueError):
        remote.s3_url(uri)
