"""Tests for archive discovery: URI validation, the SIA query, TSV parsing and the request."""

import httpx
import pytest

from spherex_viewer import discovery
from spherex_viewer.discovery import (
    DETECTORS,
    MAX_URI_LENGTH,
    SIA_URL,
    DiscoveryError,
    Exposure,
    discover,
    is_valid_uri,
    parse_tsv,
    sia_params,
)

DR1_URI = (
    "ibe/data/spherex/dr1/level2/2025W19_1B/l2b-v27-2026-197/3/"
    "level2_2025W19_1B_0116_1D3_spx_l2b-v27-2026-197.fits"
)
QR3_URI = (
    "ibe/data/spherex/qr3/level2/2026W20_2A/l2b-v27-2026-267/2/"
    "level2_2026W20_2A_0047_1D2_spx_l2b-v27-2026-267.fits"
)
PREFIX = "https://irsa.ipac.caltech.edu/"
COLUMNS = (
    "s_ra s_dec facility_name instrument_name dataproduct_subtype calib_level dataproduct_type "
    "energy_bandpassname energy_emband obs_id s_resolution em_min em_max em_res_power "
    "proposal_title access_url access_format access_estsize t_exptime s_region obs_collection "
    "obs_intent algorithm_name facility_keywords instrument_keywords environment_photometric "
    "proposal_id proposal_pi proposal_project target_name target_type target_standard "
    "target_moving target_keywords obs_release_date s_xel1 s_xel2 s_pixel_scale "
    "position_timedependent t_min t_max t_resolution t_xel obs_publisher_did s_fov em_xel "
    "pol_states pol_xel cloud_access o_ucd upload_row_id"
).split()
HEADER = "\t".join(COLUMNS)
# [em_min, em_max] in metres of every exposure of each detector, as served by IRSA.
EM_RANGES = {"D1": (7.455e-07, 1.1167e-06), "D2": (1.1033e-06, 1.6499e-06),
             "D3": (1.6301e-06, 2.4346e-06), "D4": (2.4027e-06, 3.8473e-06),
             "D5": (3.8113e-06, 4.43e-06), "D6": (4.4115e-06, 5.0096e-06)}


def row(url: str, mjd: object, band: str = "SPHEREx-D2", collection: str = "spherex_dr1") -> str:
    values = dict.fromkeys(COLUMNS, "")
    values.update(access_url=url, t_min=str(mjd), energy_bandpassname=band,
                  obs_collection=collection, s_region="POLYGON ICRS 1 2 3 4 5 6 1 2",
                  cloud_access='{"aws": {"bucket_name": "nasa-irsa-spherex", "key":"x"}}')
    return "\t".join(values[c] for c in COLUMNS)


def tsv(*rows: str) -> str:
    return "".join(line + "\n" for line in (HEADER, *rows))


def parse(text: str, detector: str = "D2") -> list[Exposure]:
    return parse_tsv(text.encode().splitlines(), detector)


def _uri(release: str, i: int) -> str:
    return f"ibe/data/spherex/{release}/level2/2025W19_1B/l2b-v27/2/level2_{i:04d}_1D2.fits"


@pytest.fixture
def no_sleep(monkeypatch):
    sleeps = []
    monkeypatch.setattr("time.sleep", lambda s: sleeps.append(s))
    return sleeps


@pytest.mark.parametrize(
    "uri",
    [DR1_URI, QR3_URI, "ibe/data/spherex/dr1/level2/a..b.fits",
     "ibe/data/spherex/x9/level2/f.fits", "ibe/data/spherex/dr1/level2/.a/x.fits"],
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
        DR1_URI + "\n",
        DR1_URI + "\nibe/data/spherex/dr1/level2/x.fits",
        "ibe/data/spherex/dr1/level2/./x.fits",
        "ibe/data/spherex/dr1/level2/a/./b/x.fits",
        "ibe/data/spherex/dr1/level2/a/../x.fits",
    ],
)
def test_is_valid_uri_rejects(uri):
    assert not is_valid_uri(uri)


def test_is_valid_uri_length_limit():
    prefix = "ibe/data/spherex/dr1/level2/"
    longest = prefix + "a" * (MAX_URI_LENGTH - len(prefix) - len(".fits")) + ".fits"
    assert len(longest) == MAX_URI_LENGTH == 300
    assert is_valid_uri(longest)
    assert not is_valid_uri(longest.replace("/a", "/aa", 1))
    assert not is_valid_uri(prefix + "a" * 60000 + ".fits")


def test_sia_params_point_query_over_all_spherex_collections():
    params = sia_params(133.795129, -7.245147, "D3")
    assert dict(params) == {"POS": "circle 133.795129 -7.245147 0", "INSTRUMENT": "SPHEREx",
                            "BAND": "2.02e-06", "RESPONSEFORMAT": "TSV"}
    assert "COLLECTION" not in dict(params)


def test_sia_params_uses_repr_of_coordinates():
    ra, dec = 0.1 + 0.2, -1e-07
    assert dict(sia_params(ra, dec, "D2"))["POS"] == f"circle {ra!r} {dec!r} 0"


@pytest.mark.parametrize("detector", DETECTORS)
def test_band_lies_in_this_detector_only(detector):
    band = float(dict(sia_params(10.0, 20.0, detector))["BAND"])
    for other, (em_min, em_max) in EM_RANGES.items():
        assert (em_min <= band <= em_max) == (other == detector)


@pytest.mark.parametrize("detector", ["D7", "D0", "d2", "", "SPHEREx-D2"])
def test_sia_params_rejects_unknown_detector(detector):
    with pytest.raises(ValueError):
        sia_params(133.795129, -7.245147, detector)


def test_parse_sorts_shuffled_dr1_and_qr3_rows():
    rows = [
        (_uri("qr3", 4), 61200.5),
        (_uri("dr1", 1), 60801.25),
        (_uri("qr3", 3), 61190.0),
        (_uri("dr1", 0), 60801.1066),
        (_uri("dr1", 2), 60986.24),
    ]
    result = parse(tsv(*(row(PREFIX + u, repr(m)) for u, m in rows)))
    assert result == [Exposure(u, m) for u, m in sorted(rows, key=lambda r: r[1])]
    assert all(isinstance(e.mjd, float) for e in result)


def test_parse_keeps_only_the_requested_detector():
    text = tsv(row(PREFIX + _uri("dr1", 0), 60801.0, band="SPHEREx-D1"),
               row(PREFIX + _uri("dr1", 1), 60802.0, band="SPHEREx-D2"),
               row(PREFIX + "ibe/data/spherex/dr1/level3/cube.fits", 60800.0, band="SPHEREx",
                   collection="spherex_dr1_cube"),
               row(PREFIX + _uri("dr1", 3), 60803.0, band="SPHEREx-D3"))
    assert parse(text, "D2") == [Exposure(_uri("dr1", 1), 60802.0)]
    assert parse(text, "D4") == []


def test_parse_header_only_is_empty():
    assert parse(tsv()) == []


@pytest.mark.parametrize(
    "header",
    ["", HEADER.replace("t_min", "t_max_"), HEADER.replace("access_url", "uri"),
     HEADER.replace("energy_bandpassname", "band"), HEADER.replace("\t", ",")],
)
def test_parse_rejects_wrong_header(header):
    with pytest.raises(DiscoveryError):
        parse(f"{header}\n{row(PREFIX + DR1_URI, 60801.1)}\n")


def test_parse_rejects_empty_body():
    with pytest.raises(DiscoveryError):
        parse("")


def test_parse_rejects_error_document():
    body = ('<?xml version="1.0"?>\n<VOTABLE><RESOURCE type="results">'
            '<INFO name="QUERY_STATUS" value="ERROR">Invalid POS</INFO></RESOURCE></VOTABLE>\n')
    with pytest.raises(DiscoveryError):
        parse(body)


@pytest.mark.parametrize(
    "url",
    [PREFIX + "ibe/data/spherex/dr1/level2/../x.fits", "https://example.com/" + DR1_URI,
     DR1_URI, "not-a-uri", "http://irsa.ipac.caltech.edu/" + DR1_URI],
)
def test_parse_rejects_bad_url(url):
    with pytest.raises(DiscoveryError):
        parse(tsv(row(PREFIX + DR1_URI, 60801.1), row(url, 60802.0)))


@pytest.mark.parametrize("mjd", ["abc", "", "nan", "inf", "-inf", "1e999"])
def test_parse_rejects_bad_time(mjd):
    with pytest.raises(DiscoveryError):
        parse(tsv(row(PREFIX + DR1_URI, mjd)))


@pytest.mark.parametrize("change", [lambda r: r + "\textra", lambda r: r.rsplit("\t", 1)[0]])
def test_parse_rejects_wrong_field_count(change):
    with pytest.raises(DiscoveryError):
        parse(tsv(change(row(PREFIX + DR1_URI, 60801.1))))


def test_parse_rejects_invalid_utf8():
    lines = [HEADER.encode(), row(PREFIX + DR1_URI, 60801.1).encode() + b"\xff"]
    with pytest.raises(DiscoveryError):
        parse_tsv(lines, "D2")


def _client(responses, requests):
    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        item = responses[len(requests) - 1]
        if isinstance(item, Exception):
            raise item
        status, body = item
        if isinstance(body, httpx.SyncByteStream):
            return httpx.Response(status, stream=body)
        return httpx.Response(status, text=body)

    return httpx.Client(transport=httpx.MockTransport(handler))


class Chunks(httpx.SyncByteStream):
    """Response body delivered in the given chunks; an exception item is raised mid-stream."""

    def __init__(self, *chunks):
        self.chunks = chunks

    def __iter__(self):
        for chunk in self.chunks:
            if isinstance(chunk, Exception):
                raise chunk
            yield chunk


PROXY_ERROR = "<html><head><title>502 Proxy Error</title></head><body>Proxy Error</body></html>"
BODY = tsv(row(PREFIX + QR3_URI, 61200.0), row(PREFIX + DR1_URI.replace("1D3", "1D2"), 60801.1066))
EXPECTED = [Exposure(DR1_URI.replace("1D3", "1D2"), 60801.1066), Exposure(QR3_URI, 61200.0)]


def test_discover_sends_query_and_parses(no_sleep):
    requests = []
    with _client([(200, BODY)], requests) as client:
        result = discover(client, 133.795129, -7.245147, "D2")
    assert result == EXPECTED
    assert len(requests) == 1
    request = requests[0]
    assert request.method == "GET"
    url = request.url
    assert f"{url.scheme}://{url.host}{url.path}" == SIA_URL
    assert list(url.params.multi_items()) == sia_params(133.795129, -7.245147, "D2")
    timeout = request.extensions["timeout"]
    assert timeout == {"connect": 5, "read": 10, "write": 5, "pool": 5}
    assert no_sleep == []


def test_discover_reassembles_lines_split_across_chunks(no_sleep):
    data = BODY.encode()
    chunks = [data[i:i + 7] for i in range(0, len(data), 7)]
    with _client([(200, Chunks(*chunks))], []) as client:
        assert discover(client, 133.795129, -7.245147, "D2") == EXPECTED


def test_discover_rejects_oversized_response(no_sleep, monkeypatch):
    monkeypatch.setattr(discovery, "MAX_RESPONSE_BYTES", len(BODY) - 1)
    requests = []
    with _client([(200, BODY), (200, BODY)], requests) as client:
        with pytest.raises(DiscoveryError):
            discover(client, 133.795129, -7.245147, "D2")
    assert len(requests) == 1


def test_discover_stops_reading_past_the_cap(no_sleep):
    class Oversized(httpx.SyncByteStream):
        """Sends far more than the cap; stops eventually so a missing cap fails, not hangs."""

        def __init__(self):
            self.sent = 0

        def __iter__(self):
            yield HEADER.encode() + b"\n"
            while self.sent < discovery.MAX_RESPONSE_BYTES + 8 * 2**20:
                self.sent += 2**20
                yield b"x" * 2**20

    stream = Oversized()
    with _client([(200, stream)], []) as client:
        with pytest.raises(DiscoveryError):
            discover(client, 133.795129, -7.245147, "D2")
    assert stream.sent <= discovery.MAX_RESPONSE_BYTES + 2**20


def test_discover_retries_after_503(no_sleep):
    requests = []
    with _client([(503, "busy"), (200, BODY)], requests) as client:
        result = discover(client, 133.795129, -7.245147, "D2")
    assert result == EXPECTED
    assert len(requests) == 2
    assert no_sleep == [1]


def test_discover_survives_four_gateway_errors(no_sleep):
    requests = []
    with _client([(502, PROXY_ERROR)] * 4 + [(200, BODY)], requests) as client:
        result = discover(client, 133.795129, -7.245147, "D2")
    assert result == EXPECTED
    assert len(requests) == 5
    assert no_sleep == [1, 2, 3, 4]


def test_discover_retries_after_transport_error(no_sleep):
    requests = []
    responses = [httpx.ConnectError("refused"), (200, BODY)]
    with _client(responses, requests) as client:
        result = discover(client, 133.795129, -7.245147, "D2")
    assert result == EXPECTED
    assert len(requests) == 2
    assert no_sleep == [1]


def test_discover_retries_after_error_mid_body(no_sleep):
    requests = []
    broken = Chunks(BODY.encode()[:100], httpx.ReadError("reset"))
    with _client([(200, broken), (200, BODY)], requests) as client:
        result = discover(client, 133.795129, -7.245147, "D2")
    assert result == EXPECTED
    assert len(requests) == 2


def test_discover_fails_after_five_gateway_errors(no_sleep):
    requests = []
    with _client([(502, PROXY_ERROR)] * 5 + [(200, BODY)], requests) as client:
        with pytest.raises(DiscoveryError, match="HTTP 502"):
            discover(client, 133.795129, -7.245147, "D2")
    assert len(requests) == 5


class Clock:
    """Simulated ``time.monotonic``/``time.sleep``; mock requests advance it to model stalls."""

    def __init__(self):
        self.now = 1000.0
        self.sleeps = []

    def sleep(self, seconds):
        self.sleeps.append(seconds)
        self.now += seconds


@pytest.fixture
def clock(monkeypatch):
    clock = Clock()
    monkeypatch.setattr("time.monotonic", lambda: clock.now)
    monkeypatch.setattr("time.sleep", clock.sleep)
    return clock


def _stalling_client(clock, stall_s, outcome, requests):
    """Each request takes ``stall_s`` simulated seconds, then ``outcome`` happens."""

    def handler(request):
        requests.append(clock.now)
        clock.now += stall_s
        if isinstance(outcome, Exception):
            raise outcome
        return httpx.Response(outcome, text=PROXY_ERROR)

    return httpx.Client(transport=httpx.MockTransport(handler))


@pytest.mark.parametrize("stall_s", [0.1, 4.0, 9.9, 16.0, 25.0])
@pytest.mark.parametrize("outcome", [502, httpx.ReadTimeout("stalled")])
def test_discover_ends_within_the_budget_when_every_attempt_fails(clock, stall_s, outcome):
    requests = []
    start = clock.now
    with _stalling_client(clock, stall_s, outcome, requests) as client:
        with pytest.raises(DiscoveryError):
            discover(client, 133.795129, -7.245147, "D2")
    assert clock.now - start <= 45
    assert all(t - start <= 20 for t in requests)


def test_discover_does_not_retry_after_the_last_start(clock):
    requests = []
    with _stalling_client(clock, 9.0, httpx.ReadTimeout("stalled"), requests) as client:
        with pytest.raises(DiscoveryError, match="could not be reached"):
            discover(client, 133.795129, -7.245147, "D2")
    assert len(requests) == 2
    assert clock.sleeps == [1]


def test_discover_stops_a_trickling_response_within_the_budget(clock):
    class Trickle(httpx.SyncByteStream):
        """A valid body whose every chunk arrives 9 s after the previous one (180 s in all)."""

        def __iter__(self):
            yield HEADER.encode() + b"\n"
            for _ in range(20):
                clock.now += 9.0
                yield row(PREFIX + DR1_URI, 60801.1).encode() + b"\n"

    start = clock.now
    with _client([(200, Trickle())], []) as client:
        with pytest.raises(DiscoveryError, match="too slowly"):
            discover(client, 133.795129, -7.245147, "D2")
    assert clock.now - start <= 45


def test_discover_fails_at_once_on_400(no_sleep):
    requests = []
    with _client([(400, "bad query"), (200, BODY)], requests) as client:
        with pytest.raises(DiscoveryError):
            discover(client, 133.795129, -7.245147, "D2")
    assert len(requests) == 1
    assert no_sleep == []


@pytest.mark.parametrize("body", ["<html>maintenance</html>\n", ""])
def test_discover_fails_on_unparsable_body(no_sleep, body):
    requests = []
    with _client([(200, body), (200, BODY)], requests) as client:
        with pytest.raises(DiscoveryError):
            discover(client, 133.795129, -7.245147, "D2")
    assert len(requests) == 1


def test_discover_is_not_cached(no_sleep):
    requests = []
    with _client([(200, BODY), (200, BODY)], requests) as client:
        discover(client, 133.795129, -7.245147, "D2")
        discover(client, 133.795129, -7.245147, "D2")
    assert len(requests) == 2
