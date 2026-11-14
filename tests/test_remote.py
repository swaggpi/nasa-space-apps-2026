"""Tests of byte-range reading of FITS windows from remote SPHEREx files."""

import io
import struct
import warnings

import httpx
import numpy as np
import pytest
from astropy.io import fits
from astropy.wcs import WCS, FITSFixedWarning

from spherex_viewer import remote
from spherex_viewer.cutout import UnsupportedLayoutError
from spherex_viewer.remote import RemoteReadError
from synthetic import (
    FLAG_NAMES,
    TIME_KEYS,
    FakeRangeReader,
    assert_same_wcs,
    corrupt_flags_heap,
    exposure_wcs,
    make_exposure,
    rewrite_flags,
)

URL = "https://example.invalid/exposure.fits"
TARGET_RA, TARGET_DEC = 150.0, 20.0
TARGET_SHAPE = (59, 59)
N = 300
NAN_PIXEL = (150, 160)
HEAD_READ = 21 * 2880


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


def replace_card(blob: bytes, hdu: int, key: str, card: str) -> bytes:
    """Return ``blob`` with the header card ``key`` of HDU ``hdu`` replaced by ``card``."""
    info = hdu_spans(blob)[hdu]
    for pos in range(info["hdrLoc"], info["datLoc"], 80):
        if blob[pos:pos + 8] == key.encode().ljust(8):
            return blob[:pos] + card.encode().ljust(80) + blob[pos + 80:]
    raise KeyError(key)


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

    assert calls[0][1:] == (0, HEAD_READ)
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


@pytest.mark.parametrize(("ra", "dec"), [(10.0, -30.0), (TARGET_RA + 1.0, TARGET_DEC),
                                         (TARGET_RA + 180.0, -TARGET_DEC)])
def test_far_target_reads_only_the_headers(exposure, ra, dec):
    window, calls = window_reads(exposure, spec_target_wcs(ra, dec))
    assert window is None
    assert [call[1:] for call in calls] == [(0, HEAD_READ)]


def header_only_exposure(n: int, rot_deg: float) -> bytes:
    """Primary and IMAGE headers of an n x n SIP exposure centred on the target, no data."""
    header = fits.Header([("XTENSION", "IMAGE"), ("BITPIX", -32), ("NAXIS", 2), ("NAXIS1", n),
                          ("NAXIS2", n), ("PCOUNT", 0), ("GCOUNT", 1), ("EXTNAME", "IMAGE")])
    header.extend(exposure_wcs((TARGET_RA, TARGET_DEC), n=n, rot_deg=rot_deg,
                               sip=True).to_header(relax=True))
    return (fits.PrimaryHDU().header.tostring() + header.tostring()).encode("ascii")


def test_far_target_on_full_size_detector_reads_only_the_headers():
    blob = header_only_exposure(2040, 37.0)
    window, calls = window_reads(blob, spec_target_wcs(TARGET_RA - 64.0, TARGET_DEC + 58.0))
    assert window is None
    assert sum(stop - start for _, start, stop in calls) <= HEAD_READ


def test_target_just_off_the_detector_edge_returns_none(exposure):
    _, _, wcs = full_read(exposure)
    ra, dec = wcs.all_pix2world(N + 60.0, N / 2, 0)
    window, calls = window_reads(exposure, spec_target_wcs(float(ra), float(dec)))
    assert window is None
    assert sum(stop - start for _, start, stop in calls) == HEAD_READ


@pytest.mark.parametrize("rot_deg", [0.0, 15.0, 30.0, 45.0, 60.0, 135.0, 225.0])
def test_footprint_window_accepts_every_grid_orientation(target, rot_deg):
    wcs = exposure_wcs((TARGET_RA, TARGET_DEC), n=N, rot_deg=rot_deg, sip=True)
    box = remote.footprint_window(wcs, (N, N), target, TARGET_SHAPE)
    assert box is not None
    x0, x1, y0, y1 = box
    px, py = border_positions(wcs, target)
    assert x0 < px.min() and x1 > px.max() and y0 < py.min() and y1 > py.max()


@pytest.mark.parametrize(("ra", "dec"), [(TARGET_RA - 64.0, TARGET_DEC + 58.0),
                                         (TARGET_RA + 3.0, TARGET_DEC), (330.0, -20.0)])
def test_far_target_is_refused_without_sky_to_pixel_transform(target, monkeypatch, ra, dec):
    wcs = exposure_wcs((TARGET_RA, TARGET_DEC), n=2040, rot_deg=37.0, sip=True)
    calls = []
    inverse = wcs.all_world2pix
    monkeypatch.setattr(wcs, "all_world2pix", lambda *a, **k: calls.append(1) or inverse(*a, **k))
    assert remote.footprint_window(wcs, (2040, 2040), target, TARGET_SHAPE) is not None
    assert calls == [1]
    assert remote.footprint_window(wcs, (2040, 2040), spec_target_wcs(ra, dec),
                                   TARGET_SHAPE) is None
    assert calls == [1]


def test_footprint_window_refuses_a_diverged_inversion(target, monkeypatch):
    wcs = exposure_wcs((TARGET_RA, TARGET_DEC), n=2040, rot_deg=0.0, sip=True)
    assert remote.footprint_window(wcs, (2040, 2040), target, TARGET_SHAPE) is not None

    def scattered(ra, dec, origin, **kwargs):
        spread = np.linspace(-500.0, 2500.0, np.size(ra))
        return spread, spread[::-1]

    monkeypatch.setattr(wcs, "all_world2pix", scattered)
    assert remote.footprint_window(wcs, (2040, 2040), target, TARGET_SHAPE) is None


def test_square_flag_tiles_are_unsupported(exposure, target):
    blob = rewrite_flags(exposure, tile_shape=(N, N))
    with pytest.raises(UnsupportedLayoutError):
        remote.read_window(FakeRangeReader({URL: blob}), URL, target, TARGET_SHAPE)


def test_renamed_flag_bit_is_unsupported(exposure, target):
    blob = rewrite_flags(exposure, rename={"MSKN0010": "HOTPIX"})
    with pytest.raises(UnsupportedLayoutError):
        remote.read_window(FakeRangeReader({URL: blob}), URL, target, TARGET_SHAPE)


def test_additional_flag_bit_is_accepted(exposure, target):
    blob = rewrite_flags(exposure, rename={"MSKN0030": "NEWFLAG", "MSKM0030": 1 << 30})
    window, _ = window_reads(blob, target)
    expected, _ = window_reads(exposure, target)
    np.testing.assert_array_equal(window.flags, expected.flags)


@pytest.mark.parametrize(
    ("key", "card"),
    [
        ("ZVAL2", "ZVAL2   =                   -1"),
        ("ZVAL2", "ZVAL2   =                    8"),
        ("ZVAL1", "ZVAL1   =                    0"),
        ("ZNAME1", "ZNAME1  = 'NOISEBIT'"),
        ("ZNAME2", "COMMENT"),
    ],
)
def test_unexpected_rice_parameters_never_reach_the_decoder(exposure, target, monkeypatch,
                                                            key, card):
    decoded = []
    monkeypatch.setattr(remote, "decode_flag_rows", lambda *args: decoded.append(args))
    blob = replace_card(exposure, 2, key, card)
    with pytest.raises(UnsupportedLayoutError):
        remote.read_window(FakeRangeReader({URL: blob}), URL, target, TARGET_SHAPE)
    assert decoded == []


def truncate_in_image(blob: bytes) -> bytes:
    return blob[:hdu_spans(blob)[1]["datLoc"] + 1000]


def truncate_in_heap(blob: bytes) -> bytes:
    info = hdu_spans(blob)[2]
    return blob[:info["datLoc"] + info["datSpan"] // 2]


MALFORMED = {
    "corrupted FLAGS heap": corrupt_flags_heap,
    "IMAGE without NAXIS1": lambda b: replace_card(b, 1, "NAXIS1", "COMMENT"),
    "primary without BITPIX": lambda b: replace_card(b, 0, "BITPIX", "COMMENT"),
    "primary NAXIS is text": lambda b: replace_card(b, 0, "NAXIS", "NAXIS   = 'two'"),
    "IMAGE NAXIS1 is text": lambda b: replace_card(b, 1, "NAXIS1", "NAXIS1  = 'wide'"),
    "IMAGE CRPIX1 is text": lambda b: replace_card(b, 1, "CRPIX1", "CRPIX1  = 'centre'"),
    "IMAGE CTYPE1 unknown": lambda b: replace_card(b, 1, "CTYPE1", "CTYPE1  = 'XX---TAN'"),
    "FLAGS PCOUNT is text": lambda b: replace_card(b, 2, "PCOUNT", "PCOUNT  = 'many'"),
    "FLAGS without PCOUNT": lambda b: replace_card(b, 2, "PCOUNT", "COMMENT"),
    "truncated IMAGE data": truncate_in_image,
    "truncated FLAGS heap": truncate_in_heap,
    "not FITS": lambda b: b"<html>" + b" " * 70000,
}


@pytest.mark.parametrize("name", list(MALFORMED))
def test_malformed_content_is_unsupported_layout(exposure, target, name):
    blob = MALFORMED[name](exposure)
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        with pytest.raises(UnsupportedLayoutError):
            remote.read_window(FakeRangeReader({URL: blob}), URL, target, TARGET_SHAPE)


class ShortBodyReader(FakeRangeReader):
    """Serves the IMAGE rows read (the second call) one byte short."""

    def read(self, url: str, start: int, stop: int) -> bytes:
        data = super().read(url, start, stop)
        return data[:-1] if len(self.calls) == 2 else data


def test_short_body_is_unsupported_layout(exposure, target):
    with pytest.raises(UnsupportedLayoutError):
        remote.read_window(ShortBodyReader({URL: exposure}), URL, target, TARGET_SHAPE)


def http_reader(handler) -> tuple[remote.HttpRangeReader, list[httpx.Request]]:
    requests: list[httpx.Request] = []

    def record(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        return handler(request, len(requests))

    client = httpx.Client(transport=httpx.MockTransport(record))
    return remote.HttpRangeReader(client), requests


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


def test_http_oversized_partial_body_is_an_error(sleeps):
    reader, _ = http_reader(lambda request, i: httpx.Response(206, content=b"x" * 11))
    with pytest.raises(RemoteReadError):
        reader.read(URL, 0, 10)


def test_http_short_partial_body_is_returned(sleeps):
    reader, _ = http_reader(lambda request, i: httpx.Response(206, content=b"x" * 4))
    assert reader.read(URL, 0, 10) == b"x" * 4


@pytest.mark.parametrize("url", [remote.S3_BASE + "x" * 70000, "https://exaémple..com/x",
                                 "http://[::1/x"])
def test_http_unusable_url_is_a_read_error(sleeps, url):
    reader, requests = http_reader(lambda request, i: httpx.Response(206, content=b"x"))
    with pytest.raises(RemoteReadError):
        reader.read(url, 0, 10)
    assert requests == []
    assert sleeps == []


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


def parsed_header(sip: bool, extra: tuple[str, ...] = ()) -> fits.Header:
    """A detector header as ``remote`` parses it from file bytes, plus ``extra`` raw cards."""
    header = exposure_wcs((269.45, 4.69), n=100, rot_deg=20.0, sip=sip).to_header(relax=True)
    cards = [fits.Card("NAXIS", 2), fits.Card("NAXIS1", 100), fits.Card("NAXIS2", 100),
             *header.cards, *(fits.Card.fromstring(card) for card in extra)]
    return fits.Header.fromstring("".join(card.image for card in cards) + "END".ljust(80))


def alternate_wcs_cards(key: str) -> tuple[str, ...]:
    alternate = exposure_wcs((269.5, 4.7), n=100, rot_deg=5.0, sip=False)
    return tuple(card.image for card in alternate.to_header(key=key).cards)


INVERSE_SIP = ("AP_ORDER=                    2", "AP_2_0  =               -2E-05",
               "AP_0_2  =                1E-05", "BP_ORDER=                    2",
               "BP_1_1  =             -1.5E-05", "BP_0_2  =               -2E-05")
EXTRA_CARDS = (
    *INVERSE_SIP,
    *(f"HISTORY step {i}" for i in range(3)), "COMMENT a comment",
    *(f"INST{i:04d}= {i * 0.5!r} / instrument value" for i in range(30)),
    *alternate_wcs_cards("A"), *alternate_wcs_cards("W"),
)


def full_wcs(header: fits.Header) -> WCS:
    with warnings.catch_warnings():
        warnings.simplefilter("ignore", FITSFixedWarning)
        return WCS(header)


def test_celestial_wcs_equals_full_wcs_with_extra_cards(monkeypatch):
    header = parsed_header(sip=True, extra=EXTRA_CARDS)
    full = full_wcs(header)
    received = []
    monkeypatch.setattr(remote, "WCS", lambda given: received.append(given) or full_wcs(given))
    reduced = remote.celestial_wcs(header)
    assert len(received) == 1
    keys = [card.keyword for card in received[0].cards]
    assert keys and all(remote._WCS_KEYWORD.fullmatch(key) for key in keys)
    assert_same_wcs(reduced, full, size=100, step=9)
    assert full.pixel_shape == (100, 100)


def test_celestial_wcs_keyword_list_is_complete():
    written = full_wcs(parsed_header(sip=True, extra=EXTRA_CARDS)).to_header(relax=True)
    assert [key for key in written
            if key not in TIME_KEYS and not remote._WCS_KEYWORD.fullmatch(key)] == []


FOREIGN = {
    "CPDIS1": "CPDIS1  = 'LOOKUP  '",
    "D2IMDIS1": "D2IMDIS1= 'LOOKUP  '",
    "DP1 record": "DP1     = 'EXTVER: 1'",
    "DQ2 record": "DQ2     = 'NAXES: 2'",
    "CRVAL3": "CRVAL3  = 1.0",
    "PC3_3": "PC3_3   = 1.0",
    "PC001002": "PC001002= 0.5",
    "PC01_01": "PC01_01 = 0.5",
    "PC1_02": "PC1_02  = 0.5",
    "CRPIX12": "CRPIX12 = 1.0",
    "PV3_1": "PV3_1   = 1.0",
    "PV12_1": "PV12_1  = 1.0",
    "NAXIS3": "NAXIS3  = 5",
}


@pytest.mark.parametrize("name", [None, *FOREIGN])
def test_celestial_wcs_falls_back_to_the_full_header(monkeypatch, name):
    header = parsed_header(sip=False) if name is None else parsed_header(True, (FOREIGN[name],))
    received = []
    monkeypatch.setattr(remote, "WCS", lambda given: received.append(given) or "full")
    assert remote.celestial_wcs(header) == "full"
    assert received[0] is header


def test_read_window_builds_the_wcs_from_the_reduced_header(exposure, target, monkeypatch):
    received = []
    monkeypatch.setattr(remote, "WCS", lambda given: received.append(given) or full_wcs(given))
    assert remote.read_window(FakeRangeReader({URL: exposure}), URL, target,
                              TARGET_SHAPE) is not None
    assert len(received) == 1
    keys = [card.keyword for card in received[0].cards]
    assert keys and all(remote._WCS_KEYWORD.fullmatch(key) for key in keys)


def flag_rows(blob: bytes, y0: int, y1: int) -> tuple[fits.Header, np.ndarray, bytes, int]:
    """Raw FLAGS header, descriptors of rows [y0, y1), the whole heap and its start offset 0."""
    info = hdu_spans(blob)[2]
    header = raw_header(blob, info)
    table_len = header["NAXIS1"] * header["NAXIS2"]
    start = info["datLoc"]
    descriptors = np.frombuffer(blob[start:start + table_len], dtype=">i4").reshape(-1, 2)
    heap = blob[start + table_len:start + table_len + header["PCOUNT"]]
    return header, descriptors[y0:y1], heap, 0


def test_decode_flag_rows_ignores_other_header_cards(exposure):
    header, descriptors, heap, heap_start = flag_rows(exposure, 40, 52)
    busy = header.copy()
    for card in full_wcs(header).to_header(relax=True).cards:
        busy.append(card)
    busy["MSKN0031"] = ("EXTRA", "Name for mask plane 31")
    busy["MSKM0031"] = (1 << 31, "Bitmask for plane n=31; always 1<<n")
    busy.add_history("processed")
    busy["THEAP"] = header["NAXIS1"] * header["NAXIS2"]
    before = busy.tostring()
    decoded = remote.decode_flag_rows(busy, descriptors, heap, heap_start)
    assert busy.tostring() == before
    assert decoded.dtype == np.int32
    np.testing.assert_array_equal(decoded, remote.decode_flag_rows(header, descriptors, heap,
                                                                   heap_start))
    _, flags, _ = full_read(exposure)
    np.testing.assert_array_equal(decoded, flags[40:52])
