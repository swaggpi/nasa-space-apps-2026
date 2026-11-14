"""Tests for archive discovery (DESIGN.md section 3, discovery.py; test-plan rows 3-5)."""

import httpx
import pytest

from spherex_viewer.discovery import (
    DETECTORS,
    TAP_URL,
    DiscoveryError,
    Exposure,
    build_adql,
    discover,
    is_valid_uri,
    parse_csv,
)

DR1_URI = (
    "ibe/data/spherex/dr1/level2/2025W19_1B/l2b-v27-2026-197/3/"
    "level2_2025W19_1B_0116_1D3_spx_l2b-v27-2026-197.fits"
)
QR3_URI = (
    "ibe/data/spherex/qr3/level2/2026W20_2A/l2b-v27-2026-267/2/"
    "level2_2026W20_2A_0047_1D2_spx_l2b-v27-2026-267.fits"
)
CONTRACT_ADQL_D3 = (
    "SELECT a.uri, p.time_bounds_lower FROM spherex.artifact a JOIN spherex.plane p "
    "ON a.planeid = p.planeid WHERE 1 = CONTAINS(POINT('ICRS', 133.795129, -7.245147), p.poly) "
    "AND p.energy_bandpassname = 'SPHEREx-D3' ORDER BY p.time_bounds_lower"
)


def _uri(release: str, i: int) -> str:
    return f"ibe/data/spherex/{release}/level2/2025W19_1B/l2b-v27/3/level2_{i:04d}_1D3.fits"


@pytest.fixture
def no_sleep(monkeypatch):
    sleeps = []
    monkeypatch.setattr("time.sleep", lambda s: sleeps.append(s))
    return sleeps


@pytest.mark.parametrize(
    "uri",
    [DR1_URI, QR3_URI, "ibe/data/spherex/dr1/level2/a..b.fits", "ibe/data/spherex/x9/level2/f.fits"],
)
def test_is_valid_uri_accepts(uri):
    assert is_valid_uri(uri)


@pytest.mark.parametrize(
    "uri",
    [
        "",
        "ibe/data/spherex/dr1/level2/../../../etc/passwd.fits",
        "ibe/data/spherex/dr1/level2/2025W19_1B/../x.fits",
        "ibe/data/spherex/dr1/level2/..",
        "https://nasa-irsa-spherex.s3.us-east-1.amazonaws.com/dr1/level2/x.fits",
        "/ibe/data/spherex/dr1/level2/x.fits",
        "ibe/data/spherex/DR1/level2/x.fits",
        "ibe/data/spherex/dr1/level1/x.fits",
        "ibe/data/spherex/dr1/level2/x.fits.gz",
        "ibe/data/spherex/dr1/level2/x y.fits",
        "ibe/data/spherex/dr1/level2/x.fits?a=b",
    ],
)
def test_is_valid_uri_rejects(uri):
    assert not is_valid_uri(uri)


def test_build_adql_equals_contract_query():
    assert build_adql(133.795129, -7.245147, "D3") == CONTRACT_ADQL_D3


def test_build_adql_uses_repr_of_coordinates():
    ra, dec = 0.1 + 0.2, -1e-07
    adql = build_adql(ra, dec, "D2")
    assert f"POINT('ICRS', {ra!r}, {dec!r})" in adql
    assert "'SPHEREx-D2'" in adql


@pytest.mark.parametrize("detector", DETECTORS)
def test_build_adql_accepts_every_detector(detector):
    assert f"p.energy_bandpassname = 'SPHEREx-{detector}'" in build_adql(10.0, 20.0, detector)


def test_detectors_are_d1_to_d6():
    assert DETECTORS == ("D1", "D2", "D3", "D4", "D5", "D6")


@pytest.mark.parametrize("detector", ["D7", "D0", "d2", "", "SPHEREx-D2"])
def test_build_adql_rejects_unknown_detector(detector):
    with pytest.raises(ValueError):
        build_adql(133.795129, -7.245147, detector)


def test_parse_csv_sorts_shuffled_dr1_and_qr3_rows():
    rows = [
        (_uri("qr3", 4), 61200.5),
        (_uri("dr1", 1), 60801.25),
        (_uri("qr3", 3), 61190.0),
        (_uri("dr1", 0), 60801.1066),
        (_uri("dr1", 2), 60986.24),
    ]
    text = "uri,time_bounds_lower\n" + "".join(f"{u},{m!r}\n" for u, m in rows)
    result = parse_csv(text)
    expected = [Exposure(u, m) for u, m in sorted(rows, key=lambda r: r[1])]
    assert result == expected
    assert all(isinstance(e.mjd, float) for e in result)


def test_parse_csv_header_only_is_empty():
    assert parse_csv("uri,time_bounds_lower\n") == []


@pytest.mark.parametrize(
    "header", ["uri,mjd", "time_bounds_lower,uri", "uri", "a.uri,p.time_bounds_lower", ""]
)
def test_parse_csv_rejects_wrong_header(header):
    with pytest.raises(DiscoveryError):
        parse_csv(f"{header}\n{DR1_URI},60801.1\n")


@pytest.mark.parametrize(
    "uri", ["ibe/data/spherex/dr1/level2/../x.fits", "https://example.com/x.fits", "not-a-uri"]
)
def test_parse_csv_rejects_bad_uri(uri):
    with pytest.raises(DiscoveryError):
        parse_csv(f"uri,time_bounds_lower\n{DR1_URI},60801.1\n{uri},60802.0\n")


@pytest.mark.parametrize("row", [f"{DR1_URI},abc", f"{DR1_URI}", f"{DR1_URI},"])
def test_parse_csv_rejects_bad_row(row):
    with pytest.raises(DiscoveryError):
        parse_csv(f"uri,time_bounds_lower\n{row}\n")


def test_discovery_error_is_runtime_error():
    assert issubclass(DiscoveryError, RuntimeError)


def _client(responses, requests):
    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        item = responses[len(requests) - 1]
        if isinstance(item, Exception):
            raise item
        status, body = item
        return httpx.Response(status, text=body)

    return httpx.Client(transport=httpx.MockTransport(handler))


CSV_BODY = f"uri,time_bounds_lower\n{QR3_URI},61200.0\n{DR1_URI},60801.1066\n"
EXPECTED = [Exposure(DR1_URI, 60801.1066), Exposure(QR3_URI, 61200.0)]


def test_discover_sends_query_and_parses(no_sleep):
    requests = []
    with _client([(200, CSV_BODY)], requests) as client:
        result = discover(client, 133.795129, -7.245147, "D3")
    assert result == EXPECTED
    assert len(requests) == 1
    request = requests[0]
    assert request.method == "GET"
    url = request.url
    assert f"{url.scheme}://{url.host}{url.path}" == TAP_URL
    assert url.params["QUERY"] == build_adql(133.795129, -7.245147, "D3")
    assert url.params["FORMAT"] == "CSV"
    timeout = request.extensions["timeout"]
    assert timeout["connect"] == 10
    assert timeout["read"] == 120
    assert no_sleep == []


def test_discover_retries_once_after_503(no_sleep):
    requests = []
    with _client([(503, "busy"), (200, CSV_BODY)], requests) as client:
        result = discover(client, 133.795129, -7.245147, "D2")
    assert result == EXPECTED
    assert len(requests) == 2
    assert no_sleep == [2]


def test_discover_retries_once_after_transport_error(no_sleep):
    requests = []
    responses = [httpx.ConnectError("refused"), (200, CSV_BODY)]
    with _client(responses, requests) as client:
        result = discover(client, 133.795129, -7.245147, "D2")
    assert result == EXPECTED
    assert len(requests) == 2
    assert no_sleep == [2]


def test_discover_fails_after_two_500s(no_sleep):
    requests = []
    with _client([(500, "error"), (500, "error"), (200, CSV_BODY)], requests) as client:
        with pytest.raises(DiscoveryError):
            discover(client, 133.795129, -7.245147, "D2")
    assert len(requests) == 2


def test_discover_fails_at_once_on_400(no_sleep):
    requests = []
    with _client([(400, "bad query"), (200, CSV_BODY)], requests) as client:
        with pytest.raises(DiscoveryError):
            discover(client, 133.795129, -7.245147, "D2")
    assert len(requests) == 1
    assert no_sleep == []


def test_discover_fails_on_unparsable_body(no_sleep):
    requests = []
    with _client([(200, "<html>maintenance</html>\n")], requests) as client:
        with pytest.raises(DiscoveryError):
            discover(client, 133.795129, -7.245147, "D2")


def test_discover_is_not_cached(no_sleep):
    requests = []
    with _client([(200, CSV_BODY), (200, CSV_BODY)], requests) as client:
        discover(client, 133.795129, -7.245147, "D2")
        discover(client, 133.795129, -7.245147, "D2")
    assert len(requests) == 2
