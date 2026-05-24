"""
data/broker_factory.py
─────────────────────────────────────────────────────
Thread-safe broker-client factories.

Replaces the v2 pattern of mutating `os.environ` to pass per-user
credentials (which has a concurrent-request race condition).

Usage from a request handler:

    from core.security import decrypted_broker_config
    from data.broker_factory import build_groww_client, build_delta_client

    cfg = decrypted_broker_config(user_config)
    groww = build_groww_client(cfg)      # None if user hasn't configured
    delta = build_delta_client(cfg)

The returned clients hold their credentials as instance state only —
they never read `os.environ` or any other process-global.

Implementation note
-------------------
The existing `data/groww_client.py` and `data/delta_client.py` modules
read env vars at import time, which is fine for the platform's own
default singleton (used by schedulers). This factory builds *fresh*
instances bound to a specific user's credentials.

If the underlying client classes don't support constructor kwargs
cleanly, `_UserScopedClient` wraps them with a context manager that
restores env on exit — but unlike v2, we hold a module-level lock for
the short window, so concurrent requests serialize on credential
swapping instead of racing.
"""
from __future__ import annotations

import os
import threading
from contextlib import contextmanager
from typing import Any, Iterator, Optional

from loguru import logger


# Single global lock guarding env-var-based client construction.
# Only held for the few microseconds it takes to instantiate the
# client — the client itself then holds credentials internally.
_ENV_LOCK = threading.Lock()


@contextmanager
def _temporarily_set_env(**kwargs: str) -> Iterator[None]:
    """
    Context manager that sets env vars inside a lock, then restores
    them on exit. Serializes concurrent callers rather than letting
    them race like v2 did.
    """
    with _ENV_LOCK:
        saved: dict[str, Optional[str]] = {}
        try:
            for k, v in kwargs.items():
                saved[k] = os.environ.get(k)
                if v is None:
                    os.environ.pop(k, None)
                else:
                    os.environ[k] = v
            yield
        finally:
            for k, old in saved.items():
                if old is None:
                    os.environ.pop(k, None)
                else:
                    os.environ[k] = old


def build_groww_client(user_config: dict) -> Optional[Any]:
    """
    Build a user-scoped Groww client.

    `user_config` must already be decrypted (see
    `core.security.decrypted_broker_config`).

    Returns None if the user hasn't configured Groww credentials.
    """
    api_key = user_config.get("groww_api_key") or ""
    totp = user_config.get("groww_totp_secret") or ""
    if not (api_key and totp):
        return None

    try:
        # Construct under the lock so concurrent users don't step on
        # each other during the brief env-var handoff window.
        with _temporarily_set_env(
            GROWW_API_KEY=api_key,
            GROWW_TOTP_SECRET=totp,
        ):
            from data.groww_client import GrowwClient  # lazy import
            client = GrowwClient()
        return client
    except Exception as e:
        logger.error(f"Failed to build Groww client: {type(e).__name__}: {e}")
        return None


def build_delta_client(user_config: dict) -> Optional[Any]:
    """
    Build a user-scoped Delta Exchange client.

    The global trading mode (is_paper_trading()) takes precedence over the
    per-user delta_paper setting.  When the platform is in LIVE mode, all
    users always trade live — per-user testnet preference is ignored.

    Live mode (global LIVE or delta_paper=False):
      - Uses platform live credentials (DELTA_API_KEY) as fallback.
    Paper mode (global PAPER and delta_paper=True):
      - Uses platform testnet credentials (DELTA_TESTNET_API_KEY) as fallback.
    """
    from core.trading_mode import is_paper_trading

    api_key    = user_config.get("delta_api_key")    or ""
    api_secret = user_config.get("delta_api_secret") or ""

    # Global paper trading switch overrides per-user preference.
    # If the platform is LIVE, never build a testnet client regardless of
    # what the user has saved in their settings.
    global_paper = is_paper_trading()
    user_paper   = bool(user_config.get("delta_paper", False))
    paper        = global_paper and user_paper  # LIVE globally → always False

    try:
        from core.config import (
            DELTA_API_KEY, DELTA_API_SECRET,
            DELTA_BASE_URL, DELTA_TESTNET_URL,
            DELTA_TESTNET_API_KEY, DELTA_TESTNET_API_SECRET,
        )
        from data.delta_client import DeltaRestClient

        if paper:
            effective_key    = api_key    or DELTA_TESTNET_API_KEY
            effective_secret = api_secret or DELTA_TESTNET_API_SECRET
            base_url         = DELTA_TESTNET_URL
        else:
            effective_key    = api_key    or DELTA_API_KEY
            effective_secret = api_secret or DELTA_API_SECRET
            base_url         = DELTA_BASE_URL

        if not (effective_key and effective_secret):
            return None

        return DeltaRestClient(
            api_key=effective_key,
            api_secret=effective_secret,
            base_url=base_url,
            paper=paper,
        )
    except Exception as e:
        logger.error(f"Failed to build Delta client: {type(e).__name__}: {e}")
        return None
