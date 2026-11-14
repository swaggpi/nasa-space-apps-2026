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
docker run --rm -p 8000:8000 --memory 512m --env-file .env -v hack-demo-data:/data hack-demo
```

The container serves plain HTTP on `0.0.0.0:8000` (one uvicorn worker) and is meant to sit
behind a TLS-terminating reverse proxy such as Caddy (e.g. `reverse_proxy localhost:8000` for
the subdomain); it trusts the proxy's `X-Forwarded-Proto` and `X-Forwarded-For` headers.
`GET /healthz` returns 200 `{"status":"ok"}` once the app is ready.

Everything that must survive a restart lives under `/data`: the on-disk cutout cache in
`/data/cutouts`, created on first start. Mount a named volume or any host directory there.

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `SPHEREX_CACHE_DIR` | `/data/cutouts` | Directory of the cutout cache; created at startup. |

No secrets are needed: all data sources are public. Outbound HTTPS honours the standard
`HTTPS_PROXY` and `SSL_CERT_FILE` variables if your network requires them.

## Tests

```sh
pytest                               # unit tests on synthetic data, no network
pytest -m live                       # live validation against IRSA and S3
node --test 'tests/js/*.test.mjs'    # pure frontend logic (Node 22)
node --test 'tests/e2e/*.test.mjs'   # opt-in: starts the app and drives a real browser via Playwright
```

## Limitations

- Coordinates are used as given; fast-moving stars need current-epoch coordinates to fall in
  the 6′ field.
- Each frame averages over the detector's wavelength range and visits sample that range
  differently, so part of any frame-to-frame brightness change is not intrinsic.
- Very bright stars show an empty (no-data) core because the detector saturates there.
- The cutout cache has no eviction; it grows by about 0.7 MB (typical position) to 6 MB (deep
  field) per new search.

## Acknowledgement

This publication makes use of data products from the Spectro-Photometer for the History of the
Universe, Epoch of Reionization and Ices Explorer (SPHEREx), which is a joint project of the Jet
Propulsion Laboratory and the California Institute of Technology, and is funded by the National
Aeronautics and Space Administration.
