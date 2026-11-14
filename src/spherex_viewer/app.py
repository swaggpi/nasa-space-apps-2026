"""FastAPI application: search and frame endpoints, health check and the static page."""

import asyncio
import json
import logging
import math
import os
from collections.abc import AsyncIterator, Callable
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Annotated

import httpx
from fastapi import FastAPI, HTTPException, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, ConfigDict, Field, StringConstraints
from starlette.concurrency import run_in_threadpool
from starlette.types import ASGIApp, Message, Receive, Scope, Send

from . import discovery
from .cache import CutoutCache
from .coords import CoordinateError, parse_dec, parse_ra
from .discovery import DETECTORS, DiscoveryError, Exposure, is_valid_uri
from .frames import FrameBuilder, FrameError
from .grid import GRID_SHAPE
from .ratelimit import FRAME_BURST, FRAME_PER_MINUTE, SEARCH_BURST, SEARCH_PER_MINUTE, RateLimiter
from .remote import HttpRangeReader, RangeReader
from .visits import EXPOSURE_CAP, plan_frames

CACHE_DIR_ENV = "SPHEREX_CACHE_DIR"
DEFAULT_CACHE_DIR = Path("/data/cutouts")
CACHE_MAX_MB_ENV = "SPHEREX_CACHE_MAX_MB"
DEFAULT_CACHE_MAX_MB = 1024

MAX_URI_LENGTH = 300
# A frame request with 24 URIs of 300 characters is about 8 kB.
MAX_BODY_BYTES = 64 * 1024

MAX_CONCURRENT_SEARCHES = 4
# TAP answers took 2.7-32 s, so a queued search waits about one slow answer before giving up.
SEARCH_WAIT_S = 30.0
MAX_CONCURRENT_FRAMES = 4
# A full frame takes ~3 s on the shared 4-thread pool, so 4 running builds clear in ~12 s.
FRAME_WAIT_S = 15.0

INVALID_REQUEST = "Invalid request."
BODY_TOO_LARGE = "Request body too large."
SERVER_BUSY = "The server is busy. Try again in a moment."
SEARCH_FAILED = "The archive search failed. Try again later."
FRAME_FAILED = "No exposure of this frame could be loaded."

STATIC_DIR = Path(__file__).parent / "static"

logger = logging.getLogger(__name__)

Uri = Annotated[str, StringConstraints(max_length=MAX_URI_LENGTH)]


class FrameRequest(BaseModel):
    """Body of `POST /api/frame`: the search position (degrees) and one frame's exposure URIs."""

    model_config = ConfigDict(strict=True)

    ra_deg: Annotated[float, Field(ge=0.0, lt=360.0, allow_inf_nan=False)]
    dec_deg: Annotated[float, Field(ge=-90.0, le=90.0, allow_inf_nan=False)]
    uris: Annotated[list[Uri], Field(min_length=1, max_length=EXPOSURE_CAP)]


class BodyLimit:
    """ASGI middleware: answers 413 once a request body exceeds `max_bytes`, before the app runs.

    The body is read completely (at most `max_bytes`) and then handed to the app, so chunked
    bodies without `Content-Length` are bounded too.
    """

    def __init__(self, app: ASGIApp, max_bytes: int = MAX_BODY_BYTES) -> None:
        self.app = app
        self.max_bytes = max_bytes

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        length = dict(scope["headers"]).get(b"content-length")
        if length is not None and (not length.isdigit() or int(length) > self.max_bytes):
            await self._reject(send)
            return
        chunks: list[bytes] = []
        size = 0
        while True:
            message = await receive()
            if message["type"] != "http.request":
                return
            chunk = message.get("body", b"")
            size += len(chunk)
            if size > self.max_bytes:
                await self._reject(send)
                return
            chunks.append(chunk)
            if not message.get("more_body", False):
                break
        body = b"".join(chunks)
        delivered = False

        async def replay() -> Message:
            nonlocal delivered
            if delivered:
                return await receive()
            delivered = True
            return {"type": "http.request", "body": body, "more_body": False}

        await self.app(scope, replay, send)

    @staticmethod
    async def _reject(send: Send) -> None:
        content = json.dumps({"detail": BODY_TOO_LARGE}).encode()
        await send({"type": "http.response.start", "status": 413, "headers": [
            (b"content-type", b"application/json"),
            (b"content-length", str(len(content)).encode()),
            (b"connection", b"close"),
        ]})
        await send({"type": "http.response.body", "body": content})


def cache_max_bytes() -> int:
    """Return the cache size cap from `SPHEREX_CACHE_MAX_MB` (MB = 2**20 bytes, default 1024).

    Raises `ValueError` for a non-numeric, non-finite or non-positive value.
    """
    text = os.environ.get(CACHE_MAX_MB_ENV, "").strip()
    if not text:
        return DEFAULT_CACHE_MAX_MB * 2**20
    try:
        megabytes = float(text)
    except ValueError:
        megabytes = math.nan
    if not math.isfinite(megabytes) or megabytes <= 0:
        raise ValueError(f"{CACHE_MAX_MB_ENV} must be a positive number of megabytes, "
                         f"got {text!r}.")
    return max(1, int(megabytes * 2**20))


@asynccontextmanager
async def slot(semaphore: asyncio.Semaphore, wait_s: float) -> AsyncIterator[None]:
    """Hold one of `semaphore`'s slots; 503 if none frees within `wait_s` seconds."""
    try:
        async with asyncio.timeout(wait_s):
            await semaphore.acquire()
    except TimeoutError:
        raise HTTPException(status_code=503, detail=SERVER_BUSY) from None
    try:
        yield
    finally:
        semaphore.release()


def check_rate(limiter: RateLimiter, request: Request) -> None:
    """Raise 429 with `Retry-After` when the client's budget in `limiter` is used up."""
    retry_after = limiter.take(request.client.host if request.client else "")
    if retry_after:
        raise HTTPException(status_code=429,
                            detail=f"Too many requests. Try again in {retry_after} s.",
                            headers={"Retry-After": str(retry_after)})


def create_app(*, cache_dir: Path | None = None, reader: RangeReader | None = None,
               discover: Callable[[float, float, str], list[Exposure]] | None = None) -> FastAPI:
    """Create the app. `None` arguments select the env-var cache dir, S3 reader and TAP discovery.

    Raises `ValueError` when `SPHEREX_CACHE_MAX_MB` is invalid.
    """
    if cache_dir is None:
        cache_dir = Path(os.environ.get(CACHE_DIR_ENV) or DEFAULT_CACHE_DIR)
    max_bytes = cache_max_bytes()
    search_limiter = RateLimiter(SEARCH_BURST, SEARCH_PER_MINUTE)
    frame_limiter = RateLimiter(FRAME_BURST, FRAME_PER_MINUTE)

    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        cache = CutoutCache(cache_dir, max_bytes)
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
                app.state.search_slots = asyncio.Semaphore(MAX_CONCURRENT_SEARCHES)
                app.state.frame_slots = asyncio.Semaphore(MAX_CONCURRENT_FRAMES)
                yield
            finally:
                builder.close()
        finally:
            client.close()

    app = FastAPI(lifespan=lifespan, docs_url=None, redoc_url=None, openapi_url=None)
    app.add_middleware(BodyLimit)

    @app.exception_handler(RequestValidationError)
    async def invalid_request(request: Request, exc: RequestValidationError) -> JSONResponse:
        return JSONResponse(status_code=422, content={"detail": INVALID_REQUEST})

    @app.get("/healthz")
    async def healthz() -> dict:
        return {"status": "ok"}

    @app.get("/api/search")
    async def search(request: Request, ra: str, dec: str, detector: str = "D2") -> dict:
        check_rate(search_limiter, request)
        try:
            ra_deg = parse_ra(ra)
        except CoordinateError:
            raise HTTPException(status_code=422, detail="Invalid RA: use degrees from 0 to 360 "
                                "or sexagesimal hours such as 08h55m10.831s.") from None
        try:
            dec_deg = parse_dec(dec)
        except CoordinateError:
            raise HTTPException(status_code=422, detail="Invalid Dec: use degrees from -90 to "
                                "+90 or sexagesimal such as -7d14m42.53s.") from None
        if detector not in DETECTORS:
            raise HTTPException(status_code=422, detail="Unknown detector; use one of D1–D6.")
        try:
            if True:
                exposures = await run_in_threadpool(request.app.state.discover,
                                                    ra_deg, dec_deg, detector)
        except DiscoveryError as exc:
            logger.warning("Search at (%r, %r) %s failed: %s", ra_deg, dec_deg, detector, exc)
            raise HTTPException(status_code=502, detail=SEARCH_FAILED) from None
        plans = plan_frames(exposures)
        return {
            "ra_deg": ra_deg,
            "dec_deg": dec_deg,
            "detector": detector,
            "n_exposures": len(exposures),
            "cap": EXPOSURE_CAP,
            "capped": any(plan.capped for plan in plans),
            "frames": [
                {
                    "label": plan.label,
                    "n_available": plan.n_available,
                    "n_used": plan.n_used,
                    "capped": plan.capped,
                    "uris": [exposure.uri for exposure in plan.exposures],
                }
                for plan in plans
            ],
        }

    @app.post("/api/frame")
    async def frame(request: Request, body: FrameRequest) -> dict:
        check_rate(frame_limiter, request)
        if not all(is_valid_uri(uri) for uri in body.uris):
            raise HTTPException(status_code=422, detail="Invalid SPHEREx exposure URI.")
        uris = list(dict.fromkeys(body.uris))
        try:
            async with slot(request.app.state.frame_slots, FRAME_WAIT_S):
                result = await run_in_threadpool(request.app.state.builder.build,
                                                 uris, body.ra_deg, body.dec_deg)
        except FrameError as exc:
            logger.warning("Frame at (%r, %r) failed: %s", body.ra_deg, body.dec_deg, exc)
            raise HTTPException(status_code=502, detail=FRAME_FAILED) from None
        north_up = result.data[::-1, :].ravel().tolist()
        return {
            "width": GRID_SHAPE[1],
            "height": GRID_SHAPE[0],
            "pixels": [v if math.isfinite(v) else None for v in north_up],
            "n_used": result.n_used,
        }

    app.mount("/", StaticFiles(directory=STATIC_DIR, html=True), name="static")
    return app
