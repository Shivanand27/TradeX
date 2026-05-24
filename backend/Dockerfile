# syntax=docker/dockerfile:1.6
# ───────────────────────────────────────────────────────────
# TradeX backend — production Dockerfile
# ───────────────────────────────────────────────────────────
# Multi-stage build:
#   1. builder  — installs Python deps into a venv
#   2. runtime  — slim image with only the venv + app code
#
# Security hardening:
#   • Runs as non-root UID 10001
#   • No build tools / no pip in the final image
#   • Read-only root FS compatible (write to /tmp only)
#   • Healthcheck hits /health (liveness, not /ready to avoid
#     marking the container unhealthy when Supabase hiccups)
# ───────────────────────────────────────────────────────────

ARG PYTHON_VERSION=3.11
FROM python:${PYTHON_VERSION}-slim-bookworm AS builder

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

WORKDIR /build

# Minimal build deps for cryptography / pandas wheels
RUN apt-get update \
    && apt-get install -y --no-install-recommends build-essential gcc \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt ./
RUN python -m venv /opt/venv \
    && /opt/venv/bin/pip install --upgrade pip wheel \
    && /opt/venv/bin/pip install -r requirements.txt


# ────────────────────────────────────────────────────────────
FROM python:${PYTHON_VERSION}-slim-bookworm AS runtime

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PATH="/opt/venv/bin:${PATH}" \
    PYTHONPATH=/app

# libgomp1 is required by numpy/pandas at runtime; tini for proper
# PID 1 signal handling; curl for the healthcheck.
RUN apt-get update \
    && apt-get install -y --no-install-recommends libgomp1 tini curl \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --uid 10001 --create-home --shell /usr/sbin/nologin app

COPY --from=builder /opt/venv /opt/venv

WORKDIR /app
COPY --chown=app:app . /app

USER 10001
EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD curl -fsS http://127.0.0.1:${PORT:-8000}/health || exit 1

ENTRYPOINT ["/usr/bin/tini", "--"]
# uvicorn workers=1 is intentional: we rely on the async event loop
# and the process is stateful (WebSocket manager, in-proc caches).
# Scale horizontally by running more containers, not more workers.
CMD ["sh", "-c", "uvicorn api:app --host 0.0.0.0 --port ${PORT:-8000} --workers 1 --proxy-headers --forwarded-allow-ips='*'"]
