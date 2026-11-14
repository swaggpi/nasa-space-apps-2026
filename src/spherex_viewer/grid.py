"""The common target grid every exposure is resampled onto."""

from astropy.wcs import WCS

PIXEL_SCALE_ARCSEC = 6.15
FIELD_PIXELS = 59
GRID_SHAPE = (FIELD_PIXELS, FIELD_PIXELS)
# Grids of 1 x 1 field (the frame) and 3 x 3 fields (the frame and its surround).
FIELDS = (1, 3)


def grid_shape(fields: int) -> tuple[int, int]:
    """Shape (ny, nx) of the grid of ``fields`` x ``fields`` fields; ValueError otherwise."""
    if fields not in FIELDS:
        raise ValueError(f"fields must be one of {FIELDS}, got {fields!r}")
    return (FIELD_PIXELS * fields, FIELD_PIXELS * fields)


def target_wcs(ra_deg: float, dec_deg: float, fields: int = 1) -> WCS:
    """Return the tangent-plane WCS of ``fields`` x ``fields`` fields centred on (ra, dec).

    North up, east left: row 0 is south, column 0 is east; ICRS degrees. The centre pixel,
    0-based (29, 29) for one field and (88, 88) for three, lies exactly on the query position;
    the scale is ``PIXEL_SCALE_ARCSEC`` with no rotation. Pixel (x + 59, y + 59) of the
    3-field grid is pixel (x, y) of the 1-field grid.
    """
    shape = grid_shape(fields)
    wcs = WCS(naxis=2)
    wcs.wcs.ctype = ["RA---TAN", "DEC--TAN"]
    wcs.wcs.crval = [ra_deg, dec_deg]
    wcs.wcs.crpix = [(shape[1] + 1) / 2, (shape[0] + 1) / 2]
    wcs.wcs.cdelt = [-PIXEL_SCALE_ARCSEC / 3600.0, PIXEL_SCALE_ARCSEC / 3600.0]
    wcs.wcs.radesys = "ICRS"
    wcs.array_shape = shape
    return wcs
