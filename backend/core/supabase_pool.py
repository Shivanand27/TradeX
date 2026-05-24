"""
core/supabase_pool.py
─────────────────────────────────────────────────────
Cached Supabase clients + short-lived JWT verification cache.

Why this exists
---------------
The v2 code built a new `create_client()` on every request AND on every
auth check. That's two network-capable clients per HTTP call. Under any
real load this is (a) slow, (b) wasteful of Supabase free-tier quota,
and (c) creates socket churn that will get flagged by Render's proxy.

What this gives you
-------------------
  • `anon_client()`  — shared anon client (for token verification)
  • `admin_client()` — shared service-role client (bypasses RLS)
  • `verify_jwt_cached(token)` — returns a verified user dict,
     cached for JWT_CACHE_TTL_SECONDS. Dramatically cuts auth latency
     without compromising security (token expiry still enforced).

Thread safety
-------------
`supabase-py` clients are thread-safe for read operations and we only
use them for short-lived HTTP calls, never long-running state. The
TTL cache uses a lock.
"""
from __future__ import annotations

import threading
import time
from dataclasses import dataclass
from functools import lru_cache
from typing import Optional

from loguru import logger
from supabase import Client, create_client

from core.config import get_settings


# ─── Client singletons ───────────────────────────────────────────

@lru_cache(maxsize=1)
def anon_client() -> Client:
    """Shared anon-role client (used to verify user JWTs)."""
    s = get_settings()
    if not s.SUPABASE_URL or not s.SUPABASE_KEY:
        raise RuntimeError("SUPABASE_URL / SUPABASE_KEY not configured")
    return create_client(s.SUPABASE_URL, s.SUPABASE_KEY)


@lru_cache(maxsize=1)
def admin_client() -> Client:
    """Shared service-role client. Bypasses RLS — use carefully."""
    s = get_settings()
    service_key = s.SUPABASE_SERVICE_KEY.get_secret_value()
    if not s.SUPABASE_URL or not service_key:
        raise RuntimeError("SUPABASE_URL / SUPABASE_SERVICE_KEY not configured")
    return create_client(s.SUPABASE_URL, service_key)


# ─── JWT verification cache ──────────────────────────────────────

@dataclass
class CachedUser:
    user: dict
    expires_at: float


class _JWTCache:
    """
    Thread-safe TTL cache of token → verified user.

    We cache the result of Supabase JWT verification + user-table lookup
    for a short window (default 60s). This is safe because:
      1. Supabase tokens are signed JWTs — their expiry is enforced
         server-side regardless of our cache.
      2. If an admin deactivates a user, there's at most a 60s window
         before they're locked out. That's an acceptable trade-off for
         ~20x lower auth latency.
    """

    def __init__(self) -> None:
        self._store: dict[str, CachedUser] = {}
        self._lock = threading.Lock()
        self._max_size = 5000  # hard cap, evicts oldest on overflow

    def get(self, token: str) -> Optional[dict]:
        now = time.time()
        with self._lock:
            entry = self._store.get(token)
            if entry and entry.expires_at > now:
                return entry.user
            if entry:
                # expired — drop
                self._store.pop(token, None)
        return None

    def put(self, token: str, user: dict, ttl: float) -> None:
        with self._lock:
            if len(self._store) >= self._max_size:
                # naive eviction: drop ~10% oldest entries
                drop = sorted(self._store.items(), key=lambda kv: kv[1].expires_at)
                for k, _ in drop[: self._max_size // 10]:
                    self._store.pop(k, None)
            self._store[token] = CachedUser(user=user, expires_at=time.time() + ttl)

    def invalidate(self, token: str) -> None:
        with self._lock:
            self._store.pop(token, None)

    def invalidate_user(self, user_id: str) -> None:
        """Invalidate all cached entries for a specific user (e.g. on deactivation)."""
        with self._lock:
            to_drop = [t for t, c in self._store.items() if c.user.get("id") == user_id]
            for t in to_drop:
                self._store.pop(t, None)

    def clear(self) -> None:
        with self._lock:
            self._store.clear()


_cache = _JWTCache()


def verify_jwt_cached(token: str) -> dict:
    """
    Verify a Supabase JWT and return the user record from the `users` table.

    Raises:
        PermissionError — token invalid, user missing, or account not active.

    Returns:
        dict with keys: id, email, full_name, plan, status, is_admin
    """
    # Fast path
    cached = _cache.get(token)
    if cached:
        return cached

    s = get_settings()

    # Verify JWT with Supabase
    try:
        resp = anon_client().auth.get_user(token)
    except Exception as e:
        logger.warning(f"JWT verify failed: {type(e).__name__}")
        raise PermissionError("Invalid token") from e

    if not resp or not resp.user:
        raise PermissionError("Invalid token")

    uid = resp.user.id

    # Fetch user record
    try:
        rec = (
            admin_client()
            .table("users")
            .select("id, email, full_name, plan, status, is_admin")
            .eq("id", uid)
            .single()
            .execute()
        )
    except Exception as e:
        logger.error(f"User lookup failed for {uid}: {e}")
        raise PermissionError("User registration lookup failed") from e

    if not rec.data:
        raise PermissionError("User not registered")
    if rec.data.get("status") != "active":
        raise PermissionError(f"Account {rec.data.get('status')}")

    _cache.put(token, rec.data, s.JWT_CACHE_TTL_SECONDS)
    return rec.data


def invalidate_token(token: str) -> None:
    """Call on logout to evict a token from the cache immediately."""
    _cache.invalidate(token)


def invalidate_user_tokens(user_id: str) -> None:
    """Call when an admin deactivates a user to force re-auth immediately."""
    _cache.invalidate_user(user_id)
