FROM python:3.13-slim

ENV PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1 OPENBLAS_NUM_THREADS=1 OMP_NUM_THREADS=1

WORKDIR /app

# Install the runtime dependencies listed in pyproject.toml first, so this layer stays cached
# when only the source changes.
COPY pyproject.toml ./
RUN python -c "import tomllib; print('\n'.join(tomllib.load(open('pyproject.toml', 'rb'))['project']['dependencies']))" > /tmp/requirements.txt \
    && pip install --no-cache-dir -r /tmp/requirements.txt \
    && rm /tmp/requirements.txt

# The source is bind-mounted for the install only, so the image holds just the installed package.
RUN --mount=type=bind,source=src,target=/app/src,rw \
    pip install --no-cache-dir --no-deps . && mkdir /data

EXPOSE 8000

# 100 connections: far above one page load (a browser opens at most 6) and the 8 work slots,
# far below the ~5,000 stalled uploads that exhaust 512 MB.
CMD ["uvicorn", "spherex_viewer.app:create_app", "--factory", "--host", "0.0.0.0", "--port", "8000", "--proxy-headers", "--forwarded-allow-ips", "*", "--workers", "1", "--timeout-graceful-shutdown", "8", "--limit-concurrency", "100"]
