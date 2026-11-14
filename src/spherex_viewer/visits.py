"""Grouping of exposures into visits and time bins, exposure cap, and frame planning."""

import math
from collections.abc import Sequence
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta

from .discovery import Exposure

MAX_GAP_DAYS = 30.0
MAX_BIN_DAYS = 30.0
EXPOSURE_CAP = 24

_MJD_EPOCH = datetime(1858, 11, 17, tzinfo=UTC)


@dataclass(frozen=True)
class FramePlan:
    """Exposures planned for one frame; ``mjd_start``/``mjd_end`` span the whole bin (MJD)."""

    index: int
    exposures: tuple[Exposure, ...]
    n_available: int
    mjd_start: float
    mjd_end: float
    label: str

    @property
    def n_used(self) -> int:
        """Number of exposures used for the frame."""
        return len(self.exposures)

    @property
    def capped(self) -> bool:
        """True if the exposure cap removed exposures from this bin."""
        return self.n_used < self.n_available


def segment(exposures: Sequence[Exposure]) -> list[list[Exposure]]:
    """Split exposures into time-ordered bins.

    A new run starts after a gap of more than ``MAX_GAP_DAYS``; a run spanning more than
    ``MAX_BIN_DAYS`` is cut into ``ceil(span / 30)`` equal-width bins, empty bins dropped.
    """
    ordered = sorted(exposures, key=lambda e: e.mjd)
    runs: list[list[Exposure]] = []
    for exposure in ordered:
        if runs and exposure.mjd - runs[-1][-1].mjd <= MAX_GAP_DAYS:
            runs[-1].append(exposure)
        else:
            runs.append([exposure])
    bins: list[list[Exposure]] = []
    for run in runs:
        t_first = run[0].mjd
        span = run[-1].mjd - t_first
        if span <= MAX_BIN_DAYS:
            bins.append(run)
            continue
        k = math.ceil(span / MAX_BIN_DAYS)
        width = span / k
        split: list[list[Exposure]] = [[] for _ in range(k)]
        for exposure in run:
            split[min(math.floor((exposure.mjd - t_first) / width), k - 1)].append(exposure)
        bins.extend(b for b in split if b)
    return bins


def subsample(exposures: Sequence[Exposure], cap: int = EXPOSURE_CAP) -> list[Exposure]:
    """Return at most ``cap`` exposures evenly spaced in time order, first and last included."""
    ordered = sorted(exposures, key=lambda e: e.mjd)
    n = len(ordered)
    if n <= cap:
        return ordered
    return [ordered[(j * (n - 1) + (cap - 1) // 2) // (cap - 1)] for j in range(cap)]


def date_label(mjd_start: float, mjd_end: float) -> str:
    """Return the UTC date label of a bin: one date, or "start – end" if the dates differ."""
    start = (_MJD_EPOCH + timedelta(days=mjd_start)).date().isoformat()
    end = (_MJD_EPOCH + timedelta(days=mjd_end)).date().isoformat()
    return start if start == end else f"{start} – {end}"


def plan_frames(exposures: Sequence[Exposure]) -> list[FramePlan]:
    """Plan one frame per bin, in time order, with the exposure cap applied."""
    plans = []
    for index, bin_ in enumerate(segment(exposures)):
        start, end = bin_[0].mjd, bin_[-1].mjd
        plans.append(
            FramePlan(
                index=index,
                exposures=tuple(subsample(bin_)),
                n_available=len(bin_),
                mjd_start=start,
                mjd_end=end,
                label=date_label(start, end),
            )
        )
    return plans
