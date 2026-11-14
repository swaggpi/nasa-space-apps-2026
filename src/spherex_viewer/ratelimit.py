"""In-memory per-client token-bucket rate limiter."""

import math
import threading
import time
from collections import OrderedDict
from collections.abc import Callable

# Each search is one archive query of 2.7-32 s: a few positions at once, then one per 30 s.
SEARCH_BURST = 10
SEARCH_PER_MINUTE = 2.0
# Each frame reads up to 24 exposures (~1.2 MB each): a few searches' frames, then one per 10 s.
FRAME_BURST = 60
FRAME_PER_MINUTE = 6.0
# Bounds the client table to a few MB whatever the number of distinct addresses.
MAX_CLIENTS = 10_000


class RateLimiter:
    """Token buckets of `burst` tokens refilled at `per_minute` tokens per minute, one per key.

    Keys untouched for the time a bucket needs to refill completely are dropped (a full bucket
    is the same as no entry); beyond `max_clients` entries the least recently used is dropped.
    Thread-safe; `clock` returns seconds.
    """

    def __init__(self, burst: int, per_minute: float, *, max_clients: int = MAX_CLIENTS,
                 clock: Callable[[], float] = time.monotonic) -> None:
        self._burst = float(burst)
        self._rate = per_minute / 60.0
        self._idle_s = self._burst / self._rate
        self._max_clients = max_clients
        self._clock = clock
        self._lock = threading.Lock()
        self._buckets: OrderedDict[str, tuple[float, float]] = OrderedDict()

    def __len__(self) -> int:
        with self._lock:
            return len(self._buckets)

    def take(self, key: str) -> int:
        """Take one token for `key`; return 0 if granted, else whole seconds until one is due."""
        with self._lock:
            now = self._clock()
            while self._buckets:
                oldest, (_, last) = next(iter(self._buckets.items()))
                if now - last < self._idle_s:
                    break
                del self._buckets[oldest]
            tokens, last = self._buckets.pop(key, (self._burst, now))
            tokens = min(self._burst, tokens + (now - last) * self._rate)
            granted = tokens >= 1.0
            if granted:
                tokens -= 1.0
            self._buckets[key] = (tokens, now)
            if len(self._buckets) > self._max_clients:
                self._buckets.popitem(last=False)
            return 0 if granted else max(1, math.ceil((1.0 - tokens) / self._rate))
