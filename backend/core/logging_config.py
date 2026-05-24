"""
core/logging_config.py
─────────────────────────────────────────────────────
Structured logging configuration.

In production, logs are JSON so they can be parsed by any log
aggregator (Render logs, Grafana Loki, Datadog, etc). In dev,
we keep the pretty loguru default because it reads better in a
terminal.

Every request gets a short request ID via middleware (`RequestIDMiddleware`
in api.py). That ID is bound into loguru's context so every log line
emitted while handling the request carries it automatically.
"""
from __future__ import annotations

import json
import sys
import uuid
from contextvars import ContextVar

from loguru import logger

from core.config import get_settings


_request_id: ContextVar[str] = ContextVar("request_id", default="-")


def current_request_id() -> str:
    return _request_id.get()


def set_request_id(rid: str | None = None) -> str:
    rid = rid or uuid.uuid4().hex[:12]
    _request_id.set(rid)
    return rid


def _patch_record(record: dict) -> None:
    """Inject request_id into every log record."""
    record["extra"]["request_id"] = _request_id.get()


def _json_sink(message: object) -> None:
    """Emit one JSON object per log line to stdout."""
    rec = message.record  # type: ignore[attr-defined]
    payload = {
        "ts": rec["time"].isoformat(),
        "level": rec["level"].name,
        "msg": rec["message"],
        "module": rec["name"],
        "request_id": rec["extra"].get("request_id", "-"),
    }
    if rec["exception"] is not None:
        payload["exc_type"] = rec["exception"].type.__name__ if rec["exception"].type else None
        payload["exc_value"] = str(rec["exception"].value) if rec["exception"].value else None
    sys.stdout.write(json.dumps(payload, default=str) + "\n")
    sys.stdout.flush()


def configure_logging() -> None:
    """Call once at process startup."""
    s = get_settings()
    logger.remove()
    logger.configure(patcher=_patch_record)

    if s.is_prod:
        logger.add(_json_sink, level=s.LOG_LEVEL, enqueue=True)
    else:
        logger.add(
            sys.stdout,
            level=s.LOG_LEVEL,
            format=(
                "<green>{time:HH:mm:ss}</green> | <level>{level:<7}</level> | "
                "<cyan>{extra[request_id]}</cyan> | {message}"
            ),
            enqueue=False,
        )

    logger.info(f"Logging configured: env={s.ENVIRONMENT} level={s.LOG_LEVEL}")
