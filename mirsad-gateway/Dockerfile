FROM python:3.12-slim

# libgomp1: LightGBM; pango/harfbuzz: WeasyPrint PDF evidence reports.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates libgomp1 \
      libpango-1.0-0 libpangoft2-1.0-0 libharfbuzz0b libharfbuzz-subset0 \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Dependencies first, in their own layer, so a code change rebuilds in seconds.
COPY pyproject.toml ./
RUN mkdir -p src/scamshield && touch src/scamshield/__init__.py \
 && pip install --no-cache-dir . \
 && pip uninstall -y scamshield \
 && rm -rf src build \
 && python -m playwright install --with-deps chromium-headless-shell \
 && rm -rf /var/lib/apt/lists/*

# Editable install: the package runs from /app/src, data files (brand registry, fonts, templates) included.
COPY src ./src
COPY dashboard ./dashboard
RUN pip install --no-cache-dir --no-deps -e .

ENV SCAMSHIELD_ROOT=/app \
    SCAMSHIELD_DATA=/app/data \
    SCAMSHIELD_MODELS=/app/ml/artifacts \
    PYTHONUNBUFFERED=1

EXPOSE 8000
CMD ["python", "-m", "scamshield", "serve"]
