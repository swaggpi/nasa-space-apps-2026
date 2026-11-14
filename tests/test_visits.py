"""Tests for visit segmentation, capping and labels (DESIGN.md 3, 5.1, 5.2; rows 7-11)."""

import random

import numpy as np
import pytest

from spherex_viewer.discovery import Exposure
from spherex_viewer.visits import (
    EXPOSURE_CAP,
    MAX_BIN_DAYS,
    MAX_GAP_DAYS,
    FramePlan,
    date_label,
    plan_frames,
    segment,
    subsample,
)

T0 = 60000.0


def _exposures(mjds) -> list[Exposure]:
    return [
        Exposure(f"ibe/data/spherex/dr1/level2/w/{i:05d}.fits", float(m)) for i, m in enumerate(mjds)
    ]


def _expected_indices(n: int) -> list[int]:
    return [(j * (n - 1) + 11) // 23 for j in range(24)]


def _flatten(groups):
    return [e for g in groups for e in g]


def test_constants():
    assert MAX_GAP_DAYS == 30.0
    assert MAX_BIN_DAYS == 30.0
    assert EXPOSURE_CAP == 24


@pytest.mark.parametrize(("gap", "n_runs"), [(29.9, 1), (30.0, 1), (30.1, 2)])
def test_segment_new_run_only_after_gap_above_30_days(gap, n_runs):
    exposures = _exposures([T0, T0 + gap])
    groups = segment(exposures)
    assert len(groups) == n_runs
    assert _flatten(groups) == exposures


def test_segment_sequence_of_gaps():
    first = _exposures([T0, T0 + 29.9])
    second = _exposures([T0 + 100.0, T0 + 130.0])
    third = _exposures([T0 + 200.0, T0 + 230.1])
    groups = segment(first + second + third)
    assert groups == [first, second, [third[0]], [third[1]]]


def test_segment_daily_exposures_over_99_days_gives_4_equal_bins():
    exposures = _exposures([T0 + d for d in range(100)])
    groups = segment(exposures)
    assert len(groups) == 4
    assert [len(g) for g in groups] == [25, 25, 25, 25]
    assert all(g[-1].mjd - g[0].mjd <= 30.0 for g in groups)
    assert _flatten(groups) == exposures


def test_segment_span_exactly_30_days_is_one_bin():
    exposures = _exposures([T0, T0 + 10.0, T0 + 20.0, T0 + 30.0])
    assert segment(exposures) == [exposures]


def test_segment_span_60_5_days_gives_3_bins():
    exposures = _exposures([T0 + 0.5 * i for i in range(122)])
    groups = segment(exposures)
    assert len(groups) == 3
    assert all(g[-1].mjd - g[0].mjd <= 30.0 for g in groups)
    assert _flatten(groups) == exposures


def test_segment_drops_empty_bins():
    exposures = _exposures([T0, T0 + 20.0, T0 + 50.0, T0 + 61.0])
    assert segment(exposures) == [exposures[:2], exposures[2:]]


def test_segment_sorts_by_mjd():
    exposures = _exposures([T0 + d for d in range(10)] + [T0 + 100 + d for d in range(5)])
    shuffled = exposures[:]
    random.Random(1).shuffle(shuffled)
    groups = segment(shuffled)
    assert groups == [exposures[:10], exposures[10:]]


def test_segment_empty():
    assert segment([]) == []


VISIT_RANGES = [
    (8, 60801.11, 60801.45),
    (19, 60986.24, 60989.44),
    (6, 61020.80, 61022.37),
    (15, 61161.59, 61174.29),
]


def test_plan_frames_wise0855_like_visits():
    mjds = np.concatenate([np.linspace(a, b, n) for n, a, b in VISIT_RANGES])
    exposures = _exposures(mjds)
    plans = plan_frames(exposures)
    assert [p.n_available for p in plans] == [8, 19, 6, 15]
    assert [p.n_used for p in plans] == [8, 19, 6, 15]
    assert [p.index for p in plans] == [0, 1, 2, 3]
    assert not any(p.capped for p in plans)
    assert [e for p in plans for e in p.exposures] == exposures
    assert [p.mjd_start for p in plans] == pytest.approx([a for _, a, _ in VISIT_RANGES])
    assert [p.mjd_end for p in plans] == pytest.approx([b for _, _, b in VISIT_RANGES])


@pytest.mark.parametrize("n", [1, 5, 23, 24])
def test_subsample_keeps_bins_up_to_cap(n):
    exposures = _exposures([T0 + 0.01 * i for i in range(n)])
    assert list(subsample(exposures)) == exposures


@pytest.mark.parametrize("n", [25, 300])
def test_subsample_above_cap_uses_design_indices(n):
    exposures = _exposures([T0 + 0.01 * i for i in range(n)])
    result = list(subsample(exposures))
    assert result == [exposures[i] for i in _expected_indices(n)]


@pytest.mark.parametrize("n", [25, 26, 47, 48, 49, 100, 300, 5125])
def test_subsample_indices_properties(n):
    exposures = _exposures([T0 + 0.001 * i for i in range(n)])
    position = {e.uri: i for i, e in enumerate(exposures)}
    indices = [position[e.uri] for e in subsample(exposures)]
    assert len(indices) == 24
    assert len(set(indices)) == 24
    assert indices == sorted(indices)
    assert indices[0] == 0
    assert indices[-1] == n - 1
    steps = np.diff(indices)
    assert steps.min() >= 1
    assert steps.max() - steps.min() <= 1


@pytest.mark.parametrize(
    ("start", "end", "label"),
    [
        (60801.1066, 60801.4501, "2025-05-06"),
        (60801.0, 60801.999, "2025-05-06"),
        (60986.24, 60989.44, "2025-11-07 – 2025-11-10"),
        (60800.99999, 60801.0, "2025-05-05 – 2025-05-06"),
        (60000.0, 60000.0, "2023-02-25"),
    ],
)
def test_date_label(start, end, label):
    assert date_label(start, end) == label


def test_plan_frames_capped_and_uncapped_bins():
    big = [T0 + i / 32 for i in range(300)]
    small = [61000.1 + 0.1 * i for i in range(5)]
    exposures = _exposures(big + small)
    plans = plan_frames(exposures)
    assert len(plans) == 2
    first, second = plans
    assert isinstance(first, FramePlan)

    assert first.index == 0
    assert first.n_available == 300
    assert first.n_used == 24
    assert first.capped is True
    assert first.exposures == tuple(exposures[i] for i in _expected_indices(300))
    assert first.mjd_start == T0
    assert first.mjd_end == T0 + 299 / 32
    assert first.label == "2023-02-25 – 2023-03-06"

    assert second.index == 1
    assert second.n_available == 5
    assert second.n_used == 5
    assert second.capped is False
    assert second.exposures == tuple(exposures[300:])
    assert second.mjd_start == exposures[300].mjd
    assert second.mjd_end == exposures[304].mjd
    assert second.label == "2025-11-21"


def test_plan_frames_mjd_range_is_whole_bin_not_used_exposures():
    mjds = [T0 + i / 32 for i in range(300)]
    plans = plan_frames(_exposures(mjds))
    assert len(plans) == 1
    assert plans[0].mjd_start == mjds[0]
    assert plans[0].mjd_end == mjds[-1]
    assert all(plans[0].mjd_start <= e.mjd <= plans[0].mjd_end for e in plans[0].exposures)


def test_plan_frames_empty():
    assert plan_frames([]) == []
