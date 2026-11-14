"""FastAPI application: search and frame endpoints, health check and the static page."""

import asyncio
import base64
import json
import logging
import math
import os
from collections.abc import AsyncIterator, Callable
from contextlib import AsyncExitStack, asynccontextmanager
from pathlib import Path
from typing import Annotated, Literal

import httpx
import numpy as np
from fastapi import FastAPI, HTTPException, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, ConfigDict, Field, StringConstraints
from starlette.concurrency import run_in_threadpool
from starlette.types import ASGIApp, Message, Receive, Scope, Send

from . import discovery
from .cache import CutoutCache
from .coords import CoordinateError, parse_dec, parse_ra
from .discovery import DETECTORS, MAX_URI_LENGTH, DiscoveryError, Exposure, is_valid_uri
from .frames import FrameBuilder, FrameError
from .grid import GRID_SHAPE
from .ratelimit import (
    FRAME_BURST,
    FRAME_PER_MINUTE,
    SEARCH_BURST,
    SEARCH_PER_MINUTE,
    WIDE_BURST,
    WIDE_PER_MINUTE,
    RateLimiter,
    client_key,
)
from .remote import HttpRangeReader, RangeReader
from .visits import EXPOSURE_CAP, plan_frames

CACHE_DIR_ENV = "SPHEREX_CACHE_DIR"
DEFAULT_CACHE_DIR = Path("/data/cutouts")
CACHE_MAX_MB_ENV = "SPHEREX_CACHE_MAX_MB"
DEFAULT_CACHE_MAX_MB = 1024

# astropy's angle parser takes time quadratic in input length (60,000 characters: ~19 s of CPU);
# a precise sexagesimal value needs about 30.
MAX_COORD_LENGTH = 64
# A frame request with 24 URIs of 300 characters is about 8 kB.
MAX_BODY_BYTES = 64 * 1024
# A body of at most 64 kB arrives in well under a second; a client that stalls longer only
# holds a connection and its buffer.
BODY_READ_S = 10.0

MAX_CONCURRENT_SEARCHES = 4
# Discovery normally answers in about a second and `discover` bounds it at 45 s, so a queued
# search normally waits a few seconds and gives up before an unresponsive archive frees a slot.
SEARCH_WAIT_S = 30.0
MAX_CONCURRENT_FRAMES = 4
# A full frame takes about 1.5-3 s on the shared 8-thread pool, so 4 running builds clear
# well within the wait.
FRAME_WAIT_S = 15.0
# A wide frame costs about twice the CPU and 2.6 times the archive bytes of a normal one; one
# at a time leaves three frame slots and most of the core to the frames visitors wait for.
MAX_CONCURRENT_WIDE_FRAMES = 1

INVALID_REQUEST = "Invalid request."
BODY_TOO_LARGE = "Request body too large."
BODY_TIMEOUT = "Request body not received in time."
SERVER_BUSY = "The server is busy. Try again in a moment."
SEARCH_FAILED = "The archive search failed. Try again later."
FRAME_FAILED = "No exposure of this frame could be loaded."
INVALID_RA = "Invalid RA: use degrees from 0 to 360 or sexagesimal hours such as 08h55m10.831s."
INVALID_DEC = "Invalid Dec: use degrees from -90 to +90 or sexagesimal such as -7d14m42.53s."

STATIC_DIR = Path(__file__).parent / "static"

logger = logging.getLogger(__name__)

Uri = Annotated[str, StringConstraints(max_length=MAX_URI_LENGTH)]


class FrameRequest(BaseModel):
    """Body of `POST /api/frame`: the search position (degrees), one frame's exposure URIs and
    the grid: 1 field (the frame) or 3 x 3 fields (the frame and its surround)."""

    model_config = ConfigDict(strict=True)

    ra_deg: Annotated[float, Field(ge=0.0, lt=360.0, allow_inf_nan=False)]
    dec_deg: Annotated[float, Field(ge=-90.0, le=90.0, allow_inf_nan=False)]
    uris: Annotated[list[Uri], Field(min_length=1, max_length=EXPOSURE_CAP)]
    fields: Literal[1, 3] = 1


class RevalidatedStaticFiles(StaticFiles):
    """The page's static files, marked `Cache-Control: no-cache`: a browser may store them but
    revalidates each one (a cheap 304 while unchanged) before use, so after a redeployment it
    never combines a new `index.html` with an old script or stylesheet."""

    def file_response(self, full_path: str | os.PathLike[str], stat_result: os.stat_result,
                      scope: Scope, status_code: int = 200) -> Response:
        response = super().file_response(full_path, stat_result, scope, status_code)
        response.headers["Cache-Control"] = "no-cache"
        return response


class BodyLimit:
    """ASGI middleware: answers 413 once a request body exceeds `max_bytes`, before the app runs.

    The body is read completely (at most `max_bytes`) and then handed to the app, so chunked
    bodies without `Content-Length` are bounded too. A body not complete within `read_s`
    seconds is answered with 408 and its bytes are dropped.
    """

    def __init__(self, app: ASGIApp, max_bytes: int = MAX_BODY_BYTES,
                 read_s: float = BODY_READ_S) -> None:
        self.app = app
        self.max_bytes = max_bytes
        self.read_s = read_s

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        length = dict(scope["headers"]).get(b"content-length")
        if length is not None and (not length.isdigit() or int(length) > self.max_bytes):
            await self._reject(send, 413, BODY_TOO_LARGE)
            return
        try:
            async with asyncio.timeout(self.read_s):
                body = await self._read_body(receive)
        except TimeoutError:
            await self._reject(send, 408, BODY_TIMEOUT)
            return
        if body is None:
            return
        if len(body) > self.max_bytes:
            await self._reject(send, 413, BODY_TOO_LARGE)
            return
        delivered = False

        async def replay() -> Message:
            nonlocal delivered
            if delivered:
                return await receive()
            delivered = True
            return {"type": "http.request", "body": body, "more_body": False}

        await self.app(scope, replay, send)

    async def _read_body(self, receive: Receive) -> bytes | None:
        """The whole body; None if the client disconnected; stops once over `max_bytes`."""
        chunks: list[bytes] = []
        size = 0
        while True:
            message = await receive()
            if message["type"] != "http.request":
                return None
            chunk = message.get("body", b"")
            size += len(chunk)
            chunks.append(chunk)
            if size > self.max_bytes or not message.get("more_body", False):
                return b"".join(chunks)

    @staticmethod
    async def _reject(send: Send, status: int, detail: str) -> None:
        content = json.dumps({"detail": detail}).encode()
        await send({"type": "http.response.start", "status": status, "headers": [
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
async def slot(semaphore: asyncio.Semaphore, wait_s: float,
               request: Request) -> AsyncIterator[None]:
    """Hold one of `semaphore`'s slots; 503 if none frees within `wait_s` seconds.

    A client that disconnected while waiting gets its slot back at once, without the work; the
    503 raised then is never received.
    """
    try:
        async with asyncio.timeout(wait_s):
            await semaphore.acquire()
    except TimeoutError:
        raise HTTPException(status_code=503, detail=SERVER_BUSY) from None
    try:
        # Reading the (buffered) body first makes the next receive report the connection state.
        await request.body()
        if await request.is_disconnected():
            raise HTTPException(status_code=503, detail=SERVER_BUSY)
        yield
    finally:
        semaphore.release()


def check_rate(limiter: RateLimiter, request: Request) -> None:
    """Raise 429 with `Retry-After` when the client's budget in `limiter` is used up.

    The budget is per `client_key` of the client address (IPv4 address, IPv6 /64).
    """
    retry_after = limiter.take(client_key(request.client.host if request.client else ""))
    if retry_after:
        raise HTTPException(status_code=429,
                            detail=f"Too many requests. Try again in {retry_after} s.",
                            headers={"Retry-After": str(retry_after)})


def create_app(*, cache_dir: Path | None = None, reader: RangeReader | None = None,
               discover: Callable[[float, float, str], list[Exposure]] | None = None) -> FastAPI:
    """Create the app. `None` arguments select the env-var cache dir, S3 reader and archive search.

    Raises `ValueError` when `SPHEREX_CACHE_MAX_MB` is invalid.
    """
    if cache_dir is None:
        cache_dir = Path(os.environ.get(CACHE_DIR_ENV) or DEFAULT_CACHE_DIR)
    max_bytes = cache_max_bytes()
    search_limiter = RateLimiter(SEARCH_BURST, SEARCH_PER_MINUTE)
    frame_limiter = RateLimiter(FRAME_BURST, FRAME_PER_MINUTE)
    wide_limiter = RateLimiter(WIDE_BURST, WIDE_PER_MINUTE)

    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        cache = CutoutCache(cache_dir, max_bytes)
        client = httpx.Client(
            timeout=httpx.Timeout(connect=5, read=10, write=10, pool=60),
            # 8 exposure reads plus 4 searches, so a search never queues behind range reads.
            limits=httpx.Limits(max_connections=12),
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
                app.state.wide_slots = asyncio.Semaphore(MAX_CONCURRENT_WIDE_FRAMES)
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
        try:
            if len(ra) > MAX_COORD_LENGTH:
                raise CoordinateError(INVALID_RA)
            ra_deg = parse_ra(ra)
        except CoordinateError:
            raise HTTPException(status_code=422, detail=INVALID_RA) from None
        try:
            if len(dec) > MAX_COORD_LENGTH:
                raise CoordinateError(INVALID_DEC)
            dec_deg = parse_dec(dec)
        except CoordinateError:
            raise HTTPException(status_code=422, detail=INVALID_DEC) from None
        if detector not in DETECTORS:
            raise HTTPException(status_code=422, detail="Unknown detector; use one of D1–D6.")
        check_rate(search_limiter, request)
        try:
            async with slot(request.app.state.search_slots, SEARCH_WAIT_S, request):
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
        wide = body.fields == 3
        check_rate(wide_limiter if wide else frame_limiter, request)
        if not all(is_valid_uri(uri) for uri in body.uris):
            raise HTTPException(status_code=422, detail="Invalid SPHEREx exposure URI.")
        uris = list(dict.fromkeys(body.uris))
        try:
            async with AsyncExitStack() as stack:
                if wide:
                    await stack.enter_async_context(
                        slot(request.app.state.wide_slots, FRAME_WAIT_S, request))
                await stack.enter_async_context(
                    slot(request.app.state.frame_slots, FRAME_WAIT_S, request))
                result = await run_in_threadpool(request.app.state.builder.build,
                                                 uris, body.ra_deg, body.dec_deg, body.fields)
        except FrameError as exc:
            logger.warning("Frame at (%r, %r) failed: %s", body.ra_deg, body.dec_deg, exc)
            raise HTTPException(status_code=502, detail=FRAME_FAILED) from None
        if wide:
            north_up = np.ascontiguousarray(result.data[::-1, :], dtype="<f4")
            return {
                "width": result.data.shape[1],
                "height": result.data.shape[0],
                "pixels_b64": base64.b64encode(north_up.tobytes()).decode("ascii"),
                "n_used": result.n_used,
                "n_fields": list(result.n_fields),
            }
        north_up = result.data[::-1, :].ravel().tolist()
        return {
            "width": GRID_SHAPE[1],
            "height": GRID_SHAPE[0],
            "pixels": [v if math.isfinite(v) else None for v in north_up],
            "n_used": result.n_used,
        }

    app.mount("/", RevalidatedStaticFiles(directory=STATIC_DIR, html=True), name="static")
    return app
