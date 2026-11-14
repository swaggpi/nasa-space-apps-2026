"""Tests for RA/Dec text parsing (DESIGN.md section 3, coords.py; test-plan rows 1-2)."""

import pytest

from spherex_viewer.coords import CoordinateError, parse_dec, parse_ra

RA_REF = 133.795129
DEC_REF = -7.245147


@pytest.mark.parametrize(
    "text",
    ["08h55m10.831s", "08:55:10.831", "08 55 10.831", "133.795129", "  08h55m10.831s  "],
)
def test_parse_ra_reference_forms_agree(text):
    assert parse_ra(text) == pytest.approx(RA_REF, abs=1e-6)


@pytest.mark.parametrize(
    "text",
    ["-7d14m42.53s", "-07:14:42.53", "-07 14 42.53", "-7.245147", " -7d14m42.53s "],
)
def test_parse_dec_reference_forms_agree(text):
    assert parse_dec(text) == pytest.approx(DEC_REF, abs=1e-6)


def test_parse_ra_degree_sexagesimal_form():
    assert parse_ra("133d47m42.4645s") == pytest.approx(133 + 47 / 60 + 42.4645 / 3600, abs=1e-9)


def test_parse_ra_degree_sign_form():
    assert parse_ra("133.795129°") == pytest.approx(RA_REF, abs=1e-9)


def test_parse_dec_degree_sign_form():
    assert parse_dec("-7.245147°") == pytest.approx(DEC_REF, abs=1e-9)


@pytest.mark.parametrize(
    ("text", "expected"),
    [("0", 0.0), ("359.999", 359.999), (".5", 0.5), ("+12.", 12.0), ("150", 150.0)],
)
def test_parse_ra_decimal_degrees(text, expected):
    assert parse_ra(text) == expected


@pytest.mark.parametrize(
    ("text", "expected"),
    [("90", 90.0), ("-90", -90.0), ("+20.5", 20.5), ("-.25", -0.25), ("0", 0.0)],
)
def test_parse_dec_decimal_degrees(text, expected):
    assert parse_dec(text) == expected


def test_decimal_values_are_not_rounded():
    assert parse_ra("123.456789012345") == 123.456789012345
    assert parse_dec("-12.345678901234") == -12.345678901234


@pytest.mark.parametrize("text", ["", "   ", "abc", "25h0m0s", "360", "-1"])
def test_parse_ra_rejects(text):
    with pytest.raises(CoordinateError):
        parse_ra(text)


@pytest.mark.parametrize("text", ["", "   ", "abc", "91", "-90.1", "5h", "5h0m0s"])
def test_parse_dec_rejects(text):
    with pytest.raises(CoordinateError):
        parse_dec(text)


def test_coordinate_error_is_value_error():
    assert issubclass(CoordinateError, ValueError)
