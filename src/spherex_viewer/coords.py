"""Parsing of RA/Dec text (decimal degrees or sexagesimal) into ICRS degrees."""

import re

import astropy.units as u
from astropy.coordinates import Angle

_DECIMAL = re.compile(r"^[+-]?(\d+\.?\d*|\.\d+)$")


class CoordinateError(ValueError):
    """Raised when a coordinate text cannot be parsed or is out of range."""


def _to_degrees(name: str, text: str, unit: str | None) -> float:
    try:
        angle = Angle(text) if unit is None else Angle(text, unit=unit)
    except (ValueError, OverflowError, u.UnitsError) as exc:
        raise CoordinateError(f"Cannot parse {name}.") from exc
    # 24h converts to 359.99999999999994 degrees, so hours are range-checked as hours.
    if angle.unit == u.hourangle and not angle.hour < 24.0:
        raise CoordinateError(f"{name} is outside 0 to 24 hours.")
    return float(angle.degree)


def parse_ra(text: str) -> float:
    """Parse right ascension text to degrees, 0 <= ra < 360.

    Decimal numbers are degrees; text with ``h`` or ``d``/``°`` is parsed by astropy with its
    units; other sexagesimal forms (colons or spaces) are hours.
    """
    text = text.strip()
    if not text:
        raise CoordinateError("RA is empty.")
    if _DECIMAL.match(text):
        ra = float(text)
    elif "h" in text or "d" in text or "°" in text:
        ra = _to_degrees("RA", text, None)
    else:
        ra = _to_degrees("RA", text, "hourangle")
    if not 0.0 <= ra < 360.0:
        raise CoordinateError("RA is outside 0 to 360 degrees.")
    return ra


def parse_dec(text: str) -> float:
    """Parse declination text to degrees, -90 <= dec <= 90.

    Decimal numbers are degrees; text with ``d``/``°`` is parsed by astropy with its units;
    other sexagesimal forms (colons or spaces) are degrees; hours are rejected.
    """
    text = text.strip()
    if not text:
        raise CoordinateError("Dec is empty.")
    if _DECIMAL.match(text):
        dec = float(text)
    elif "h" in text:
        raise CoordinateError("Dec must not be given in hours.")
    elif "d" in text or "°" in text:
        dec = _to_degrees("Dec", text, None)
    else:
        dec = _to_degrees("Dec", text, "deg")
    if not -90.0 <= dec <= 90.0:
        raise CoordinateError("Dec is outside -90 to +90 degrees.")
    return dec
