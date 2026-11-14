"""Build the homepage example, ``src/spherex_viewer/static/example.json``, from the live archive.

The frames are made by the package's own pipeline, exactly as ``GET /api/search`` followed by
``POST /api/frame`` would make them for the same position and detector (``discovery.discover``
-> ``visits.plan_frames`` -> ``frames.FrameBuilder.build``). Each frame carries a marker: the
star's predicted position at the frame's mean epoch (mean start time of the frame's planned
exposures), from catalogue astrometry with proper motion and parallax, in display pixels
(x right from the left edge, y down from the top edge, pixel centres at integers; north up).

Usage (needs network access; reads about 60 exposures on a cold cache)::

    .venv/bin/python scripts/build_example.py [--cache-dir DIR]

Without ``--cache-dir`` a temporary cutout cache is used and removed afterwards.

Why Barnard's Star in D6: of the six detectors it is the one where the star's core has data
(D1-D4 saturate, leaving an empty centre, in every frame; D5 in three of four). In the D6
frames used, Moffat-fitted centroids agree with the markers to <= 0.15 px, the star moves
1.7 px (10.4") north from the first to the last frame, and field stars stay within 0.05 px.
"""

import argparse
import json
import math
import tempfile
import warnings
from pathlib import Path

import astropy.units as u
import httpx
import numpy as np
from astropy.coordinates import Distance, SkyCoord, get_body_barycentric
from astropy.time import Time

from spherex_viewer import discovery
from spherex_viewer.cache import CutoutCache
from spherex_viewer.frames import FrameBuilder
from spherex_viewer.grid import GRID_SHAPE, target_wcs
from spherex_viewer.remote import HttpRangeReader
from spherex_viewer.visits import plan_frames

OUTPUT = Path(__file__).resolve().parents[1] / "src/spherex_viewer/static/example.json"
NAME = "Barnard's Star"
DETECTOR = "D6"
HINT = ("Barnard's Star is the bright star in the centre. Step from the first frame to the last: "
        "in one year it moves about 10 arcseconds (almost 2 pixels) upward, which is north, "
        "while the other stars stay where they are.")
# Gaia DR3 4472832130942575872 (ICRS, epoch J2016.0 TCB): RA, Dec (deg), proper motion
# (pmRA cos Dec, pmDec) in mas/yr, parallax in mas; radial velocity taken as 0.
GAIA_RA_DEG, GAIA_DEC_DEG = 269.44850253, 4.73942005
GAIA_EPOCH = Time(2016.0, format="jyear", scale="tcb")
PM_RA_COSDEC_MAS_YR, PM_DEC_MAS_YR = -801.551, 10362.394
PARALLAX_MAS = 546.976
# Query centre: the proper-motion-only position at J2026.0, rounded as a user would type it
# (the same centre as validation/run_validation.py).
CENTRE_EPOCH = Time(2026.0, format="jyear", scale="tcb")
# A frame whose star centre has no data (saturated in all its exposures) cannot show where the
# star is, so it is left out: no-data pixels within this radius of the marker. In D6 this
# drops one frame, 2026-05-04 - 2026-05-05 (4 exposures, 15 no-data pixels at the star).
CORE_RADIUS_PX = 3.0
CACHE_MAX_BYTES = 2**30


def _reference() -> SkyCoord:
    return SkyCoord(GAIA_RA_DEG * u.deg, GAIA_DEC_DEG * u.deg,
                    pm_ra_cosdec=PM_RA_COSDEC_MAS_YR * u.mas / u.yr,
                    pm_dec=PM_DEC_MAS_YR * u.mas / u.yr,
                    distance=Distance(parallax=PARALLAX_MAS * u.mas), obstime=GAIA_EPOCH)


def _space_motion(t: Time) -> SkyCoord:
    """Barycentric position at ``t`` (rigorous space motion, no parallax)."""
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        moved = _reference().apply_space_motion(new_obstime=t)
    return SkyCoord(moved.ra, moved.dec)


def predicted_position(mjd: float) -> SkyCoord:
    """Astrometric position seen from Earth at ``mjd`` (UTC): space motion plus annual parallax.

    Parallax: dRA cos Dec = p (X sin a - Y cos a), dDec = p (X cos a sin d + Y sin a sin d
    - Z cos d), with Earth's barycentric X, Y, Z in AU.
    """
    t = Time(mjd, format="mjd", scale="utc")
    pos = _space_motion(t)
    x, y, z = get_body_barycentric("earth", t).xyz.to_value(u.au)
    a, d = pos.ra.rad, pos.dec.rad
    dra = PARALLAX_MAS * (x * math.sin(a) - y * math.cos(a))
    ddec = PARALLAX_MAS * (x * math.cos(a) * math.sin(d) + y * math.sin(a) * math.sin(d)
                           - z * math.cos(d))
    return pos.spherical_offsets_by(dra * u.mas, ddec * u.mas)


def round4(value: float) -> float | None:
    """Value rounded to 4 significant digits; None for no data."""
    return float(f"{value:.4g}") if math.isfinite(value) else None


def build(cache_dir: Path) -> dict:
    """Build the example document (the schema of ``example.json``)."""
    centre = _space_motion(CENTRE_EPOCH)
    ra_deg, dec_deg = round(centre.ra.deg, 7), round(centre.dec.deg, 7)
    wcs = target_wcs(ra_deg, dec_deg)
    yy, xx = np.indices(GRID_SHAPE)
    frames = []
    with httpx.Client(timeout=httpx.Timeout(connect=10, read=30, write=10, pool=60),
                      limits=httpx.Limits(max_connections=8)) as client:
        builder = FrameBuilder(HttpRangeReader(client), CutoutCache(cache_dir, CACHE_MAX_BYTES))
        try:
            for plan in plan_frames(discovery.discover(client, ra_deg, dec_deg, DETECTOR)):
                result = builder.build([e.uri for e in plan.exposures], ra_deg, dec_deg)
                mjd = float(np.mean([e.mjd for e in plan.exposures]))
                gx, gy = (float(v) for v in wcs.world_to_pixel(predicted_position(mjd)))
                core = np.hypot(xx - gx, yy - gy) <= CORE_RADIUS_PX
                if not np.isfinite(result.data[core]).all():
                    print(f"left out {plan.label}: no data at the star")
                    continue
                north_up = result.data[::-1, :].ravel()
                frames.append({
                    "label": plan.label,
                    "n_used": result.n_used,
                    "pixels": [round4(float(v)) for v in north_up],
                    "marker": {"x": round(gx, 2), "y": round(GRID_SHAPE[0] - 1 - gy, 2)},
                })
                print(f"{plan.label}: {result.n_used} exposures, marker {frames[-1]['marker']}")
        finally:
            builder.close()
    return {"name": NAME, "hint": HINT, "ra_deg": ra_deg, "dec_deg": dec_deg,
            "detector": DETECTOR, "width": GRID_SHAPE[1], "height": GRID_SHAPE[0],
            "frames": frames}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--cache-dir", type=Path,
                        help="cutout cache to use and keep (default: a temporary directory)")
    args = parser.parse_args()
    if args.cache_dir is None:
        with tempfile.TemporaryDirectory(prefix="spherex-example-") as tmp:
            example = build(Path(tmp))
    else:
        example = build(args.cache_dir)
    if len(example["frames"]) < 2:
        raise SystemExit("Fewer than two usable frames; example.json not written.")
    OUTPUT.write_text(json.dumps(example, ensure_ascii=False, separators=(",", ":")) + "\n",
                      encoding="utf-8")
    print(f"wrote {OUTPUT} ({OUTPUT.stat().st_size / 1024:.0f} KiB)")


if __name__ == "__main__":
    main()
