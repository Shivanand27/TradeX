"""
core/state_store.py
─────────────────────────────────────────────────────
Global State Store backed by Upstash Redis (free 10k req/day).
All agents READ and WRITE structured JSON here.
No agent passes raw context to another — they query the store.

Key namespaces:
  /data/india/{SYMBOL}          ← UnifiedMarketDataAgent
  /data/crypto/{SYMBOL}         ← UnifiedMarketDataAgent
  /charts/india/{SYMBOL}        ← UnifiedChartPatternAgent
  /charts/crypto/{SYMBOL}       ← UnifiedChartPatternAgent
  /sentiment/india/{SYMBOL}     ← IndiaSentimentNewsAgent
  /sentiment/crypto             ← CryptoSentimentOnChainAgent
  /fundamentals/india/{SYMBOL}  ← IndiaFundamentalsAgent
  /debate/{session_id}/bull     ← BullResearchAgent
  /debate/{session_id}/bear     ← BearResearchAgent
  /verdict/{session_id}         ← VerdictAgent
  /llm_spend/today              ← Budget tracker
  /positions/index              ← Active position keys ["india/SYM", "crypto/SYM"]
  /positions/{market}/{SYMBOL}  ← Per-position state (entry, stop, size, sector)
"""
from __future__ import annotations
import json
import time
from typing import Any
import requests
from loguru import logger
from core.config import (
    UPSTASH_REDIS_REST_URL,
    UPSTASH_REDIS_REST_TOKEN,
    REDIS_STATE_TTL_SECONDS,
)


class StateStore:
    """
    Thin wrapper around Upstash Redis REST API.
    Uses REST (not TCP socket) — works anywhere including Render free tier.
    """

    def __init__(self):
        self._base = UPSTASH_REDIS_REST_URL.rstrip("/") if UPSTASH_REDIS_REST_URL else ""
        self._headers = {
            "Authorization": f"Bearer {UPSTASH_REDIS_REST_TOKEN}",
            "Content-Type": "application/json",
        }
        self._use_local = not (UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN)
        self._quota_exhausted = False  # set True when Upstash returns the limit error

        # Circuit breaker: after a network failure, pause Upstash requests for
        # _CB_COOLDOWN seconds before retrying. Avoids 5-second hangs per write.
        self._CB_COOLDOWN = 60
        self._cb_open = False       # True = circuit open (paused)
        self._cb_retry_at = 0.0     # epoch-second when we next probe Upstash

        # Write-through in-process cache: key → (deserialized_value, expires_at).
        # Always populated on every set(). get()/mget() check here before hitting Redis.
        # This eliminates Redis reads for hot keys written in the same process
        # (risk, India indices, RF signals, delta snapshot, etc.) — the biggest cost driver.
        self._wcache: dict[str, tuple[Any, float]] = {}

        if self._use_local:
            logger.warning(
                "Upstash Redis not configured — using in-memory store. "
                "Data will NOT persist across restarts. "
                "Set UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN in .env"
            )

    # ─── Internal helpers ────────────────────────────────────────

    def _cache_put(self, key: str, value: Any, ttl: int) -> None:
        self._wcache[key] = (value, time.time() + ttl)

    def _cache_get(self, key: str) -> tuple[bool, Any]:
        """Return (found, value). Evicts the entry if expired."""
        entry = self._wcache.get(key)
        if entry is None:
            return False, None
        val, exp = entry
        if time.time() < exp:
            return True, val
        del self._wcache[key]
        return False, None

    def _circuit_allows(self) -> bool:
        """Return True if we should attempt a network call (circuit is closed or half-open)."""
        if not self._cb_open:
            return True
        if time.time() >= self._cb_retry_at:
            self._cb_open = False   # half-open: allow one probe
            return True
        return False

    def _circuit_trip(self, exc: Exception) -> None:
        """Open the circuit breaker after a network-level failure."""
        if not self._cb_open:
            self._cb_open = True
            self._cb_retry_at = time.time() + self._CB_COOLDOWN
            logger.warning(
                f"Upstash unreachable ({exc.__class__.__name__}: {exc}) — "
                f"pausing Redis calls for {self._CB_COOLDOWN}s. "
                "Data is safe in in-process cache."
            )

    def _circuit_reset(self) -> None:
        """Close the circuit after a successful response."""
        if self._cb_open:
            logger.info("Upstash connection restored — resuming normal operation.")
        self._cb_open = False

    def _check_quota_error(self, results: list) -> bool:
        """Return True and flip to in-memory mode if Upstash reports quota exhaustion."""
        for item in results:
            err = item.get("error", "")
            if "max requests limit exceeded" in err or "rate limit" in err.lower():
                if not self._quota_exhausted:
                    self._quota_exhausted = True
                    logger.critical(
                        "Upstash Redis monthly quota exhausted — switching to in-memory "
                        "fallback. Data will not persist across restarts. "
                        "Upgrade your Upstash plan or wait for the monthly reset."
                    )
                return True
        return False

    # ─── Core Operations ─────────────────────────────────────────

    def set(self, key: str, value: Any, ttl: int = REDIS_STATE_TTL_SECONDS) -> bool:
        """Write a value. Always updates in-process cache; writes through to Redis."""
        self._cache_put(key, value, ttl)

        if self._use_local or self._quota_exhausted or not self._circuit_allows():
            return True

        serialised = json.dumps(value, default=str)
        try:
            resp = requests.post(
                f"{self._base}/pipeline",
                headers=self._headers,
                json=[["SET", key, serialised, "EX", ttl]],
                timeout=5,
            )
            results = resp.json()
            self._circuit_reset()
            if self._check_quota_error(results):
                return True  # already in _wcache
            return results[0].get("result") == "OK"
        except Exception as e:
            self._circuit_trip(e)
            return True  # already in _wcache

    def get(self, key: str) -> Any | None:
        """Read a value. Served from in-process cache when available; falls back to Redis."""
        found, val = self._cache_get(key)
        if found:
            return val

        if self._use_local or self._quota_exhausted or not self._circuit_allows():
            return None

        try:
            resp = requests.post(
                f"{self._base}/pipeline",
                headers=self._headers,
                json=[["GET", key]],
                timeout=5,
            )
            results = resp.json()
            self._circuit_reset()
            if self._check_quota_error(results):
                return None
            raw = results[0].get("result")
            if raw is None:
                return None
            parsed = json.loads(raw)
            self._cache_put(key, parsed, 300)  # cache Redis reads for 5 min
            return parsed
        except Exception as e:
            self._circuit_trip(e)
            return None

    def mget(self, keys: list[str]) -> dict[str, Any]:
        """Fetch multiple keys. Cache hits are free; only misses go to Redis (one pipeline call)."""
        if not keys:
            return {}

        out: dict[str, Any] = {}
        missing: list[str] = []
        for k in keys:
            found, val = self._cache_get(k)
            if found:
                out[k] = val
            else:
                missing.append(k)

        if not missing or self._use_local or self._quota_exhausted or not self._circuit_allows():
            return out

        try:
            resp = requests.post(
                f"{self._base}/pipeline",
                headers=self._headers,
                json=[["GET", k] for k in missing],
                timeout=10,
            )
            results = resp.json()
            self._circuit_reset()
            if self._check_quota_error(results):
                return out
            for k, item in zip(missing, results):
                raw = item.get("result")
                if raw is not None:
                    parsed = json.loads(raw)
                    self._cache_put(k, parsed, 300)
                    out[k] = parsed
        except Exception as e:
            self._circuit_trip(e)
        return out

    def delete(self, key: str) -> bool:
        self._wcache.pop(key, None)
        if self._use_local or self._quota_exhausted or not self._circuit_allows():
            return True
        try:
            resp = requests.post(
                f"{self._base}/pipeline",
                headers=self._headers,
                json=[["DEL", key]],
                timeout=5,
            )
            results = resp.json()
            self._circuit_reset()
            self._check_quota_error(results)
            return resp.status_code == 200
        except Exception as e:
            self._circuit_trip(e)
            return False

    def exists(self, key: str) -> bool:
        return self.get(key) is not None

    # ─── Typed Namespace Helpers ─────────────────────────────────

    def write_market_data(self, market: str, symbol: str, data: dict) -> bool:
        return self.set(f"/data/{market}/{symbol}", data)

    def read_market_data(self, market: str, symbol: str) -> dict | None:
        return self.get(f"/data/{market}/{symbol}")

    def write_chart_data(self, market: str, symbol: str, data: dict) -> bool:
        return self.set(f"/charts/{market}/{symbol}", data)

    def read_chart_data(self, market: str, symbol: str) -> dict | None:
        return self.get(f"/charts/{market}/{symbol}")

    def write_sentiment(self, market: str, key: str, data: dict) -> bool:
        return self.set(f"/sentiment/{market}/{key}", data)

    def read_sentiment(self, market: str, key: str) -> dict | None:
        return self.get(f"/sentiment/{market}/{key}")

    def write_fundamentals(self, symbol: str, data: dict) -> bool:
        return self.set(f"/fundamentals/india/{symbol}", data, ttl=604800)  # 7 days

    def read_fundamentals(self, symbol: str) -> dict | None:
        return self.get(f"/fundamentals/india/{symbol}")

    def write_debate(self, session_id: str, role: str, data: dict) -> bool:
        return self.set(f"/debate/{session_id}/{role}", data, ttl=3600)  # 1h

    def read_debate(self, session_id: str, role: str) -> dict | None:
        return self.get(f"/debate/{session_id}/{role}")

    def write_verdict(self, session_id: str, data: dict) -> bool:
        return self.set(f"/verdict/{session_id}", data, ttl=86400)

    def read_verdict(self, session_id: str) -> dict | None:
        return self.get(f"/verdict/{session_id}")

    def get_llm_spend_today(self) -> float:
        v = self.get("/llm_spend/today")
        return float(v or 0.0)

    def add_llm_spend(self, amount_inr: float) -> float:
        current = self.get_llm_spend_today() + amount_inr
        self.set("/llm_spend/today", current, ttl=86400)
        return current

    def reset_llm_spend(self) -> None:
        self.set("/llm_spend/today", 0.0, ttl=86400)

    # ─── Position Tracking ───────────────────────────────────────

    def write_position(self, market: str, symbol: str, data: dict) -> bool:
        """Register or update an open position."""
        idx = self.get("/positions/index") or []
        pos_key = f"{market}/{symbol}"
        if pos_key not in idx:
            idx.append(pos_key)
            self.set("/positions/index", idx, ttl=86400 * 30)
        return self.set(f"/positions/{market}/{symbol}", data, ttl=86400 * 30)

    def read_position(self, market: str, symbol: str) -> dict | None:
        return self.get(f"/positions/{market}/{symbol}")

    def delete_position(self, market: str, symbol: str) -> bool:
        """Remove a closed position from the store and index."""
        idx = self.get("/positions/index") or []
        pos_key = f"{market}/{symbol}"
        if pos_key in idx:
            idx.remove(pos_key)
            self.set("/positions/index", idx, ttl=86400 * 30)
        return self.delete(f"/positions/{market}/{symbol}")

    def get_all_positions(self) -> list[dict]:
        """Return all currently open positions."""
        idx = self.get("/positions/index") or []
        positions = []
        for pos_key in idx:
            parts = pos_key.split("/", 1)
            if len(parts) == 2:
                data = self.get(f"/positions/{pos_key}")
                if data:
                    positions.append(data)
        return positions

    def get_crypto_exposure_pct(self, total_capital_inr: float) -> float:
        """Sum of open crypto positions as % of total capital."""
        if total_capital_inr <= 0:
            return 0.0
        positions = self.get_all_positions()
        deployed = sum(
            float(p.get("capital_deployed_inr", 0))
            for p in positions
            if "crypto" in p.get("market", "")
        )
        return round(deployed / total_capital_inr * 100, 2)

    def get_sector_exposure_pct(self, sector: str, total_capital_inr: float) -> float:
        """Sum of open India positions in a sector as % of total capital."""
        if total_capital_inr <= 0 or not sector or sector == "Unknown":
            return 0.0
        positions = self.get_all_positions()
        deployed = sum(
            float(p.get("capital_deployed_inr", 0))
            for p in positions
            if p.get("sector") == sector and "india" in p.get("market", "")
        )
        return round(deployed / total_capital_inr * 100, 2)

    # ─── Bulk reads ──────────────────────────────────────────────

    def get_all_chart_data(self, market: str, symbols: list[str]) -> dict[str, dict]:
        """Return chart data for multiple symbols. Missing ones skipped."""
        result = {}
        for sym in symbols:
            data = self.read_chart_data(market, sym)
            if data:
                result[sym] = data
        return result

    def get_full_context(self, market: str, symbol: str) -> dict:
        """
        Assemble the complete context dict for a symbol.
        This is what agents receive as input — all data in one dict.
        """
        ctx = {
            "symbol": symbol,
            "market_data": self.read_market_data(market, symbol) or {},
            "chart_data": self.read_chart_data(market, symbol) or {},
        }
        if market == "india":
            ctx["sentiment"] = self.read_sentiment("india", symbol) or {}
            ctx["fundamentals"] = self.read_fundamentals(symbol) or {}
        else:
            ctx["sentiment"] = self.read_sentiment("crypto", "global") or {}
        return ctx


def _encode_key(key: str) -> str:
    """URL-encode the key for Upstash REST API path."""
    return key.replace("/", "%2F").replace(" ", "%20")


# Singleton — import and use directly
state = StateStore()
