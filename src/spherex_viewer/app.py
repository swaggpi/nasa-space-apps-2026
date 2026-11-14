"""FastAPI application: search and frame endpoints, health check and the static page."""

import math
import os
import threading
from collections.abc import AsyncIterator, Callable
from contextlib import asynccontextmanager
from pathlib import Path

import httpx
from fastapi import FastAPI, HTTPException, Request
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from . import discovery
from .cache import CutoutCache
from .coords import CoordinateError, parse_dec, parse_ra
from .discovery import DETECTORS, DiscoveryError, Exposure, is_valid_uri
from .frames import FrameBuilder, FrameError
from .grid import GRID_SHAPE
from .remote import HttpRangeReader, RangeReader
from .visits import EXPOSURE_CAP, plan_frames

CACHE_DIR_ENV = "SPHEREX_CACHE_DIR"
DEFAULT_CACHE_DIR = Path("/data/cutouts")
MAX_CONCURRENT_SEARCHES = 4

STATIC_DIR = Path(__file__).parent / "static"


class FrameRequest(BaseModel):
    """Body of `POST /api/frame`: the search position and one frame's exposure URIs."""

    ra_deg: float
    dec_deg: float
    uris: list[str]


def create_app(*, cache_dir: Path | None = None, reader: RangeReader | None = None,
               discover: Callable[[float, float, str], list[Exposure]] | None = None) -> FastAPI:
    """Create the app. `None` arguments select the env-var cache dir, S3 reader and TAP discovery."""
    if cache_dir is None:
        cache_dir = Path(os.environ.get(CACHE_DIR_ENV) or DEFAULT_CACHE_DIR)
    search_slots = threading.BoundedSemaphore(MAX_CONCURRENT_SEARCHES)

    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        cache = CutoutCache(cache_dir)
        client = httpx.Client(
            timeout=httpx.Timeout(connect=10, read=30, write=10, pool=60),
            limits=httpx.Limits(max_connections=8),
        )
        try:
            builder = FrameBuilder(reader if reader is not None else HttpRangeReader(client),
                                   cache)
            try:
                app.state.builder = builder
                app.state.discover = discover if discover is not None else (
                    lambda ra, dec, detector: discovery.discover(client, ra, dec, detector))
                yield
            finally:
                builder.close()
        finally:
            client.close()

    app = FastAPI(lifespan=lifespan)

    @app.get("/healthz")
    def healthz() -> dict:
        return {"status": "ok"}

    @app.get("/api/search")
    def search(request: Request, ra: str, dec: str, detector: str = "D2") -> dict:
        try:
            ra_deg = parse_ra(ra)
            dec_deg = parse_dec(dec)
        except CoordinateError as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc
        if detector not in DETECTORS:
            raise HTTPException(status_code=422,
                                detail=f"Unknown detector {detector!r}; use one of D1–D6.")
        try:
            with search_slots:
                exposures = request.app.state.discover(ra_deg, dec_deg, detector)
        except DiscoveryError as exc:
            raise HTTPException(status_code=502, detail=str(exc)) from exc
        plans = plan_frames(exposures)
        return {
            "ra_deg": ra_deg,
            "dec_deg": dec_deg,
            "detector": detector,
            "width": GRID_SHAPE[1],
            "height": GRID_SHAPE[0],
            "n_exposures": len(exposures),
            "cap": EXPOSURE_CAP,
            "capped": any(plan.capped for plan in plans),
            "frames": [
                {
                    "index": plan.index,
                    "label": plan.label,
                    "mjd_start": plan.mjd_start,
                    "mjd_end": plan.mjd_end,
                    "n_available": plan.n_available,
                    "n_used": plan.n_used,
                    "capped": plan.capped,
                    "uris": [exposure.uri for exposure in plan.exposures],
                }
                for plan in plans
            ],
        }

    @app.post("/api/frame")
    def frame(request: Request, body: FrameRequest) -> dict:
        if not 0.0 <= body.ra_deg < 360.0 or not -90.0 <= body.dec_deg <= 90.0:
            raise HTTPException(status_code=422, detail="Coordinates are out of range.")
        if not body.uris:
            raise HTTPException(status_code=422, detail="No exposure URIs given.")
        if len(body.uris) > EXPOSURE_CAP:
            raise HTTPException(status_code=422,
                                detail=f"At most {EXPOSURE_CAP} exposure URIs per frame.")
        if not all(is_valid_uri(uri) for uri in body.uris):
            raise HTTPException(status_code=422, detail="Invalid SPHEREx exposure URI.")
        try:
            result = request.app.state.builder.build(body.uris, body.ra_deg, body.dec_deg)
        except FrameError as exc:
            raise HTTPException(status_code=502, detail=str(exc)) from exc
        north_up = result.data[::-1, :].ravel().tolist()
        return {
            "width": GRID_SHAPE[1],
            "height": GRID_SHAPE[0],
            "pixels": [v if math.isfinite(v) else None for v in north_up],
            "n_used": result.n_used,
            "n_failed": result.n_failed,
        }

    app.mount("/", StaticFiles(directory=STATIC_DIR, html=True), name="static")
    return app
