"""
core/ratelimit.py
─────────────────────────────────────────────────────
Lightweight per-user/per-IP rate limiter backed by the state store.

Semantics: fixed-window counter (not sliding). Simple, fast, and
good enough for abuse protection on a 1-minute window. For true
fairness we'd use a token bucket, but the infra cost (Redis Lua
or a proper worker) is not worth it at this scale.

Usage:
    from fastapi import Depends
    from core.ratelimit import rate_limit

    @app.post("/scan/run", dependencies=[Depends(rate_limit("scan", per_minute=5))])
    async def trigger_scan(...):
        ...
"""
from __future__ import annotations

import time
from typing import Callable

from fastapi import HTTPException, Request, status


def _current_window() -> int:
    return int(time.time() // 60)


def _client_key(request: Request, user: dict | None) -> str:
    """
    Prefer authenticated user ID; fall back to the real client IP.
    Works behind a proxy if X-Forwarded-For is passed through.
    """
    if user and user.get("id"):
        return f"u:{user['id']}"
    fwd = request.headers.get("x-forwarded-for", "")
    if fwd:
        return f"ip:{fwd.split(',')[0].strip()}"
    return f"ip:{request.client.host if request.client else 'unknown'}"


def rate_limit(bucket: str, per_minute: int) -> Callable:
    """
    FastAPI dependency factory. Tracks calls per (bucket, client, minute).
    Raises 429 when the limit is exceeded.

    Args:
        bucket: short identifier for the endpoint class (e.g. "scan", "user")
        per_minute: maximum calls allowed inside any one clock minute
    """
    async def _dep(request: Request) -> None:
        # Pull user from request.state if the auth dependency ran first.
        user = getattr(request.state, "user", None)
        key = f"/ratelimit/{bucket}/{_client_key(request, user)}/{_current_window()}"

        # Lazy import avoids a cycle with state_store -> config on startup.
        from core.state_store import state

        # Read-modify-write. state.set() has 60s TTL for this window.
        # Upstash REST doesn't expose atomic INCR over our wrapper,
        # so we tolerate a small race under sustained spam — the next
        # window (≤60s away) enforces cleanly regardless.
        current = int(state.get(key) or 0) + 1
        state.set(key, current, ttl=90)

        if current > per_minute:
            raise HTTPException(
                status_code=status.HTTP_429_TOO_MANY_REQUESTS,
                detail=f"Rate limit exceeded ({per_minute}/min for '{bucket}'). "
                       f"Try again in {60 - int(time.time() % 60)}s.",
                headers={"Retry-After": str(60 - int(time.time() % 60))},
            )

    return _dep
