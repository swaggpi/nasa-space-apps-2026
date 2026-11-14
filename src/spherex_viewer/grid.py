"""The common target grid every exposure is resampled onto."""

from astropy.wcs import WCS

PIXEL_SCALE_ARCSEC = 6.15
GRID_SHAPE = (59, 59)


def target_wcs(ra_deg: float, dec_deg: float) -> WCS:
    """Return the tangent-plane WCS centred on (ra, dec) in ICRS degrees.

    North up, east left: row 0 is south, column 0 is east. The centre pixel (29, 29), 0-based,
    lies exactly on the query position; the scale is ``PIXEL_SCALE_ARCSEC`` with no rotation.
    """
    wcs = WCS(naxis=2)
    wcs.wcs.ctype = ["RA---TAN", "DEC--TAN"]
    wcs.wcs.crval = [ra_deg, dec_deg]
    wcs.wcs.crpix = [30.0, 30.0]
    wcs.wcs.cdelt = [-PIXEL_SCALE_ARCSEC / 3600.0, PIXEL_SCALE_ARCSEC / 3600.0]
    wcs.wcs.radesys = "ICRS"
    wcs.array_shape = GRID_SHAPE
    return wcs
