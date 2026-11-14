"""Tests of flag checks, masking, background, reprojection and combine."""

import io
import warnings

import numpy as np
import pytest
from astropy.io import fits
from astropy.wcs import WCS, FITSFixedWarning

from spherex_viewer import cutout
from spherex_viewer.cutout import UnsupportedLayoutError, Window
from synthetic import FLAG_NAMES, fit_centroid, make_exposure

TARGET_RA, TARGET_DEC = 150.0, 20.0
TARGET_SHAPE = (59, 59)
STAR_PIXEL = (40.3, 21.7)
N = 300
SOURCE, HOT = 21, 10

# Supplement Table 16 and the Mosaic Tool's masked set (Supplement 3.4.3).
SPEC_FLAG_BITS = {
    "TRANSIENT": 0, "OVERFLOW": 1, "SUR_ERROR": 2, "NONFUNC": 6, "DICHROIC": 7, "MISSING_DATA": 9,
    "HOT": 10, "COLD": 11, "FULLSAMPLE": 12, "PHANMISS": 14, "NONLINEAR": 15, "PERSIST": 17,
    "OUTLIER": 19, "CROSSTALK": 20, "SOURCE": 21, "GHOST": 22, "GHOST_FPA": 23, "GHOST_EXT": 24,
    "STREAK": 25, "BLOOM": 26, "SNOWBALL": 27, "HALO": 28, "SATELLITE_HALO": 29,
}
SPEC_BAD_BITS = [0, 2, 6, 7, 9, 10, 11, 14, 15, 17, 20, 22, 23, 24, 25, 26, 27, 28, 29]
UNKNOWN_BIT = 30


def spec_target_wcs(ra: float, dec: float) -> WCS:
    w = WCS(naxis=2)
    w.wcs.ctype = ["RA---TAN", "DEC--TAN"]
    w.wcs.crval = [ra, dec]
    w.wcs.crpix = [30, 30]
    w.wcs.cdelt = [-6.15 / 3600, 6.15 / 3600]
    return w


TARGET = spec_target_wcs(TARGET_RA, TARGET_DEC)
STAR = tuple(float(v) for v in TARGET.all_pix2world(*STAR_PIXEL, 0))


def open_exposure(blob: bytes) -> tuple[np.ndarray, np.ndarray, fits.Header]:
    with fits.open(io.BytesIO(blob)) as hdul:
        return (np.array(hdul["IMAGE"].data, dtype=np.float32),
                np.array(hdul["FLAGS"].data, dtype=np.int32),
                hdul["IMAGE"].header.copy())


def make_wcs(header: fits.Header) -> WCS:
    with warnings.catch_warnings():
        warnings.simplefilter("ignore", FITSFixedWarning)
        return WCS(header)


def strip_sip(header: fits.Header) -> fits.Header:
    stripped = header.copy()
    for key in list(stripped.keys()):
        if key.split("_")[0] in ("A", "B", "AP", "BP") and "_" in key:
            del stripped[key]
    stripped["CTYPE1"] = "RA---TAN"
    stripped["CTYPE2"] = "DEC--TAN"
    return stripped


def window_for(image: np.ndarray, flags: np.ndarray, wcs: WCS, margin: int = 5) -> Window:
    ny, nx = TARGET_SHAPE
    yy, xx = np.mgrid[0:ny, 0:nx]
    ra, dec = TARGET.all_pix2world(xx.ravel(), yy.ravel(), 0)
    px, py = wcs.all_world2pix(ra, dec, 0)
    x0 = max(int(np.floor(px.min())) - margin, 0)
    y0 = max(int(np.floor(py.min())) - margin, 0)
    x1 = min(int(np.ceil(px.max())) + margin + 1, image.shape[1])
    y1 = min(int(np.ceil(py.max())) + margin + 1, image.shape[0])
    return Window(image=image[y0:y1, x0:x1].copy(), flags=flags[y0:y1, x0:x1].copy(), wcs=wcs,
                  x0=x0, y0=y0)


def detector_pixel_of(wcs: WCS, grid_x: float, grid_y: float) -> tuple[int, int]:
    ra, dec = TARGET.all_pix2world(grid_x, grid_y, 0)
    x, y = wcs.all_world2pix(ra, dec, 0)
    return int(round(float(x))), int(round(float(y)))


def flags_header(names: dict[int, str]) -> fits.Header:
    header = fits.Header()
    for bit, name in names.items():
        header[f"MSKN{bit:04d}"] = name
        header[f"MSKM{bit:04d}"] = 1 << bit
    return header


def test_flag_definitions_of_the_supplement_are_accepted():
    cutout.check_flag_definitions(flags_header({b: n for n, b in SPEC_FLAG_BITS.items()}))
    cutout.check_flag_definitions(flags_header(FLAG_NAMES))


def test_additional_unknown_flag_bit_is_accepted():
    names = {b: n for n, b in SPEC_FLAG_BITS.items()} | {UNKNOWN_BIT: "NEWFLAG", 31: "OTHER"}
    cutout.check_flag_definitions(flags_header(names))


@pytest.mark.parametrize("change", [
    {10: "HOTPIX"},
    {10: "COLD", 11: "HOT"},
    {UNKNOWN_BIT: "SOURCE"},
    {21: "NEWFLAG"},
])
def test_renamed_or_renumbered_known_flag_is_rejected(change):
    names = {b: n for n, b in SPEC_FLAG_BITS.items()}
    if UNKNOWN_BIT in change:
        del names[SPEC_FLAG_BITS[change[UNKNOWN_BIT]]]
    with pytest.raises(UnsupportedLayoutError):
        cutout.check_flag_definitions(flags_header(names | change))


@pytest.fixture(scope="module")
def plain_exposure() -> tuple[np.ndarray, np.ndarray, fits.Header]:
    return open_exposure(make_exposure((TARGET_RA, TARGET_DEC), STAR, rot_deg=37.0, seed=3))


def test_background_ignores_source_flagged_pixels(plain_exposure):
    image, flags, header = plain_exposure
    image = image.copy()
    flags = flags.copy()
    sx, sy = make_wcs(header).all_world2pix(*STAR, 0)
    yy, xx = np.mgrid[0:N, 0:N]
    near_star = (xx - sx) ** 2 + (yy - sy) ** 2 <= 8**2
    extended = xx < 0.45 * N
    flags[near_star | extended] |= 1 << SOURCE
    image[extended] += 0.15
    image[5, 250:260] = np.nan
    assert cutout.estimate_background(image, flags) == pytest.approx(0.25, abs=0.005)


def test_background_falls_back_to_non_bad_pixels(plain_exposure):
    image, _, _ = plain_exposure
    flags = np.full(image.shape, 1 << SOURCE, dtype=np.int32)
    assert cutout.estimate_background(image, flags) == pytest.approx(0.25, abs=0.005)


def test_background_nan_without_usable_pixel(plain_exposure):
    image, _, _ = plain_exposure
    assert np.isnan(cutout.estimate_background(image, np.full(image.shape, 1 << HOT, np.int32)))
    assert np.isnan(cutout.estimate_background(np.full((20, 20), np.nan, np.float32),
                                               np.zeros((20, 20), np.int32)))


def test_background_is_sigma_clipped():
    rng = np.random.default_rng(7)
    image = rng.normal(0.25, 0.1, (N, N)).astype(np.float32)
    outliers = rng.random((N, N)) < 0.1
    image[outliers] += 3.0
    assert np.median(image) > 0.25 + 0.01
    background = cutout.estimate_background(image, np.zeros((N, N), np.int32))
    assert background == pytest.approx(0.25, abs=0.003)


@pytest.mark.parametrize("bit", list(SPEC_FLAG_BITS.values()) + [UNKNOWN_BIT])
def test_align_masks_exactly_the_bad_bits(plain_exposure, bit):
    image, flags, header = plain_exposure
    wcs = make_wcs(header)
    flags = flags.copy()
    x, y = detector_pixel_of(wcs, 15.0, 15.0)
    flags[y, x] = 1 << bit
    out = cutout.align(window_for(image, flags, wcs), TARGET, TARGET_SHAPE)
    assert np.isnan(out).any() == (bit in SPEC_BAD_BITS)


def test_align_without_background_is_all_nan(plain_exposure):
    image, flags, header = plain_exposure
    window = window_for(image, np.full(flags.shape, 1 << HOT, np.int32), make_wcs(header))
    out = cutout.align(window, TARGET, TARGET_SHAPE)
    assert out.shape == TARGET_SHAPE
    assert np.isnan(out).all()


HOT_GRID_PIXEL = (15.0, 44.0)


@pytest.fixture(scope="module")
def hot_exposure() -> tuple[np.ndarray, np.ndarray, WCS, tuple[int, int]]:
    wcs_probe = make_wcs(open_exposure(
        make_exposure((TARGET_RA, TARGET_DEC), STAR, rot_deg=201.0, seed=4))[2])
    hx, hy = detector_pixel_of(wcs_probe, *HOT_GRID_PIXEL)
    blob = make_exposure((TARGET_RA, TARGET_DEC), STAR, rot_deg=201.0, bad=[(hx, hy, HOT)], seed=4)
    image, flags, header = open_exposure(blob)
    assert flags[hy, hx] == 1 << HOT and image[hy, hx] > 1000
    return image, flags, make_wcs(header), (hx, hy)


def test_flagged_hot_pixel_is_masked(hot_exposure):
    image, flags, wcs, _ = hot_exposure
    out = cutout.align(window_for(image, flags, wcs), TARGET, TARGET_SHAPE)
    assert out.dtype == np.float32
    assert out.shape == TARGET_SHAPE
    assert np.nanmax(out) <= 50.0 + 0.1
    ys, xs = np.nonzero(np.isnan(out))
    assert 0 < len(xs) <= 9
    assert xs.max() - xs.min() <= 2 and ys.max() - ys.min() <= 2
    assert abs(xs.mean() - HOT_GRID_PIXEL[0]) <= 1.5 and abs(ys.mean() - HOT_GRID_PIXEL[1]) <= 1.5


def test_unflagged_hot_pixel_is_kept(hot_exposure):
    image, flags, wcs, (hx, hy) = hot_exposure
    flags = flags.copy()
    flags[hy, hx] = 0
    out = cutout.align(window_for(image, flags, wcs), TARGET, TARGET_SHAPE)
    assert not np.isnan(out).any()
    assert np.nanmax(out) > 100


ALIGN_CASES = [
    (37.0, (0.01, 0.02)),
    (201.0, (-0.03, 0.01)),
    (-80.0, (0.05, -0.04)),
    (37.0, (0.0, 0.24)),
    (201.0, (-0.16, 0.24)),
    (-80.0, (0.24, 0.16)),
]


@pytest.mark.parametrize("sip", [True, False])
@pytest.mark.parametrize(("rot_deg", "offset"), ALIGN_CASES)
def test_star_lands_on_target_pixel(rot_deg, offset, sip):
    center = (TARGET_RA + offset[0], TARGET_DEC + offset[1])
    image, flags, header = open_exposure(
        make_exposure(center, STAR, rot_deg=rot_deg, sip=sip, seed=int(rot_deg) % 97))
    wcs = make_wcs(header)
    assert (wcs.sip is not None) == sip
    out = cutout.align(window_for(image, flags, wcs), TARGET, TARGET_SHAPE)
    x, y = fit_centroid(out, *STAR_PIXEL)
    assert np.hypot(x - STAR_PIXEL[0], y - STAR_PIXEL[1]) <= 0.1


def test_sip_is_honoured():
    center = (TARGET_RA + 0.24, TARGET_DEC + 0.16)
    image, flags, header = open_exposure(make_exposure(center, STAR, rot_deg=-80.0, seed=21))
    wcs_sip = make_wcs(header)
    wcs_tan = make_wcs(strip_sip(header))
    assert wcs_tan.sip is None

    det = wcs_sip.all_world2pix(*STAR, 0)
    expected_tan = np.array(TARGET.all_world2pix(*wcs_tan.all_pix2world(*det, 0), 0), dtype=float)
    predicted_shift = np.hypot(*(expected_tan - np.array(STAR_PIXEL)))
    assert predicted_shift > 0.4

    with_sip = fit_centroid(cutout.align(window_for(image, flags, wcs_sip), TARGET, TARGET_SHAPE),
                            *STAR_PIXEL)
    without_sip = fit_centroid(
        cutout.align(window_for(image, flags, wcs_tan), TARGET, TARGET_SHAPE), *STAR_PIXEL)
    assert np.hypot(with_sip[0] - STAR_PIXEL[0], with_sip[1] - STAR_PIXEL[1]) <= 0.1
    assert np.hypot(without_sip[0] - expected_tan[0], without_sip[1] - expected_tan[1]) <= 0.1
    moved = np.hypot(without_sip[0] - with_sip[0], without_sip[1] - with_sip[1])
    assert moved > 0.5 * predicted_shift


@pytest.fixture
def stack() -> list[np.ndarray]:
    rng = np.random.default_rng(22)
    field = rng.normal(0.0, 0.5, TARGET_SHAPE)
    cutouts = [(field + rng.normal(0.0, 0.001, TARGET_SHAPE)).astype(np.float32) for _ in range(7)]
    cutouts[2][10, 20] += 1000.0
    cutouts[4][:] = np.nan
    for c in cutouts:
        c[30, 31] = np.nan
    return cutouts


def test_combine_median_ignores_outlier(stack):
    field_value = np.nanmedian([c[10, 20] for i, c in enumerate(stack) if i != 2])
    result = cutout.combine(stack)
    assert result.dtype == np.float32
    assert result.shape == TARGET_SHAPE
    assert result[10, 20] == pytest.approx(field_value, abs=0.005)
    with warnings.catch_warnings():
        warnings.simplefilter("ignore", RuntimeWarning)
        expected = np.nanmedian(np.stack(stack), axis=0)
    np.testing.assert_allclose(result, expected, rtol=0, atol=1e-6)


def test_combine_keeps_all_nan_pixel_without_warning(stack):
    with warnings.catch_warnings():
        warnings.simplefilter("error")
        result = cutout.combine(stack)
    assert np.isnan(result[30, 31])
    assert np.isnan(result).sum() == 1


def test_combine_empty_raises():
    with pytest.raises(ValueError):
        cutout.combine([])


def test_combine_shape_mismatch_raises():
    with pytest.raises(ValueError):
        cutout.combine([np.zeros((59, 59), np.float32), np.zeros((58, 59), np.float32)])


def test_align_with_core_takes_the_sky_level_from_the_core_only(plain_exposure):
    image, flags, header = plain_exposure
    wcs = make_wcs(header)
    core_window = window_for(image, flags, wcs)
    expected = cutout.align(core_window, TARGET, TARGET_SHAPE)
    ny, nx = core_window.image.shape
    core = (core_window.x0, core_window.x0 + nx, core_window.y0, core_window.y0 + ny)
    brighter = image.copy()
    outer = np.ones(image.shape, dtype=bool)
    outer[core[2]:core[3], core[0]:core[1]] = False
    brighter[outer] += 10.0
    wide = window_for(brighter, flags, wcs, margin=40)
    assert wide.image.shape[0] > ny + 50 and wide.image.shape[1] > nx + 50
    out = cutout.align(Window(image=wide.image, flags=wide.flags, wcs=wcs, x0=wide.x0,
                              y0=wide.y0, core=core), TARGET, TARGET_SHAPE)
    np.testing.assert_array_equal(out, expected)
    without_core = cutout.align(wide, TARGET, TARGET_SHAPE)
    assert np.nanmedian(expected - without_core) > 1.0
