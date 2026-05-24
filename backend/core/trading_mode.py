"""
core/trading_mode.py
─────────────────────────────────────────────────────
Runtime paper-trading toggle for TradeX v3.

Priority (highest → lowest):
  1. Redis key /system/paper_trading  — written by admin API, survives restarts
  2. PAPER_TRADING env var             — startup default from .env

Changing mode via the admin API:
  • Takes effect immediately for all new orders / portfolio queries
  • Also updates the Delta singleton's base URL and _paper flag in-process
  • Delta WebSocket reconnects to the correct endpoint on next disconnect
  • Groww paper gate uses this function — no restart needed
"""
from __future__ import annotations

from loguru import logger

_REDIS_KEY = "/system/paper_trading"
_TTL       = 86400 * 365  # 1-year TTL — effectively permanent until overwritten


# ─── Public read helper ───────────────────────────────────────────

def is_paper_trading() -> bool:
    """
    Return True when paper trading (simulated orders) is active.
    Reads the runtime Redis override first; falls back to the .env value.
    """
    try:
        from core.state_store import state
        val = state.get(_REDIS_KEY)
        if val is not None:
            return bool(val)
    except Exception:
        pass  # Redis unavailable at startup — fall through to env
    from core.config import PAPER_TRADING
    return PAPER_TRADING


# ─── Public write helper ──────────────────────────────────────────

def set_paper_trading(enabled: bool) -> None:
    """
    Toggle paper / live mode at runtime.
    Writes to Redis and hot-patches the Delta singleton so the change is
    effective immediately without a server restart.
    """
    from core.state_store import state
    from core.config import DELTA_BASE_URL, DELTA_TESTNET_URL

    state.set(_REDIS_KEY, enabled, ttl=_TTL)
    mode_str = "PAPER (testnet)" if enabled else "LIVE"
    logger.warning(f"⚡ Trading mode changed → {mode_str}")

    # Hot-patch the Delta Exchange singleton so in-process calls use the
    # correct endpoint and skip/include authenticated portfolio queries.
    try:
        from data.delta_client import delta_rest
        delta_rest._paper = enabled
        delta_rest._base  = DELTA_TESTNET_URL if enabled else DELTA_BASE_URL
        logger.info(
            f"  Delta singleton updated: _paper={enabled} _base={delta_rest._base}"
        )
    except Exception as e:
        logger.warning(f"  Could not hot-patch Delta singleton: {e}")


# ─── Convenience alias ────────────────────────────────────────────

def is_live_trading() -> bool:
    return not is_paper_trading()
