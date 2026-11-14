"""Tests for the common target grid."""

import numpy as np
import pytest
from astropy.coordinates import SkyCoord

from spherex_viewer.grid import GRID_SHAPE, grid_shape, target_wcs


def _sky(wcs, x, y):
    ra, dec = wcs.pixel_to_world_values(x, y)
    return float(ra), float(dec)


def test_centre_pixel_is_query_position():
    wcs = target_wcs(150.0, 20.0)
    ra, dec = _sky(wcs, 29, 29)
    assert ra == pytest.approx(150.0, abs=1e-10)
    assert dec == pytest.approx(20.0, abs=1e-10)


def test_header_values():
    wcs = target_wcs(150.0, 20.0)
    assert list(wcs.wcs.ctype) == ["RA---TAN", "DEC--TAN"]
    np.testing.assert_allclose(wcs.wcs.crval, [150.0, 20.0])
    np.testing.assert_allclose(wcs.wcs.crpix, [30.0, 30.0])
    np.testing.assert_allclose(
        wcs.pixel_scale_matrix,
        [[-6.15 / 3600, 0.0], [0.0, 6.15 / 3600]],
        rtol=0,
        atol=1e-15,
    )
    assert not wcs.has_distortion


def test_plus_x_is_west_and_plus_y_is_north():
    wcs = target_wcs(150.0, 20.0)
    ra_x, dec_x = _sky(wcs, 30, 29)
    ra_y, dec_y = _sky(wcs, 29, 30)
    assert ra_x < 150.0
    assert dec_x == pytest.approx(20.0, abs=1e-6)
    assert dec_y > 20.0
    assert ra_y == pytest.approx(150.0, abs=1e-9)


def test_row_0_is_south_and_column_0_is_east():
    wcs = target_wcs(150.0, 20.0)
    assert _sky(wcs, 29, 0)[1] < 20.0
    assert _sky(wcs, 0, 29)[0] > 150.0


@pytest.mark.parametrize(("dx", "dy"), [(1, 0), (0, 1), (-1, 0), (0, -1)])
def test_pixel_scale_is_6_15_arcsec(dx, dy):
    wcs = target_wcs(150.0, 20.0)
    centre = SkyCoord(*_sky(wcs, 29, 29), unit="deg")
    neighbour = SkyCoord(*_sky(wcs, 29 + dx, 29 + dy), unit="deg")
    assert centre.separation(neighbour).arcsec == pytest.approx(6.15, rel=1e-6)


def test_grid_spans_59_pixels_of_6_15_arcsec():
    wcs = target_wcs(150.0, 20.0)
    ny, nx = GRID_SHAPE
    west = SkyCoord(*_sky(wcs, nx - 1, 29), unit="deg")
    east = SkyCoord(*_sky(wcs, 0, 29), unit="deg")
    assert east.separation(west).arcsec == pytest.approx(58 * 6.15, rel=1e-4)
    north = SkyCoord(*_sky(wcs, 29, ny - 1), unit="deg")
    south = SkyCoord(*_sky(wcs, 29, 0), unit="deg")
    assert south.separation(north).arcsec == pytest.approx(58 * 6.15, rel=1e-4)


def test_world_to_pixel_of_query_position_is_centre():
    wcs = target_wcs(150.0, 20.0)
    x, y = wcs.world_to_pixel_values(150.0, 20.0)
    assert float(x) == pytest.approx(29.0, abs=1e-9)
    assert float(y) == pytest.approx(29.0, abs=1e-9)


def test_wide_centre_pixel_is_query_position():
    wcs = target_wcs(150.0, 20.0, 3)
    assert wcs.array_shape == (177, 177)
    ra, dec = _sky(wcs, 88, 88)
    assert ra == pytest.approx(150.0, abs=1e-10)
    assert dec == pytest.approx(20.0, abs=1e-10)


@pytest.mark.parametrize(("ra", "dec"), [(150.0, 20.0), (0.01, -7.2), (269.4, 88.9)])
def test_wide_central_field_is_the_narrow_grid(ra, dec):
    rows, cols = np.mgrid[0:59, 0:59]
    narrow = target_wcs(ra, dec).pixel_to_world_values(cols, rows)
    wide = target_wcs(ra, dec, 3).pixel_to_world_values(cols + 59, rows + 59)
    ra_diff = (wide[0] - narrow[0] + 180.0) % 360.0 - 180.0
    assert np.max(np.abs(ra_diff)) <= 1e-9
    assert np.max(np.abs(wide[1] - narrow[1])) <= 1e-9


def test_grid_shape():
    assert grid_shape(1) == GRID_SHAPE == (59, 59)
    assert grid_shape(3) == (177, 177)
    for fields in (0, 2, 9):
        with pytest.raises(ValueError):
            grid_shape(fields)
