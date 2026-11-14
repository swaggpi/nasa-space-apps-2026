"""Tests of the per-client token-bucket rate limiter, with an injected clock."""

import pytest

from spherex_viewer.ratelimit import (
    FRAME_BURST,
    FRAME_PER_MINUTE,
    INVALID_ADDRESS_KEY,
    SEARCH_BURST,
    SEARCH_PER_MINUTE,
    WIDE_BURST,
    WIDE_PER_MINUTE,
    RateLimiter,
    client_key,
)


class Clock:
    def __init__(self) -> None:
        self.now = 1000.0

    def __call__(self) -> float:
        return self.now


@pytest.fixture
def clock() -> Clock:
    return Clock()


def test_burst_is_granted_then_refused(clock):
    limiter = RateLimiter(10, 2.0, clock=clock)
    assert [limiter.take("a") for _ in range(10)] == [0] * 10
    assert limiter.take("a") == 30


def test_tokens_refill_at_the_given_rate(clock):
    limiter = RateLimiter(2, 6.0, clock=clock)
    assert [limiter.take("a") for _ in range(3)] == [0, 0, 10]
    clock.now += 4.0
    assert limiter.take("a") == 6
    clock.now += 6.0
    assert limiter.take("a") == 0
    assert limiter.take("a") == 10


def test_retry_after_is_rounded_up_to_whole_seconds(clock):
    limiter = RateLimiter(1, 2.0, clock=clock)
    assert limiter.take("a") == 0
    clock.now += 29.5
    assert limiter.take("a") == 1
    clock.now += 1.0
    assert limiter.take("a") == 0


def test_refill_does_not_exceed_the_burst(clock):
    limiter = RateLimiter(3, 60.0, clock=clock)
    limiter.take("a")
    clock.now += 3600.0
    assert [limiter.take("a") for _ in range(4)] == [0, 0, 0, 1]


def test_clients_have_separate_budgets(clock):
    limiter = RateLimiter(1, 1.0, clock=clock)
    assert limiter.take("a") == 0
    assert limiter.take("a") == 60
    assert limiter.take("b") == 0


def test_idle_clients_are_pruned(clock):
    limiter = RateLimiter(2, 6.0, clock=clock)
    limiter.take("a")
    clock.now += 15.0
    limiter.take("b")
    assert len(limiter) == 2
    clock.now += 5.0
    limiter.take("c")
    assert len(limiter) == 2
    clock.now += 20.0
    limiter.take("d")
    assert len(limiter) == 1


def test_client_table_is_capped(clock):
    limiter = RateLimiter(1, 1.0, max_clients=3, clock=clock)
    for i in range(100):
        assert limiter.take(f"10.0.0.{i}") == 0
    assert len(limiter) == 3
    assert limiter.take("10.0.0.99") == 60


@pytest.mark.parametrize(
    ("host", "key"),
    [
        ("203.0.113.7", "203.0.113.7"),
        ("2001:db8:1:2:3:4:5:6", "2001:db8:1:2::/64"),
        ("2001:db8:1:2:ffff::", "2001:db8:1:2::/64"),
        ("2001:db8:1:3::1", "2001:db8:1:3::/64"),
        ("fe80::1%" + "e" * 16000, "fe80::/64"),
        ("::ffff:203.0.113.7", "203.0.113.7"),
        ("", INVALID_ADDRESS_KEY),
        ("testclient", INVALID_ADDRESS_KEY),
        ("203.0.113.7, 198.51.100.1", INVALID_ADDRESS_KEY),
        ("x" * 16384, INVALID_ADDRESS_KEY),
    ],
)
def test_client_key(host, key):
    assert client_key(host) == key


@pytest.mark.parametrize("burst, per_minute, limits, retry_after", [
    (SEARCH_BURST, SEARCH_PER_MINUTE, (30, 6.0), 10),
    (FRAME_BURST, FRAME_PER_MINUTE, (180, 18.0), 4),
    (WIDE_BURST, WIDE_PER_MINUTE, (120, 18.0), 4),
])
def test_per_client_limits_and_their_retry_after(clock, burst, per_minute, limits, retry_after):
    assert (burst, per_minute) == limits
    limiter = RateLimiter(burst, per_minute, clock=clock)
    assert [limiter.take("a") for _ in range(burst)] == [0] * burst
    assert limiter.take("a") == retry_after
