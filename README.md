# SPHEREx sky-change viewer

A small web tool for the NASA Space Apps 2026 challenge "Planet X and SPHEREx". You enter a sky
position (RA/Dec, ICRS, decimal degrees or sexagesimal such as `08h55m10.831s`, `-7d14m42.53s`)
and a detector (D1–D6). The server asks the IRSA archive for every SPHEREx spectral-image
exposure covering that position, reads only the needed pixels of each exposure from the public
`nasa-irsa-spherex` S3 bucket with HTTP range requests, resamples them onto one common 6′×6′
north-up grid centred on the position, and co-adds them into one frame per visit (at most 30
days). The page plays the frames like a short video with one common brightness stretch, so
moving or changing objects stand out.

## Run locally

Requires Python 3.12 or newer.

```sh
python3 -m venv .venv
. .venv/bin/activate
pip install -e '.[dev]'
SPHEREX_CACHE_DIR=./cache uvicorn spherex_viewer.app:create_app --factory --port 8000
```

Open http://localhost:8000/.

## Run with Docker

```sh
docker build --platform linux/amd64 -t hack-demo .
cp .env.example .env
docker run --rm -p 127.0.0.1:8000:8000 --memory 512m --env-file .env -v hack-demo-data:/data hack-demo
```

The container serves plain HTTP on `0.0.0.0:8000` (one uvicorn worker) and is meant to sit
behind a TLS-terminating reverse proxy such as Caddy (e.g. `reverse_proxy localhost:8000` for
the subdomain). It trusts `X-Forwarded-For` and `X-Forwarded-Proto` from any peer, and the rate
limits are keyed by that forwarded address, so the container port must be reachable only
through the proxy (publish it on `127.0.0.1` as above, never on a public interface).
`GET /healthz` returns 200 `{"status":"ok"}` once the app is ready.

Everything that must survive a restart lives under `/data`: the on-disk cutout cache in
`/data/cutouts`, created on first start. Mount a named volume or any host directory there.

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `SPHEREX_CACHE_DIR` | `/data/cutouts` | Directory of the cutout cache; created at startup. |
| `SPHEREX_CACHE_MAX_MB` | `1024` | Size cap of the cutout cache in MB; must be a positive number. |

No secrets are needed: all data sources are public. Outbound HTTPS honours the standard
`HTTPS_PROXY` and `SSL_CERT_FILE` variables if your network requires them.

## Limits

- Per client address: 10 searches at once, then 2 per minute; 60 frame requests at once, then
  6 per minute. Beyond that the server answers 429 with a `Retry-After` header.
- At most 4 searches and 4 frame builds run at a time; a request that cannot start within
  30 s (search) or 15 s (frame) gets 503.
- The cutout cache is capped at `SPHEREX_CACHE_MAX_MB`; older cutouts are
  removed when it is exceeded. A typical search adds about 0.7 MB, a deep field about 6 MB.

## Tests and validation

```sh
pytest                               # unit tests on synthetic data, no network
pytest -m live                       # three smoke tests against the real IRSA archive and S3
node --test 'tests/js/*.test.mjs'    # pure frontend logic (Node 22)
node --test 'tests/e2e/*.test.mjs'   # opt-in: starts the app and drives a real browser via Playwright
python validation/run_validation.py  # live validation on real data; writes validation/REPORT.md
```

## Limitations

- **What it is for**: stars whose position changes by several arcseconds between visits, and
  sources whose brightness changes by more than about a factor 1.5–2. It is not a tool for
  finding asteroids, comets or a distant planet, and not a photometer.
- **Solar-system objects**: each frame is a median over one visit, so anything moving faster
  than about 1″ per hour within a visit is suppressed, and anything moving more than about 3′
  between visits leaves the 6′ field.
- **Coordinates are used as given**: fast-moving stars need current-epoch coordinates to fall
  inside the field.
- **Sparse frames**: frames built from only one or two exposures have no artefact rejection and
  can show cosmic rays or a bright band; about half of all searches contain a frame with five
  exposures or fewer. The page shows each frame's exposure count next to its date (e.g.
  `2025-11-07 – 2025-11-10 · 19 exposures`), so such frames can be recognised.
- **Brightness**: each frame averages over the detector's wavelength range and visits sample
  that range differently. Constant stars vary by about 4 % in flux and up to about 40 % in peak
  pixel between frames, sources with strong spectral features far more, and the brightest
  pixels are clipped to white. Changes below about a factor 1.5 are not evidence of
  variability.
- **Saturation**: stars near saturation can switch between a visible core and a no-data hole
  between frames, and the hole's outline can shift by about a pixel; that is not motion. Very
  bright stars show an empty core throughout.
- **Positions**: shifts smaller than about 1″ (a sixth of a pixel) are not significant.
- **Extended emission** that fills the field is subtracted with the background.
- **Exposure cap**: above 24 exposures per frame, exposures are picked evenly spaced in time
  order (every k-th exposure), not at evenly spaced clock times; this samples the detector's
  wavelength range more evenly.

## Acknowledgement

This publication makes use of data products from the Spectro-Photometer for the History of the
Universe, Epoch of Reionization and Ices Explorer (SPHEREx), which is a joint project of the Jet
Propulsion Laboratory and the California Institute of Technology, and is funded by the National
Aeronautics and Space Administration.
