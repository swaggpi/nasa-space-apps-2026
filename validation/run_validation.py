"""Live validation of the SPHEREx viewer on the five targets named by the NASA Space Apps challenge.

For each target and detector D1-D6 this script runs the package's own pipeline against the real
archive (``discovery.discover`` -> ``visits.plan_frames`` -> ``frames.FrameBuilder.build``), then
measures each frame at the target's expected position and writes ``validation/REPORT.md``.

Usage (opt-in, needs network access; takes minutes on a cold cache)::

    .venv/bin/python validation/run_validation.py [--cache-dir DIR]

Without ``--cache-dir`` a temporary directory is used and removed afterwards; pass a directory to
make reruns cheap. The application's cache under ``/data`` is never touched.
"""

from __future__ import annotations

import argparse
import logging
import math
import sys
import tempfile
import threading
import time
import warnings
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path

import astropy.units as u
import httpx
import numpy as np
from astropy.coordinates import Distance, SkyCoord, get_body_barycentric
from astropy.modeling import fitting, models
from astropy.time import Time

from spherex_viewer import discovery
from spherex_viewer.cache import CutoutCache
from spherex_viewer.coords import parse_dec, parse_ra
from spherex_viewer.frames import FrameBuilder, FrameError
from spherex_viewer.grid import GRID_SHAPE, PIXEL_SCALE_ARCSEC, target_wcs
from spherex_viewer.remote import HttpRangeReader
from spherex_viewer.visits import (EXPOSURE_CAP, MAX_BIN_DAYS, MAX_GAP_DAYS, FramePlan,
                                   plan_frames)

REPORT_PATH = Path(__file__).with_name("REPORT.md")
CORE_RADIUS_PX = 3.0          # no-data count, peak and aperture radius around the expected position
RING_RADIUS_PX = 10.0         # outer radius searched for flux around a no-data core
NOISE_EXCLUDE_PX = 7.0        # pixels closer than this to the expected position are not noise
FIT_RADIUS_PX = 7.0           # Moffat fit uses finite pixels within this radius
CACHE_MAX_BYTES = 2 * 1024**3
DETECTION_SIGMA = 5.0
MIN_CORE_HOLE = 3             # no-data pixels within CORE_RADIUS_PX that make a "core hole"
VARIABILITY_SIGMA = 5.0
PIXEL_SR = (PIXEL_SCALE_ARCSEC * u.arcsec).to_value(u.rad) ** 2
CENTRE_PX = (GRID_SHAPE[1] - 1) / 2

logger = logging.getLogger("validation")


@dataclass(frozen=True)
class Astrometry:
    """Barycentric ICRS position at ``epoch`` with proper motion (mas/yr) and parallax (mas)."""

    ra_deg: float
    dec_deg: float
    epoch: Time
    pm_ra_cosdec: float
    pm_dec: float
    parallax: float

    def position(self, t: Time, with_parallax: bool = True) -> SkyCoord:
        """Astrometric position at ``t``: space motion, then annual parallax seen from Earth."""
        ref = SkyCoord(self.ra_deg * u.deg, self.dec_deg * u.deg,
                       pm_ra_cosdec=self.pm_ra_cosdec * u.mas / u.yr,
                       pm_dec=self.pm_dec * u.mas / u.yr,
                       distance=Distance(parallax=self.parallax * u.mas), obstime=self.epoch)
        with warnings.catch_warnings():
            warnings.simplefilter("ignore")
            moved = ref.apply_space_motion(new_obstime=t)
        pos = SkyCoord(moved.ra, moved.dec)
        if not with_parallax:
            return pos
        dra, ddec = parallax_offset(pos, t, self.parallax)
        return pos.spherical_offsets_by(dra * u.mas, ddec * u.mas)


def parallax_offset(pos: SkyCoord, t: Time, parallax_mas: float) -> tuple[float, float]:
    """Parallactic displacement (dRA cos Dec, dDec) in mas for Earth's barycentric position."""
    x, y, z = get_body_barycentric("earth", t).xyz.to_value(u.au)
    a, d = pos.ra.rad, pos.dec.rad
    return (parallax_mas * (x * math.sin(a) - y * math.cos(a)),
            parallax_mas * (x * math.cos(a) * math.sin(d) + y * math.sin(a) * math.sin(d)
                            - z * math.cos(d)))


def from_observed(ra_deg: float, dec_deg: float, t: Time, pm_ra_cosdec: float, pm_dec: float,
                  parallax: float) -> Astrometry:
    """Astrometry whose reference is an observed (parallax-displaced) position at ``t``."""
    pos = SkyCoord(ra_deg * u.deg, dec_deg * u.deg)
    dra, ddec = parallax_offset(pos, t, parallax)
    bary = pos.spherical_offsets_by(-dra * u.mas, -ddec * u.mas)
    return Astrometry(bary.ra.deg, bary.dec.deg, t, pm_ra_cosdec, pm_dec, parallax)


@dataclass(frozen=True)
class Target:
    name: str
    ra_deg: float                       # query centre, as a user would type it
    dec_deg: float
    astrometry: Astrometry | None       # None: fixed position = query centre
    variable: bool = False

    def expected(self, t: Time) -> SkyCoord:
        if self.astrometry is None:
            return SkyCoord(self.ra_deg * u.deg, self.dec_deg * u.deg)
        return self.astrometry.position(t)


EPOCH_2026 = Time(2026.0, format="jyear", scale="tcb")
BARNARD = Astrometry(269.44850253, 4.73942005, Time(2016.0, format="jyear", scale="tcb"),
                     -801.551, 10362.394, 546.976)
EPS_IND_B = from_observed(331.043836, -56.782707, Time(1999.855, format="jyear"),
                          3966.661, -2536.192, 274.843)
WISE_0855 = Astrometry(parse_ra("08h55m10.831s"), parse_dec("-7d14m42.53s"),
                       Time(2010.3, format="jyear"), -8118.0, 680.0, 449.0)
# Cross-checks (reported, not used): Luhman & Esplin 2016 Table 2, HST epoch MJD 57484.38;
# Gaia DR3 6412596012146801152 (the unresolved eps Ind Ba+Bb), epoch 2016.0.
WISE_0855_HST = from_observed(133.7818300, -7.2440063, Time(57484.38, format="mjd"),
                              -8118.0, 680.0, 449.0)
EPS_IND_B_GAIA = Astrometry(331.07645259656, -56.79381206688,
                            Time(2016.0, format="jyear", scale="tcb"),
                            3981.977, -2466.832, 270.658)


def centre_2026(astrometry: Astrometry) -> tuple[float, float]:
    """Query centre: proper-motion-only position at 2026.0, rounded as a user would type it."""
    pos = astrometry.position(EPOCH_2026, with_parallax=False)
    return round(pos.ra.deg, 7), round(pos.dec.deg, 7)


TARGETS = (
    Target("Barnard's Star", *centre_2026(BARNARD), BARNARD),
    Target("Epsilon Indi B", *centre_2026(EPS_IND_B), EPS_IND_B),
    Target("WISE 0855", WISE_0855.ra_deg, WISE_0855.dec_deg, WISE_0855),
    Target("RW Aurigae", 76.95608120, 30.40120459, None, variable=True),
    Target("R Draconis", 248.16737837, 66.75500675, None, variable=True),
)


class CountingReader:
    """RangeReader wrapper that counts requests and bytes, for the report."""

    def __init__(self, inner: HttpRangeReader) -> None:
        self._inner = inner
        self._lock = threading.Lock()
        self.requests = 0
        self.bytes = 0

    def read(self, url: str, start: int, stop: int) -> bytes:
        data = self._inner.read(url, start, stop)
        with self._lock:
            self.requests += 1
            self.bytes += len(data)
        return data


@dataclass
class FrameMeasurement:
    plan: FramePlan
    mean_mjd: float
    n_used: int = 0
    n_failed: int = 0
    error: str = ""
    x: float = math.nan                 # expected position, grid pixel (0-based, x = column)
    y: float = math.nan
    no_data: int = 0
    peak: float = math.nan              # MJy/sr, within CORE_RADIUS_PX
    ring_peak: float = math.nan         # MJy/sr, CORE_RADIUS_PX < r <= RING_RADIUS_PX
    noise: float = math.nan             # MJy/sr, 1.4826 * MAD outside NOISE_EXCLUDE_PX
    verdict: str = "not detected"
    aperture_mjy: float = math.nan
    aperture_err_mjy: float = math.nan
    fit: SkyCoord | None = None
    expected: SkyCoord | None = None
    data: np.ndarray | None = None


@dataclass
class DetectorResult:
    detector: str
    n_exposures: int = 0
    frames: tuple[FrameMeasurement, ...] = ()
    error: str = ""

    @property
    def capped(self) -> bool:
        return any(f.plan.capped for f in self.frames)


def radius_map(x: float, y: float) -> np.ndarray:
    yy, xx = np.indices(GRID_SHAPE)
    return np.hypot(xx - x, yy - y)


def classify(m: FrameMeasurement) -> str:
    """Verdict from the stated rules (see the report's method section)."""
    if not m.noise > 0:
        return "not detected"
    hole = m.no_data >= MIN_CORE_HOLE
    signal = np.nanmax([m.peak, m.ring_peak]) if hole else m.peak
    if not signal >= DETECTION_SIGMA * m.noise:
        return "not detected"
    return "saturated core" if hole else "visible"


def aperture_sums(data: np.ndarray, x: float, y: float) -> tuple[float, float]:
    """Aperture sum (mJy) at (x, y) and the robust scatter of sums at empty-sky positions."""
    to_mjy = PIXEL_SR * 1e9          # MJy/sr * sr -> mJy

    def total(cx: float, cy: float) -> float:
        inside = radius_map(cx, cy) <= CORE_RADIUS_PX
        values = data[inside]
        return float(values.sum()) * to_mjy if np.all(np.isfinite(values)) else math.nan

    step = int(2 * CORE_RADIUS_PX + 1)
    edge = int(math.ceil(CORE_RADIUS_PX))
    sky = [total(cx, cy) for cy in range(edge, GRID_SHAPE[0] - edge, step)
           for cx in range(edge, GRID_SHAPE[1] - edge, step)
           if math.hypot(cx - x, cy - y) > 10]
    sky = np.array([s for s in sky if np.isfinite(s)])
    err = 1.4826 * float(np.median(np.abs(sky - np.median(sky)))) if sky.size >= 5 else math.nan
    return total(x, y), err


def fit_position(data: np.ndarray, x: float, y: float,
                 saturated: bool) -> tuple[float, float] | None:
    """Moffat2D + Const2D fit (LevMarLSQFitter) to finite pixels within FIT_RADIUS_PX."""
    r = radius_map(x, y)
    ok = (r <= FIT_RADIUS_PX) & np.isfinite(data)
    if np.count_nonzero(ok) < 10:
        return None
    yy, xx = np.indices(GRID_SHAPE)
    peak = float(np.nanmax(data[ok]))
    model = (models.Moffat2D(peak * (5.0 if saturated else 1.0), x, y, 1.5, 2.0)
             + models.Const2D(0.0))
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        fitted = fitting.LevMarLSQFitter()(model, xx[ok], yy[ok], data[ok], maxiter=500)
    moffat = fitted[0]
    fx, fy = moffat.x_0.value, moffat.y_0.value
    sane = (moffat.amplitude.value > 0 and 0.5 < moffat.fwhm < 10
            and math.hypot(fx - x, fy - y) <= FIT_RADIUS_PX)
    return (fx, fy) if sane else None


def measure(builder: FrameBuilder, target: Target, plan: FramePlan) -> FrameMeasurement:
    """Build one frame through the package and measure it at the expected position."""
    mean_mjd = float(np.mean([e.mjd for e in plan.exposures]))
    m = FrameMeasurement(plan=plan, mean_mjd=mean_mjd)
    try:
        result = builder.build([e.uri for e in plan.exposures], target.ra_deg, target.dec_deg)
    except FrameError as exc:
        m.error = str(exc)
        m.n_failed = plan.n_used
        return m
    m.n_used, m.n_failed, m.data = result.n_used, result.n_failed, result.data
    wcs = target_wcs(target.ra_deg, target.dec_deg)
    m.expected = target.expected(Time(mean_mjd, format="mjd"))
    m.x, m.y = (float(v) for v in wcs.world_to_pixel(m.expected))
    r = radius_map(m.x, m.y)
    core, ring = r <= CORE_RADIUS_PX, (r > CORE_RADIUS_PX) & (r <= RING_RADIUS_PX)
    data = result.data
    m.no_data = int(np.count_nonzero(core & ~np.isfinite(data)))
    with warnings.catch_warnings():
        warnings.simplefilter("ignore", RuntimeWarning)
        m.peak = float(np.nanmax(np.where(core, data, np.nan)))
        m.ring_peak = float(np.nanmax(np.where(ring, data, np.nan)))
        sky = data[(r > NOISE_EXCLUDE_PX) & np.isfinite(data)]
    if sky.size:
        m.noise = 1.4826 * float(np.median(np.abs(sky - np.median(sky))))
    m.verdict = classify(m)
    if target.variable:
        m.aperture_mjy, m.aperture_err_mjy = aperture_sums(data, m.x, m.y)
    if target.astrometry is not None and m.verdict != "not detected":
        fitted = fit_position(data, m.x, m.y, m.verdict == "saturated core")
        if fitted is not None:
            m.fit = wcs.pixel_to_world(*fitted)
    return m


def run_detector(client: httpx.Client, builder: FrameBuilder, target: Target,
                 detector: str) -> DetectorResult:
    try:
        exposures = discovery.discover(client, target.ra_deg, target.dec_deg, detector)
    except discovery.DiscoveryError as exc:
        return DetectorResult(detector, error=str(exc))
    frames = tuple(measure(builder, target, plan) for plan in plan_frames(exposures))
    return DetectorResult(detector, len(exposures), frames)


def fmt(value: float, spec: str = ".3f") -> str:
    return "–" if not np.isfinite(value) else format(value, spec)


def offset_arcsec(origin: SkyCoord, point: SkyCoord) -> np.ndarray:
    dra, ddec = origin.spherical_offsets_to(point)
    return np.array([dra.to_value(u.arcsec), ddec.to_value(u.arcsec)])


def shift(target: Target, det: DetectorResult) -> tuple[FrameMeasurement, FrameMeasurement,
                                                        np.ndarray, np.ndarray] | None:
    """First and last fitted frame, measured and predicted shift between them (arcsec)."""
    fitted = [f for f in det.frames if f.fit is not None]
    if len(fitted) < 2:
        return None
    centre = SkyCoord(target.ra_deg * u.deg, target.dec_deg * u.deg)
    first, last = fitted[0], fitted[-1]
    meas = offset_arcsec(centre, last.fit) - offset_arcsec(centre, first.fit)
    pred = offset_arcsec(centre, last.expected) - offset_arcsec(centre, first.expected)
    return first, last, meas, pred


def motion_verdict(meas: np.ndarray, pred: np.ndarray) -> str:
    """'follows the predicted motion', 'static' or 'inconclusive' (rule in the method section)."""
    if np.hypot(*(meas - pred)) < 0.5 * np.hypot(*pred):
        return "follows the predicted motion"
    if np.hypot(*meas) < 0.5 * np.hypot(*pred):
        return "static"
    return "inconclusive"


def motion_rows(target: Target, results: list[DetectorResult]) -> list[str]:
    """Measured versus predicted first-to-last shift per detector (arcsec)."""
    rows = []
    for det in results:
        n_fit = sum(f.fit is not None for f in det.frames)
        found = shift(target, det)
        if found is None:
            rows.append(f"| {det.detector} | {n_fit} of {len(det.frames)} | – | – | – | – | "
                        "fewer than two frames with a fit |")
            continue
        first, last, meas, pred = found
        note = ("saturated core in first and/or last frame: fit uses the wings only"
                if "saturated core" in (first.verdict, last.verdict) else "no saturated core")
        rows.append(
            f"| {det.detector} | {n_fit} of {len(det.frames)} | "
            f"{first.plan.label} → {last.plan.label} | {meas[0]:+.2f}, {meas[1]:+.2f} | "
            f"{pred[0]:+.2f}, {pred[1]:+.2f} | {np.hypot(*(meas - pred)):.2f} | "
            f"{motion_verdict(meas, pred)}; {note} |")
    return rows


def detector_span(dets: list[str]) -> str:
    return ", ".join(dets) if dets else "none"


def plural(n: int, noun: str) -> str:
    """``n`` followed by ``noun``, with an "s" unless ``n`` is 1."""
    return f"{n} {noun}" if n == 1 else f"{n} {noun}s"


def detectors(dets: list[str]) -> str:
    """"detector D1" or "detectors D1, D2"."""
    return ("detector " if len(dets) == 1 else "detectors ") + detector_span(dets)


def summary_line(target: Target, results: list[DetectorResult]) -> str:
    frames = [(d.detector, f) for d in results for f in d.frames]
    failed = [d.detector for d in results if d.error]
    note = (f" Discovery failed in {detector_span(failed)} (see failures); this line covers the "
            "other detectors only." if failed else "")
    if not frames:
        return (f"- **{target.name}**: no frames: "
                + ("archive discovery failed in every detector." if len(failed) == len(results)
                   else "no SPHEREx exposures were found." + note))
    by_verdict = {v: sorted({d for d, f in frames if f.verdict == v})
                  for v in ("visible", "saturated core", "not detected")}
    counts = {v: sum(f.verdict == v for _, f in frames) for v in by_verdict}
    labels = [f.plan.label for _, f in frames]
    text = (f"- **{target.name}** ({plural(len(frames), 'frame')}, {min(labels)[:10]} to "
            f"{max(labels)[-10:]}): ")
    if counts["visible"] + counts["saturated core"] == 0:
        return text + ("the tool shows nothing at the expected position in any frame of any "
                       "detector (not detected in all frames)." + note)
    parts = []
    if counts["visible"]:
        parts.append(f"a source at the expected position in {plural(counts['visible'], 'frame')} "
                     f"({detectors(by_verdict['visible'])})")
    if counts["saturated core"]:
        parts.append(f"a bright star with an empty (no-data) centre in "
                     f"{plural(counts['saturated core'], 'frame')} "
                     f"({detectors(by_verdict['saturated core'])})")
    if counts["not detected"]:
        parts.append(f"nothing above the threshold in {plural(counts['not detected'], 'frame')} "
                     f"({detectors(by_verdict['not detected'])})")
    text += "; ".join(parts) + "."
    if target.astrometry is not None:
        tests = {d.detector: motion_verdict(*found[2:]) for d in results
                 if (found := shift(target, d)) is not None}
        groups = {v: [k for k, w in tests.items() if w == v] for v in sorted(set(tests.values()))}
        text += (" Motion test (first to last fitted frame): "
                 + "; ".join(f"{v} in {detector_span(k)}" for v, k in groups.items())
                 + "; no test (fewer than two fits) in "
                 + detector_span([d.detector for d in results if d.detector not in tests]) + "."
                 + (" A static source at the expected position is an unrelated object, not the "
                    "target." if "static" in groups else ""))
    if target.variable:
        status = {d.detector: variability(d)[0] for d in results}
        text += (" Aperture sums differ between frames by more than "
                 f"{VARIABILITY_SIGMA:g}σ in: "
                 f"{detector_span([k for k, v in status.items() if v == 'yes'])}; not measurable "
                 "(fewer than two frames without no-data pixels in the aperture) in: "
                 f"{detector_span([k for k, v in status.items() if v == 'n/a'])} (see caveats).")
    return text + note


def variability(det: DetectorResult) -> tuple[str, str]:
    """('yes'/'no'/'n/a', explanation) for max-min aperture difference against the noise."""
    good = [f for f in det.frames if np.isfinite(f.aperture_mjy) and f.aperture_err_mjy > 0]
    if len(good) < 2:
        return "n/a", f"{plural(len(good), 'frame')} with a complete aperture"
    hi = max(good, key=lambda f: f.aperture_mjy)
    lo = min(good, key=lambda f: f.aperture_mjy)
    sig = (hi.aperture_mjy - lo.aperture_mjy) / math.hypot(hi.aperture_err_mjy,
                                                          lo.aperture_err_mjy)
    return ("yes" if sig > VARIABILITY_SIGMA else "no",
            f"max−min = {hi.aperture_mjy - lo.aperture_mjy:.2f} mJy = {sig:.1f}σ "
            f"over {plural(len(good), 'frame')}")


def frame_table(target: Target, det: DetectorResult) -> list[str]:
    head = ("| # | date | used / failed | expected x, y | no-data ≤3 px | peak | σ (MAD) "
            "| peak/σ | verdict |")
    if target.variable:
        head += " aperture sum ± σ (mJy) |"
    if target.astrometry is not None:
        head += " fit − predicted (″, ΔRA cosδ, ΔDec) |"
    lines = [head, "|" + "---|" * (head.count("|") - 1)]
    for f in det.frames:
        if f.error:
            lines.append(f"| {f.plan.index} | {f.plan.label} | 0 / {f.n_failed} | "
                         f"FrameError: {f.error} |")
            continue
        ratio = f.peak / f.noise if f.noise > 0 else math.nan
        row = (f"| {f.plan.index} | {f.plan.label} | {f.n_used} / {f.n_failed} | "
               f"{f.x:.1f}, {f.y:.1f} | {f.no_data} | {fmt(f.peak)} | {fmt(f.noise, '.4f')} | "
               f"{fmt(ratio, '.1f')} | {f.verdict} |")
        if target.variable:
            row += (f" {fmt(f.aperture_mjy, '.2f')} ± {fmt(f.aperture_err_mjy, '.2f')} |"
                    if np.isfinite(f.aperture_mjy) else " incomplete (no-data pixels) |")
        if target.astrometry is not None:
            row += (" {:+.2f}, {:+.2f} |".format(*offset_arcsec(f.expected, f.fit))
                    if f.fit is not None else " no fit |")
        lines.append(row)
    return lines


def astrometry_section() -> list[str]:
    t = Time("2025-11-01")
    wise_diff = WISE_0855.position(t).separation(WISE_0855_HST.position(t)).arcsec
    indi_diff = EPS_IND_B.position(t).separation(EPS_IND_B_GAIA.position(t)).arcsec
    return [
        "## Astrometric inputs",
        "",
        "Expected positions are computed for each frame's mean epoch (mean start time of the "
        "exposures planned for the frame). Method: astropy `SkyCoord.apply_space_motion` "
        "(rigorous space motion, radial velocity taken as 0) from the reference epoch, then annual "
        "parallax "
        "Δα cosδ = π(X sinα − Y cosα), Δδ = π(X cosα sinδ + Y sinα sinδ − Z cosδ) with Earth's "
        "barycentric X, Y, Z (AU) from `get_body_barycentric('earth')`. SPHEREx's own offset from "
        "Earth's centre (low Earth orbit) changes this by < 0.05 mas and is ignored.",
        "",
        "- Barnard's Star: Gaia DR3 4472832130942575872 (values confirmed in the Gaia DR3 table "
        "at IRSA), 269.44850253, +4.73942005 (2016.0), pm (−801.551, +10362.394) mas/yr, "
        "π 546.976 mas. Query centre = epoch 2026.0 without parallax: "
        "{}, {}.".format(*centre_2026(BARNARD)),
        "- Epsilon Indi B: 2MASS 331.043836, −56.782707 (epoch 1999.855, treated as an observed "
        "position and corrected for parallax), with the Gaia DR3 motion of ε Indi A "
        "(+3966.661, −2536.192) mas/yr, π 274.843 mas. Query centre (2026.0): "
        "{}, {}. ".format(*centre_2026(EPS_IND_B)) + "Cross-check: Gaia DR3 also lists the "
        "unresolved Ba+Bb (6412596012146801152, pm (+3981.977, −2466.832), π 270.658); its "
        f"predicted position on 2025-11-01 differs from ours by {indi_diff:.2f}″ "
        f"({indi_diff / PIXEL_SCALE_ARCSEC:.2f} px).",
        "- WISE 0855: query centre = the challenge's coordinates "
        f"({WISE_0855.ra_deg:.6f}, {WISE_0855.dec_deg:.6f}), taken as the barycentric position "
        "at epoch 2010.3. pm (−8.118, +0.680) ″/yr and π 0.449″ are confirmed from Luhman & "
        "Esplin 2016, AJ 152, 78 (arXiv:1605.06655), Table 4 (π 0.449 ± 0.008″, μα cosδ "
        "−8.118 ± 0.008″/yr, μδ 0.680 ± 0.007″/yr). The paper gives no reference position; its "
        "Table 2 lists a WISE position at MJD 55320.38 (2010.34) within 0.5″ of the challenge "
        "coordinates, which supports the 2010.3 epoch. Cross-check: predicting from the paper's "
        "last HST position (MJD 57484.38, ±0.02″) instead differs on 2025-11-01 by "
        f"{wise_diff:.2f}″ ({wise_diff / PIXEL_SCALE_ARCSEC:.2f} px).",
        "- RW Aurigae 76.95608120, +30.40120459 and R Draconis 248.16737837, +66.75500675: "
        "Gaia DR3 positions (2016.0) held fixed; their proper motions (≤ 28 mas/yr, Gaia DR3 at "
        "IRSA) move them < 0.3″ by 2026. RW Aur A and its companion 1.5″ away (Gaia G 12.2 and "
        "13.0) are one unresolved source at 6.15″ pixels.",
        "",
    ]


def method_section() -> list[str]:
    return [
        "## Method and rules",
        "",
        "Each frame is produced exactly as the web tool produces it: `discovery.discover` (live "
        "search of IRSA's Simple Image Access service), `visits.plan_frames` (exposures split "
        f"into visits at gaps of more than {MAX_GAP_DAYS:g} days, visits longer than "
        f"{MAX_BIN_DAYS:g} days cut into equal bins of at most {MAX_BIN_DAYS:g} days, at most "
        f"{EXPOSURE_CAP} exposures per frame picked evenly spaced in time order with first and "
        "last kept), `FrameBuilder.build` (byte-range reads from the public S3 bucket, "
        "sigma-clipped median background subtracted per exposure, pixels with the SPHEREx Mosaic "
        "Tool's bad flags set to NaN, bilinear reprojection onto `grid.target_wcs`, per-pixel "
        "NaN-ignoring median). "
        "Measurements are on that 59×59 frame (6.15″ pixels, MJy/sr, background-subtracted). "
        "r is the distance in pixels from the expected position.",
        "",
        f"- **no-data ≤3 px**: NaN pixels with r ≤ {CORE_RADIUS_PX:g} (of 29).",
        f"- **peak**: maximum finite value with r ≤ {CORE_RADIUS_PX:g}. **σ**: 1.4826 × median "
        f"absolute deviation of all finite pixels with r > {NOISE_EXCLUDE_PX:g} (frame noise).",
        f"- **visible**: fewer than {MIN_CORE_HOLE} no-data pixels and peak ≥ "
        f"{DETECTION_SIGMA:g}σ.",
        f"- **saturated core**: at least {MIN_CORE_HOLE} no-data pixels and the maximum finite "
        f"value with r ≤ {RING_RADIUS_PX:g} is ≥ {DETECTION_SIGMA:g}σ (a hole surrounded by "
        "bright signal; saturated cores are NaN in the archive images).",
        "- **not detected**: anything else. The rule tests for flux near the expected position; "
        "it cannot tell the target from an unrelated source within 3 px (18″).",
        f"- **Aperture sum** (variable stars): sum over pixels with r ≤ {CORE_RADIUS_PX:g} "
        "converted to mJy (MJy/sr × pixel solid angle), no aperture correction; σ is the "
        "1.4826 × MAD scatter of the same aperture placed on a 7-px grid of empty-sky positions "
        "(r > 10) of the same frame. A frame with a no-data pixel in the aperture is "
        "\"incomplete\" (the sum would be a lower bound). Variability: max − min over complete "
        "frames divided by the combined σ of those two frames, \"yes\" if > "
        f"{VARIABILITY_SIGMA:g}.",
        "- **Position fit** (moving targets, frames not \"not detected\"): `Moffat2D + Const2D` "
        f"fitted with `LevMarLSQFitter` to finite pixels with r ≤ {FIT_RADIUS_PX:g}; rejected "
        "unless amplitude > 0, 0.5 < FWHM < 10 px and the centre lies within that radius. With a "
        "no-data core only the wings are fitted, which can bias the centre.",
        "- **Motion test** (first to last frame with a fit): \"follows the predicted motion\" if "
        "|measured − predicted| < 0.5 |predicted|; \"static\" if |measured| < 0.5 |predicted| "
        "(a fixed source near the expected position, i.e. not the target); else \"inconclusive\".",
        "",
    ]


def render(results: dict[str, list[DetectorResult]], info: dict[str, str]) -> str:
    lines = ["# Live validation on the five challenge targets", "",
             "Generated by `validation/run_validation.py` for the five targets named by the NASA "
             "Space Apps challenge. " + info["run"],
             "", "## What a user of the tool sees", ""]
    lines += [summary_line(t, results[t.name]) for t in TARGETS]
    lines += ["", "Caveat for brightness: each frame averages over the detector's wavelength "
              "range and visits sample that range differently, so part of any frame-to-frame "
              "brightness change is not intrinsic (one of the limitations listed in the "
              "README).", ""]
    lines += method_section() + astrometry_section()
    lines += ["## Motion: measured versus predicted first-to-last shift", "",
              "Offsets in arcsec as (ΔRA cosδ, ΔDec), between the first and last frame of each "
              "detector that has a successful fit.", ""]
    for t in TARGETS:
        if t.astrometry is None:
            continue
        lines += [f"**{t.name}**", "",
                  "| detector | frames with fit | first → last | measured | predicted "
                  "| difference (″) | motion test |", "|---|---|---|---|---|---|---|"]
        lines += motion_rows(t, results[t.name]) + [""]
    anomalies = [f"- {t.name} {d.detector}: {d.error}" for t in TARGETS for d in results[t.name]
                 if d.error]
    anomalies += [f"- {t.name} {d.detector} frame {f.plan.index} ({f.plan.label}): "
                  + (f.error or f"{plural(f.n_failed, 'exposure')} failed to load")
                  for t in TARGETS for d in results[t.name] for f in d.frames
                  if f.error or f.n_failed]
    anomalies += [f"- {t.name} {d.detector} frame {f.plan.index} ({f.plan.label}): frame has no "
                  "valid pixel" for t in TARGETS for d in results[t.name] for f in d.frames
                  if f.data is not None and not np.isfinite(f.data).any()]
    lines += ["## Failures and anomalies", ""] + (anomalies or ["None."]) + [""]
    for t in TARGETS:
        lines += [f"## {t.name}", ""]
        for det in results[t.name]:
            if det.error:
                lines += [f"**{det.detector}**: discovery failed: {det.error}", ""]
                continue
            cap = "yes" if det.capped else "no"
            lines += [f"**{det.detector}**: {plural(det.n_exposures, 'exposure')}, "
                      f"{plural(len(det.frames), 'frame')}, cap applied: {cap}."
                      + (f" Variability: {' – '.join(variability(det))}." if t.variable else ""),
                      ""]
            if det.frames:
                lines += frame_table(t, det) + [""]
    return "\n".join(lines) + "\n"


def count_cutouts(root: Path) -> int:
    return sum(1 for _ in root.glob("*/*.npy"))


def run(cache_dir: Path) -> tuple[dict[str, list[DetectorResult]], dict[str, str]]:
    """Run every target and detector sequentially through one cache and one FrameBuilder."""
    started = time.monotonic()
    cache = CutoutCache(cache_dir, CACHE_MAX_BYTES)
    before = count_cutouts(cache_dir)
    client = httpx.Client(timeout=httpx.Timeout(connect=10, read=30, write=10, pool=60),
                          limits=httpx.Limits(max_connections=8))
    reader = CountingReader(HttpRangeReader(client))
    builder = FrameBuilder(reader, cache)
    results: dict[str, list[DetectorResult]] = {}
    try:
        for target in TARGETS:
            results[target.name] = []
            for detector in discovery.DETECTORS:
                logger.info("%s %s ...", target.name, detector)
                results[target.name].append(run_detector(client, builder, target, detector))
    finally:
        builder.close()
        client.close()
    elapsed = time.monotonic() - started
    n_exposures = sum(d.n_exposures for r in results.values() for d in r)
    n_used = sum(len(f.plan.exposures) for r in results.values() for d in r for f in d.frames)
    info = {"run": (
        f"Run {datetime.now(UTC):%Y-%m-%d %H:%M} UTC in {elapsed / 60:.1f} min: "
        f"{plural(n_exposures, 'exposure')} discovered, {n_used} planned for frames, "
        f"{plural(count_cutouts(cache_dir) - before, 'new cutout')} read from S3 and cached in "
        "this run (the other planned exposures came from the validation cache, or missed the "
        f"grid or failed to load), {plural(reader.requests, 'range request')}, "
        f"{reader.bytes / 1e6:.0f} MB.")}
    return results, info


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--cache-dir", type=Path,
                        help="cutout cache to use and keep (default: a temporary directory)")
    args = parser.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(message)s",
                        stream=sys.stderr)
    logging.getLogger("httpx").setLevel(logging.WARNING)
    if args.cache_dir is None:
        with tempfile.TemporaryDirectory(prefix="spherex-validation-") as tmp:
            results, info = run(Path(tmp))
    else:
        results, info = run(args.cache_dir)
    REPORT_PATH.write_text(render(results, info), encoding="utf-8")
    logger.info("%s; report written to %s", info["run"], REPORT_PATH)


if __name__ == "__main__":
    main()
