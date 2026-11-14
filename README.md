# SPHEREx sky-change viewer

A small web tool for the NASA Space Apps 2026 challenge "Planet X and SPHEREx". You enter a sky
position (RA/Dec, ICRS, decimal degrees or sexagesimal such as `08h55m10.831s`, `-7d14m42.53s`)
and a detector (D1–D6). The server asks the IRSA archive for every SPHEREx spectral-image
exposure covering that position, reads only the needed pixels of each exposure from the public
`nasa-irsa-spherex` S3 bucket with HTTP range requests, resamples them onto one common 6′×6′
north-up grid centred on the position, and co-adds them into one frame per visit (at most 30
days). The page plays the frames like a short video with one common brightness stretch, so
moving or changing objects stand out.

Searches use IRSA's Simple Image Access service across all SPHEREx collections, so new releases
appear automatically; a search normally answers in about a second. IRSA's gateway sometimes
rejects requests briefly; the tool retries for up to about 20 s and then reports the archive as
unavailable — try again a moment later.

The homepage opens on a precomputed example, `src/spherex_viewer/static/example.json`:
Barnard's Star in detector D6, three real SPHEREx frames from August 2025 to August 2026, so it
plays without an archive search. It is built by `.venv/bin/python scripts/build_example.py` with
the server's own pipeline. The marker is the star's position predicted from Gaia DR3 proper
motion and parallax; it agrees with the star's measured centre to within 0.15 pixel.

The page shows the sky image with Play/Pause, previous and next frame and a timeline below it,
and the date (or date range) and exposure count of the shown frame. The target panel beside it
(below it on narrow screens) names what is shown, gives a short hint for the example, toggles
the marker and the difference view, and always shows the search: "Pick on sky map", the RA and
Dec fields, the detector with its wavelength range (D2 by default) and "Show".

The − and + buttons beside the timeline, or the − and + keys, zoom the image while it plays,
from 18′ to 1.5′ across; the arrow keys move the view (Left is east, Up is north). After the
last frame of a search has loaded, the page loads the surrounding area: one 18′ frame (3×3
fields) per visit, from the same exposures, about 2.6 times the archive bytes of the normal
frames. For loops of more than 120 exposures it loads only at the first zoom-out or move. The
surround uses each exposure's sky level from the central field, so the centre stays exactly as
it was when the surround arrives; it has fewer exposures towards the edges (the label then
shows a range such as `23–24 exposures`) and can show a faint brightness ramp (see
Limitations). Holding an arrow key at the edge of the loaded area and resting for half a
second searches the next 6′ field in that direction; the frames shown keep playing until it
has loaded, and the address bar then names its centre.

"Pick on sky map" replaces the image with a map of the sky (2MASS J, H, K colour images,
near-infrared like SPHEREx), centred on the position shown, about 1.5° across. Drag to pan,
scroll, pinch or use −/+ to zoom between the whole sky and 2′. A click or tap selects a
position: the map outlines the 6′ field around it that a search would fetch and shows its
RA/Dec. "Search here" runs the search there with the chosen detector, exactly as if the
coordinates had been typed; "Close map" returns without searching. Selecting alone never
searches.

The map uses [Aladin Lite](https://github.com/cds-astro/aladin-lite) 3.8.2 (CDS, Strasbourg),
vendored unmodified as `src/spherex_viewer/static/vendor/aladin.js` with its licence (GNU LGPL
v3, see `vendor/README.md`). The page loads it only when the map is first opened. The map's
images come from the 2MASS colour HiPS that IRSA hosts: when the map is opened, the visitor's
browser fetches them from `irsa.ipac.caltech.edu`; nothing else on the page leaves the server's
origin. The library is 2.4 MB uncompressed (0.8 MB gzipped), so the reverse proxy should
compress responses (Caddy: `encode gzip`).

The box "Difference from the other frames" in the target panel (off by default, available once
two frames are loaded) draws each frame as its difference from the others instead: the frame
minus the exposure-weighted average of the other frames, averaged over 3×3 pixels, on the sky
image's brightness scale. Mid-grey means no difference, white brighter, black fainter; pixels
without a difference stay transparent.

A result can be linked: `?ra=…&dec=…&detector=…` after the page's address opens that search
without a click, also inside an `<iframe>` (a sandboxed one needs `allow-scripts` and
`allow-same-origin`). Every submitted search leaves such a link in the
address bar, so a reload repeats the search; without these parameters the page opens on the
example. The five challenge targets, each with a detector that suits it, to append to the
page's address (e.g. http://localhost:8000/):
`?ra=269.4462683&dec=4.7682045&detector=D6` (Barnard's Star),
`?ra=331.0965743&dec=-56.8010859&detector=D5` (Epsilon Indi B),
`?ra=08h55m10.831s&dec=-7d14m42.53s&detector=D6` (WISE 0855),
`?ra=76.9560812&dec=30.40120459&detector=D5` (RW Aurigae),
`?ra=248.16737837&dec=66.75500675&detector=D6` (R Draconis).

## Run locally

Requires Python 3.12 or newer.

```sh
python3 -m venv .venv
. .venv/bin/activate
pip install -e '.[dev]'
SPHEREX_CACHE_DIR=./cache uvicorn spherex_viewer.app:create_app --factory --port 8000 \
    --limit-concurrency 100
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
the subdomain).

Note: the app trusts `X-Forwarded-For` from any peer (rate limits are keyed by it), so port 8000
must only be reachable through the reverse proxy: publish it on the loopback interface with
`-p 127.0.0.1:8000:8000` when Caddy runs on the host, or publish no port and share a Docker
network when Caddy runs in a container.

`GET /healthz` returns 200 `{"status":"ok"}` once the app is ready.

Everything that must survive a restart lives under `/data`: the on-disk cutout cache in
`/data/cutouts`, created on first start. Mount a named volume or any host directory there.

## API

- `GET /api/search?ra=…&dec=…&detector=D2` lists the frames of a position: per visit its date
  label, exposure counts and exposure URIs.
- `POST /api/frame` with `{"ra_deg": …, "dec_deg": …, "uris": [...]}` (one frame's URIs from
  the search) answers `{"width": 59, "height": 59, "pixels": [...], "n_used": …}`: 3,481
  values in MJy/sr, row by row with the first row north and the first column east, `null`
  where there is no data. With `"fields": 3` it builds the frame and its surround, 3×3 fields
  of 59 pixels, and answers `{"width": 177, "height": 177, "pixels_b64": …, "n_used": …,
  "n_fields": [...]}`: `pixels_b64` is the base64 of 31,329 little-endian float32 values in the
  same order (NaN where there is no data), `n_fields` the exposures with data in each field
  (north row first, east column first) and `n_used` that of the central field. The central
  59×59 pixels equal the 1-field frame. `fields` is 1 (the default) or 3.

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `SPHEREX_CACHE_DIR` | `/data/cutouts` | Directory of the cutout cache; created at startup. |
| `SPHEREX_CACHE_MAX_MB` | `1024` | Size cap of the cutout cache in MB; must be a positive number. |

No secrets are needed: all data sources are public. Outbound HTTPS honours the standard
`HTTPS_PROXY` and `SSL_CERT_FILE` variables if your network requires them.

## Limits

- Per client address: 10 searches at once, then 2 per minute; 60 frame requests at once, then
  6 per minute; separately, 40 wide frame requests (`"fields": 3`) at once, then 6 per minute.
  Beyond that the server answers 429 with a `Retry-After` header.
- At most 4 searches and 4 frame builds run at a time, and of the frame builds at most one
  wide one; a request that cannot start within 30 s (search) or 15 s (frame; a wide frame
  waits up to 15 s for the wide slot, then for a frame slot) gets 503.
- The cutout cache is capped at `SPHEREX_CACHE_MAX_MB`; older cutouts are
  removed when it is exceeded. A typical search adds about 0.7 MB, a deep field about 6 MB;
  its surround about 8 MB, a deep field's about 54 MB.

## Tests and validation

```sh
pytest                               # unit tests on synthetic data, no network
pytest -m live                       # three smoke tests against the real IRSA archive and S3
node --test 'tests/js/*.test.mjs'    # pure frontend logic (Node 22)
node --test 'tests/e2e/*.test.mjs'   # opt-in: starts the app and drives a real browser via Playwright
python validation/run_validation.py  # live validation on real data; writes validation/REPORT.md
node validation/check_difference.mjs http://localhost:8000 > /tmp/DIFFERENCE.md \
    && mv /tmp/DIFFERENCE.md validation/DIFFERENCE.md
```

The last command checks the difference view on real loops of the five targets and a constant
control star through a running server (a JSON file of recorded loops works too). It exits with
status 1 if a must-show target (Barnard's Star, Epsilon Indi B, RW Aurigae) has no frame from
more than five exposures or is not drawn strongly at the centre in each such frame (at least
50 and twice the field), if the strongest such frame of each of these loops does not reach 100,
if a frame of the constant control star from more than five exposures reaches 85 at the centre,
or if a field pixel reaches half scale. A strong centre in one frame is not by itself a change
(see the control in `validation/DIFFERENCE.md`). A server that answers "too many requests" is
asked again after the wait it names. On a failed check or an unreachable server the committed
`validation/DIFFERENCE.md` is left in place.

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
- **Difference view** (numbers from `validation/DIFFERENCE.md`; grey distance is how far a
  pixel is drawn from mid-grey, out of the 127.5 grey levels between mid-grey and black or
  white): every bright star leaves a residual at the centre even when it is constant, from the
  few-per-cent flux and pixel-phase scatter described under Brightness. The constant flux
  standard HD 2811 is drawn at 57.5–75.5 in D5 and D6, often as a black-and-white pair, against
  76.5–121.5 for Barnard's Star (D6), Epsilon Indi B (D5) and RW Aurigae (D5), in frames from
  more than five exposures. The two ranges touch: the weakest target frames are no stronger than
  the control, and only the strongest frame of each target loop (105.5–121.5) clearly exceeds
  it, so a pair or patch in a single frame at a bright star proves nothing. Look instead for a
  pair that reverses between the first and the last frame (motion) or a patch that changes sign
  (brightness). A patch of one sign means the
  frame is brighter or fainter there than the others (RW Aurigae); a cool object can show one
  from wavelength sampling alone in D1–D4, as Epsilon Indi B, a constant source, does in D2.
  Pixels next to the no-data hole of a saturated star are unreliable (R Draconis). Frames from
  five or fewer exposures can show artefacts as change. WISE 0855 is not
  distinguishable from the field (at most 17.5 of the 127.5 grey levels at the target, up to
  46.5 elsewhere). In frames from more than five exposures, no pixel more than 9 px from the
  centre reaches half scale (64) in any of the checked loops, so the fainter field stars there
  stay below it.
- **Surround**: it uses only exposures that cover the central field, with each exposure's
  sky level from that field, so exposures thin out towards its edges and a frame from one or
  two exposures can have empty patches there. One constant per exposure leaves the real sky
  gradient: across 18′ the field medians differ by about one frame noise level, differently
  per frame, so a faint brightness ramp can show (in the 6′ frame about a third of that).
- **Exposure cap**: above 24 exposures per frame, exposures are picked evenly spaced in time
  order (every k-th exposure), not at evenly spaced clock times; this samples the detector's
  wavelength range more evenly.

## Acknowledgement

This publication makes use of data products from the Spectro-Photometer for the History of the
Universe, Epoch of Reionization and Ices Explorer (SPHEREx), which is a joint project of the Jet
Propulsion Laboratory and the California Institute of Technology, and is funded by the National
Aeronautics and Space Administration.

The sky map shows data from the Two Micron All Sky Survey (2MASS), a joint project of the
University of Massachusetts and the Infrared Processing and Analysis Center/California Institute
of Technology, funded by NASA and the NSF, as a HiPS colour survey made by CDS (CNRS/Unistra,
ODbL 1.0) and served by IRSA. The map is drawn with Aladin Lite (Boch & Fernique 2014, ASPC
485, 277).
