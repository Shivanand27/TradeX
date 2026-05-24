"""
backend/api.py  (v3)
─────────────────────────────────────────────────────
Hardened FastAPI application.

Changes vs v2
-------------
  • CORS locked to explicit origin allow-list (no "*" + credentials)
  • Supabase clients cached (v2 rebuilt on every request)
  • JWT verification result cached (60s TTL) for lower auth latency
  • /ws/live now requires a valid JWT, passed as `?token=...` query
    (browsers cannot set headers on native WebSocket — this is the
    standard pattern; token is short-lived and sent over TLS)
  • Per-route rate limiting (scan, admin, user-config)
  • Structured logging + request ID on every request/log line
  • /health (liveness) vs /ready (readiness) split
  • Admin actions written to audit_log table
  • Global exception handler so internals never leak to clients
  • Secrets never returned to clients — masked at the config endpoint
"""
from __future__ import annotations

import asyncio
import collections
import json
import logging
import math
import secrets
import time
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from typing import Optional

# Silence noisy third-party loggers globally at startup
logging.getLogger("yfinance").setLevel(logging.CRITICAL)
logging.getLogger("peewee").setLevel(logging.CRITICAL)

import pytz
from fastapi import (
    BackgroundTasks,
    Depends,
    FastAPI,
    HTTPException,
    Query,
    Request,
    WebSocket,
    WebSocketDisconnect,
    status,
)
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from loguru import logger
from pydantic import BaseModel, EmailStr
from starlette.middleware.base import BaseHTTPMiddleware

from core.audit import audit
from core.config import ENVIRONMENT, IST_TIMEZONE, PAPER_TRADING, get_settings
from core.database import get_open_signals
from core.logging_config import configure_logging, set_request_id
from core.ratelimit import rate_limit
from core.security import encrypt_key, is_encrypted, mask_secret
from core.state_store import state
from core.supabase_pool import (
    admin_client,
    invalidate_token,
    invalidate_user_tokens,
    verify_jwt_cached,
)

IST = pytz.timezone(IST_TIMEZONE)
_settings = get_settings()


# ─── Background tasks started in lifespan ────────────────────────

async def _global_push_task() -> None:
    """
    Broadcasts risk status + India index prices to all connected clients every second.
    All state.get/mget calls are served from the StateStore write-through in-process cache —
    zero Redis reads for hot keys written in this same process.
    Crypto/Delta ticks arrive event-driven via event_bus — no polling needed there.
    """
    IST = pytz.timezone(IST_TIMEZONE)
    _INDIA_INDICES = [
        ("^NSEI",      "NIFTY50"),
        ("^NSEBANK",   "BANKNIFTY"),
        ("^INDIAVIX",  "INDIAVIX"),
        ("USDINR=X",   "USDINR"),
        ("SENSEX",     "SENSEX"),
    ]
    _IDX_KEYS = [f"/data/india/{s}" for s, _ in _INDIA_INDICES]

    tick = 0
    while True:
        await asyncio.sleep(1)
        if not manager.active:
            tick += 1
            continue
        try:
            # Risk — served from in-process cache (written by risk guardian each cycle)
            risk = state.get("/risk") or {}
            await manager.broadcast({"type": "risk", "data": risk})

            # India indices — served from in-process cache (written by _india_index_poll_task)
            fetched = state.mget(_IDX_KEYS)
            for k, (yf_sym, bc_sym) in zip(_IDX_KEYS, _INDIA_INDICES):
                mkt = fetched.get(k) or {}
                ltp = mkt.get("ltp")
                if ltp:
                    await manager.broadcast({
                        "type":   "ticker",
                        "symbol": bc_sym,
                        "data": {
                            "price":  f"{ltp:,.2f}",
                            "change": f"{mkt.get('change_pct', 0):+.2f}%",
                        },
                    })

            # RF/DW signals snapshot — every 5 s
            if tick % 5 == 0:
                rf = state.get("/rf_dw/latest") or {}
                if rf:
                    await manager.broadcast({"type": "rf_snapshot", "data": rf})

            # Bot execution cycle — every 5 s for fast crypto signal response
            if tick % 5 == 0:
                asyncio.create_task(_run_bot_cycle())

            # Price alert checking — every 30 s
            if tick % 30 == 0:
                async with manager._lock:
                    connected_users = set(manager.active.values())
                for uid in connected_users:
                    try:
                        alerts: list = state.get(f"/alerts/{uid}") or []
                        dirty = False
                        for alert in alerts:
                            if alert.get("triggered"):
                                continue
                            sym = alert.get("symbol", "")
                            target = alert.get("target_price", 0)
                            direction = alert.get("direction", "above")
                            mkt = state.read_market_data("india", sym) or state.read_market_data("crypto", sym) or {}
                            ltp = mkt.get("ltp") or mkt.get("price")
                            if ltp is None:
                                continue
                            triggered = (
                                (direction == "above" and float(ltp) >= target) or
                                (direction == "below" and float(ltp) <= target)
                            )
                            if triggered:
                                alert["triggered"] = True
                                alert["triggered_at"] = datetime.now(timezone.utc).isoformat()
                                dirty = True
                                await manager.send_to_user(uid, {
                                    "type":         "price_alert_triggered",
                                    "alert_id":     alert["id"],
                                    "symbol":       sym,
                                    "target_price": target,
                                    "direction":    direction,
                                    "ltp":          float(ltp),
                                })
                        if dirty:
                            state.set(f"/alerts/{uid}", alerts, ttl=86400 * 30)
                    except Exception as _ae:
                        logger.debug(f"Alert check error uid={uid}: {_ae}")

        except Exception as e:
            logger.debug(f"_global_push_task error: {e}")
        tick += 1


async def _india_ltp_poll_task() -> None:
    """
    During market hours: poll Groww LTP every 1 second for the full India watchlist.
    Broadcasts immediately via WebSocket on every tick.
    Redis writes are throttled to every 30s per symbol to conserve Upstash quota.
    """
    from datetime import datetime as _dt
    import time as _time
    from core.config import INDIA_WATCHLIST as _INDIA_WL
    # Strip .NS suffix — Groww expects bare symbols
    _GROWW_SYMS = [s.replace(".NS", "").replace(".BO", "") for s in _INDIA_WL]
    _last_write: dict[str, float] = {}
    _WRITE_TTL = 30.0  # seconds between Redis writes per symbol

    while True:
        now = _dt.now(_IST)
        market_open = (
            now.weekday() < 5
            and (now.hour > 9 or (now.hour == 9 and now.minute >= 15))
            and (now.hour < 15 or (now.hour == 15 and now.minute <= 30))
        )

        if market_open and manager.active:
            try:
                from data.groww_client import groww as _groww_client
                prices: dict = _groww_client.get_ltp(_GROWW_SYMS)
                now_ts = _time.monotonic()
                for sym, ltp in prices.items():
                    if not ltp:
                        continue
                    await manager.broadcast({
                        "type":   "ticker",
                        "symbol": sym,
                        "data":   {"price": f"{ltp:,.2f}", "change": "—"},
                    })
                    if now_ts - _last_write.get(sym, 0) >= _WRITE_TTL:
                        state.write_market_data("india", sym, {"ltp": ltp, "price": ltp})
                        _last_write[sym] = now_ts
            except Exception as e:
                logger.debug(f"India LTP poll error: {e}")
            await asyncio.sleep(1)
        else:
            await asyncio.sleep(30)


async def _india_index_poll_task() -> None:
    """
    Polls NIFTY50, BANKNIFTY, INDIAVIX, SENSEX, USDINR, DXY via yfinance every 60s
    (market hours) or 5 min (off-hours). Updates state so the 1s push task broadcasts
    fresh index data instead of hours-old snapshots. Also broadcasts directly on update.
    """
    _IDX = [
        ("^NSEI",    "NIFTY50"),
        ("^NSEBANK", "BANKNIFTY"),
        ("^INDIAVIX","INDIAVIX"),
        ("^BSESN",   "SENSEX"),
        ("USDINR=X", "USDINR"),
        ("DX-Y.NYB", "DXY"),
    ]

    def _fetch_one(yf_sym: str) -> dict | None:
        import yfinance as yf
        try:
            df = yf.Ticker(yf_sym).history(period="1d", interval="5m", auto_adjust=True)
            if df.empty:
                return None
            closes = df["Close"].dropna()
            if closes.empty:
                return None
            ltp  = float(closes.iloc[-1])
            prev = float(closes.iloc[-2]) if len(closes) >= 2 else ltp
            chg  = round((ltp - prev) / prev * 100, 2) if prev else 0
            return {"ltp": ltp, "change_pct": chg}
        except Exception:
            return None

    while True:
        await asyncio.sleep(60 if _is_market_hours() else 300)
        try:
            results = await asyncio.gather(
                *[asyncio.to_thread(_fetch_one, sym) for sym, _ in _IDX],
                return_exceptions=True,
            )
            any_written = False
            for (yf_sym, bc_sym), tick in zip(_IDX, results):
                if not tick or isinstance(tick, Exception):
                    continue
                # Write directly — no need to read-then-merge; yfinance gives us ltp+change_pct
                state.write_market_data("india", yf_sym, tick)
                any_written = True
                if manager.active:
                    await manager.broadcast({
                        "type":   "ticker",
                        "symbol": bc_sym,
                        "data":   {
                            "price":  f"{tick['ltp']:,.2f}",
                            "change": f"{tick['change_pct']:+.2f}%",
                        },
                    })
            # Always stamp after each poll so the feed never shows "offline" during
            # off-hours (yfinance returns empty candles but the backend is alive).
            # Short TTL (600 s) when fresh data arrived; long TTL (3600 s) otherwise.
            state.set("/health/india_feed_ts", datetime.now(timezone.utc).isoformat(),
                      ttl=600 if any_written else 3600)
        except Exception as e:
            logger.debug(f"India index poll error: {e}")


# ─── In-process agent scheduler ──────────────────────────────────
# All agent jobs run here (inside the API process) so loguru logs
# from every agent flow through _agent_log_sink and appear on the UI.

import pytz as _pytz
_IST = _pytz.timezone("Asia/Kolkata")


def _ist_now_str() -> str:
    from datetime import datetime as _dt
    return _dt.now(_IST).strftime("%H:%M:%S IST")


def _is_market_hours() -> bool:
    from datetime import datetime as _dt
    now = _dt.now(_IST)
    if now.weekday() >= 5:
        return False
    return (now.hour > 9 or (now.hour == 9 and now.minute >= 15)) and \
           (now.hour < 15 or (now.hour == 15 and now.minute <= 30))


async def _agent_india_data():
    try:
        logger.info("━━ AGENT: India Market Data ━━")
        from data.india_market import run_india_market_data_agent
        await run_india_market_data_agent()
        state.set("/scheduler/last_run/india_data", _ist_now_str(), ttl=86400)
    except Exception as e:
        logger.error(f"India data agent failed: {e}")


async def _agent_india_chart():
    try:
        logger.info("━━ AGENT: India Chart Pattern Scan ━━")
        from agents.chart_pattern_agent import run_chart_pattern_agent
        await run_chart_pattern_agent("india")
        state.set("/scheduler/last_run/india_chart", _ist_now_str(), ttl=86400)
    except Exception as e:
        logger.error(f"India chart agent failed: {e}")


async def _agent_india_sentiment():
    """
    Market hours  (9:15–15:30 IST, Mon–Fri): full run — VIX, Nifty trend, RSS fetch,
                                               LLM sentiment classification, state update.
    Off-hours / weekends: RSS-only fetch (free HTTP) to keep /news/feed fresh; LLM skipped.
    This cuts ~67% of LLM calls with zero loss of in-market functionality.
    """
    try:
        market_open = _is_market_hours()
        logger.info(f"━━ AGENT: India Sentiment & News {'[market open]' if market_open else '[off-hours, RSS only]'} ━━")

        vix, trend = None, None
        if market_open:
            # VIX + Nifty trend are only meaningful during live trading
            from data.india_market import fetch_india_vix, fetch_nifty_trend
            vix, trend = await asyncio.gather(
                asyncio.to_thread(fetch_india_vix),
                asyncio.to_thread(fetch_nifty_trend),
            )
            if vix:
                state.set("/market/india_vix", vix)
            if trend:
                state.set("/market/nifty_trend", trend)

        if market_open:
            # Full run: fetch RSS + FII/DII + LLM sentiment classification
            from data.india_news import fetch_india_news_sentiment
            news = await fetch_india_news_sentiment()
            if news:
                state.write_sentiment("india", "global", news)
        else:
            # Off-hours: fetch RSS headlines only — no LLM, no FII data
            from data.india_news import _fetch_rss_news
            raw_items = await _fetch_rss_news()
            news = {"news_items": raw_items} if raw_items else None

        if news:
            existing = state.get("/news/feed") or []
            new_items = news.get("news_items", [])
            seen = {n.get("headline") for n in existing}
            fresh = [n for n in new_items if n.get("headline") not in seen]
            merged = (fresh + existing)[:300]
            merged.sort(key=lambda n: n.get("age_hours", 9999))
            state.set("/news/feed", merged, ttl=3600)
            if fresh:
                await manager.broadcast({"type": "news", "items": fresh[:10]})

        state.set("/scheduler/last_run/india_sentiment", _ist_now_str(), ttl=86400)
        nifty = trend.get("nifty_trend", "?") if isinstance(trend, dict) else "—"
        logger.info(f"  news={len((news or {}).get('news_items', []))} items  VIX={vix}  trend={nifty}  llm={'yes' if market_open else 'no'}")
    except Exception as e:
        logger.error(f"India sentiment agent failed: {e}")


async def _agent_india_fundamentals():
    try:
        logger.info("━━ AGENT: India Fundamentals ━━")
        from agents.fundamentals_agent import run_india_fundamentals_agent
        await run_india_fundamentals_agent()
        state.set("/scheduler/last_run/india_fundamentals", _ist_now_str(), ttl=86400)
    except Exception as e:
        logger.error(f"India fundamentals agent failed: {e}")


async def _agent_india_signals():
    try:
        logger.info("━━ AGENT: India Signal Generation ━━")
        from agents.signal_pipeline import run_signal_pipeline
        await run_signal_pipeline("india")
        state.set("/scheduler/last_run/india_signal", _ist_now_str(), ttl=86400)
    except Exception as e:
        logger.error(f"India signal agent failed: {e}")


async def _agent_both_signals():
    try:
        logger.info("━━ AGENT: Signal Generation [India + Crypto] ━━")
        from agents.signal_pipeline import run_signal_pipeline
        await run_signal_pipeline("both")
        state.set("/scheduler/last_run/india_signal", _ist_now_str(), ttl=86400)
        state.set("/scheduler/last_run/crypto_signal", _ist_now_str(), ttl=86400)
    except Exception as e:
        logger.error(f"Both-market signal agent failed: {e}")


async def _agent_delta_snapshot():
    """Refresh Delta Exchange funding rates, OI and mark prices every 5 min."""
    try:
        logger.info("━━ AGENT: Delta Snapshot ━━")
        from data.delta_client import build_delta_snapshot
        await asyncio.to_thread(build_delta_snapshot)
        state.set("/scheduler/last_run/delta_snapshot", _ist_now_str(), ttl=86400)
    except Exception as e:
        logger.error(f"Delta snapshot agent failed: {e}")


async def _agent_india_data_gated():
    """Run India market data agent only during market hours (Mon–Fri 09:15–15:30)."""
    if _is_market_hours():
        await _agent_india_data()


_screener_scanning   = False
_intraday_scanning   = False


async def _agent_intraday_screener() -> None:
    """Intraday screener — runs every 15 min during market hours only."""
    global _intraday_scanning
    if not _is_market_hours() or _intraday_scanning:
        return
    _intraday_scanning = True
    try:
        logger.info("━━ AGENT: Intraday Screener ━━")
        from agents.screener_agent import run_intraday_screener_scan
        await run_intraday_screener_scan()
        state.set("/scheduler/last_run/intraday_screener", _ist_now_str(), ttl=86400)
        await manager.broadcast({"type": "intraday_screener_updated", "last_scan": _ist_now_str()})
    except Exception as e:
        logger.error(f"Intraday screener failed: {e}")
    finally:
        _intraday_scanning = False


async def _agent_screener_scan() -> None:
    """Run the full screener scan. Concurrent calls are dropped (deduplicated)."""
    global _screener_scanning
    if _screener_scanning:
        return
    _screener_scanning = True
    try:
        logger.info("━━ AGENT: Screener Scan ━━")
        from agents.screener_agent import run_screener_scan
        await run_screener_scan("all")
        last_scan = _ist_now_str()
        state.set("/scheduler/last_run/screener", last_scan, ttl=86400)
        # Notify all connected clients that fresh screener data is available
        await manager.broadcast({"type": "screener_updated", "last_scan": last_scan})
    except Exception as e:
        logger.error(f"Screener scan failed: {e}")
    finally:
        _screener_scanning = False


async def _agent_crypto_chart():
    try:
        logger.info("━━ AGENT: Crypto Chart Scan ━━")
        from agents.chart_pattern_agent import run_chart_pattern_agent
        await run_chart_pattern_agent("crypto")
        state.set("/scheduler/last_run/crypto_chart", _ist_now_str(), ttl=86400)
    except Exception as e:
        logger.error(f"Crypto chart agent failed: {e}")


async def _warm_state_from_db() -> None:
    """
    Load the last-known snapshots from Supabase into state-store so all
    screener/deals/events/insider tabs show data immediately on restart,
    without waiting for a fresh scan (~45s for screener alone).
    """
    try:
        from agents.screener_agent import _load_screener_from_db
        snap = _load_screener_from_db("all")
        if snap:
            state.set("/screener/results", snap, ttl=86400)
            state.set("/screener/last_scan", snap.get("last_scan", ""), ttl=86400)
            logger.info("✓ Boot warm: screener snapshot loaded from DB")
    except Exception as e:
        logger.debug(f"Boot warm screener: {e}")

    try:
        db = admin_client()
        # Intraday screener — most recent row
        res = db.table("intraday_screener_results") \
            .select("scanned_at,total_scanned,last_scan,categories") \
            .order("scanned_at", desc=True).limit(1).execute()
        if res.data:
            row = res.data[0]
            intraday_snap = {
                "timestamp":     row["scanned_at"],
                "last_scan":     row["last_scan"],
                "market":        "india",
                "total_scanned": row["total_scanned"],
                "categories":    row["categories"],
                "from_db":       True,
            }
            state.set("/screener/intraday", intraday_snap, ttl=900)
            logger.info("✓ Boot warm: intraday screener loaded from DB")
    except Exception as e:
        logger.debug(f"Boot warm intraday: {e}")

    try:
        db = admin_client()
        # Block/Bulk deals — today's deals into state
        today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
        res = db.table("block_bulk_deals").select("*").eq("trade_date", today) \
            .order("value_crore", desc=True).limit(100).execute()
        if res.data:
            block = [d for d in res.data if d.get("deal_type") == "block"]
            bulk  = [d for d in res.data if d.get("deal_type") == "bulk"]
            state.set("/market/deals/today", {"block_deals": block, "bulk_deals": bulk}, ttl=86400)
            logger.info(f"✓ Boot warm: {len(res.data)} deals loaded from DB")
    except Exception as e:
        logger.debug(f"Boot warm deals: {e}")

    try:
        db = admin_client()
        # Corporate events — next 14 days
        from datetime import timedelta
        to_date = (datetime.now(timezone.utc) + timedelta(days=14)).strftime("%Y-%m-%d")
        today   = datetime.now(timezone.utc).strftime("%Y-%m-%d")
        res = db.table("corporate_events") \
            .select("*").gte("event_date", today).lte("event_date", to_date) \
            .order("event_date").limit(200).execute()
        if res.data:
            state.set("/market/events/upcoming", {"all_events": res.data, "today_events": [e for e in res.data if e.get("event_date") == today]}, ttl=86400)
            logger.info(f"✓ Boot warm: {len(res.data)} events loaded from DB")
    except Exception as e:
        logger.debug(f"Boot warm events: {e}")

    try:
        db = admin_client()
        # Insider trades — last 7 days
        from datetime import timedelta
        from_date = (datetime.now(timezone.utc) - timedelta(days=7)).strftime("%Y-%m-%d")
        res = db.table("insider_trades").select("*").gte("trade_date", from_date) \
            .order("trade_date", desc=True).limit(200).execute()
        if res.data:
            from data.nse_insider import detect_clusters
            clusters = detect_clusters(res.data)
            state.set("/market/insider/recent", {"trades": res.data, "clusters": clusters}, ttl=86400)
            logger.info(f"✓ Boot warm: {len(res.data)} insider trades loaded from DB")
    except Exception as e:
        logger.debug(f"Boot warm insider: {e}")


async def _agent_boot_sequence():
    """Run immediately on startup: populate all state so the UI has data from the first request."""
    await asyncio.sleep(3)  # let the event loop settle
    logger.info("▶▶ Boot sequence: initial data collection starting")

    # Phase 0: Warm all state from DB immediately — no network calls needed.
    # UI tabs show last-known data within seconds of startup.
    await _warm_state_from_db()

    # Phase 1: Live market prices + crypto snapshot (fast, non-blocking)
    await asyncio.gather(
        _agent_india_data(),
        _agent_delta_snapshot(),
        return_exceptions=True,
    )
    await asyncio.gather(
        _agent_india_sentiment(),
        _agent_india_chart(),
        return_exceptions=True,
    )
    await _agent_india_fundamentals()

    # Phase 2: Heavy scans run in the background — UI already has DB-warmed data.
    # For deals/events/insider: only run if DB was empty (cold state after warm).
    asyncio.create_task(_agent_screener_scan(), name="boot_screener")
    if not state.get("/market/deals/today"):
        asyncio.create_task(_agent_block_deals(session_num=0), name="boot_deals")
    if not state.get("/market/events/upcoming"):
        asyncio.create_task(_agent_events_calendar(), name="boot_events")
    if not state.get("/market/insider/recent"):
        asyncio.create_task(_agent_insider_monitor(), name="boot_insider")
    logger.info("✓ Boot sequence complete — UI data ready")


# ─── Phase 1: Block & Bulk Deal Agent ────────────────────────────

async def _agent_block_deals(session_num: int = 0) -> None:
    try:
        logger.info(f"━━ AGENT: NSE Block/Bulk Deals [session={session_num}] ━━")
        from data.nse_deals import run_deals_agent
        result = await run_deals_agent(session_num=session_num)

        # Cache in state store
        state.set("/market/deals/today", result, ttl=86400)
        state.set(f"/scheduler/last_run/block_deals", _ist_now_str(), ttl=86400)

        # Persist new deals to Supabase
        all_deals = result.get("block_deals", []) + result.get("bulk_deals", [])
        if all_deals:
            try:
                db = admin_client()
                for d in all_deals:
                    db.table("block_bulk_deals").upsert({
                        "symbol":       d["symbol"],
                        "company_name": d["company_name"],
                        "client_name":  d["client_name"],
                        "direction":    d["direction"],
                        "quantity":     d["quantity"],
                        "price":        d["price"],
                        "value_crore":  d["value_crore"],
                        "deal_type":    d["deal_type"],
                        "session_num":  session_num,
                        "trade_date":   d["trade_date"],
                        "traded_at":    d["traded_at"],
                        "remarks":      d["remarks"],
                        "on_watchlist": d["on_watchlist"],
                    }).execute()
            except Exception as e:
                logger.error(f"Block deal DB upsert failed: {e}")

        # Notify watchlist hits via Telegram
        hits = result.get("watchlist_hits", [])
        if hits:
            from notifications.telegram import send_deals_alert
            await send_deals_alert(hits, session_num)

        # Broadcast to WebSocket clients
        await manager.broadcast({
            "type":            "deals_updated",
            "session":         session_num,
            "watchlist_hits":  len(hits),
            "total":           result.get("total", 0),
        })
    except Exception as e:
        logger.error(f"Block deals agent failed: {e}")


async def _agent_block_deals_s1() -> None:
    await _agent_block_deals(session_num=1)


async def _agent_block_deals_s2() -> None:
    await _agent_block_deals(session_num=2)


# ─── Phase 2: Corporate Events Agent ─────────────────────────────

async def _agent_events_calendar() -> None:
    try:
        logger.info("━━ AGENT: NSE Corporate Events Calendar ━━")
        from data.nse_events import run_events_agent, build_morning_brief
        result = await run_events_agent(lookahead_days=7)

        state.set("/market/events/upcoming", result, ttl=86400)
        state.set("/scheduler/last_run/events", _ist_now_str(), ttl=86400)

        # Persist to Supabase (upsert, unique on symbol+event_type+event_date)
        all_events = result.get("all_events", [])
        if all_events:
            try:
                db = admin_client()
                for ev in all_events:
                    db.table("corporate_events").upsert({
                        "symbol":           ev["symbol"],
                        "company_name":     ev["company_name"],
                        "event_type":       ev["event_type"],
                        "event_type_label": ev["event_type_label"],
                        "event_date":       ev["event_date"],
                        "details":          ev["details"],
                        "source":           ev["source"],
                        "on_watchlist":     ev["on_watchlist"],
                    }, on_conflict="symbol,event_type,event_date").execute()
            except Exception as e:
                logger.error(f"Events DB upsert failed: {e}")

        # Send Telegram morning brief
        from notifications.telegram import send_message
        brief = build_morning_brief(result)
        await send_message(brief, _msg_type="morning_brief")

        # Broadcast to WebSocket
        await manager.broadcast({
            "type":            "events_updated",
            "today_count":     len(result.get("today_events", [])),
            "watchlist_count": len(result.get("watchlist_events", [])),
        })
    except Exception as e:
        logger.error(f"Events calendar agent failed: {e}")


# ─── Phase 4: Insider Trading Agent ──────────────────────────────

async def _agent_insider_monitor() -> None:
    try:
        logger.info("━━ AGENT: Insider Trading Monitor ━━")
        from data.nse_insider import run_insider_agent
        result = await run_insider_agent(days=30)

        state.set("/market/insider/recent", result, ttl=86400)
        state.set("/scheduler/last_run/insider", _ist_now_str(), ttl=86400)

        # Persist trades to Supabase
        trades = result.get("trades", [])
        if trades:
            try:
                db = admin_client()
                for t in trades:
                    db.table("insider_trades").upsert({
                        "symbol":           t["symbol"],
                        "company_name":     t["company_name"],
                        "insider_name":     t["insider_name"],
                        "insider_role":     t["insider_role"],
                        "insider_role_raw": t["insider_role_raw"],
                        "trade_type":       t["trade_type"],
                        "quantity":         t["quantity"],
                        "price":            t["price"],
                        "value_lakh":       t["value_lakh"],
                        "pre_holding_pct":  t["pre_holding_pct"],
                        "post_holding_pct": t["post_holding_pct"],
                        "security_type":    t["security_type"],
                        "acquisition_mode": t["acquisition_mode"],
                        "trade_date":       t["trade_date"],
                        "disclosure_date":  t["disclosure_date"],
                        "remarks":          t["remarks"],
                        "on_watchlist":     t["on_watchlist"],
                    }).execute()
            except Exception as e:
                logger.error(f"Insider trades DB upsert failed: {e}")

        # Alert on cluster signals
        clusters = result.get("clusters", [])
        if clusters:
            from notifications.telegram import send_cluster_alert
            for cl in clusters:
                await send_cluster_alert(cl)

        # Broadcast
        await manager.broadcast({
            "type":          "insider_updated",
            "cluster_count": len(clusters),
            "trade_count":   len(trades),
        })
    except Exception as e:
        logger.error(f"Insider monitor agent failed: {e}")


def _build_agent_scheduler():
    """Create and configure APScheduler with all agent jobs (IST timezone)."""
    from apscheduler.schedulers.asyncio import AsyncIOScheduler
    sched = AsyncIOScheduler(timezone=_IST)

    # ── India market data: every 5 min during market hours ────────
    sched.add_job(_agent_india_data_gated, "interval", minutes=5,  id="india_data_5m")

    # ── India chart patterns: key market events (Mon–Fri) ─────────
    sched.add_job(_agent_india_chart,       "cron", day_of_week="mon-fri", hour=9,  minute=20, id="india_chart_open")
    sched.add_job(_agent_india_chart,       "cron", day_of_week="mon-fri", hour=11, minute=0,  id="india_chart_mid1")
    sched.add_job(_agent_india_chart,       "cron", day_of_week="mon-fri", hour=13, minute=30, id="india_chart_mid2")
    sched.add_job(_agent_india_chart,       "cron", day_of_week="mon-fri", hour=15, minute=0,  id="india_chart_preclose")

    # ── India signals: key market events (Mon–Fri) ────────────────
    sched.add_job(_agent_india_signals,     "cron", day_of_week="mon-fri", hour=11, minute=15, id="india_signals_mid1")
    sched.add_job(_agent_india_signals,     "cron", day_of_week="mon-fri", hour=13, minute=45, id="india_signals_mid2")
    sched.add_job(_agent_india_fundamentals,"cron", day_of_week="mon-fri", hour=15, minute=30, id="india_fundamentals")
    sched.add_job(_agent_both_signals,      "cron", day_of_week="mon-fri", hour=16, minute=0,  id="eod_signals")

    # ── India sentiment: every 5 min (gated to market hours) ──────
    sched.add_job(_agent_india_sentiment, "interval", minutes=5, id="india_sentiment_5m")

    # ── Delta snapshot: every 15 min 24/7 (funding rates + OI) ─────
    # 15 min is sufficient — funding rates and OI don't tick-by-tick.
    # Owned here (not scheduler.py) so logs appear in the WS agent feed.
    sched.add_job(_agent_delta_snapshot, "interval", minutes=15, id="delta_snapshot_15m")

    # ── Crypto chart patterns: every 30 min 24/7 ──────────────────
    sched.add_job(_agent_crypto_chart, "interval", minutes=30, id="crypto_chart_30m")

    # ── Crypto signals: every 2 h 24/7 ───────────────────────────
    sched.add_job(_agent_both_signals, "interval", hours=2, id="crypto_signals_2h")

    # ── Screener: 9:30 AM and 1:30 PM IST, Mon–Fri ───────────────
    sched.add_job(_agent_screener_scan, "cron", day_of_week="mon-fri", hour=9,  minute=30, id="screener_morning")
    sched.add_job(_agent_screener_scan, "cron", day_of_week="mon-fri", hour=13, minute=30, id="screener_afternoon")

    # ── Phase 1: Block/Bulk Deals — post each session window ─────
    sched.add_job(_agent_block_deals_s1, "cron", day_of_week="mon-fri", hour=9,  minute=5,  id="block_deals_s1")
    sched.add_job(_agent_block_deals_s2, "cron", day_of_week="mon-fri", hour=14, minute=25, id="block_deals_s2")

    # ── Phase 2: Corporate Events Calendar — 8:30 AM daily ───────
    sched.add_job(_agent_events_calendar, "cron", day_of_week="mon-fri", hour=8, minute=30, id="events_calendar")

    # ── Phase 4: Insider Trading — 7:00 PM (post disclosure window)
    sched.add_job(_agent_insider_monitor, "cron", day_of_week="mon-fri", hour=19, minute=0, id="insider_monitor")

    # ── Phase 5: Intraday Screener — every 15 min during market hours ─
    sched.add_job(_agent_intraday_screener, "interval", minutes=15, id="intraday_screener_15m")

    return sched


# ─── Lifespan ────────────────────────────────────────────────────
@asynccontextmanager
async def lifespan(app: FastAPI):
    configure_logging()
    # Register agent-log sink — must happen after configure_logging() so we add on top
    logger.add(_agent_log_sink, level="DEBUG", format="{message}", enqueue=True)
    logger.info(
        f"TradeX API starting | env={_settings.ENVIRONMENT} "
        f"paper={_settings.PAPER_TRADING}"
    )
    # Warm up caches so first request doesn't pay the cost
    try:
        admin_client()
    except Exception as e:
        logger.warning(f"Supabase warm-up failed: {e}")

    # Validate that user_configs.bots column exists (migration guard)
    try:
        admin_client().table("user_configs").select("bots").limit(1).execute()
        logger.info("✓ user_configs.bots column present")
    except Exception as _col_err:
        logger.error(
            "⚠ user_configs.bots column MISSING — bots will NOT persist across restarts!\n"
            "Fix: run this SQL in Supabase → SQL Editor:\n"
            "  ALTER TABLE public.user_configs\n"
            "  ADD COLUMN IF NOT EXISTS bots JSONB DEFAULT '[]'::jsonb;\n"
            f"  (error: {_col_err})"
        )

    # ── Register event bus so background WS threads can push ticks ──
    loop = asyncio.get_running_loop()
    from core.event_bus import register as _eb_register
    _eb_register(loop, manager.broadcast)
    logger.info("✓ Event bus registered")

    # ── Start Binance WebSocket stream as an asyncio task ────────────
    # Runs in the FastAPI event loop — ticks are emitted via event_bus immediately.
    _binance_task: asyncio.Task | None = None
    try:
        from data.crypto_market import BinanceCryptoStream, CRYPTO_WATCHLIST
        _binance_task = asyncio.create_task(
            BinanceCryptoStream(CRYPTO_WATCHLIST).start(),
            name="binance_stream",
        )
        logger.info("✓ Binance WebSocket stream task started")
    except Exception as e:
        logger.warning(f"Binance stream failed to start: {e}")

    # ── Start global 1-second push task ─────────────────────────────
    _push_task = asyncio.create_task(_global_push_task(), name="global_push")
    logger.info("✓ Global 1s push task started")

    # ── Start India LTP polling task (Groww, every 1s during market hours) ──
    _india_task = asyncio.create_task(_india_ltp_poll_task(), name="india_ltp_poll")
    logger.info("✓ India LTP poll task started")

    # ── Start India index fast-poll task (yfinance, every 60s/5min) ──
    _index_task = asyncio.create_task(_india_index_poll_task(), name="india_index_poll")
    logger.info("✓ India index poll task started (NIFTY50/BANKNIFTY/VIX/SENSEX/USDINR/DXY)")
    # Seed feed timestamp so health check shows "stale" rather than "offline" at startup
    state.set("/health/india_feed_ts", datetime.now(timezone.utc).isoformat(), ttl=3600)

    # ── Start in-process agent scheduler (APScheduler) ───────────────
    # Running agents here (not in a separate scheduler.py process) ensures
    # every agent log goes through _agent_log_sink → WebSocket → UI.
    _agent_sched = _build_agent_scheduler()
    _agent_sched.start()
    logger.info("✓ Agent scheduler started (Nifty50 + sectors — India & Crypto)")

    # ── Boot sequence: populate state immediately so UI has data on first load ──
    _boot_task = asyncio.create_task(_agent_boot_sequence(), name="boot_sequence")

    yield

    # ── Graceful shutdown ────────────────────────────────────────────
    _agent_sched.shutdown(wait=False)
    for task in [_push_task, _india_task, _index_task, _boot_task]:
        task.cancel()
        try:
            await task
        except asyncio.CancelledError:
            pass
    if _binance_task:
        _binance_task.cancel()
        try:
            await _binance_task
        except asyncio.CancelledError:
            pass
    logger.info("TradeX API shutting down")


# ─── App ─────────────────────────────────────────────────────────
def _sanitize_nan(obj):
    """Recursively replace float NaN/Inf with None so json.dumps never chokes."""
    if isinstance(obj, float) and (math.isnan(obj) or math.isinf(obj)):
        return None
    if isinstance(obj, dict):
        return {k: _sanitize_nan(v) for k, v in obj.items()}
    if isinstance(obj, list):
        return [_sanitize_nan(v) for v in obj]
    return obj


class SafeJSONResponse(JSONResponse):
    def render(self, content) -> bytes:
        return json.dumps(
            _sanitize_nan(content),
            ensure_ascii=False,
            allow_nan=False,
        ).encode("utf-8")


app = FastAPI(
    title="TradeX Terminal API",
    description="Multi-user trading intelligence platform.",
    version="3.0.0",
    docs_url=None if _settings.is_prod else "/docs",
    redoc_url=None if _settings.is_prod else "/redoc",
    openapi_url=None if _settings.is_prod else "/openapi.json",
    lifespan=lifespan,
    default_response_class=SafeJSONResponse,
)


# ─── CORS (locked) ───────────────────────────────────────────────
app.add_middleware(
    CORSMiddleware,
    allow_origins=_settings.cors_origins,
    allow_credentials=True,
    allow_methods=["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allow_headers=["Authorization", "Content-Type", "X-Request-ID"],
    max_age=600,
)


# ─── Request ID + access log middleware ──────────────────────────
class RequestIDMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next):
        rid = request.headers.get("x-request-id") or set_request_id()
        set_request_id(rid)
        start = time.perf_counter()
        try:
            response = await call_next(request)
        except Exception:
            elapsed_ms = (time.perf_counter() - start) * 1000
            logger.exception(
                f"500 {request.method} {request.url.path} "
                f"{elapsed_ms:.0f}ms"
            )
            raise
        elapsed_ms = (time.perf_counter() - start) * 1000
        response.headers["X-Request-ID"] = rid
        # Only log non-trivial requests; spare the health checks
        if request.url.path not in ("/health", "/ready"):
            logger.info(
                f"{response.status_code} {request.method} {request.url.path} "
                f"{elapsed_ms:.0f}ms"
            )
        return response


app.add_middleware(RequestIDMiddleware)


# ─── Global exception handler ────────────────────────────────────
@app.exception_handler(Exception)
async def unhandled_exception_handler(request: Request, exc: Exception):
    logger.exception(f"Unhandled exception on {request.url.path}")
    # Never leak internals in prod
    return JSONResponse(
        status_code=500,
        content={
            "error": "internal_server_error",
            "request_id": request.headers.get("x-request-id", "-"),
        },
    )


# ─── Auth dependencies ───────────────────────────────────────────
_bearer = HTTPBearer(auto_error=True)


_DEV_USER = {
    "id": "00000000-0000-0000-0000-000000000001",
    "email": "dev@localhost",
    "full_name": "Dev Admin",
    "plan": "admin",
    "status": "active",
    "is_admin": True,
}


async def get_current_user(
    request: Request,
    creds: HTTPAuthorizationCredentials = Depends(_bearer),
) -> dict:
    if _settings.ENVIRONMENT == "dev" and creds.credentials == "dev-admin-token":
        request.state.user = _DEV_USER
        request.state.token = creds.credentials
        return _DEV_USER
    try:
        user = verify_jwt_cached(creds.credentials)
    except PermissionError as e:
        raise HTTPException(status_code=401, detail=str(e))
    # Stash on request state for downstream dependencies (rate limiter, audit)
    request.state.user = user
    request.state.token = creds.credentials
    return user


async def require_admin(user: dict = Depends(get_current_user)) -> dict:
    if not user.get("is_admin"):
        raise HTTPException(status_code=403, detail="Admin access required")
    return user


# ─── Pydantic models ─────────────────────────────────────────────
class UserCreate(BaseModel):
    full_name: str
    email: EmailStr
    plan: str = "BASIC"
    payment_ref: str = ""
    amount: float = 0
    valid_until: Optional[str] = None
    password: str


class UserUpdate(BaseModel):
    plan: Optional[str] = None
    status: Optional[str] = None
    valid_until: Optional[str] = None
    is_admin: Optional[bool] = None


class UserConfig(BaseModel):
    groww_api_key: Optional[str] = None
    groww_totp_secret: Optional[str] = None
    groww_capital: Optional[float] = 200000
    groww_max_pct: Optional[float] = 10
    groww_bot: Optional[bool] = False
    delta_api_key: Optional[str] = None
    delta_api_secret: Optional[str] = None
    delta_paper: Optional[bool] = False   # False = live Delta India (default)
    delta_bot: Optional[bool] = False
    delta_max_pct: Optional[float] = 30
    twitter_handles: Optional[str] = "realDonaldTrump,elonmusk,SEBI_India,saylor,whale_alert"
    telegram_chat_id: Optional[str] = None
    alert_signals: Optional[bool] = True
    alert_stops: Optional[bool] = True
    alert_news: Optional[bool] = True
    daily_summary: Optional[bool] = True
    watchlist: Optional[dict] = None


# ─── Health endpoints ────────────────────────────────────────────
@app.get("/health", tags=["infra"])
def health():
    """Liveness probe — cheap, no external I/O."""
    return {"status": "ok", "ts": datetime.now(timezone.utc).isoformat()}


@app.get("/ready", tags=["infra"])
def ready():
    """
    Readiness probe — checks downstream deps.
    Returns 503 if Supabase or state store is unreachable.
    """
    checks: dict = {"supabase": False, "state_store": False}
    try:
        admin_client().table("users").select("id").limit(1).execute()
        checks["supabase"] = True
    except Exception as e:
        checks["supabase_error"] = str(e)[:80]
    try:
        state.set("/ready/ping", int(time.time()), ttl=30)
        checks["state_store"] = state.get("/ready/ping") is not None
    except Exception as e:
        checks["state_store_error"] = str(e)[:80]

    all_ok = checks["supabase"] and checks["state_store"]
    return JSONResponse(
        status_code=200 if all_ok else 503,
        content={
            "status": "ready" if all_ok else "degraded",
            "mode": "paper" if PAPER_TRADING else "live",
            "checks": checks,
            "signals_open": len(get_open_signals()) if checks["supabase"] else None,
            "ts": datetime.now(timezone.utc).isoformat(),
        },
    )


@app.get("/health/connectivity", tags=["infra"])
async def health_connectivity(user: dict = Depends(get_current_user)):
    """
    Connectivity health for the CommandBar status panel.
    Returns broker status (Groww, Delta) and data-feed freshness (India, Crypto).
    Lightweight — uses pre-computed state; never blocks on broker I/O.
    """
    from core.config import GROWW_API_KEY, GROWW_ACCESS_TOKEN, DELTA_API_KEY
    from data.groww_client import groww as _groww
    from core.trading_mode import is_paper_trading
    _paper = is_paper_trading()

    now = datetime.now(timezone.utc)

    # ── Broker status ─────────────────────────────────────────────
    if _paper:
        groww_status = delta_status = "paper"
    else:
        groww_configured = bool(GROWW_API_KEY or GROWW_ACCESS_TOKEN)
        groww_status = (
            "ok"           if (groww_configured and _groww.is_connected) else
            "error"        if (groww_configured and not _groww.is_connected) else
            "unconfigured"
        )
        delta_configured = bool(DELTA_API_KEY)
        # Delta REST is always reachable (public endpoints); mark ok if key present
        delta_status = "ok" if delta_configured else "unconfigured"

    # ── India data-feed freshness ─────────────────────────────────
    india_ts  = state.get("/health/india_feed_ts")
    india_age: float | None = None
    if india_ts:
        try:
            india_age = (now - datetime.fromisoformat(india_ts)).total_seconds()
        except Exception:
            pass
    india_status = (
        "ok"      if india_age is not None and india_age < 150   else
        "stale"   if india_age is not None and india_age < 3600  else
        "offline"
    )

    # ── Crypto data-feed freshness ────────────────────────────────
    snap       = state.get("/sentiment/crypto/delta_snapshot") or {}
    crypto_raw = snap.get("timestamp")
    crypto_age: float | None = None
    if crypto_raw:
        try:
            crypto_age = (now - datetime.fromisoformat(crypto_raw)).total_seconds()
        except Exception:
            pass
    crypto_status = (
        "ok"      if crypto_age is not None and crypto_age < 150  else
        "stale"   if crypto_age is not None and crypto_age < 600  else
        "offline"
    )

    # ── Overall ───────────────────────────────────────────────────
    feed_ok   = india_status == "ok" and crypto_status == "ok"
    broker_ok = groww_status in ("ok", "paper", "unconfigured") and \
                delta_status in ("ok", "paper", "unconfigured")
    overall   = "ok" if (feed_ok and broker_ok) else "degraded"

    return {
        "broker": {"groww": groww_status, "delta": delta_status},
        "feed":   {
            "india":        india_status,
            "crypto":       crypto_status,
            "india_age_s":  round(india_age)  if india_age  is not None else None,
            "crypto_age_s": round(crypto_age) if crypto_age is not None else None,
        },
        "overall":    overall,
        "paper_mode": _paper,
        "ts":         now.isoformat(),
    }


# ─── Signals ─────────────────────────────────────────────────────
@app.get("/signals")
async def list_signals(
    market: Optional[str] = None,
    limit: int = Query(20, ge=1, le=100),
    user: dict = Depends(get_current_user),
):
    from core.config import INDIA_WATCHLIST
    sigs = get_open_signals(market)

    # If no signals in DB yet, synthesise watchlist rows from live market data
    if not sigs:
        sigs = _build_market_rows(market, INDIA_WATCHLIST)

    return {"count": min(len(sigs), limit), "signals": sigs[:limit]}


def _build_market_rows(market, india_list):
    """Build watchlist rows from live market data when signal pipeline hasn't run."""
    rows = []
    if market in (None, "india_stock", "india"):
        for sym in india_list:
            mkt = state.read_market_data("india", sym) or {}
            if not mkt.get("ltp"):
                continue
            ltp    = mkt["ltp"]
            chg    = mkt.get("change_pct", 0)
            vol_r  = mkt.get("volume_ratio", 1.0)
            rows.append({
                "symbol":       sym.replace(".NS", "").replace(".BO", ""),
                "company_name": sym.replace(".NS", "").replace(".BO", ""),
                "market":       "india",
                "verdict":      "WATCH",
                "conviction":   "—",
                "price":        f"₹{ltp:,.2f}",
                "chg":          f"{chg:+.2f}",
                "vol":          f"{vol_r:.1f}",
                "score":        None,
                "tag":          "NSE",
                "entry_price":  ltp,
            })
    if market in (None, "crypto"):
        # Priority symbols to show in the watchlist
        PRIORITY_CRYPTO = ["BTCUSD", "ETHUSD", "SOLUSD", "BNBUSD", "AVAXUSD", "XRPUSD"]
        snap = state.get("/sentiment/crypto/delta_snapshot") or {}
        all_tickers = snap.get("tickers") or {}
        # Build map: show priority symbols first, fall back to individual keys
        ticker_map = {}
        for csym in PRIORITY_CRYPTO:
            if csym in all_tickers:
                ticker_map[csym] = all_tickers[csym]
            else:
                tick = state.read_market_data("crypto", csym)
                if tick:
                    ticker_map[csym] = tick
        for sym, tick in ticker_map.items():
            ltp = tick.get("ltp") or tick.get("price")
            if not ltp:
                continue
            chg = tick.get("change_pct", 0)
            rows.append({
                "symbol":       sym,
                "company_name": sym,
                "market":       "crypto",
                "verdict":      "WATCH",
                "conviction":   "—",
                "price":        f"${ltp:,.2f}",
                "chg":          f"{chg:+.2f}",
                "vol":          "—",
                "score":        None,
                "tag":          "PERP",
                "entry_price":  ltp,
            })
    return rows


@app.get("/signals/performance")
async def signal_performance(user: dict = Depends(get_current_user)):
    """
    Aggregate closed signal outcomes into a leaderboard.
    Returns per-symbol stats and per-source breakdown.
    Signals without an outcome (still open) are excluded from win/loss counts
    but included in the total fired count.
    """
    try:
        db = admin_client()
        result = db.table("signals") \
            .select("symbol,market,conviction,outcome,actual_pnl_pct,overall_score,created_at,closed_at") \
            .order("created_at", desc=True) \
            .limit(500) \
            .execute()
        rows = result.data or []
    except Exception as e:
        logger.error(f"signal_performance query failed: {e}")
        rows = []

    from collections import defaultdict

    sym_stats: dict = defaultdict(lambda: {
        "total": 0, "closed": 0, "wins": 0, "losses": 0,
        "pnl_sum": 0.0, "win_pnls": [], "loss_pnls": [],
        "market": "", "conviction_counts": defaultdict(int),
    })
    overall = {"total": 0, "closed": 0, "wins": 0, "losses": 0, "pnl_sum": 0.0}

    for r in rows:
        sym   = r.get("symbol") or "UNKNOWN"
        mkt   = r.get("market") or ""
        conv  = r.get("conviction") or "—"
        oc    = r.get("outcome")          # WIN / LOSS / BREAKEVEN / None
        pnl   = r.get("actual_pnl_pct")  # float or None

        s = sym_stats[sym]
        s["total"]  += 1
        s["market"]  = mkt
        s["conviction_counts"][conv] += 1
        overall["total"] += 1

        if oc in ("WIN", "LOSS", "BREAKEVEN"):
            s["closed"] += 1
            overall["closed"] += 1
            if oc == "WIN":
                s["wins"] += 1
                overall["wins"] += 1
                if pnl is not None:
                    s["win_pnls"].append(float(pnl))
                    s["pnl_sum"] += float(pnl)
                    overall["pnl_sum"] += float(pnl)
            elif oc == "LOSS":
                s["losses"] += 1
                overall["losses"] += 1
                if pnl is not None:
                    s["loss_pnls"].append(float(pnl))
                    s["pnl_sum"] += float(pnl)
                    overall["pnl_sum"] += float(pnl)

    leaderboard = []
    for sym, s in sym_stats.items():
        closed   = s["closed"]
        wins     = s["wins"]
        losses   = s["losses"]
        win_rate = round(wins / closed * 100, 1) if closed else None
        avg_win  = round(sum(s["win_pnls"]) / len(s["win_pnls"]), 2) if s["win_pnls"] else None
        avg_loss = round(sum(s["loss_pnls"]) / len(s["loss_pnls"]), 2) if s["loss_pnls"] else None
        net_pnl  = round(s["pnl_sum"], 2)

        # Simple expectancy: (win_rate/100 * avg_win) + ((1 - win_rate/100) * avg_loss)
        expectancy = None
        if win_rate is not None and avg_win is not None and avg_loss is not None:
            wr = win_rate / 100
            expectancy = round(wr * avg_win + (1 - wr) * avg_loss, 2)

        leaderboard.append({
            "symbol":      sym,
            "market":      s["market"],
            "total":       s["total"],
            "closed":      closed,
            "wins":        wins,
            "losses":      losses,
            "win_rate":    win_rate,
            "avg_win":     avg_win,
            "avg_loss":    avg_loss,
            "net_pnl_pct": net_pnl,
            "expectancy":  expectancy,
        })

    # Sort: by win_rate desc (symbols with no closed signals go to bottom)
    leaderboard.sort(key=lambda x: (x["win_rate"] is not None, x["win_rate"] or 0), reverse=True)

    overall_win_rate = round(overall["wins"] / overall["closed"] * 100, 1) if overall["closed"] else None
    overall_avg_pnl  = round(overall["pnl_sum"] / overall["closed"], 2) if overall["closed"] else None

    return {
        "leaderboard": leaderboard,
        "summary": {
            "total_signals": overall["total"],
            "closed":        overall["closed"],
            "wins":          overall["wins"],
            "losses":        overall["losses"],
            "win_rate":      overall_win_rate,
            "avg_pnl_pct":   overall_avg_pnl,
        },
    }


@app.get("/signals/{signal_id}")
async def signal_detail(signal_id: str, user: dict = Depends(get_current_user)):
    verdict = state.read_verdict(signal_id)
    if not verdict:
        raise HTTPException(404, "Signal not found")
    return verdict


# ─── Chart data ───────────────────────────────────────────────────
@app.get("/chart/{symbol}")
async def chart_data(
    symbol: str,
    period: str = Query("3mo", regex="^(5d|1mo|3mo|6mo|1y|2y)$"),
    interval: str = Query("1d", regex="^(15m|1h|1d|1wk)$"),
    user: dict = Depends(get_current_user),
):
    """Fetch OHLCV history for a symbol via yfinance."""
    import yfinance as yf
    import pandas as pd

    # Normalise symbol for yfinance
    sym = symbol.upper()
    # Delta Exchange crypto perps: BTCUSD → BTC-USD, SOLUSDT → SOL-USDT
    # yfinance requires the hyphenated format for crypto/forex pairs
    if sym.endswith("USDT") and "-" not in sym and "." not in sym:
        sym = sym[:-4] + "-USDT"
    elif sym.endswith("USD") and "-" not in sym and "." not in sym and len(sym) > 3:
        sym = sym[:-3] + "-USD"
    # India stocks: add .NS if no exchange suffix
    elif not any(sym.endswith(x) for x in (".NS", ".BO", "=X", "-USD", "-USDT")):
        sym = sym + ".NS"

    try:
        ticker = yf.Ticker(sym)
        hist = ticker.history(period=period, interval=interval, auto_adjust=True)
        if hist.empty:
            # Fallback: try with -USDT variant for USDT-settled pairs (e.g. SOL-USD → SOL-USDT)
            alt = sym.replace("-USD", "-USDT") if sym.endswith("-USD") else None
            if alt and alt != sym:
                ticker = yf.Ticker(alt)
                hist = ticker.history(period=period, interval=interval, auto_adjust=True)
        if hist.empty:
            raise HTTPException(404, f"No data for {symbol}")

        candles = []
        for ts, row in hist.iterrows():
            candles.append({
                "t":    int(ts.timestamp() * 1000),
                "date": ts.strftime("%d %b"),
                "o":    round(float(row["Open"]),   2),
                "h":    round(float(row["High"]),   2),
                "l":    round(float(row["Low"]),    2),
                "c":    round(float(row["Close"]),  2),
                "v":    int(row["Volume"]),
            })
        info = ticker.fast_info
        return {
            "symbol":   symbol.upper(),
            "period":   period,
            "interval": interval,
            "candles":  candles,
            "meta": {
                "52w_high": float(getattr(info, "year_high", 0) or 0),
                "52w_low":  float(getattr(info, "year_low",  0) or 0),
                "currency": getattr(info, "currency", "USD"),
            },
        }
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"chart_data failed for {symbol}: {e}")
        raise HTTPException(500, "Chart data fetch failed")


# ─── Market data ─────────────────────────────────────────────────
@app.get("/market/india")
async def india_market(user: dict = Depends(get_current_user)):
    from core.config import INDIA_WATCHLIST

    result = {}
    for full_sym in INDIA_WATCHLIST:
        # Stored with the .NS suffix; display key is short name
        display_key = full_sym.replace(".NS", "").replace(".BO", "")
        mkt   = state.read_market_data("india", full_sym) or {}
        chart = state.read_chart_data("india", full_sym) or {}
        fund  = state.read_fundamentals(full_sym) or {}
        result[display_key] = {
            "price":   mkt.get("ltp"),
            "change":  mkt.get("change_pct"),
            "score":   chart.get("technical_score"),
            "bias":    chart.get("overall_bias"),
            "fund":    fund.get("fundamental_score"),
            "verdict": chart.get("verdict"),
        }
    return {"timestamp": datetime.now(timezone.utc).isoformat(), "stocks": result}


@app.get("/market/prices", tags=["market"])
async def get_market_prices(
    symbols: str = "",
    market: str = "india",
    user: dict = Depends(get_current_user),
):
    """
    Batch last-price fetch for watchlist symbols.
    Serves state cache first (populated live during market hours); falls back to
    yfinance for cold starts and off-hours so the sidebar always shows prices.
    """
    syms = [s.strip().upper() for s in (symbols or "").split(",") if s.strip()][:50]
    if not syms:
        return {"prices": {}}

    result: dict[str, dict] = {}
    missing: list[str] = []

    # State cache — zero-cost reads for keys written during market hours
    for sym in syms:
        mkt = state.read_market_data(market, sym)
        if mkt and mkt.get("ltp"):
            result[sym] = {
                "price":      float(mkt["ltp"]),
                "change_pct": float(mkt.get("change_pct") or 0),
            }
        else:
            missing.append(sym)

    # yfinance fallback for cache misses (off-hours / cold start)
    if missing and market == "india":
        def _yf_fetch_india() -> dict:
            import yfinance as yf
            out: dict[str, dict] = {}
            for sym in missing:
                try:
                    fi   = yf.Ticker(f"{sym}.NS").fast_info
                    last = float(getattr(fi, "last_price", None) or 0)
                    prev = float(getattr(fi, "previous_close", None) or 0)
                    if last > 0:
                        pct = round((last - prev) / prev * 100, 2) if prev > 0 else 0
                        out[sym] = {"price": last, "change_pct": pct}
                except Exception:
                    pass
            return out

        try:
            fetched = await asyncio.to_thread(_yf_fetch_india)
            result.update(fetched)
        except Exception as e:
            logger.debug(f"/market/prices yfinance india fallback: {e}")

    elif missing and market == "commodity":
        # MCX symbols don't exist on Yahoo Finance — use global futures + USD/INR conversion.
        # Unit conversions match MCX quoting conventions:
        #   Gold:       GC=F  USD/troy-oz  → INR/10g  (MCX standard lot unit)
        #   Silver:     SI=F  USD/troy-oz  → INR/kg
        #   Crude Oil:  CL=F  USD/barrel   → INR/barrel
        #   Nat Gas:    NG=F  USD/MMBtu    → INR/MMBtu
        #   Copper:     HG=F  USD/lb       → INR/kg
        #   Aluminium:  ALI=F USD/MT       → INR/kg
        #   Zinc:       ZNC=F USD/MT       → INR/kg
        #   Cotton:     CT=F  USD/lb       → INR/lb (approximate)
        # Nickel/Lead have no reliable Yahoo Finance future — skipped.
        _COMM_YF = {
            "GOLD":       "GC=F",
            "SILVER":     "SI=F",
            "CRUDEOIL":   "CL=F",
            "NATURALGAS": "NG=F",
            "COPPER":     "HG=F",
            "ALUMINIUM":  "ALI=F",
            "ZINC":       "ZNC=F",
            "COTTON":     "CT=F",
        }
        _TROY_OZ_PER_KG = 32.1507  # troy oz in 1 kg

        def _usd_to_inr(sym: str, usd: float, usdinr: float) -> float:
            # Gold: USD/troy-oz → INR/10g  (multiply by usdinr, divide by oz-per-kg, ×10 for 10g)
            if sym == "GOLD":    return round(usd * usdinr * _TROY_OZ_PER_KG / 100, 2)
            # Silver: USD/troy-oz → INR/kg
            if sym == "SILVER":  return round(usd * usdinr * _TROY_OZ_PER_KG, 2)
            # Crude / Nat Gas: direct per-barrel or per-MMBtu
            if sym in ("CRUDEOIL", "NATURALGAS"): return round(usd * usdinr, 2)
            # Copper: USD/lb → INR/kg  (1 kg = 2.20462 lb)
            if sym == "COPPER":  return round(usd * usdinr * 2.20462, 2)
            # Aluminium, Zinc: USD/MT → INR/kg
            if sym in ("ALUMINIUM", "ZINC"): return round(usd * usdinr / 1000, 2)
            return round(usd * usdinr, 2)

        def _yf_fetch_commodity() -> dict:
            import yfinance as yf
            out: dict[str, dict] = {}
            try:
                usdinr = float(getattr(yf.Ticker("USDINR=X").fast_info, "last_price", None) or 84.0)
            except Exception:
                usdinr = 84.0
            for sym in missing:
                yf_sym = _COMM_YF.get(sym)
                if not yf_sym:
                    continue
                try:
                    fi   = yf.Ticker(yf_sym).fast_info
                    last = float(getattr(fi, "last_price", None) or 0)
                    prev = float(getattr(fi, "previous_close", None) or 0)
                    if last > 0:
                        pct   = round((last - prev) / prev * 100, 2) if prev > 0 else 0
                        price = _usd_to_inr(sym, last, usdinr)
                        out[sym] = {"price": price, "change_pct": pct}
                except Exception:
                    pass
            return out

        try:
            fetched = await asyncio.to_thread(_yf_fetch_commodity)
            result.update(fetched)
        except Exception as e:
            logger.debug(f"/market/prices yfinance commodity fallback: {e}")

    return {"prices": result}


@app.get("/market/crypto")
async def crypto_market(user: dict = Depends(get_current_user)):
    snap    = state.get("/sentiment/crypto/delta_snapshot") or {}
    fg      = state.read_sentiment("crypto", "global") or {}
    tickers = snap.get("tickers", {})
    # Normalise ticker entries for the frontend
    formatted = {}
    for sym, d in tickers.items():
        chg = d.get("change_pct")
        formatted[sym] = {
            "price":  d.get("ltp") or d.get("price"),
            "change": f"{chg:+.2f}%" if chg is not None else "—",
            **d,
        }
    return {
        "timestamp":     datetime.now(timezone.utc).isoformat(),
        "fear_greed":    snap.get("fear_greed") or fg.get("fear_greed"),
        "btc_dominance": snap.get("btc_dominance_pct"),
        "funding":       snap.get("funding", {}),
        "tickers":       formatted,
    }


@app.get("/market/india/vix")
async def india_vix(user: dict = Depends(get_current_user)):
    return {"india_vix": state.get("/market/india_vix")}


@app.get("/market/sentiment")
async def market_sentiment(user: dict = Depends(get_current_user)):
    """
    Aggregated market sentiment snapshot for the MarketSentimentPanel.
    Combines: Crypto Fear & Greed, BTC dominance, funding rates,
    India VIX, FII/DII flows, and latest news highlights.
    """
    crypto_snap = state.read_sentiment("crypto", "global") or {}
    india_sent  = state.read_sentiment("india",  "global") or {}

    # Latest 5 high-impact headlines for inline display
    feed = state.get("/news/feed") or []
    top_news = [n for n in feed if n.get("impact", "").upper() in ("HIGH", "MEDIUM")][:5]

    # Expose all funding rates, not just BTC/ETH/SOL
    funding_all = crypto_snap.get("funding_all", {})

    # Altcoin season heuristic based on BTC dominance
    btc_dom = crypto_snap.get("btc_dominance_pct") or 55
    altcoin_season = (
        "alt_season" if btc_dom < 52 else
        "btc_season" if btc_dom > 56 else
        "neutral"
    )

    return {
        # ── Crypto sentiment ──────────────────────────────────────
        "fear_greed":         crypto_snap.get("fear_greed", 50),
        "fear_greed_signal":  crypto_snap.get("fear_greed_signal", "neutral"),
        "btc_dominance_pct":  btc_dom,
        "btc_funding_8h":     crypto_snap.get("btc_funding_8h", 0),
        "eth_funding_8h":     crypto_snap.get("eth_funding_8h", 0),
        "sol_funding_8h":     crypto_snap.get("sol_funding_8h", 0),
        "bnb_funding_8h":     funding_all.get("BNBUSDT", 0),
        "avax_funding_8h":    funding_all.get("AVAXUSDT", 0),
        "xrp_funding_8h":     funding_all.get("XRPUSDT", 0),
        "news_sentiment":     crypto_snap.get("news_sentiment", "neutral"),
        "coinglass":          crypto_snap.get("coinglass", {}),
        "long_short_ratios":  crypto_snap.get("long_short_ratios", {}),
        "open_interest_usd":  crypto_snap.get("open_interest_usd", {}),
        "altcoin_season":     altcoin_season,
        # ── India sentiment ───────────────────────────────────────
        "india_vix":          float(state.get("/market/india_vix") or 0),
        "fii_flow_today_cr":  india_sent.get("fii_flow_today_cr", 0),
        "dii_flow_today_cr":  india_sent.get("dii_flow_today_cr", 0),
        "institutional_bias": india_sent.get("institutional_bias", "neutral"),
        "india_sentiment_score": india_sent.get("avg_sentiment_score", 0),
        "india_overall":      india_sent.get("overall_sentiment", "neutral"),
        "sector_performance": (india_sent.get("sector_performance")
                               or state.get("/market/sectors") or {}),
        "extra_indices":      (india_sent.get("extra_indices")
                               or state.get("/market/extra_indices") or {}),
        "india_breadth": {
            "bullish": india_sent.get("bullish_stocks", 0),
            "bearish": india_sent.get("bearish_stocks", 0),
            "neutral": india_sent.get("neutral_stocks", 0),
            "mood":    india_sent.get("market_mood", "mixed"),
        },
        # ── Top headlines ─────────────────────────────────────────
        "top_news":           top_news,
        "timestamp":          crypto_snap.get("timestamp", ""),
    }


@app.get("/watchlist/{market}")
async def watchlist(market: str, user: dict = Depends(get_current_user)):
    if market not in ("india", "crypto", "commodity"):
        raise HTTPException(400, "market must be 'india', 'crypto', or 'commodity'")
    return {"watch": state.get(f"/watch_list/{market}") or []}


# ─── News feed ───────────────────────────────────────────────────
@app.get("/news")
async def news_feed(
    tab: str = "ALL",
    impact: str = "ALL",
    limit: int = Query(60, ge=1, le=200),
    user: dict = Depends(get_current_user),
):
    # Primary: pre-aggregated feed written by scheduler
    items = state.get("/news/feed") or []

    # Fallback: assemble from sentiment keys if aggregated feed not yet written
    if not items:
        india_sent  = state.read_sentiment("india", "global") or {}
        india_news  = india_sent.get("news_items", [])
        crypto_snap = state.get("/sentiment/crypto/delta_snapshot") or {}
        crypto_news = crypto_snap.get("news", [])
        items = india_news + crypto_news

    if tab != "ALL":
        items = [n for n in items if n.get("category") == tab]
    if impact != "ALL":
        items = [n for n in items if n.get("impact") == impact]

    items.sort(key=lambda n: n.get("age_hours", 9999))

    return {"count": min(len(items), limit), "items": items[:limit]}


# ─── Risk ────────────────────────────────────────────────────────
@app.get("/risk")
async def risk_status(user: dict = Depends(get_current_user)):
    from agents.risk_guardian import get_risk_summary
    return get_risk_summary()


@app.post("/risk/soft-kill",
          dependencies=[Depends(rate_limit("admin", per_minute=_settings.ADMIN_RATE_LIMIT_PER_MIN))])
async def activate_soft_kill(
    request: Request,
    reason: str = "API request",
    admin: dict = Depends(require_admin),
):
    from agents.risk_guardian import soft_kill

    soft_kill(f"Admin {admin['email']}: {reason}")
    audit(admin, "risk.soft_kill", details={"reason": reason},
          ip=request.client.host if request.client else None)
    return {"status": "soft_kill_activated", "reason": reason}


class GranularKillBody(BaseModel):
    scope:  str          # 'crypto' | 'shorts' | 'longs'
    reason: str = "Manual via terminal"

@app.post("/risk/granular-kill", tags=["risk"])
async def granular_kill(body: GranularKillBody, user: dict = Depends(get_current_user)):
    """Activate a scope-limited kill switch (crypto / shorts / longs)."""
    if not user.get("is_admin"):
        raise HTTPException(status_code=403, detail="Admin required")
    if body.scope not in ("crypto", "shorts", "longs"):
        raise HTTPException(status_code=400, detail="scope must be crypto | shorts | longs")
    state.set(f"/risk/granular_kill/{body.scope}", {"active": True, "reason": body.reason, "ts": datetime.now(timezone.utc).isoformat()})
    await audit(user["id"], f"granular_kill_{body.scope}", {"reason": body.reason})
    return {"scope": body.scope, "active": True}

@app.delete("/risk/granular-kill/{scope}", tags=["risk"])
async def reset_granular_kill(scope: str, user: dict = Depends(get_current_user)):
    """Reset a scope-limited kill switch."""
    if not user.get("is_admin"):
        raise HTTPException(status_code=403, detail="Admin required")
    if scope not in ("crypto", "shorts", "longs"):
        raise HTTPException(status_code=400, detail="scope must be crypto | shorts | longs")
    state.set(f"/risk/granular_kill/{scope}", {"active": False})
    await audit(user["id"], f"reset_granular_kill_{scope}", {})
    return {"scope": scope, "active": False}

@app.post("/risk/reset",
          dependencies=[Depends(rate_limit("admin", per_minute=_settings.ADMIN_RATE_LIMIT_PER_MIN))])
async def reset_kill_switch(request: Request, admin: dict = Depends(require_admin)):
    from agents.risk_guardian import reset_kill

    reset_kill(f"admin:{admin['email']}")
    audit(admin, "risk.kill_reset",
          ip=request.client.host if request.client else None)
    return {"status": "kill_switch_reset"}


# ─── Trading Mode Toggle ─────────────────────────────────────────

@app.get("/admin/trading-mode", dependencies=[Depends(require_admin)])
async def get_trading_mode():
    """
    Return the current trading mode (live vs paper/testnet) and all relevant flags.
    The runtime Redis override takes priority over the .env PAPER_TRADING setting.
    """
    from core.trading_mode import is_paper_trading
    from data.delta_client import delta_rest, PAPER_TRADING as _env_paper
    paper = is_paper_trading()
    return {
        "mode":              "paper" if paper else "live",
        "paper_trading":     paper,
        "env_paper_trading": _env_paper,
        "delta_endpoint":    delta_rest._base,
        "delta_paper_flag":  delta_rest._paper,
        "description": (
            "PAPER MODE — orders are simulated, no real money at risk"
            if paper else
            "LIVE MODE — orders execute on real exchanges with real funds"
        ),
    }


class TradingModeBody(BaseModel):
    paper: bool


@app.post("/admin/trading-mode", dependencies=[Depends(require_admin)])
async def set_trading_mode(body: TradingModeBody, admin: dict = Depends(require_admin)):
    """
    Toggle paper / live trading mode at runtime.
    Takes effect immediately for all new orders — no restart required.
    The setting persists in Redis across server restarts.
    """
    from core.trading_mode import set_paper_trading, is_paper_trading
    set_paper_trading(body.paper)
    await audit(admin["id"], f"trading_mode_{'paper' if body.paper else 'live'}", {
        "changed_by": admin.get("email"),
        "new_mode":   "paper" if body.paper else "live",
    })
    logger.warning(
        f"🔄 Trading mode changed to {'PAPER' if body.paper else 'LIVE'} "
        f"by {admin.get('email')}"
    )
    return {
        "mode":          "paper" if body.paper else "live",
        "paper_trading": body.paper,
        "effective":     "immediately — no restart required",
    }


# ─── Orders ──────────────────────────────────────────────────────

class PlaceOrderPayload(BaseModel):
    symbol:     str
    side:       str            # BUY | SELL
    qty:        float
    order_type: str = "MARKET"
    price:      float = 0.0
    product:    str = "CNC"    # CNC | MIS | NRML
    market:     str = "india"  # india | crypto


# ── Order normalisation helpers ─────────────────────────────────────
_GROWW_STATUS_MAP = {
    "PLACED":           "PENDING",
    "AMO_PLACED":       "PENDING",
    "OPEN":             "OPEN",
    "MODIFIED":         "OPEN",
    "TRIGGER_PENDING":  "TRIGGERED",
    "PARTIAL":          "PARTIAL",
    "PARTIAL_DONE":     "PARTIAL",
    "COMPLETE":         "FILLED",
    "COMPLETED":        "FILLED",
    "CANCELLED":        "CANCELLED",
    "REJECTED":         "REJECTED",
}
_DELTA_STATUS_MAP = {
    "OPEN":       "OPEN",
    "PENDING":    "PENDING",
    "CLOSED":     "FILLED",
    "FILLED":     "FILLED",
    "CANCELLED":  "CANCELLED",
    "REJECTED":   "REJECTED",
}
_ORDER_TYPE_MAP = {
    "LIMIT":        "LIMIT",
    "MARKET":       "MARKET",
    "MARKET_ORDER": "MARKET",
    "SL":           "SL",
    "SL_M":         "SL",
    "STOP_LOSS":    "SL",
    "IOC":          "IOC",
    "GTT":          "GTT",
}


def _norm_status(raw: str, broker: str = "groww") -> str:
    key = (raw or "").upper().replace("-", "_").replace(" ", "_")
    mapping = _GROWW_STATUS_MAP if broker == "groww" else _DELTA_STATUS_MAP
    return mapping.get(key, key) or "OPEN"


def _norm_type(raw: str) -> str:
    key = (raw or "").upper().replace("-", "_").replace(" ", "_")
    return _ORDER_TYPE_MAP.get(key, key) or "MARKET"


def _fmt_order_time(ts: str) -> str:
    """Convert UTC ISO timestamp → HH:MM:SS IST for the UI."""
    if not ts:
        return ""
    try:
        from datetime import datetime, timezone, timedelta
        _IST_OFFSET = timedelta(hours=5, minutes=30)
        ts_clean = ts.replace("Z", "+00:00")
        dt = datetime.fromisoformat(ts_clean).astimezone(timezone.utc)
        ist = dt + _IST_OFFSET
        return ist.strftime("%H:%M:%S")
    except Exception:
        return str(ts)[:8]



@app.get("/orders")
async def list_orders(
    market: str = Query("all", description="india | crypto | all"),
    user: dict = Depends(get_current_user),
):
    """
    Fetch open orders from Groww (India equity/FnO) and/or Delta (crypto).
    Uses broker clients built from the requesting user's stored config, or
    falls back to the platform singleton (scheduler credentials).
    """
    from core.security import decrypted_broker_config
    from data.broker_factory import build_delta_client, build_groww_client

    uid = user["id"]
    try:
        rec = (
            admin_client()
            .table("user_configs")
            .select("*")
            .eq("user_id", uid)
            .limit(1)
            .execute()
        )
        cfg = decrypted_broker_config(rec.data[0] if rec.data else {})
    except Exception:
        cfg = {}

    orders: list[dict] = []

    if market in ("india", "all"):
        try:
            gc = build_groww_client(cfg)
            if gc is None:
                from data.groww_client import groww as _groww_singleton
                gc = _groww_singleton
            raw = gc.get_orders()
            for o in raw:
                ts = o.get("orderTimestamp") or o.get("createdAt") or ""
                orders.append({
                    "id":       str(o.get("growwOrderId") or o.get("id") or ""),
                    "time":     _fmt_order_time(ts),
                    "symbol":   o.get("tradingSymbol") or o.get("symbol") or "",
                    "exch":     "NSE",
                    "side":     (o.get("transactionType") or o.get("side") or "").upper(),
                    "type":     _norm_type(o.get("orderType") or ""),
                    "qty":      o.get("quantity") or o.get("qty") or 0,
                    "price":    o.get("price") or 0,
                    "filled":   o.get("filledQuantity") or o.get("executedQty") or o.get("filled") or 0,
                    "avg_fill": o.get("averagePrice") or o.get("tradedPrice") or o.get("avg_fill") or None,
                    "status":   _norm_status(o.get("status") or "", "groww"),
                    "product":  o.get("product") or "CNC",
                    "market":   "india",
                })
        except Exception as e:
            logger.warning(f"India orders fetch failed: {e}")

    if market in ("crypto", "all"):
        try:
            dc = build_delta_client(cfg)
            if dc is None:
                from data.delta_client import delta_rest as _delta_singleton
                dc = _delta_singleton
            raw = dc.get_orders(state="open")
            for o in raw:
                raw_sym = o.get("product", {}).get("symbol") or o.get("symbol") or ""
                sym = raw_sym.replace("USDT", "USD").replace(".PERP", "")
                ts = o.get("created_at") or ""
                orders.append({
                    "id":       str(o.get("id") or ""),
                    "time":     _fmt_order_time(ts),
                    "symbol":   sym,
                    "exch":     "DELTA",
                    "side":     (o.get("side") or "").upper(),
                    "type":     _norm_type(o.get("order_type") or ""),
                    "qty":      o.get("size") or 0,
                    "price":    float(o.get("limit_price") or 0),
                    "filled":   o.get("filled") or 0,
                    "avg_fill": float(o.get("average_fill_price") or 0) or None,
                    "status":   _norm_status((o.get("state") or "").upper(), "delta"),
                    "product":  "PERP",
                    "market":   "crypto",
                })
        except Exception as e:
            logger.warning(f"Crypto orders fetch failed: {e}")

    # ── Merge bot executions ─────────────────────────────────────
    # Bot orders placed via _try_broker_order are tracked in the state store.
    # Paper/simulated orders never reach the real broker, so they would be
    # invisible in the Trades UI unless we merge them here.
    # Live orders (status="PLACED") may already appear from the broker fetch
    # above; we include them too and rely on distinct IDs to avoid confusion.
    _BOT_EXEC_STATUS_MAP = {
        "PENDING":        "PENDING",
        "SIMULATED":      "FILLED",
        "PLACED":         "FILLED",
        "REVERSAL_CLOSE": "FILLED",
        "ERROR":          "REJECTED",
    }
    try:
        broker_ids = {o["id"] for o in orders}
        bot_execs: list = state.get(f"/bot_executions/{uid}") or []
        for ex in bot_execs[:200]:
            ex_id = str(ex.get("id") or "")
            if ex_id in broker_ids:
                continue  # already present from live broker fetch
            ex_market = ex.get("market", "india")
            if market != "all" and ex_market != market:
                continue
            ex_status = _BOT_EXEC_STATUS_MAP.get(
                (ex.get("status") or "").upper(), ex.get("status") or "PENDING"
            )
            orders.append({
                "id":       ex_id,
                "time":     _fmt_order_time(ex.get("ts") or ""),
                "symbol":   ex.get("symbol") or "",
                "exch":     "DELTA" if ex_market == "crypto" else "NSE",
                "side":     (ex.get("side") or "").upper(),
                "type":     "MARKET",
                "qty":      ex.get("qty") or 0,
                "price":    float(ex.get("price") or 0),
                "filled":   (ex.get("qty") or 0) if ex_status == "FILLED" else 0,
                "avg_fill": float(ex.get("price") or 0) if ex_status == "FILLED" else None,
                "status":   ex_status,
                "product":  "PERP" if ex_market == "crypto" else "CNC",
                "source":   "bot",
                "bot_name": ex.get("bot_name") or "",
            })
    except Exception as e:
        logger.warning(f"Bot execution merge failed: {e}")

    return {"orders": orders, "count": len(orders)}


@app.post("/orders")
async def place_order(
    payload: PlaceOrderPayload,
    request: Request,
    user: dict = Depends(get_current_user),
):
    """Place an order via the appropriate broker based on market."""
    from core.security import decrypted_broker_config
    from data.broker_factory import build_delta_client, build_groww_client

    uid = user["id"]
    try:
        rec = (
            admin_client()
            .table("user_configs")
            .select("*")
            .eq("user_id", uid)
            .limit(1)
            .execute()
        )
        cfg = decrypted_broker_config(rec.data[0] if rec.data else {})
    except Exception:
        cfg = {}

    mkt = payload.market.lower()
    side = payload.side.upper()

    if mkt == "crypto":
        dc = build_delta_client(cfg)
        if dc is None:
            from data.delta_client import delta_rest as _delta_singleton
            dc = _delta_singleton
        products = {p["symbol"]: p["id"] for p in dc.get_products()}
        pid = products.get(payload.symbol)
        if not pid:
            raise HTTPException(404, f"Delta product not found: {payload.symbol}")
        result = dc.place_order(
            product_id=pid,
            side=side.lower(),
            size=int(payload.qty),
            order_type="market_order" if payload.order_type == "MARKET" else "limit_order",
            limit_price=payload.price if payload.order_type != "MARKET" else None,
        )
    else:
        gc = build_groww_client(cfg)
        if gc is None:
            from data.groww_client import groww as _groww_singleton
            gc = _groww_singleton
        result = gc.place_equity_order(
            symbol=payload.symbol,
            qty=int(payload.qty),
            side=side,
            order_type=payload.order_type,
            price=payload.price,
            product=payload.product,
        )

    audit(user, "order.place",
          details={"symbol": payload.symbol, "side": side, "qty": payload.qty,
                   "market": mkt},
          ip=request.client.host if request.client else None)
    return {"status": "submitted", "result": result}


@app.delete("/orders/{order_id}")
async def cancel_order(
    order_id: str,
    market: str = Query("india", description="india | crypto"),
    product_id: int = Query(None, description="Required for crypto"),
    segment: str = Query("CASH", description="CASH | FNO (India only)"),
    request: Request = None,
    user: dict = Depends(get_current_user),
):
    """Cancel an open order."""
    from core.security import decrypted_broker_config
    from data.broker_factory import build_delta_client, build_groww_client

    uid = user["id"]
    try:
        rec = (
            admin_client()
            .table("user_configs")
            .select("*")
            .eq("user_id", uid)
            .limit(1)
            .execute()
        )
        cfg = decrypted_broker_config(rec.data[0] if rec.data else {})
    except Exception:
        cfg = {}

    # ── Bot order: remove from state store, skip broker call ────────
    try:
        bot_execs: list = state.get(f"/bot_executions/{uid}") or []
        matched = any(str(ex.get("id") or "") == order_id for ex in bot_execs)
        if matched:
            state.set(f"/bot_executions/{uid}",
                      [ex for ex in bot_execs if str(ex.get("id") or "") != order_id])
            audit(user, "order.cancel",
                  details={"order_id": order_id, "market": market, "source": "bot"},
                  ip=request.client.host if request.client else None)
            return {"status": "cancelled", "source": "bot"}
    except Exception:
        pass

    if market == "crypto":
        if product_id is None:
            raise HTTPException(422, "product_id required for crypto order cancellation")
        dc = build_delta_client(cfg)
        if dc is None:
            from data.delta_client import delta_rest as _delta_singleton
            dc = _delta_singleton
        result = dc.cancel_order(int(order_id), product_id)
    else:
        gc = build_groww_client(cfg)
        if gc is None:
            from data.groww_client import groww as _groww_singleton
            gc = _groww_singleton
        result = gc.cancel_order(order_id, segment)

    audit(user, "order.cancel", details={"order_id": order_id, "market": market},
          ip=request.client.host if request.client else None)
    return {"status": "cancelled", "result": result}


# ─── Positions ────────────────────────────────────────────────────

@app.get("/positions")
async def list_positions(user: dict = Depends(get_current_user)):
    """
    Merge positions from:
    1. Platform state store (agent-tracked positions with entry/stop/target)
    2. Live broker positions (Groww cash+FnO, Delta perps) for real-time PnL

    State store data is the source of truth for trade context;
    broker data provides live price overlay.
    """
    from core.security import decrypted_broker_config
    from data.broker_factory import build_delta_client, build_groww_client

    uid = user["id"]
    try:
        rec = (
            admin_client()
            .table("user_configs")
            .select("*")
            .eq("user_id", uid)
            .limit(1)
            .execute()
        )
        cfg = decrypted_broker_config(rec.data[0] if rec.data else {})
    except Exception:
        cfg = {}

    positions: list[dict] = []

    # ── State store positions (agent-managed) ──────────────────────
    state_positions = state.get_all_positions()
    state_map: dict[str, dict] = {}
    for p in state_positions:
        key = p.get("symbol") or ""
        if key:
            state_map[key] = p
            unrl_pnl = float(p.get("unrealised_pnl") or p.get("unrealized_pnl") or 0)
            avg      = float(p.get("entry_price") or p.get("current_price") or 0)
            ltp      = float(p.get("current_price") or avg)
            qty      = float(p.get("qty") or p.get("size") or 0)
            mkt      = p.get("market", "india")
            side     = p.get("direction", "LONG")
            entry_ts = p.get("entry_time") or p.get("created_at") or ""
            positions.append({
                "symbol":        key,
                "market":        mkt,
                "side":          side,
                "avg":           avg,
                "ltp":           ltp,
                "qty":           qty,
                "unrl_pnl":      round(unrl_pnl, 4),
                "unrl_pct":      round(float(p.get("pnl_pct") or 0), 4),
                "realized_pnl":  0.0,
                "day_pnl":       round(unrl_pnl, 4),
                "delta":         qty if side == "LONG" else -qty,
                "exch":          "DELTA" if mkt == "crypto" else "NSE",
                "product":       "PERP" if mkt == "crypto" else "CNC",
                "currency":      "USD" if mkt == "crypto" else "INR",
                "entry_time":    _fmt_order_time(entry_ts),
                "stop_loss":     p.get("stop_loss"),
                "target":        p.get("target"),
                "source":        "agent",
            })

    # ── Live Groww positions (broker-side) ─────────────────────────
    try:
        gc = build_groww_client(cfg)
        if gc is None:
            from data.groww_client import groww as _groww_singleton
            gc = _groww_singleton
        broker_pos = gc.get_positions()
        for segment_key in ("cash", "fno"):
            for p in (broker_pos.get(segment_key) or []):
                sym = p.get("tradingSymbol") or p.get("symbol") or ""
                if sym and sym not in state_map:
                    qty = p.get("quantity") or p.get("qty") or 0
                    if qty == 0:
                        continue
                    buy_avg = float(p.get("buyAveragePrice") or p.get("averagePrice") or 0)
                    ltp     = float(p.get("lastTradedPrice") or p.get("ltp") or buy_avg)
                    pnl     = (ltp - buy_avg) * abs(qty) if buy_avg else 0
                    pnl_pct = round((pnl / (buy_avg * abs(qty)) * 100), 2) if buy_avg * abs(qty) else 0
                    side = "LONG" if qty > 0 else "SHORT"
                    positions.append({
                        "symbol":       sym,
                        "market":       "india",
                        "side":         side,
                        "avg":          buy_avg,
                        "ltp":          ltp,
                        "qty":          abs(qty),
                        "unrl_pnl":     round(pnl, 2),
                        "unrl_pct":     pnl_pct,
                        "realized_pnl": 0.0,
                        "day_pnl":      round(pnl, 2),
                        "delta":        abs(qty) if side == "LONG" else -abs(qty),
                        "exch":         "NSE",
                        "product":      "CNC",
                        "currency":     "INR",
                        "stop_loss":    None,
                        "target":       None,
                        "source":       "broker",
                        "_raw":         p,
                    })
    except Exception as e:
        logger.warning(f"Groww positions fetch failed: {e}")

    # ── Live Delta positions (crypto broker-side) ──────────────────
    try:
        dc = build_delta_client(cfg)
        if dc is None:
            from data.delta_client import delta_rest as _delta_singleton
            dc = _delta_singleton
        for p in dc.get_positions():
            sym = p.get("product", {}).get("symbol") or p.get("symbol") or ""
            sym_clean = sym.replace("USDT", "USD").replace(".PERP", "")
            if sym_clean and sym_clean not in state_map and sym not in state_map:
                size = float(p.get("size") or 0)
                if size == 0:
                    continue
                entry_price = float(p.get("entry_price") or 0)
                mark_price  = float(p.get("mark_price") or entry_price)
                pnl_usd     = float(p.get("unrealized_pnl") or 0)
                pnl_pct_d   = round(float(p.get("pnl_pct") or 0), 4)
                # positive size = long, negative = short
                side = "LONG" if size > 0 else "SHORT"
                positions.append({
                    "symbol":       sym_clean,
                    "market":       "crypto",
                    "side":         side,
                    "avg":          entry_price,
                    "ltp":          mark_price,
                    "qty":          abs(size),
                    "unrl_pnl":     round(pnl_usd, 4),
                    "unrl_pct":     pnl_pct_d,
                    "realized_pnl": 0.0,
                    "day_pnl":      round(pnl_usd, 4),
                    "delta":        abs(size) if side == "LONG" else -abs(size),
                    "exch":         "DELTA",
                    "product":      "PERP",
                    "currency":     "USD",
                    "stop_loss":    None,
                    "target":       None,
                    "source":       "broker",
                    "_raw":         p,
                })
    except Exception as e:
        logger.warning(f"Delta positions fetch failed: {e}")

    # ── Merge bot-tracked positions ───────────────────────────────
    # Bots in paper/simulated mode never write to the real broker, so their
    # open positions won't appear in the Groww/Delta fetch above.
    # We read the latest execution per symbol from /bot_executions and surface
    # any that are still "IN_POSITION" (bot.state) and not already in the list.
    try:
        existing_syms = {p["symbol"] for p in positions}
        bot_execs: list = state.get(f"/bot_executions/{uid}") or []
        # Collapse to one record per symbol: most recent SIMULATED/PLACED entry
        _bot_pos: dict[str, dict] = {}
        for ex in reversed(bot_execs):
            ex_status = (ex.get("status") or "").upper()
            if ex_status not in ("SIMULATED", "PLACED"):
                continue
            sym = ex.get("symbol") or ""
            if sym and sym not in _bot_pos:
                _bot_pos[sym] = ex
        for sym, ex in _bot_pos.items():
            if sym in existing_syms:
                continue
            ex_market = ex.get("market", "india")
            side = (ex.get("side") or "BUY").upper()
            qty = float(ex.get("qty") or 0)
            price = float(ex.get("price") or 0)
            positions.append({
                "symbol":       sym,
                "market":       ex_market,
                "side":         "LONG" if side == "BUY" else "SHORT",
                "avg":          price,
                "ltp":          price,
                "qty":          qty,
                "unrl_pnl":     0.0,
                "unrl_pct":     0.0,
                "realized_pnl": 0.0,
                "day_pnl":      0.0,
                "delta":        qty if side == "BUY" else -qty,
                "exch":         "DELTA" if ex_market == "crypto" else "NSE",
                "product":      "PERP" if ex_market == "crypto" else "CNC",
                "currency":     "USD" if ex_market == "crypto" else "INR",
                "entry_time":   _fmt_order_time(ex.get("ts") or ""),
                "source":       "bot",
                "bot_name":     ex.get("bot_name") or "",
            })
    except Exception as e:
        logger.warning(f"Bot position merge failed: {e}")

    return {"positions": positions, "count": len(positions)}


class ClosePositionBody(BaseModel):
    qty:        float = 0
    order_type: str   = "MARKET"   # MARKET | LIMIT
    price:      Optional[float] = None


@app.post("/positions/{symbol}/close")
async def close_position(
    symbol:  str,
    body:    ClosePositionBody,
    market:  str = Query("india", description="india | crypto"),
    request: Request = None,
    user:    dict = Depends(get_current_user),
):
    """
    Close a position for the given symbol.
    For crypto: closes via Delta at market.
    For India: places a SELL order via Groww to flatten the position.
    In dev mode with no broker connection, simulates the close.
    """
    from core.security import decrypted_broker_config
    from data.broker_factory import build_delta_client, build_groww_client

    qty = body.qty
    uid = user["id"]
    try:
        rec = (
            admin_client()
            .table("user_configs")
            .select("*")
            .eq("user_id", uid)
            .limit(1)
            .execute()
        )
        cfg = decrypted_broker_config(rec.data[0] if rec.data else {})
    except Exception:
        cfg = {}

    result: dict = {}

    if market == "crypto":
        try:
            dc = build_delta_client(cfg)
            if dc is None:
                from data.delta_client import delta_rest as _delta_singleton
                dc = _delta_singleton
            products = {p["symbol"]: p["id"] for p in dc.get_products()}
            sym_perp = symbol.replace("USD", "USDT") if "USD" in symbol else symbol
            pid = products.get(sym_perp) or products.get(symbol)
            if pid:
                result = dc.close_position(pid) or {}
            else:
                result = {"simulated": True, "reason": f"product {symbol} not found on exchange"}
        except Exception as e:
            if ENVIRONMENT == "dev":
                result = {"simulated": True, "reason": str(e)[:120]}
            else:
                raise HTTPException(502, f"Delta close failed: {e}")
    else:
        if qty <= 0:
            raise HTTPException(422, "qty is required to close an India equity position")
        try:
            gc = build_groww_client(cfg)
            if gc is None:
                from data.groww_client import groww as _groww_singleton
                gc = _groww_singleton
            order_type = body.order_type if body.order_type in ("MARKET", "LIMIT") else "MARKET"
            result = gc.place_equity_order(
                symbol=symbol, qty=int(qty), side="SELL",
                order_type=order_type, product="CNC",
                price=body.price or 0,
            ) or {}
        except Exception as e:
            if ENVIRONMENT == "dev":
                result = {"simulated": True, "reason": str(e)[:120]}
            else:
                raise HTTPException(502, f"Groww close failed: {e}")

    # Remove from state store so agent doesn't double-count
    for mkt_key in ("india", "crypto"):
        state.delete_position(mkt_key, symbol)

    # Also clear from bot_executions so position disappears from UI on next poll
    try:
        bot_execs: list = state.get(f"/bot_executions/{uid}") or []
        bot_execs = [ex for ex in bot_execs if ex.get("symbol") != symbol]
        state.set(f"/bot_executions/{uid}", bot_execs)
    except Exception:
        pass

    audit(user, "position.close",
          details={"symbol": symbol, "qty": qty, "market": market, "order_type": body.order_type},
          ip=request.client.host if request.client else None)
    return {"status": "close_submitted", "symbol": symbol, "result": result}


# ─── Scan trigger ────────────────────────────────────────────────
@app.post("/scan/run",
          dependencies=[Depends(rate_limit("scan", per_minute=_settings.SCAN_RATE_LIMIT_PER_MIN))])
async def trigger_scan(request: Request, admin: dict = Depends(require_admin)):
    """Manually trigger a scan cycle. Heavy — rate-limited strictly."""
    asyncio.create_task(_run_scan_bg())
    audit(admin, "scan.trigger",
          ip=request.client.host if request.client else None)
    return {"status": "scan_started", "timestamp": datetime.now(timezone.utc).isoformat()}


async def _run_scan_bg():
    try:
        from agents.chart_pattern_agent import run_chart_pattern_agent
        from data.delta_client import build_delta_snapshot

        build_delta_snapshot()
        await run_chart_pattern_agent("india")
        await run_chart_pattern_agent("crypto")
        logger.info("Manual scan completed")
    except Exception as e:
        logger.error(f"Scan error: {e}")


# ─── India Analysis Pipeline ──────────────────────────────────────
@app.post("/agents/india/pipeline/run",
          dependencies=[Depends(rate_limit("scan", per_minute=_settings.SCAN_RATE_LIMIT_PER_MIN))])
async def run_india_pipeline(user: dict = Depends(get_current_user)):
    """Trigger the India stock analysis pipeline on demand (any authenticated user)."""
    current = state.get("/pipeline/india/status") or {}
    if current.get("status") == "running":
        return {"status": "already_running", "pipeline": current}
    asyncio.create_task(_run_india_pipeline_bg(user.get("email", "user")))
    return {"status": "started", "timestamp": datetime.now(timezone.utc).isoformat()}


async def _run_india_pipeline_bg(triggered_by: str) -> None:
    try:
        from agents.india_pipeline import run_india_analysis_pipeline
        await run_india_analysis_pipeline(triggered_by=triggered_by)
    except Exception as e:
        logger.error(f"India pipeline task error: {e}")


@app.get("/agents/india/pipeline/status")
async def get_india_pipeline_status(user: dict = Depends(get_current_user)):
    """Return current India analysis pipeline state and last-run outcome."""
    return state.get("/pipeline/india/status") or {"status": "idle"}


# ─── SMC Top-Down Signal Engine ───────────────────────────────────

@app.get("/smc/{market}/{symbol}", tags=["smc"])
async def get_smc_analysis(
    market: str,
    symbol: str,
    refresh: bool = Query(default=False, description="Force re-run instead of serving cache"),
    user: dict = Depends(get_current_user),
):
    """
    Return SMC top-down analysis for one instrument.

    Cached for 1 hour. Pass ?refresh=true to re-run immediately.
    market: india | crypto
    symbol: e.g. RELIANCE (India) or BTCUSD (crypto)
    """
    if market not in ("india", "crypto"):
        raise HTTPException(status_code=400, detail="market must be 'india' or 'crypto'")

    cached = state.get(f"/smc/{market}/{symbol}")
    if cached and not refresh:
        return cached

    try:
        from agents.smc_agent import run_smc_analysis
        result = await run_smc_analysis(symbol, market)
        return result
    except Exception as e:
        logger.error(f"SMC analysis {market}/{symbol}: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.post(
    "/agents/smc/scan",
    tags=["smc"],
    dependencies=[Depends(rate_limit("scan", per_minute=_settings.SCAN_RATE_LIMIT_PER_MIN))],
)
async def trigger_smc_scan(
    market: str = Query(default="india", description="india | crypto | both"),
    user: dict = Depends(get_current_user),
):
    """
    Trigger an SMC watchlist scan in the background.
    Returns immediately; results are written to /smc/{market}/watchlist_results.
    """
    if market not in ("india", "crypto", "both"):
        raise HTTPException(status_code=400, detail="market must be india, crypto, or both")

    async def _run():
        from agents.smc_agent import run_smc_watchlist_scan
        markets = ["india", "crypto"] if market == "both" else [market]
        for mkt in markets:
            try:
                await run_smc_watchlist_scan(mkt)
            except Exception as e:
                logger.error(f"SMC scan {mkt}: {e}")

    asyncio.create_task(_run())
    return {
        "status": "started",
        "market": market,
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "results_key": f"/smc/{market}/watchlist_results",
    }


@app.get("/smc/{market}/watchlist/results", tags=["smc"])
async def get_smc_watchlist_results(
    market: str,
    user: dict = Depends(get_current_user),
):
    """Return latest SMC watchlist scan results (LONG/SHORT signals only, RR≥3)."""
    if market not in ("india", "crypto"):
        raise HTTPException(status_code=400, detail="market must be 'india' or 'crypto'")
    results   = state.get(f"/smc/{market}/watchlist_results") or []
    last_scan = state.get(f"/smc/{market}/last_scan") or None
    return {"market": market, "last_scan": last_scan, "count": len(results), "signals": results}


# ─── User config (per-user broker keys) ──────────────────────────
@app.get("/user/config")
async def get_user_config(user: dict = Depends(get_current_user)):
    """
    Return the user's config with broker secrets *masked*.

    IMPORTANT: we never decrypt for display. The frontend gets a masked
    placeholder; if the user wants to change a secret they re-enter it.
    """
    try:
        rec = (
            admin_client()
            .table("user_configs")
            .select("*")
            .eq("user_id", user["id"])
            .limit(1)
            .execute()
        )
    except Exception as e:
        logger.error(f"get_user_config lookup failed: {e}")
        return {}

    if not rec.data:
        # Fallback: check state store (used in dev / when DB FK fails)
        cached = state.get(f"/user_config/{user['id']}")
        return cached or {}

    cfg = dict(rec.data[0])
    for field in ("groww_api_key", "groww_totp_secret",
                  "delta_api_key", "delta_api_secret"):
        cfg[field] = mask_secret(cfg.get(field))
    return cfg


@app.put("/user/config",
         dependencies=[Depends(rate_limit("user", per_minute=_settings.USER_RATE_LIMIT_PER_MIN))])
async def save_user_config(
    config: UserConfig,
    request: Request,
    user: dict = Depends(get_current_user),
):
    """
    Save user config. Incoming secrets are encrypted before persist.
    A masked placeholder (starts with "•" or is exactly "SET") means
    "keep the existing value" — we never overwrite with a mask.
    """
    data = config.model_dump(exclude_none=True)
    uid = user["id"]

    # Strip masked placeholders so they don't overwrite real encrypted values
    for field in ("groww_api_key", "groww_totp_secret",
                  "delta_api_key", "delta_api_secret"):
        val = data.get(field)
        if val and (val.startswith("•") or val == "SET"):
            data.pop(field, None)
        elif val and not is_encrypted(val):
            data[field] = encrypt_key(val)

    try:
        db = admin_client()
        existing = db.table("user_configs").select("id").eq("user_id", uid).execute()
        if existing.data:
            db.table("user_configs").update(data).eq("user_id", uid).execute()
        else:
            # upsert handles race conditions and missing FK (dev mode)
            db.table("user_configs").upsert({"user_id": uid, **data},
                                            on_conflict="user_id").execute()
    except Exception as e:
        logger.warning(f"save_user_config DB failed for {uid}, caching to state: {e}")
        # Fallback: persist to state store so settings aren't lost
        state.set(f"/user_config/{uid}", data, ttl=86400 * 30)

    audit(
        user,
        "user.config_update",
        target=uid,
        # `data` may still contain secrets — audit module redacts them
        details={"fields_updated": sorted(data.keys())},
        ip=request.client.host if request.client else None,
    )
    return {"status": "saved"}


# ─── Admin: User management ──────────────────────────────────────
@app.get("/admin/users",
         dependencies=[Depends(rate_limit("admin", per_minute=_settings.ADMIN_RATE_LIMIT_PER_MIN))])
async def list_users(admin: dict = Depends(require_admin)):
    try:
        resp = (
            admin_client()
            .table("users")
            .select("*")
            .order("created_at", desc=True)
            .execute()
        )
    except Exception as e:
        logger.error(f"list_users failed: {e}")
        raise HTTPException(500, "User list fetch failed")
    return {"users": resp.data or []}


@app.post("/admin/users",
          dependencies=[Depends(rate_limit("admin", per_minute=_settings.ADMIN_RATE_LIMIT_PER_MIN))])
async def create_new_user(
    payload: UserCreate,
    request: Request,
    admin: dict = Depends(require_admin),
):
    db = admin_client()
    try:
        auth_resp = db.auth.admin.create_user({
            "email": payload.email,
            "password": payload.password,
            "email_confirm": True,
        })
        uid = auth_resp.user.id
    except Exception as e:
        logger.warning(f"Auth create_user failed for {payload.email}: {e}")
        raise HTTPException(400, f"Auth creation failed: {e}")

    try:
        db.table("users").insert({
            "id": uid,
            "email": payload.email,
            "full_name": payload.full_name,
            "plan": payload.plan,
            "status": "active",
            "is_admin": False,
            "payment_ref": payload.payment_ref,
            "amount_paid": payload.amount,
            "valid_until": payload.valid_until,
            "created_by": admin["id"],
        }).execute()
    except Exception as e:
        # Roll back the auth user if DB insert fails to avoid orphans
        logger.error(f"users table insert failed for {uid}: {e}")
        try:
            db.auth.admin.delete_user(uid)
        except Exception:
            pass
        raise HTTPException(500, "User creation failed")

    audit(
        admin,
        "user.create",
        target=uid,
        details={"email": payload.email, "plan": payload.plan},
        ip=request.client.host if request.client else None,
    )
    return {"status": "created", "user_id": uid}


@app.put("/admin/users/{user_id}",
         dependencies=[Depends(rate_limit("admin", per_minute=_settings.ADMIN_RATE_LIMIT_PER_MIN))])
async def update_existing_user(
    user_id: str,
    payload: UserUpdate,
    request: Request,
    admin: dict = Depends(require_admin),
):
    data = payload.model_dump(exclude_none=True)
    try:
        admin_client().table("users").update(data).eq("id", user_id).execute()
    except Exception as e:
        logger.error(f"update_user failed for {user_id}: {e}")
        raise HTTPException(500, "User update failed")

    # If the user was deactivated or demoted, evict any cached tokens
    if payload.status and payload.status != "active":
        invalidate_user_tokens(user_id)

    audit(admin, "user.update", target=user_id, details=data,
          ip=request.client.host if request.client else None)
    return {"status": "updated"}


@app.delete("/admin/users/{user_id}",
            dependencies=[Depends(rate_limit("admin", per_minute=_settings.ADMIN_RATE_LIMIT_PER_MIN))])
async def remove_user(
    user_id: str,
    request: Request,
    admin: dict = Depends(require_admin),
):
    if user_id == admin["id"]:
        raise HTTPException(400, "Admins cannot delete themselves")

    db = admin_client()
    try:
        db.table("user_configs").delete().eq("user_id", user_id).execute()
        db.table("users").delete().eq("id", user_id).execute()
    except Exception as e:
        logger.error(f"remove_user failed for {user_id}: {e}")
        raise HTTPException(500, "User deletion failed")

    try:
        db.auth.admin.delete_user(user_id)
    except Exception as e:
        logger.warning(f"auth delete_user failed for {user_id} (non-fatal): {e}")

    invalidate_user_tokens(user_id)
    audit(admin, "user.delete", target=user_id,
          ip=request.client.host if request.client else None)
    return {"status": "deleted"}


# ─── Current user (for frontend bootstrap — bypasses RLS) ────────
@app.get("/auth/me")
async def auth_me(user: dict = Depends(get_current_user)):
    return {
        "id":        user["id"],
        "email":     user["email"],
        "full_name": user.get("full_name"),
        "plan":      user.get("plan"),
        "status":    user.get("status"),
        "is_admin":  user.get("is_admin", False),
    }


# ─── Logout (evict cached token) ─────────────────────────────────
@app.post("/auth/logout")
async def logout(request: Request, user: dict = Depends(get_current_user)):
    token = getattr(request.state, "token", None)
    if token:
        invalidate_token(token)
    return {"status": "logged_out"}


# ─── TradingView Webhook ──────────────────────────────────────────
#
# Setup in TradingView:
#   1. Add "RF [DW] & Labels" to a 3m crypto chart
#   2. Create an alert → On BUY label / On SELL label
#   3. Webhook URL:  https://<your-domain>/api/webhook/tradingview
#   4. Message body (JSON):
#      {
#        "token":     "<TV_WEBHOOK_SECRET from .env>",
#        "symbol":    "{{ticker}}",
#        "action":    "BUY",        // or "SELL" — hardcode per alert
#        "price":     {{close}},
#        "timeframe": "3m",
#        "indicator": "RF_DW"
#      }

class TVWebhookPayload(BaseModel):
    token:     str
    symbol:    str
    action:    str
    price:     float
    timeframe: str  = "3m"
    indicator: str  = "RF_DW"
    extra:     dict = {}


@app.post("/webhook/tradingview")
async def tradingview_webhook(payload: TVWebhookPayload, request: Request):
    """
    Receives live alerts from TradingView (RF [DW] & Labels).
    Validated by shared secret; no user session required.
    """
    settings = get_settings()
    expected = getattr(settings, "tv_webhook_secret", "") or ""
    if expected and payload.token != expected:
        raise HTTPException(403, "Invalid webhook token")

    symbol = payload.symbol.upper().replace(".PERP", "").replace("USDT", "USD")
    action = payload.action.upper()
    if action not in ("BUY", "SELL"):
        raise HTTPException(422, "action must be BUY or SELL")

    signal = {
        "symbol":     symbol,
        "timeframe":  payload.timeframe,
        "signal":     action,
        "direction":  1 if action == "BUY" else -1,
        "price":      payload.price,
        "indicator":  payload.indicator,
        "source":     "tradingview_webhook",
        "timestamp":  datetime.now(timezone.utc).isoformat(),
        "just_fired": True,
    }

    # Merge into existing RF [DW] key so /signals/rf_dw picks it up
    existing = state.get(f"/rf_dw/crypto/{symbol}") or {}
    existing.update(signal)
    state.set(f"/rf_dw/crypto/{symbol}", existing, ttl=3600)

    # Fire-and-forget notifications
    asyncio.create_task(_send_tv_alert(signal))

    logger.info(f"TV webhook: {symbol} {action} @ {payload.price}")
    return {"status": "ok", "symbol": symbol, "signal": action}


async def _send_tv_alert(s: dict) -> None:
    from notifications.telegram import send_message, _SEP, _ist_now
    is_buy = s["signal"] == "BUY"
    emoji  = "📈" if is_buy else "📉"
    action = "BUY  ▲" if is_buy else "SELL ▼"
    tf     = s.get("timeframe", "—").upper()
    msg = "\n".join([
        f"{emoji} <b>RF [DW] {action} — {s['symbol']}</b>",
        _SEP,
        f"<i>{tf}  ·  TradingView Webhook</i>",
        "",
        f"Price   <b>${float(s['price']):,.4f}</b>",
        "",
        _SEP,
        f"<i>RF [DW] &amp; Labels by DW  ·  {_ist_now()}</i>",
    ])
    try:
        await send_message(msg, _msg_type="tv_webhook")
    except Exception as e:
        logger.warning(f"TV webhook Telegram failed: {e}")


# ─── Phase 3: Chartink Webhook ───────────────────────────────────

class ChartinkPayload(BaseModel):
    scan_name:      str
    stocks:         list[str]
    trigger_prices: list[float] = []
    triggered_at:   Optional[str] = None
    scan_url:       Optional[str] = None
    token:          Optional[str] = None


class ChartinkScanCreate(BaseModel):
    scan_name:     str
    strategy_type: str = "technical"
    description:   str = ""


@app.post("/webhook/chartink")
async def chartink_webhook(payload: ChartinkPayload, request: Request):
    """
    Receives live scan alerts from Chartink.
    Set webhook URL in Chartink alert to: https://<domain>/webhook/chartink
    Payload format: {"scan_name": "RSI Breakout", "stocks": ["RELIANCE"], ...}
    """
    # Validate token against scan registry (optional — token in payload)
    if payload.token:
        try:
            db = admin_client()
            scan_row = db.table("chartink_scans") \
                .select("id,active,strategy_type") \
                .eq("scan_name", payload.scan_name) \
                .eq("webhook_token", payload.token) \
                .single().execute()
            if not scan_row.data:
                raise HTTPException(403, "Invalid Chartink webhook token or scan not registered")
            if not scan_row.data.get("active"):
                return {"status": "ignored", "reason": "scan inactive"}
            # Update trigger stats
            db.table("chartink_scans") \
                .update({"last_triggered": datetime.now(timezone.utc).isoformat(),
                         "trigger_count": scan_row.data.get("trigger_count", 0) + 1}) \
                .eq("scan_name", payload.scan_name).execute()
        except HTTPException:
            raise
        except Exception as e:
            logger.warning(f"Chartink scan lookup failed: {e}")

    symbols = [s.upper().strip() for s in payload.stocks if s.strip()]
    prices  = dict(zip(symbols, payload.trigger_prices)) if payload.trigger_prices else {}

    fired_at = payload.triggered_at or datetime.now(timezone.utc).isoformat()

    # Store in state for screener panel
    existing = state.get("/chartink/signals") or []
    for sym in symbols:
        existing.insert(0, {
            "symbol":    sym,
            "scan_name": payload.scan_name,
            "price":     prices.get(sym, 0),
            "fired_at":  fired_at,
            "source":    "chartink",
        })
    state.set("/chartink/signals", existing[:200], ttl=86400)

    # Broadcast to WebSocket
    await manager.broadcast({
        "type":      "chartink_alert",
        "scan_name": payload.scan_name,
        "symbols":   symbols,
        "count":     len(symbols),
    })

    # Telegram notification
    asyncio.create_task(_send_chartink_alert(payload.scan_name, symbols, prices))

    logger.info(f"Chartink webhook: {payload.scan_name} fired for {symbols}")
    return {"status": "ok", "scan": payload.scan_name, "symbols_count": len(symbols)}


async def _send_chartink_alert(scan_name: str, symbols: list[str], prices: dict) -> None:
    from notifications.telegram import send_message, _SEP, _ist_now
    count = len(symbols)
    lines = [
        f"🔔 <b>CHARTINK ALERT</b>",
        _SEP,
        f"<b>{scan_name}</b>  ·  {count} stock{'s' if count != 1 else ''}",
        "",
    ]
    for i, sym in enumerate(symbols[:10], 1):
        price_str = f"  @ ₹{prices[sym]:,.2f}" if prices.get(sym) else ""
        lines.append(f"  {i}. <b>{sym}</b>{price_str}")
    if count > 10:
        lines.append(f"  <i>+{count - 10} more</i>")
    lines.extend(["", _SEP, f"<i>{_ist_now()}</i>"])
    msg = "\n".join(lines)
    try:
        await send_message(msg, _msg_type="tv_webhook")
    except Exception as e:
        logger.warning(f"Chartink Telegram failed: {e}")


@app.get("/chartink/signals")
async def chartink_signals(user: dict = Depends(get_current_user)):
    """Latest Chartink scan alerts (last 200 events, cached 24h)."""
    signals = state.get("/chartink/signals") or []
    return {"timestamp": datetime.now(timezone.utc).isoformat(), "signals": signals}


# ─── Per-user webhook endpoints ───────────────────────────────────────────────

@app.post("/webhook/tv/{user_token}")
async def tv_user_webhook(user_token: str, request: Request):
    """
    Per-user TradingView webhook. Token authenticates the user+bot without a login session.
    TradingView alert message should be JSON: {"action":"buy","ticker":"{{ticker}}","price":"{{close}}"}
    Webhook URL: https://<domain>/webhook/tv/<token>
    """
    mapping = state.get(f"/wh_token/tv/{user_token}")
    if not mapping:
        raise HTTPException(status_code=403, detail="Invalid or expired webhook token")
    try:
        body = await request.json()
    except Exception:
        raise HTTPException(status_code=400, detail="Payload must be valid JSON")
    uid    = mapping["uid"]
    bot_id = mapping["bot_id"]
    action = (body.get("action") or body.get("signal") or body.get("side") or "").upper()
    ticker = (body.get("ticker") or body.get("symbol") or "").upper().strip()
    price  = body.get("price") or body.get("close") or body.get("entry_price")
    if not action or not ticker:
        raise HTTPException(status_code=400, detail="Payload must include 'action' and 'ticker'")
    side = "BUY" if action in ("BUY", "LONG", "B") else "SELL"
    # Normalise: BTCUSDT / BTC_USDT / BTCUSD → BTC
    clean_ticker = ticker.replace("USDT", "").replace("_USDT", "").replace("USD", "").replace("_USD", "")
    entry = {
        "signal_id":    f"tv_{user_token[:8]}_{clean_ticker}_{side}_{int(time.time())}",
        "symbol":       clean_ticker,
        "raw_ticker":   ticker,
        "side":         side,
        "entry_price":  float(price) if price else None,
        "verdict":      "GO",
        "conviction":   "HIGH",
        "overall_score": 8.0,
        "just_fired":   True,
        "ts":           datetime.now(timezone.utc).isoformat(),
        "bot_id":       bot_id,
        "source_name":  body.get("strategy_name") or body.get("indicator") or "TradingView",
    }
    queue: list = state.get(f"/tv_webhook/{uid}") or []
    queue.insert(0, entry)
    state.set(f"/tv_webhook/{uid}", queue[:50], ttl=3600)
    logger.info(f"TV webhook: uid={uid} bot={bot_id} {side} {clean_ticker} @ {price}")
    return {"ok": True, "symbol": clean_ticker, "side": side}


@app.post("/webhook/chartink/user/{user_token}")
async def chartink_user_webhook(user_token: str, request: Request):
    """
    Per-user Chartink webhook. Each bot gets its own token.
    Chartink fires: {"stocks":"RELIANCE,TCS","trigger_prices":"2300,3400","scan_name":"My Scan"}
    Webhook URL: https://<domain>/webhook/chartink/user/<token>
    """
    mapping = state.get(f"/wh_token/chartink/{user_token}")
    if not mapping:
        raise HTTPException(status_code=403, detail="Invalid or expired webhook token")
    try:
        body = await request.json()
    except Exception:
        raise HTTPException(status_code=400, detail="Payload must be valid JSON")
    uid       = mapping["uid"]
    bot_id    = mapping["bot_id"]
    scan_name = body.get("scan_name") or body.get("scanName") or "Chartink"
    raw_syms  = body.get("stocks") or body.get("symbols") or ""
    raw_pxs   = body.get("trigger_prices") or body.get("triggerPrices") or ""
    symbols   = [s.strip().upper() for s in str(raw_syms).split(",") if s.strip()]
    prices    = [s.strip() for s in str(raw_pxs).split(",") if s.strip()]
    price_map = dict(zip(symbols, prices))
    if not symbols:
        return {"ok": True, "symbols": []}
    fired_at = datetime.now(timezone.utc).isoformat()
    alerts = []
    for sym in symbols:
        px = price_map.get(sym)
        alerts.append({
            "signal_id":    f"ck_{user_token[:8]}_{sym}_{int(time.time())}",
            "symbol":       sym,
            "side":         "BUY",
            "entry_price":  float(px) if px else None,
            "verdict":      "GO",
            "conviction":   "MEDIUM",
            "overall_score": 7.0,
            "just_fired":   True,
            "ts":           fired_at,
            "scan_name":    scan_name,
            "bot_id":       bot_id,
        })
    token_key = user_token[:12]
    queue: list = state.get(f"/chartink_user/{uid}/{token_key}") or []
    queue = alerts + queue
    state.set(f"/chartink_user/{uid}/{token_key}", queue[:100], ttl=86400)
    logger.info(f"Chartink user webhook: uid={uid} bot={bot_id} scan={scan_name} symbols={symbols}")
    return {"ok": True, "symbols": symbols, "count": len(symbols)}


@app.get("/admin/chartink-scans", dependencies=[Depends(require_admin)])
async def list_chartink_scans():
    """List all registered Chartink scans."""
    try:
        db = admin_client()
        result = db.table("chartink_scans").select("*").order("created_at", desc=True).execute()
        return {"scans": result.data or []}
    except Exception as e:
        raise HTTPException(500, str(e)[:80])


@app.post("/admin/chartink-scans", status_code=201, dependencies=[Depends(require_admin)])
async def create_chartink_scan(body: ChartinkScanCreate, user: dict = Depends(require_admin)):
    """Register a new Chartink scan for webhook integration."""
    import secrets
    token = secrets.token_hex(16)
    try:
        db = admin_client()
        result = db.table("chartink_scans").insert({
            "scan_name":     body.scan_name,
            "strategy_type": body.strategy_type,
            "description":   body.description,
            "webhook_token": token,
            "created_by":    user["id"],
        }).execute()
        row = result.data[0] if result.data else {}
        return {
            "status":        "created",
            "scan_name":     body.scan_name,
            "webhook_token": token,
            "webhook_url":   f"/webhook/chartink",
            "id":            row.get("id"),
        }
    except Exception as e:
        raise HTTPException(500, str(e)[:80])


@app.delete("/admin/chartink-scans/{scan_name}", status_code=204, dependencies=[Depends(require_admin)])
async def delete_chartink_scan(scan_name: str):
    try:
        admin_client().table("chartink_scans").delete().eq("scan_name", scan_name).execute()
    except Exception as e:
        raise HTTPException(500, str(e)[:80])


# ─── Phase 1: Block & Bulk Deals endpoints ───────────────────────

@app.get("/market/deals")
async def market_deals(
    deal_type: str = Query("all", regex="^(all|block|bulk)$"),
    date: Optional[str] = Query(None, description="YYYY-MM-DD"),
    symbol: Optional[str] = None,
    watchlist_only: bool = False,
    limit: int = Query(100, ge=1, le=500),
    user: dict = Depends(get_current_user),
):
    """Block and bulk deals — today by default, or specify date."""
    try:
        db = admin_client()
        query = db.table("block_bulk_deals").select(
            "symbol,company_name,client_name,direction,quantity,price,"
            "value_crore,deal_type,session_num,trade_date,traded_at,on_watchlist"
        )
        filter_date = date or datetime.now(timezone.utc).strftime("%Y-%m-%d")
        query = query.eq("trade_date", filter_date)
        if deal_type != "all":
            query = query.eq("deal_type", deal_type)
        if symbol:
            query = query.eq("symbol", symbol.upper().replace(".NS", ""))
        if watchlist_only:
            query = query.eq("on_watchlist", True)
        result = query.order("value_crore", desc=True).limit(limit).execute()
        rows = result.data or []
    except Exception as e:
        logger.error(f"Deals query failed: {e}")
        # Fallback to Redis cache
        cached = state.get("/market/deals/today") or {}
        raw    = cached.get("block_deals", []) + cached.get("bulk_deals", [])
        if deal_type != "all":
            raw = [d for d in raw if d.get("deal_type") == deal_type]
        if symbol:
            raw = [d for d in raw if d.get("symbol") == symbol.upper().replace(".NS", "")]
        if watchlist_only:
            raw = [d for d in raw if d.get("on_watchlist")]
        rows = sorted(raw, key=lambda x: x.get("value_crore", 0), reverse=True)[:limit]

    return {
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "date":      filter_date,
        "count":     len(rows),
        "deals":     rows,
    }


@app.get("/market/deals/watchlist")
async def deals_watchlist_hits(
    days: int = Query(5, ge=1, le=30),
    user: dict = Depends(get_current_user),
):
    """Block/bulk deals intersecting the watchlist — last N days."""
    try:
        from datetime import timedelta
        from_date = (datetime.now(timezone.utc) - timedelta(days=days)).strftime("%Y-%m-%d")
        db = admin_client()
        result = db.table("block_bulk_deals") \
            .select("symbol,company_name,client_name,direction,value_crore,deal_type,trade_date") \
            .eq("on_watchlist", True) \
            .gte("trade_date", from_date) \
            .order("trade_date", desc=True).order("value_crore", desc=True) \
            .limit(100).execute()
        rows = result.data or []
    except Exception as e:
        logger.error(f"Deals watchlist query failed: {e}")
        cached = state.get("/market/deals/today") or {}
        rows   = cached.get("watchlist_hits", [])
    return {"timestamp": datetime.now(timezone.utc).isoformat(), "days": days, "deals": rows}


# ─── Phase 2: Corporate Events endpoints ─────────────────────────

@app.get("/market/events")
async def market_events(
    from_date: Optional[str] = Query(None, description="YYYY-MM-DD"),
    to_date:   Optional[str] = Query(None, description="YYYY-MM-DD"),
    event_type: Optional[str] = None,
    symbol:    Optional[str] = None,
    watchlist_only: bool = False,
    user: dict = Depends(get_current_user),
):
    """Corporate events calendar — results, dividends, splits, bonus, AGMs."""
    from datetime import timedelta
    today    = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    to_str   = to_date   or (datetime.now(timezone.utc) + timedelta(days=14)).strftime("%Y-%m-%d")
    from_str = from_date or today
    try:
        db = admin_client()
        query = db.table("corporate_events").select(
            "symbol,company_name,event_type,event_type_label,event_date,details,on_watchlist"
        ).gte("event_date", from_str).lte("event_date", to_str)
        if event_type:
            query = query.eq("event_type", event_type)
        if symbol:
            query = query.eq("symbol", symbol.upper().replace(".NS", ""))
        if watchlist_only:
            query = query.eq("on_watchlist", True)
        result = query.order("event_date").limit(200).execute()
        rows   = result.data or []
    except Exception as e:
        logger.error(f"Events query failed: {e}")
        cached = state.get("/market/events/upcoming") or {}
        rows   = cached.get("all_events", [])

    today_events = [e for e in rows if e.get("event_date") == today]
    return {
        "timestamp":    datetime.now(timezone.utc).isoformat(),
        "from_date":    from_str,
        "to_date":      to_str,
        "count":        len(rows),
        "today_events": today_events,
        "events":       rows,
    }


@app.get("/market/events/today")
async def events_today(user: dict = Depends(get_current_user)):
    """Today's corporate events — quick endpoint for dashboard banner."""
    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    try:
        db = admin_client()
        result = db.table("corporate_events") \
            .select("symbol,company_name,event_type,event_type_label,event_date,details,on_watchlist") \
            .eq("event_date", today) \
            .order("on_watchlist", desc=True).execute()
        rows = result.data or []
    except Exception:
        cached = state.get("/market/events/upcoming") or {}
        rows   = cached.get("today_events", [])
    return {"date": today, "count": len(rows), "events": rows}


@app.get("/market/events/{symbol}")
async def events_for_symbol(
    symbol: str,
    days: int = Query(30, ge=1, le=180),
    user: dict = Depends(get_current_user),
):
    """Upcoming events for a specific symbol."""
    from datetime import timedelta
    sym      = symbol.upper().replace(".NS", "")
    today    = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    to_str   = (datetime.now(timezone.utc) + timedelta(days=days)).strftime("%Y-%m-%d")
    try:
        db = admin_client()
        result = db.table("corporate_events") \
            .select("symbol,company_name,event_type,event_type_label,event_date,details") \
            .eq("symbol", sym).gte("event_date", today).lte("event_date", to_str) \
            .order("event_date").execute()
        rows = result.data or []
    except Exception:
        rows = []
    return {"symbol": sym, "upcoming_events": rows}


# ─── Phase 4: Insider Trading endpoints ──────────────────────────

@app.get("/market/insider-trades")
async def insider_trades(
    symbol: Optional[str] = None,
    days:   int = Query(30, ge=1, le=180),
    trade_type: Optional[str] = Query(None, regex="^(BUY|SELL)$"),
    role:   Optional[str] = Query(None, regex="^(promoter|director|kmp|employee|other)$"),
    watchlist_only: bool = False,
    limit:  int = Query(100, ge=1, le=500),
    user:   dict = Depends(get_current_user),
):
    """SEBI PIT insider trading disclosures with optional filters."""
    from datetime import timedelta
    from_date = (datetime.now(timezone.utc) - timedelta(days=days)).strftime("%Y-%m-%d")
    try:
        db = admin_client()
        query = db.table("insider_trades").select(
            "symbol,company_name,insider_name,insider_role,trade_type,"
            "quantity,price,value_lakh,pre_holding_pct,post_holding_pct,"
            "trade_date,disclosure_date,on_watchlist"
        ).gte("trade_date", from_date)
        if symbol:
            query = query.eq("symbol", symbol.upper().replace(".NS", ""))
        if trade_type:
            query = query.eq("trade_type", trade_type)
        if role:
            query = query.eq("insider_role", role)
        if watchlist_only:
            query = query.eq("on_watchlist", True)
        result = query.order("trade_date", desc=True).limit(limit).execute()
        rows   = result.data or []
    except Exception as e:
        logger.error(f"Insider trades query failed: {e}")
        cached = state.get("/market/insider/recent") or {}
        rows   = cached.get("trades", [])

    return {
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "days":      days,
        "count":     len(rows),
        "trades":    rows,
    }


@app.get("/market/insider-trades/clusters")
async def insider_clusters(
    days: int = Query(14, ge=1, le=90),
    user: dict = Depends(get_current_user),
):
    """Cluster-buy signals: ≥3 insiders buying same stock within 5 days."""
    cached = state.get("/market/insider/recent") or {}
    clusters = cached.get("clusters", [])

    if not clusters:
        from datetime import timedelta
        try:
            db = admin_client()
            from_date = (datetime.now(timezone.utc) - timedelta(days=days)).strftime("%Y-%m-%d")
            result = db.table("insider_trades") \
                .select("symbol,company_name,insider_name,insider_role,trade_type,"
                        "value_lakh,trade_date,on_watchlist") \
                .eq("trade_type", "BUY").gte("trade_date", from_date) \
                .order("trade_date", desc=True).limit(500).execute()
            trades = result.data or []
            if trades:
                from data.nse_insider import detect_clusters
                clusters = detect_clusters(trades)
        except Exception as e:
            logger.error(f"Cluster detection failed: {e}")

    return {
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "cluster_count": len(clusters),
        "clusters":      clusters,
    }


# ─── RF [DW] current state ────────────────────────────────────────

@app.get("/rf_dw/signals")
async def rf_dw_signals(user: dict = Depends(get_current_user)):
    """Current RF [DW] 3m state for all scanned crypto symbols."""
    from agents.rf_dw_agent import SCAN_SYMBOLS
    result = {}
    for sym in SCAN_SYMBOLS:
        data = state.get(f"/rf_dw/crypto/{sym}")
        if data:
            result[sym] = data
    return {"timestamp": datetime.now(timezone.utc).isoformat(), "signals": result}


# ─── Stock Screener ───────────────────────────────────────────────

@app.get("/screener/results")
async def screener_results(
    market: str = "all",
    background_tasks: BackgroundTasks = None,
    user: dict = Depends(get_current_user),
):
    """
    Return pre-computed screener category buckets.
    Priority: Redis (hot) → Supabase DB (warm, survives restarts) → scan sentinel.
    Never blocks — always returns immediately with existing data.
    market: 'india' | 'crypto' | 'all'
    """
    # 1. State-store hot path (sub-ms, 24h TTL)
    cached = state.get("/screener/results")
    if cached and cached.get("market") in (market, "all"):
        return cached

    # 2. Supabase DB fallback — survives restarts.
    # Scan always saves as market="all"; try exact match first, then "all".
    try:
        from agents.screener_agent import _load_screener_from_db
        db_result = _load_screener_from_db(market) or _load_screener_from_db("all")
        if db_result:
            state.set("/screener/results", db_result, ttl=86400)
            state.set("/screener/last_scan", db_result.get("last_scan", ""), ttl=86400)
            logger.info("Screener: served from DB snapshot (state was cold)")
            return db_result
    except Exception as _db_err:
        logger.warning(f"Screener DB fallback error: {_db_err}")

    # 3. Nothing anywhere — trigger background scan, return scanning sentinel
    if background_tasks is not None and not _screener_scanning:
        background_tasks.add_task(_agent_screener_scan)
    return {
        "scanning":      True,
        "categories":    {},
        "total_scanned": 0,
        "last_scan":     None,
        "market":        market,
    }


@app.post("/screener/refresh")
async def screener_refresh(
    market: str = "all",
    user: dict = Depends(get_current_user),
):
    """Trigger an immediate screener re-scan (rate-limited to 1/minute per user)."""
    last_key = f"/screener/refresh/{user['id']}"
    last = state.get(last_key)
    if last:
        raise HTTPException(status_code=429, detail="Refresh limited to once per minute")
    state.set(last_key, True, ttl=60)
    try:
        from agents.screener_agent import run_screener_scan
        result = await run_screener_scan(market)
        return result
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


# ─── Phase 5: Intraday Screener endpoint ─────────────────────────

async def _agent_intraday_screener_force() -> None:
    """Force intraday screener scan regardless of market hours (for on-demand trigger)."""
    global _intraday_scanning
    if _intraday_scanning:
        return
    _intraday_scanning = True
    try:
        logger.info("━━ AGENT: Intraday Screener [Force] ━━")
        from agents.screener_agent import run_intraday_screener_scan
        await run_intraday_screener_scan()
        state.set("/scheduler/last_run/intraday_screener", _ist_now_str(), ttl=86400)
        await manager.broadcast({"type": "intraday_screener_updated", "last_scan": _ist_now_str()})
    except Exception as e:
        logger.error(f"Intraday screener (force) failed: {e}")
    finally:
        _intraday_scanning = False


@app.get("/screener/intraday")
async def intraday_screener(
    background_tasks: BackgroundTasks = None,
    user: dict = Depends(get_current_user),
):
    """
    Real-time intraday screener — 5-min/15-min based categories.
    Refreshes every 15 min during market hours.
    Falls back to the most recent DB snapshot when state-store is cold.
    """
    cached = state.get("/screener/intraday")
    if cached:
        return cached

    # Fallback: read the most recent scan from Supabase (survives restarts)
    try:
        db = admin_client()
        result = db.table("intraday_screener_results") \
            .select("scanned_at,total_scanned,last_scan,categories") \
            .order("scanned_at", desc=True).limit(1).execute()
        if result.data:
            row = result.data[0]
            db_snap = {
                "timestamp":     row["scanned_at"],
                "last_scan":     row["last_scan"],
                "market":        "india",
                "total_scanned": row["total_scanned"],
                "categories":    row["categories"],
                "from_db":       True,
            }
            state.set("/screener/intraday", db_snap, ttl=900)
            return db_snap
    except Exception as e:
        logger.debug(f"Intraday DB read failed: {e}")

    # Nothing in DB — trigger a background scan if market hours
    if background_tasks is not None and not _intraday_scanning:
        background_tasks.add_task(_agent_intraday_screener)
    return {
        "scanning":      True,
        "categories":    {},
        "total_scanned": 0,
        "last_scan":     None,
        "market":        "india",
    }


@app.post("/screener/intraday/refresh")
async def intraday_refresh(
    background_tasks: BackgroundTasks,
    user: dict = Depends(get_current_user),
):
    """Trigger an immediate intraday screener scan (rate-limited 1/min per user)."""
    last_key = f"/screener/intraday/refresh/{user['id']}"
    if state.get(last_key):
        raise HTTPException(status_code=429, detail="Refresh limited to once per minute")
    if _intraday_scanning:
        return {"status": "already_running"}
    state.set(last_key, True, ttl=60)
    background_tasks.add_task(_agent_intraday_screener_force)
    return {"status": "triggered", "message": "Intraday scan started"}


@app.post("/market/deals/refresh")
async def deals_refresh(
    background_tasks: BackgroundTasks,
    user: dict = Depends(get_current_user),
):
    """Trigger an immediate block/bulk deals fetch (rate-limited 1/min per user)."""
    last_key = f"/market/deals/refresh/{user['id']}"
    if state.get(last_key):
        raise HTTPException(status_code=429, detail="Refresh limited to once per minute")
    state.set(last_key, True, ttl=60)
    background_tasks.add_task(_agent_block_deals, 0)
    return {"status": "triggered", "message": "Block deals fetch started"}


@app.post("/market/events/refresh")
async def events_refresh(
    background_tasks: BackgroundTasks,
    user: dict = Depends(get_current_user),
):
    """Trigger an immediate corporate events calendar fetch (rate-limited 1/min per user)."""
    last_key = f"/market/events/refresh/{user['id']}"
    if state.get(last_key):
        raise HTTPException(status_code=429, detail="Refresh limited to once per minute")
    state.set(last_key, True, ttl=60)
    background_tasks.add_task(_agent_events_calendar)
    return {"status": "triggered", "message": "Events calendar fetch started"}


@app.post("/market/insider-trades/refresh")
async def insider_refresh(
    background_tasks: BackgroundTasks,
    user: dict = Depends(get_current_user),
):
    """Trigger an immediate insider trades fetch (rate-limited 1/min per user)."""
    last_key = f"/market/insider/refresh/{user['id']}"
    if state.get(last_key):
        raise HTTPException(status_code=429, detail="Refresh limited to once per minute")
    state.set(last_key, True, ttl=60)
    background_tasks.add_task(_agent_insider_monitor)
    return {"status": "triggered", "message": "Insider trades fetch started"}


# ─── Confirmation Signals [Simple] current state ─────────────────

@app.get("/conf_simple/signals")
async def conf_simple_signals(user: dict = Depends(get_current_user)):
    """Current Confirmation Signals [Simple] 5m state for all scanned crypto symbols."""
    from agents.conf_simple_agent import SCAN_SYMBOLS
    result = {}
    for sym in SCAN_SYMBOLS:
        data = state.get(f"/conf_simple/crypto/{sym}")
        if data:
            result[sym] = data
    return {"timestamp": datetime.now(timezone.utc).isoformat(), "signals": result}


@app.post("/rf_dw/refresh")
async def rf_dw_refresh(user: dict = Depends(get_current_user)):
    """Trigger an immediate RF[DW] scan (rate-limited to 1/minute per user)."""
    last_key = f"/rf_dw/refresh/{user['id']}"
    if state.get(last_key):
        raise HTTPException(status_code=429, detail="Refresh limited to once per minute")
    state.set(last_key, True, ttl=60)
    try:
        from agents.rf_dw_agent import run_rf_dw_scan
        result = await run_rf_dw_scan()
        return result
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/conf_simple/refresh")
async def conf_simple_refresh(user: dict = Depends(get_current_user)):
    """Trigger an immediate Conf Signals scan (rate-limited to 1/minute per user)."""
    last_key = f"/conf_simple/refresh/{user['id']}"
    if state.get(last_key):
        raise HTTPException(status_code=429, detail="Refresh limited to once per minute")
    state.set(last_key, True, ttl=60)
    try:
        from agents.conf_simple_agent import run_conf_simple_scan
        result = await run_conf_simple_scan()
        return result
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


# ─── EMA Cross 9/15 endpoints ─────────────────────────────────────

@app.get("/ema_cross/signals", tags=["ema_cross"])
async def ema_cross_signals(user: dict = Depends(get_current_user)):
    """
    Current 9/15 EMA Crossover state for all scanned crypto symbols.

    Returns per-symbol trade decision (action, entry, SL, TP, regime, confidence)
    plus a list of recently fired signals.
    """
    from agents.ema_cross_agent import SCAN_SYMBOLS
    per_symbol = {}
    for sym in SCAN_SYMBOLS:
        data = state.get(f"/ema_cross/crypto/{sym}")
        if data:
            per_symbol[sym] = data
    recent = state.get("/ema_cross/signals") or []
    return {
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "signals":   per_symbol,
        "recent_fired": recent[:20],
    }


@app.post("/ema_cross/refresh", tags=["ema_cross"])
async def ema_cross_refresh(user: dict = Depends(get_current_user)):
    """Trigger an immediate EMA Cross scan (rate-limited to 1 per 5 minutes per user)."""
    last_key = f"/ema_cross/refresh/{user['id']}"
    if state.get(last_key):
        raise HTTPException(status_code=429, detail="EMA Cross refresh limited to once per 5 minutes")
    state.set(last_key, True, ttl=300)
    try:
        from agents.ema_cross_agent import run_ema_cross_scan
        result = await run_ema_cross_scan()
        return {"timestamp": datetime.now(timezone.utc).isoformat(), "scanned": len(result)}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


# ─── Price Alerts ─────────────────────────────────────────────────

import uuid as _uuid

class AlertCreate(BaseModel):
    symbol:       str
    target_price: float
    direction:    str   # 'above' | 'below'

@app.get("/alerts")
async def get_alerts(user: dict = Depends(get_current_user)):
    """Return all price alerts for the current user."""
    alerts = state.get(f"/alerts/{user['id']}") or []
    return {"alerts": alerts}

@app.post("/alerts", status_code=201)
async def create_alert(body: AlertCreate, user: dict = Depends(get_current_user)):
    """Create a new price alert for the current user."""
    if body.direction not in ("above", "below"):
        raise HTTPException(status_code=400, detail="direction must be 'above' or 'below'")
    alerts: list = state.get(f"/alerts/{user['id']}") or []
    new_alert = {
        "id":           str(_uuid.uuid4()),
        "symbol":       body.symbol.upper().strip(),
        "target_price": body.target_price,
        "direction":    body.direction,
        "triggered":    False,
        "created_at":   datetime.now(timezone.utc).isoformat(),
    }
    alerts.append(new_alert)
    state.set(f"/alerts/{user['id']}", alerts, ttl=86400 * 30)  # 30 days TTL
    return new_alert

@app.delete("/alerts/{alert_id}")
async def delete_alert(alert_id: str, user: dict = Depends(get_current_user)):
    """Delete a price alert by ID."""
    alerts: list = state.get(f"/alerts/{user['id']}") or []
    updated = [a for a in alerts if a.get("id") != alert_id]
    if len(updated) == len(alerts):
        raise HTTPException(status_code=404, detail="Alert not found")
    state.set(f"/alerts/{user['id']}", updated, ttl=86400 * 30)
    return {"deleted": alert_id}


# ─── Trading Bots ─────────────────────────────────────────────────

class BotCreate(BaseModel):
    name: str
    market: str = "india"               # india | crypto
    signal_source: str = "signal_pipeline"  # signal_pipeline | rf_dw | screener | conf_simple | ema_cross | tv_webhook | chartink | custom_conditions
    enabled: bool = False
    # Filters
    min_conviction: str = "HIGH"        # HIGH | MEDIUM | LOW
    min_score: float = 6.5
    verdicts: list[str] = ["GO"]
    screener_categories: list[str] = ["bullish_breakout"]
    symbols: list[str] = []             # empty = all (for rf_dw / conf_simple)
    # Position sizing
    capital_pct: float = 1.0            # % of capital_inr per trade
    capital_inr: float = 100000.0
    max_position_inr: float = 50000.0
    order_type: str = "MARKET"
    product: str = "CNC"                # CNC | MIS | PERPETUAL | QUARTERLY
    # Crypto futures
    leverage: float = 1.0              # 1–100× (applied before placing Delta order)
    margin_mode: str = "isolated"      # isolated | cross
    # Risk
    max_daily_trades: int = 5
    max_open_positions: int = 3
    max_daily_loss_inr: float = 5000.0
    cooldown_minutes: int = 5
    # Exit
    use_signal_targets: bool = True
    custom_target_pct: float = 5.0
    custom_sl_pct: float = 2.0
    trailing_stop: bool = False
    # EMA Cross overrides (ema_cross signal_source only)
    atr_sl_mult: float = 1.5   # ATR stop multiplier  (1.0–2.5)
    atr_tp_mult: float = 3.0   # ATR target multiplier (2.0–5.0)
    # TradingView Webhook (tv_webhook signal_source only)
    tv_webhook_token: str = ""
    tv_indicator_name: str = "Custom Strategy"
    # Chartink (chartink signal_source only)
    chartink_token: str = ""
    chartink_scan_name: str = ""
    # Custom Conditions (custom_conditions signal_source only)
    custom_conditions: list[dict] = []
    custom_conditions_logic: str = "AND"   # AND | OR
    custom_conditions_side: str = "BUY"    # BUY | SELL


class BotToggleBody(BaseModel):
    enabled: bool


# ─── Bot persistence helpers ─────────────────────────────────────────────────
# Bot CONFIGS are persisted to Supabase (user_configs.bots) so they survive
# server restarts and TTL expiry. Runtime state (stats, last_execution_ts)
# is merged from the state store on top of the Supabase snapshot.

_BOT_STATE_KEYS = {
    "state", "stats", "last_execution", "last_execution_ts", "last_signal_id",
    "error_count", "last_error", "last_error_ts", "first_error_ts", "disabled_reason",
}

# ─── Webhook token helpers ────────────────────────────────────────────────────

def _generate_wh_token() -> str:
    return secrets.token_urlsafe(32)


def _register_wh_token(source: str, token: str, uid: str, bot_id: str) -> None:
    """Cache token→{uid, bot_id} in Redis with no TTL so it survives bot restarts."""
    state.set(f"/wh_token/{source}/{token}", {"uid": uid, "bot_id": bot_id}, ttl=0)


def _revoke_wh_token(source: str, token: str) -> None:
    if token:
        state.delete(f"/wh_token/{source}/{token}")


# ─── Custom-condition evaluation helpers ─────────────────────────────────────

_COND_INDICATOR_PATHS: dict[str, list[str]] = {
    "rsi":                  ["rsi", "RSI", "rsi_14"],
    "adx":                  ["adx", "ADX", "adx_14"],
    "volume_ratio":         ["volume_ratio", "vol_ratio"],
    "technical_score":      ["technical_score", "score", "overall_score"],
    "atr":                  ["atr", "ATR"],
    "ema20":                ["ema20", "ema_20", "EMA20"],
    "ema50":                ["ema50", "ema_50", "EMA50"],
    "ema200":               ["ema200", "ema_200", "EMA200"],
    "price_vs_ema50_pct":   ["price_vs_ema50_pct", "pct_above_ema50"],
    "price_vs_ema200_pct":  ["price_vs_ema200_pct", "pct_above_ema200"],
}


def _get_indicator_value(data: dict, indicator: str) -> float | None:
    paths = _COND_INDICATOR_PATHS.get(indicator, [indicator])
    for key in paths:
        if key in data:
            try:
                return float(data[key])
            except (TypeError, ValueError):
                pass
    return None


def _eval_condition(value: float, op: str, threshold: float) -> bool:
    return {
        "gt":  value >  threshold,
        "gte": value >= threshold,
        "lt":  value <  threshold,
        "lte": value <= threshold,
        "eq":  abs(value - threshold) < 0.001,
    }.get(op, False)


def _load_bots(uid: str) -> list:
    """
    Load bots for a user, merging persisted Supabase config with live state-store
    runtime fields. Falls back gracefully if either source is unavailable.
    """
    # 1. Supabase: authoritative bot configs (survive restarts)
    db_bots: list = []
    try:
        rec = (
            admin_client()
            .table("user_configs")
            .select("bots")
            .eq("user_id", uid)
            .limit(1)
            .execute()
        )
        if rec.data and rec.data[0].get("bots"):
            raw = rec.data[0]["bots"]
            db_bots = raw if isinstance(raw, list) else []
    except Exception as e:
        logger.warning(f"_load_bots: Supabase read failed for {uid}: {e}")

    # 2. State store: live runtime fields (stats, last_execution, etc.)
    state_bots: list = state.get(f"/bots/{uid}") or []
    state_index = {b["id"]: b for b in state_bots if b.get("id")}

    # 3. Merge: Supabase config + state-store runtime overlay
    merged = []
    for bot in db_bots:
        live = state_index.get(bot["id"], {})
        merged.append({**bot, **{k: v for k, v in live.items() if k in _BOT_STATE_KEYS}})

    # 4. If Supabase is empty but state store has bots, use state store (migration path)
    if not merged and state_bots:
        merged = state_bots

    return merged


_BOTS_COL_MISSING: bool = False   # module-level flag; set True when column is absent


def _save_bots(uid: str, bots: list) -> None:
    """
    Persist bots to BOTH Supabase (config) and state store (runtime cache).
    Config keys go to Supabase; all keys go to the state store for the bot cycle.
    """
    global _BOTS_COL_MISSING

    # Write full list to state store (runtime cache, 30-day TTL so restarts survive)
    state.set(f"/bots/{uid}", bots, ttl=2_592_000)

    # Strip runtime-only fields before writing to Supabase
    config_bots = [{k: v for k, v in b.items() if k not in _BOT_STATE_KEYS or k in ("state",)} for b in bots]
    try:
        db = admin_client()
        existing = db.table("user_configs").select("id").eq("user_id", uid).execute()
        if existing.data:
            db.table("user_configs").update({"bots": config_bots}).eq("user_id", uid).execute()
        else:
            db.table("user_configs").upsert(
                {"user_id": uid, "bots": config_bots}, on_conflict="user_id"
            ).execute()
        _BOTS_COL_MISSING = False   # write succeeded — column exists
    except Exception as e:
        err_str = str(e).lower()
        if "bots" in err_str and ("column" in err_str or "does not exist" in err_str):
            _BOTS_COL_MISSING = True
            logger.error(
                "MIGRATION NEEDED — user_configs.bots column is missing.\n"
                "Run this SQL in your Supabase SQL Editor:\n"
                "  ALTER TABLE public.user_configs\n"
                "  ADD COLUMN IF NOT EXISTS bots JSONB DEFAULT '[]'::jsonb;\n"
                "Bots are cached in Redis only until the migration is applied."
            )
        else:
            logger.error(
                f"_save_bots: Supabase write failed for {uid}: {e}. "
                "Bots cached in Redis — will survive restarts if Upstash is configured."
            )


@app.get("/bots")
async def list_bots(user: dict = Depends(get_current_user)):
    """Return all trading bots for the current user."""
    bots = _load_bots(user["id"])
    resp: dict = {"bots": bots}
    if _BOTS_COL_MISSING:
        resp["migration_needed"] = (
            "ALTER TABLE public.user_configs "
            "ADD COLUMN IF NOT EXISTS bots JSONB DEFAULT '[]'::jsonb;"
        )
    return resp


@app.post("/bots", status_code=201)
async def create_bot(body: BotCreate, user: dict = Depends(get_current_user)):
    """Create a new trading bot configuration."""
    uid = user["id"]
    bots = _load_bots(uid)
    if len(bots) >= 10:
        raise HTTPException(status_code=400, detail="Maximum 10 bots per user")
    bot = body.model_dump()
    bot_id = str(_uuid.uuid4())
    bot.update({
        "id":              bot_id,
        "created_at":      datetime.now(timezone.utc).isoformat(),
        "state":           "IDLE",
        "stats":           {"trades_today": 0, "pnl_today": 0.0, "total_trades": 0, "wins": 0},
        "last_execution":  None,
        "last_signal_id":  None,
        "last_execution_ts": None,
    })
    # Auto-generate webhook tokens for sources that need them
    if bot.get("signal_source") == "tv_webhook" and not bot.get("tv_webhook_token"):
        token = _generate_wh_token()
        bot["tv_webhook_token"] = token
        _register_wh_token("tv", token, uid, bot_id)
    elif bot.get("signal_source") == "chartink" and not bot.get("chartink_token"):
        token = _generate_wh_token()
        bot["chartink_token"] = token
        _register_wh_token("chartink", token, uid, bot_id)
    bots.append(bot)
    _save_bots(uid, bots)
    return bot


@app.put("/bots/{bot_id}")
async def update_bot(bot_id: str, body: BotCreate, user: dict = Depends(get_current_user)):
    """Update an existing bot configuration."""
    uid = user["id"]
    bots = _load_bots(uid)
    for i, b in enumerate(bots):
        if b["id"] == bot_id:
            preserved = {k: b.get(k) for k in
                         ["id", "created_at", "state", "stats", "last_execution",
                          "last_signal_id", "last_execution_ts"]}
            updated = body.model_dump()
            updated.update(preserved)
            new_source = updated.get("signal_source")
            # Preserve existing tokens; generate if source changed and token absent
            if new_source == "tv_webhook":
                existing_token = b.get("tv_webhook_token") or updated.get("tv_webhook_token") or ""
                if not existing_token:
                    existing_token = _generate_wh_token()
                    _register_wh_token("tv", existing_token, uid, bot_id)
                updated["tv_webhook_token"] = existing_token
            elif new_source == "chartink":
                existing_token = b.get("chartink_token") or updated.get("chartink_token") or ""
                if not existing_token:
                    existing_token = _generate_wh_token()
                    _register_wh_token("chartink", existing_token, uid, bot_id)
                updated["chartink_token"] = existing_token
            bots[i] = updated
            _save_bots(uid, bots)
            return updated
    raise HTTPException(status_code=404, detail="Bot not found")


@app.post("/bots/{bot_id}/toggle")
async def toggle_bot(bot_id: str, body: BotToggleBody, user: dict = Depends(get_current_user)):
    """Enable or disable a trading bot."""
    uid = user["id"]
    bots = _load_bots(uid)
    for b in bots:
        if b["id"] == bot_id:
            b["enabled"] = body.enabled
            b["state"] = "IDLE" if body.enabled else "PAUSED"
            # Re-enabling: clear all error/disable state so the bot starts fresh
            if body.enabled:
                b["disabled_reason"] = None
                b["error_count"]     = 0
                b["last_error"]      = None
                b["last_error_ts"]   = None
                b["first_error_ts"]  = None
            _save_bots(uid, bots)
            return b
    raise HTTPException(status_code=404, detail="Bot not found")


@app.delete("/bots/{bot_id}", status_code=204)
async def delete_bot(bot_id: str, user: dict = Depends(get_current_user)):
    """Delete a trading bot."""
    uid = user["id"]
    bots = _load_bots(uid)
    to_delete = next((b for b in bots if b["id"] == bot_id), None)
    if to_delete is None:
        raise HTTPException(status_code=404, detail="Bot not found")
    # Revoke webhook tokens from Redis so stale tokens stop working
    _revoke_wh_token("tv", to_delete.get("tv_webhook_token", ""))
    _revoke_wh_token("chartink", to_delete.get("chartink_token", ""))
    _save_bots(uid, [b for b in bots if b["id"] != bot_id])


@app.get("/bots/executions")
async def get_bot_executions(user: dict = Depends(get_current_user)):
    """Return last 100 executions across all bots for this user."""
    execs = state.get(f"/bot_executions/{user['id']}") or []
    return {"executions": execs[:100]}


@app.get("/bots/{bot_id}/webhook-info")
async def get_bot_webhook_info(bot_id: str, request: Request, user: dict = Depends(get_current_user)):
    """Return webhook URL, token, and sample payload for tv_webhook / chartink bots."""
    bots = _load_bots(user["id"])
    bot = next((b for b in bots if b["id"] == bot_id), None)
    if not bot:
        raise HTTPException(status_code=404, detail="Bot not found")
    source = bot.get("signal_source")
    base = str(request.base_url).rstrip("/")
    if source == "tv_webhook":
        token = bot.get("tv_webhook_token", "")
        if not token:
            raise HTTPException(status_code=400, detail="No webhook token — re-save the bot to generate one")
        return {
            "source":        "tv_webhook",
            "webhook_url":   f"{base}/webhook/tv/{token}",
            "token":         token,
            "sample_payload": {"action": "buy", "ticker": "{{ticker}}", "price": "{{close}}"},
            "pine_template": (
                'strategy("My Strategy", overlay=true)\n'
                'longCondition = ta.crossover(ta.ema(close,9), ta.ema(close,21))\n'
                'shortCondition = ta.crossunder(ta.ema(close,9), ta.ema(close,21))\n'
                'if longCondition\n'
                f'    alert(\'{{"action":"buy","ticker":"{{{{ticker}}}}","price":"{{{{close}}}}"}}\')\n'
                'if shortCondition\n'
                f'    alert(\'{{"action":"sell","ticker":"{{{{ticker}}}}","price":"{{{{close}}}}"}}\')'
            ),
            "alert_message": '{"action":"buy","ticker":"{{ticker}}","price":"{{close}}"}',
            "alert_webhook": f"{base}/webhook/tv/{token}",
        }
    elif source == "chartink":
        token = bot.get("chartink_token", "")
        if not token:
            raise HTTPException(status_code=400, detail="No webhook token — re-save the bot to generate one")
        return {
            "source":        "chartink",
            "webhook_url":   f"{base}/webhook/chartink/user/{token}",
            "token":         token,
            "sample_payload": {
                "stocks":          "RELIANCE,TCS,INFY",
                "trigger_prices":  "2300.50,3400.00,1500.75",
                "scan_name":       "My Scan",
            },
            "setup_guide": (
                "1. Open your Chartink scan → Edit → Add Webhook\n"
                f"2. Paste URL: {base}/webhook/chartink/user/{token}\n"
                "3. Select POST method\n"
                "4. Enable webhook on the scan page\n"
                "5. Chartink fires on each new scan match"
            ),
        }
    raise HTTPException(status_code=400, detail="Bot does not use a webhook signal source (tv_webhook or chartink)")


@app.post("/bots/{bot_id}/regenerate-token")
async def regenerate_bot_token(bot_id: str, user: dict = Depends(get_current_user)):
    """Generate a new webhook token for this bot, invalidating the old one."""
    uid = user["id"]
    bots = _load_bots(uid)
    for i, b in enumerate(bots):
        if b["id"] != bot_id:
            continue
        source = b.get("signal_source")
        if source == "tv_webhook":
            _revoke_wh_token("tv", b.get("tv_webhook_token", ""))
            new_token = _generate_wh_token()
            b["tv_webhook_token"] = new_token
            _register_wh_token("tv", new_token, uid, bot_id)
        elif source == "chartink":
            _revoke_wh_token("chartink", b.get("chartink_token", ""))
            new_token = _generate_wh_token()
            b["chartink_token"] = new_token
            _register_wh_token("chartink", new_token, uid, bot_id)
        else:
            raise HTTPException(status_code=400, detail="Bot does not use a webhook source")
        bots[i] = b
        _save_bots(uid, bots)
        return {"token": new_token}
    raise HTTPException(status_code=404, detail="Bot not found")


class BotForceBody(BaseModel):
    symbol:  str
    side:    str          # BUY | SELL
    qty:     int = 1
    price:   Optional[float] = None   # None → use last market price


@app.post("/bots/{bot_id}/execute", tags=["bots"])
async def force_bot_execute(
    bot_id: str,
    body: BotForceBody,
    user: dict = Depends(get_current_user),
):
    """
    Immediately place a trade for this bot outside the normal 5-second cycle.
    Useful for manual trigger, testing, and latency benchmarking.
    The bot must be enabled; kill switches are still respected.
    """
    uid  = user["id"]
    bots = _load_bots(uid)
    bot  = next((b for b in bots if b["id"] == bot_id), None)
    if bot is None:
        raise HTTPException(status_code=404, detail="Bot not found")
    if not bot.get("enabled"):
        raise HTTPException(status_code=400, detail="Bot is disabled — enable it first")

    risk = state.get("/risk") or {}
    if risk.get("soft_kill") or risk.get("hard_kill"):
        raise HTTPException(status_code=503, detail="Risk kill switch active — trading halted")

    market = bot.get("market", "crypto")
    symbol = body.symbol.upper()
    side   = body.side.upper()
    qty    = max(1, body.qty)

    # Resolve price: use supplied price or fall back to last market data
    price = body.price
    if not price or price <= 0:
        mkt   = state.read_market_data(market, symbol) or {}
        price = float(mkt.get("ltp") or mkt.get("price") or 0)
    if not price or price <= 0:
        raise HTTPException(status_code=422, detail=f"No price available for {symbol}; supply price explicitly")

    import time as _time
    t0 = _time.monotonic()

    broker_result = await _try_broker_order(uid, bot, symbol, market, side, qty, price)

    elapsed_ms = round((_time.monotonic() - t0) * 1000, 1)

    if not broker_result["ok"]:
        raise HTTPException(status_code=502, detail=broker_result["error"])

    paper        = broker_result.get("paper", False)
    exec_status  = "SIMULATED" if paper else "PLACED"

    execution = {
        "id":            str(_uuid.uuid4()),
        "bot_id":        bot_id,
        "bot_name":      bot.get("name", ""),
        "symbol":        symbol,
        "side":          side,
        "qty":           qty,
        "price":         price,
        "market":        market,
        "signal_source": "manual",
        "verdict":       "MANUAL",
        "conviction":    "MANUAL",
        "score":         None,
        "ts":            datetime.now(timezone.utc).isoformat(),
        "status":        exec_status,
        "elapsed_ms":    elapsed_ms,
        "pnl":           None,
    }
    execs: list = state.get(f"/bot_executions/{uid}") or []
    execs.insert(0, execution)
    state.set(f"/bot_executions/{uid}", execs[:200])

    # Update bot stats
    stats = bot.get("stats") or {}
    stats["trades_today"]  = stats.get("trades_today", 0) + 1
    stats["total_trades"]  = stats.get("total_trades", 0) + 1
    bot["stats"]           = stats
    bot["state"]           = "IN_POSITION"
    bot["last_execution"]  = execution
    bot["last_execution_ts"] = execution["ts"]
    _save_bots(uid, bots)

    await manager.send_to_user(uid, {
        "type":       "bot_execution",
        "bot_id":     bot_id,
        "bot_name":   bot.get("name"),
        "symbol":     symbol,
        "side":       side,
        "qty":        qty,
        "price":      price,
        "status":     exec_status,
        "elapsed_ms": elapsed_ms,
        "ts":         execution["ts"],
    })

    logger.info(f"⚡ Manual trade: {side} {qty}× {symbol} @ {price} [{exec_status}] in {elapsed_ms}ms")
    return {
        "status":     exec_status,
        "execution":  execution,
        "elapsed_ms": elapsed_ms,
        "paper":      paper,
    }


# ─── Signal-flip helper ───────────────────────────────────────────────────────

async def _close_conflicting_position(
    uid: str, bot: dict, symbol: str, market: str, new_side: str
) -> bool:
    """
    Before a reversal trade fires, close any existing opposite-direction position
    for the same symbol+market.

    Checks two sources:
      • bot["last_execution"] + bot["state"] == "IN_POSITION"  (bot-tracked)
      • state.read_position(market, symbol)                     (state-store)

    On conflict:
      1. Closes the position via broker (Delta for crypto, Groww market order for India)
      2. Marks the source Supabase signal as CLOSED (best-effort, skips synthetic IDs)
      3. Removes position from state store
      4. Records a REVERSAL_CLOSE entry in /bot_executions
      5. Sends a "position_reversal" WS notification
      6. Resets bot.state → IDLE so the new trade can proceed

    Returns True if a conflict was found (regardless of broker call success).
    Broker failures are non-fatal — state cleanup still happens.
    """
    opposite_side = "SELL" if new_side == "BUY" else "BUY"
    opposite_dir  = "SHORT" if new_side == "BUY" else "LONG"

    last_exec = bot.get("last_execution") or {}
    bot_has_conflict = (
        bot.get("state") == "IN_POSITION"
        and last_exec.get("symbol") == symbol
        and last_exec.get("side") == opposite_side
    )

    state_pos = state.read_position(market, symbol)
    state_has_conflict = (
        state_pos is not None
        and state_pos.get("direction", "LONG") == opposite_dir
    )

    if not (bot_has_conflict or state_has_conflict):
        return False

    qty = last_exec.get("qty") or (state_pos or {}).get("qty") or 0
    logger.info(
        f"🔄 Bot '{bot.get('name')}': signal flip — "
        f"closing {opposite_side} {symbol} before entering {new_side}"
    )

    # ── 1. Close via broker (best-effort) ─────────────────────────
    try:
        from data.broker_factory import build_delta_client, build_groww_client

        cfg = await _get_broker_cfg(uid)

        if market == "crypto":
            dc = build_delta_client(cfg)
            if dc is None:
                from data.delta_client import delta_rest as _delta_singleton
                dc = _delta_singleton
            products = await asyncio.to_thread(dc.get_products)
            prod_map  = {p["symbol"]: p["id"] for p in products}
            candidates = [symbol, f"{symbol}USD", symbol.replace("USD", "USDT"), f"{symbol}USDT"]
            pid = next((prod_map[c] for c in candidates if c in prod_map), None)
            if pid:
                await asyncio.to_thread(dc.close_position, pid)
                logger.info(f"✅ Reversal broker close sent: {symbol} (pid={pid})")
            else:
                logger.warning(f"Reversal: no Delta product found for {symbol} — state cleanup only")
        else:
            # India equity: place offsetting MARKET order to flatten
            gc = build_groww_client(cfg)
            if gc is None:
                from data.groww_client import groww as _groww_singleton
                gc = _groww_singleton
            if qty > 0:
                await asyncio.to_thread(
                    gc.place_equity_order,
                    symbol, int(qty), opposite_side, "MARKET", None,
                )  # SELL to close LONG, BUY to close SHORT
    except Exception as e:
        logger.warning(f"Reversal broker close failed for {symbol}: {e} — continuing with cleanup")

    # ── 2. Mark source Supabase signal as closed (best-effort) ────
    old_sig_id = bot.get("last_signal_id") or ""
    if old_sig_id and not old_sig_id.startswith(("rf_", "cs_", "scr_")):
        try:
            admin_client().table("signals").update({
                "outcome":   "CLOSED",
                "closed_at": datetime.now(timezone.utc).isoformat(),
            }).eq("signal_id", old_sig_id).execute()
        except Exception:
            pass

    # ── 3. State store cleanup ─────────────────────────────────────
    state.delete_position(market, symbol)

    # ── 4. Record REVERSAL_CLOSE in execution log ──────────────────
    close_exec = {
        "id":            str(_uuid.uuid4()),
        "bot_id":        bot["id"],
        "bot_name":      bot.get("name", ""),
        "symbol":        symbol,
        "side":          opposite_side,
        "qty":           qty,
        "price":         last_exec.get("price") or (state_pos or {}).get("current_price") or 0,
        "market":        market,
        "signal_source": "reversal",
        "verdict":       "REVERSAL_CLOSE",
        "conviction":    "AUTO",
        "score":         None,
        "ts":            datetime.now(timezone.utc).isoformat(),
        "status":        "REVERSAL_CLOSE",
        "pnl":           None,
    }
    execs: list = state.get(f"/bot_executions/{uid}") or []
    execs.insert(0, close_exec)
    state.set(f"/bot_executions/{uid}", execs[:200])

    # ── 5. WS notification ─────────────────────────────────────────
    await manager.send_to_user(uid, {
        "type":        "position_reversal",
        "bot_id":      bot["id"],
        "bot_name":    bot.get("name"),
        "symbol":      symbol,
        "closed_side": opposite_side,
        "new_side":    new_side,
        "ts":          close_exec["ts"],
    })

    # ── 6. Reset bot state so the new trade proceeds cleanly ───────
    bot["state"] = "IDLE"
    bot["last_signal_id"] = None

    return True


# ─── Per-user broker config cache ────────────────────────────────
# Avoids a Supabase round-trip + AES decrypt on every bot trade.
# TTL=30 s: short enough to pick up key rotations, long enough for burst orders.
_BROKER_CFG_CACHE: dict[str, tuple[float, dict]] = {}  # uid -> (ts, decrypted_cfg)
_BROKER_CFG_TTL = 30  # seconds


async def _get_broker_cfg(uid: str) -> dict:
    """Return decrypted broker config, served from in-process cache when fresh."""
    from core.security import decrypted_broker_config
    cached = _BROKER_CFG_CACHE.get(uid)
    if cached:
        ts, cfg = cached
        if time.time() - ts < _BROKER_CFG_TTL:
            return cfg
    rec = await asyncio.to_thread(
        lambda: admin_client()
            .table("user_configs")
            .select("*")
            .eq("user_id", uid)
            .limit(1)
            .execute()
    )
    cfg = decrypted_broker_config(rec.data[0] if rec.data else {})
    _BROKER_CFG_CACHE[uid] = (time.time(), cfg)
    return cfg


async def _try_broker_order(
    uid: str, bot: dict, symbol: str, market: str,
    side: str, qty: int, price: float,
    signal: dict = None,
) -> dict:
    """
    Attempt to place an order with the user's configured broker.
    Returns {"ok": True, "result": {...}, "paper": bool} or {"ok": False, "error": "..."}.
    Never raises. All blocking HTTP calls run in asyncio.to_thread so the
    event loop is never stalled — order latency is network-bound only.

    signal: the full signal dict (optional) — used to extract SL/TP for bracket orders.
    """
    try:
        from data.broker_factory import build_delta_client, build_groww_client

        cfg = await _get_broker_cfg(uid)
        order_type = (bot.get("order_type") or "MARKET").upper()

        if market == "crypto":
            dc = build_delta_client(cfg)
            if dc is None:
                # No personal keys — use platform live singleton (PAPER_TRADING=false)
                from data.delta_client import delta_rest as _delta_singleton
                dc = _delta_singleton

            # products are cached inside DeltaRestClient (5-min TTL) — near-zero cost
            products = await asyncio.to_thread(dc.get_products)
            prod_map  = {p["symbol"]: p["id"] for p in products}
            candidates = [symbol, f"{symbol}USD", symbol.replace("USD", "USDT"), f"{symbol}USDT"]
            pid = next((prod_map[c] for c in candidates if c in prod_map), None)
            if not pid:
                return {"ok": False, "error": f"No Delta product found for '{symbol}'"}

            leverage = float(bot.get("leverage") or 1.0)
            if leverage > 1.0:
                try:
                    await asyncio.to_thread(dc.set_leverage, pid, leverage)
                except Exception as lev_err:
                    logger.warning(f"set_leverage({leverage}×) failed for {symbol}: {lev_err}")

            # Extract SL/TP from signal for bracket order (native Delta SL/TP management)
            sig_sl = float(signal.get("stop_loss") or 0) if signal else 0
            sig_tp = float(signal.get("target_1") or signal.get("take_profit") or 0) if signal else 0

            if order_type == "MARKET":
                # Market order: fills immediately at best price, no limit_price needed
                result = await asyncio.to_thread(
                    dc.place_order,
                    pid, side.lower(), qty, "market_order",
                    None, sig_sl or None, sig_tp or None,
                )
            else:
                # Limit order: use last traded price as limit
                result = await asyncio.to_thread(
                    dc.place_order,
                    pid, side.lower(), qty, "limit_order",
                    price, sig_sl or None, sig_tp or None,
                )

            logger.info(
                f"Delta order result: id={result.get('id')} "
                f"state={result.get('state')} "
                f"avg_px={result.get('average_fill_price', '—')} "
                f"live={'NO (testnet)' if dc._paper else 'YES'}"
            )
            return {"ok": True, "result": result, "paper": dc._paper}

        else:
            gc = build_groww_client(cfg)
            if gc is None:
                from data.groww_client import groww as _groww_singleton
                gc = _groww_singleton
            groww_order_type = "MARKET" if order_type == "MARKET" else "LIMIT"
            result = await asyncio.to_thread(
                gc.place_equity_order,
                symbol, qty, side, groww_order_type,
                price if groww_order_type == "LIMIT" else None,
            )
            return {"ok": True, "result": result, "paper": bool(cfg.get("groww_paper", False))}

    except Exception as e:
        return {"ok": False, "error": str(e)[:200]}


# ─── Bot execution engine (runs every 5 s inside _global_push_task) ──

# Cache of all user IDs that have bots configured, refreshed every 5 minutes.
# Enables headless operation — bots execute even when no browser is open.
_headless_bot_users: set[str] = set()
_headless_bot_users_ts: float = 0.0


async def _refresh_headless_bot_users() -> None:
    """Query Supabase for all users with at least one enabled bot. Cache 5 min."""
    global _headless_bot_users, _headless_bot_users_ts
    import time as _time
    if _time.monotonic() - _headless_bot_users_ts < 300:
        return
    try:
        rows = (
            admin_client()
            .table("user_configs")
            .select("user_id, bots")
            .not_.is_("bots", "null")
            .execute()
        )
        active = set()
        for row in (rows.data or []):
            bots = row.get("bots") or []
            if any(b.get("enabled") for b in bots):
                active.add(row["user_id"])
        _headless_bot_users = active
        _headless_bot_users_ts = _time.monotonic()
        if active:
            logger.debug(f"Headless bot users refreshed: {len(active)} user(s) with enabled bots")
    except Exception as _hbu_err:
        logger.debug(f"_refresh_headless_bot_users error: {_hbu_err}")


async def _run_bot_cycle() -> None:
    """
    Check all enabled bots against latest signals; place orders when criteria met.
    Runs for BOTH connected WebSocket users AND headless users (browser closed).
    This ensures 24/7 automated execution regardless of whether the UI is open.
    """
    try:
        # Connected users — fast path (already authenticated via WS)
        async with manager._lock:
            connected_users = set(manager.active.values())

        # Headless users — refresh cache every 5 min, union with connected
        await _refresh_headless_bot_users()
        all_users = connected_users | _headless_bot_users

        # Global kill switches — check once, skip all users if active
        risk = state.get("/risk") or {}
        if risk.get("hard_kill"):
            return

        soft_killed = risk.get("soft_kill", False)

        for uid in all_users:
            bots: list = _load_bots(uid)
            enabled = [b for b in bots if b.get("enabled") and not soft_killed]
            if not enabled:
                continue

            dirty = False
            for bot in enabled:
                try:
                    fired = await _execute_bot_check(uid, bot)
                    if fired:
                        dirty = True
                except Exception as _be:
                    logger.warning(f"Bot {bot.get('id')} check error: {_be}")

            if dirty:
                # Runtime state update: state store only (avoid hammering Supabase every 5s)
                state.set(f"/bots/{uid}", bots, ttl=604_800)

    except Exception as _bce:
        logger.debug(f"_run_bot_cycle error: {_bce}")


async def _execute_bot_check(uid: str, bot: dict) -> bool:
    """Evaluate one bot against current signals. Return True if an order was placed."""
    source = bot.get("signal_source", "signal_pipeline")
    market = bot.get("market", "india")

    # Pre-flight: India bots require Groww to be connected
    if market == "india":
        try:
            from data.groww_client import groww as _gwc
            if not _gwc.is_connected:
                logger.debug(f"Bot '{bot.get('name')}': Groww not connected, skipping")
                return False
        except Exception:
            return False

    # Daily trade limit
    stats = bot.get("stats") or {}
    if stats.get("trades_today", 0) >= bot.get("max_daily_trades", 5):
        return False

    # Cooldown
    last_ts = bot.get("last_execution_ts")
    if last_ts:
        elapsed_min = (datetime.now(timezone.utc) - datetime.fromisoformat(last_ts)).total_seconds() / 60
        if elapsed_min < bot.get("cooldown_minutes", 5):
            return False

    signal = None

    # ── Signal Pipeline ───────────────────────────────────────────
    if source == "signal_pipeline":
        # Primary: /latest_signals/{market} — written by signal_pipeline after each run.
        # Fallback: /signals — legacy key kept for backward compat.
        raw = state.get(f"/latest_signals/{market}") or state.get("/signals") or {}
        signals = raw if isinstance(raw, list) else raw.get("signals", []) if isinstance(raw, dict) else []
        conv_rank = {"HIGH": 3, "MEDIUM": 2, "LOW": 1}
        min_rank = conv_rank.get(bot.get("min_conviction", "HIGH"), 3)
        for sig in signals:
            if sig.get("signal_id") == bot.get("last_signal_id"):
                continue
            if sig.get("verdict") not in bot.get("verdicts", ["GO"]):
                continue
            if conv_rank.get(sig.get("conviction", "LOW"), 1) < min_rank:
                continue
            score = sig.get("overall_score") or (sig.get("SCORE CARD") or {}).get("overall") or 0
            if float(score) < bot.get("min_score", 6.5):
                continue
            signal = {**sig, "side": "BUY" if (sig.get("bull_conviction") or 50) >= 50 else "SELL"}
            break

    # ── RF[DW] ────────────────────────────────────────────────────
    elif source == "rf_dw":
        from agents.rf_dw_agent import SCAN_SYMBOLS as _RF_SYMS
        watch_syms = bot.get("symbols") or _RF_SYMS
        # Pre-fetch product list once so we can skip unavailable symbols
        _rf_prod_map: dict = {}
        try:
            from data.broker_factory import build_delta_client as _bdc
            _rf_cfg = await _get_broker_cfg(uid)
            _rf_dc  = _bdc(_rf_cfg)
            if _rf_dc is None:
                from data.delta_client import delta_rest as _rf_dc
            _rf_prod_map = {p["symbol"]: p["id"]
                            for p in await asyncio.to_thread(_rf_dc.get_products)}
        except Exception:
            pass  # proceed without pre-filter; product check happens in _try_broker_order

        for sym in watch_syms:
            rf = state.get(f"/rf_dw/crypto/{sym}") or {}
            direction = rf.get("signal")
            if direction not in ("BUY", "SELL"):
                continue
            # Only act on a fresh flip (just_fired=True) to avoid re-triggering
            if not rf.get("just_fired"):
                continue
            sig_ts = str(rf.get("bar_time") or rf.get("timestamp") or "")
            if sig_ts == str(bot.get(f"_rf_{sym}_ts", "")):
                continue
            # Skip symbols not listed on this exchange (avoids repeated errors)
            if _rf_prod_map:
                base = sym.replace("USD", "")
                candidates = [base, sym, f"{base}USDT"]
                if not any(c in _rf_prod_map for c in candidates):
                    logger.debug(f"RF bot: {sym} not on exchange, skipping")
                    bot[f"_rf_{sym}_ts"] = sig_ts  # dedup so we don't retry same bar
                    continue
            signal = {
                "signal_id":    f"rf_{sym}_{sig_ts}",
                "symbol":       sym.replace("USD", ""),
                "market":       "crypto",
                "verdict":      "GO",
                "conviction":   "HIGH",
                "overall_score": 7.0,
                "side":         direction,
                "entry_price":  float(rf.get("close") or 0) or None,
                "_rf_sym":      sym,
                "_rf_ts":       sig_ts,
            }
            break

    # ── Screener ──────────────────────────────────────────────────
    elif source == "screener":
        screener = state.get("/screener/results") or {}
        categories = screener.get("categories") or {}
        _BEAR_CATS = {"bearish_breakdown", "overbought_reversal", "death_cross", "gap_down"}
        for cat_id in (bot.get("screener_categories") or ["bullish_breakout"]):
            stocks = [s for s in (categories.get(cat_id, {}).get("stocks") or []) if s.get("market") == market]
            if not stocks:
                continue
            # Rank by technical_score descending — best setup first, not arbitrary list order
            stocks.sort(key=lambda s: float(s.get("technical_score") or s.get("score") or 0), reverse=True)
            stock = stocks[0]
            sig_id = f"scr_{cat_id}_{stock.get('symbol')}_{screener.get('last_scan')}"
            if sig_id == bot.get("last_signal_id"):
                continue
            signal = {
                "signal_id":    sig_id,
                "symbol":       stock.get("symbol"),
                "market":       market,
                "verdict":      "GO",
                "conviction":   "MEDIUM",
                "overall_score": float(stock.get("technical_score") or stock.get("score") or 7.0),
                "entry_price":  stock.get("price"),
                "side":         "SELL" if cat_id in _BEAR_CATS else "BUY",
            }
            break

    # ── Confirmation Simple ────────────────────────────────────────
    elif source == "conf_simple":
        try:
            from agents.conf_simple_agent import SCAN_SYMBOLS as _CS_SYMS
        except Exception:
            _CS_SYMS = ["BTCUSD", "ETHUSD", "SOLUSD"]
        watch_syms = bot.get("symbols") or _CS_SYMS
        for sym in watch_syms:
            conf = state.get(f"/conf_simple/crypto/{sym}") or {}
            direction = conf.get("signal", "")
            if "STRONG" not in (conf.get("strength") or ""):
                continue
            if direction not in ("BUY", "SELL"):
                continue
            sig_ts = str(conf.get("ts") or conf.get("timestamp") or "")
            if sig_ts == str(bot.get(f"_cs_{sym}_ts", "")):
                continue
            signal = {
                "signal_id":    f"cs_{sym}_{sig_ts}",
                "symbol":       sym.replace("USD", ""),
                "market":       "crypto",
                "verdict":      "GO",
                "conviction":   "HIGH",
                "overall_score": 7.5,
                "side":         direction,
                "_cs_sym":      sym,
                "_cs_ts":       sig_ts,
            }
            break

    # ── EMA Cross 9/15 ────────────────────────────────────────────
    elif source == "ema_cross":
        try:
            from agents.ema_cross_agent import SCAN_SYMBOLS as _EC_SYMS
        except Exception:
            _EC_SYMS = ["BTCUSD", "ETHUSD", "SOLUSD", "BNBUSD", "AVAXUSD", "XRPUSD"]
        watch_syms = bot.get("symbols") or _EC_SYMS
        # Bot-level ATR hyperparameter overrides (fall back to agent defaults)
        _ec_sl_mult = float(bot.get("atr_sl_mult") or 1.5)
        _ec_tp_mult = float(bot.get("atr_tp_mult") or 3.0)
        for sym in watch_syms:
            ec = state.get(f"/ema_cross/crypto/{sym}") or {}
            action = ec.get("action", "HOLD")
            if action not in ("LONG", "SHORT"):
                continue
            if not ec.get("just_fired"):
                continue
            sig_ts = str(ec.get("bar_time") or ec.get("timestamp") or "")
            if sig_ts == str(bot.get(f"_ec_{sym}_ts", "")):
                continue
            # Respect daily drawdown guard (4% hard limit in strategy definition)
            regime = ec.get("regime", "neutral")
            conviction = "HIGH" if ec.get("confidence_score", 0) >= 0.7 else "MEDIUM"
            signal = {
                "signal_id":    f"ec_{sym}_{sig_ts}",
                "symbol":       sym.replace("USD", ""),
                "market":       "crypto",
                "verdict":      "GO",
                "conviction":   conviction,
                "overall_score": round(ec.get("confidence_score", 0.5) * 10, 1),
                "side":         "BUY" if action == "LONG" else "SELL",
                "entry_price":  ec.get("entry_price"),
                "stop_loss":    ec.get("stop_loss"),
                "take_profit":  ec.get("take_profit"),
                "regime":       regime,
                "atr":          ec.get("atr"),
                "reasoning":    ec.get("reasoning", ""),
                "_ec_sym":      sym,
                "_ec_ts":       sig_ts,
            }
            break

    # ── TradingView Per-User Webhook ──────────────────────────────
    elif source == "tv_webhook":
        queue: list = state.get(f"/tv_webhook/{uid}") or []
        for entry in queue:
            if not entry.get("just_fired"):
                continue
            if entry.get("bot_id") != bot.get("id"):
                continue
            if entry.get("signal_id") == bot.get("last_signal_id"):
                continue
            signal = {**entry, "market": market}
            break

    # ── Chartink Per-User Webhook ─────────────────────────────────
    elif source == "chartink":
        token_key = (bot.get("chartink_token") or "")[:12]
        queue: list = state.get(f"/chartink_user/{uid}/{token_key}") or []
        for entry in queue:
            if not entry.get("just_fired"):
                continue
            if entry.get("bot_id") != bot.get("id"):
                continue
            if entry.get("signal_id") == bot.get("last_signal_id"):
                continue
            signal = {**entry, "market": market}
            break

    # ── Custom Conditions (no-code rule builder) ──────────────────
    elif source == "custom_conditions":
        conditions = bot.get("custom_conditions") or []
        cond_side  = bot.get("custom_conditions_side", "BUY").upper()
        logic      = (bot.get("custom_conditions_logic") or "AND").upper()
        watch_syms = bot.get("symbols") or []
        if conditions and watch_syms:
            for sym in watch_syms:
                chart = state.get(f"/charts/{market}/{sym}") or {}
                # Support various nesting patterns from chart_pattern_agent
                technicals = (
                    chart.get("indicators")
                    or chart.get("technical_summary")
                    or chart.get("technicals")
                    or chart
                )
                results = []
                for cond in conditions:
                    ind = cond.get("indicator", "")
                    op  = cond.get("op", "gt")
                    val = float(cond.get("value") or 0)
                    ind_val = _get_indicator_value(technicals, ind)
                    results.append(_eval_condition(float(ind_val), op, val) if ind_val is not None else False)
                met = all(results) if logic == "AND" else any(results)
                if not met:
                    continue
                sig_id = f"cc_{sym}_{int(time.time())}"
                if sig_id == bot.get("last_signal_id"):
                    continue
                price_data = state.read_market_data(market, sym) or {}
                signal = {
                    "signal_id":    sig_id,
                    "symbol":       sym,
                    "market":       market,
                    "verdict":      "GO",
                    "conviction":   "MEDIUM",
                    "overall_score": 7.0,
                    "side":         cond_side,
                    "entry_price":  price_data.get("ltp") or price_data.get("price"),
                }
                break

    if not signal:
        return False

    # ── Position sizing ───────────────────────────────────────────
    capital = bot.get("capital_inr", 100000.0)
    pos_value = min(capital * bot.get("capital_pct", 1.0) / 100.0,
                    bot.get("max_position_inr", 50000.0))

    entry_price = (signal.get("entry_price") or signal.get("entry_zone_low") or 0)
    if not entry_price:
        sym_key = signal.get("symbol", "")
        mkt_data = state.read_market_data(market, sym_key) or {}
        entry_price = mkt_data.get("ltp") or mkt_data.get("price") or 0

    if not entry_price or float(entry_price) <= 0:
        logger.debug(f"Bot {bot['id']}: no entry price for {signal.get('symbol')}, skipping")
        return False

    qty = max(1, int(pos_value / float(entry_price)))
    side = signal.get("side", "BUY")

    # ── Signal flip: close opposite position before reversing ─────
    # If this bot already holds the opposite side for the same symbol,
    # close it first so we are never simultaneously long and short.
    await _close_conflicting_position(uid, bot, signal.get("symbol", ""), market, side)

    # ── Record execution (PENDING until broker confirms) ─────────
    execution = {
        "id":            str(_uuid.uuid4()),
        "bot_id":        bot["id"],
        "bot_name":      bot.get("name", ""),
        "symbol":        signal.get("symbol"),
        "side":          side,
        "qty":           qty,
        "price":         float(entry_price),
        "market":        market,
        "signal_source": source,
        "verdict":       signal.get("verdict"),
        "conviction":    signal.get("conviction"),
        "score":         signal.get("overall_score"),
        "ts":            datetime.now(timezone.utc).isoformat(),
        "status":        "PENDING",
        "pnl":           None,
    }
    execs: list = state.get(f"/bot_executions/{uid}") or []
    execs.insert(0, execution)
    state.set(f"/bot_executions/{uid}", execs[:200])

    # ── Place broker order ────────────────────────────────────────
    broker_result = await _try_broker_order(
        uid, bot, signal.get("symbol", ""), market, side, qty, float(entry_price),
        signal=signal,
    )

    now_ts = datetime.now(timezone.utc).isoformat()
    if not broker_result["ok"]:
        err_msg = broker_result["error"]
        execution["status"] = "ERROR"
        execution["error"]  = err_msg
        execs[0] = execution
        state.set(f"/bot_executions/{uid}", execs[:200])

        # "Product not found" is a config issue, not a transient broker failure.
        # Set the dedup key so we don't retry the same bar, and return quietly.
        if "No Delta product found" in err_msg or "product not found" in err_msg.lower():
            if signal.get("_rf_sym"):
                bot[f"_rf_{signal['_rf_sym']}_ts"] = signal.get("_rf_ts", "")
            if signal.get("_ec_sym"):
                bot[f"_ec_{signal['_ec_sym']}_ts"] = signal.get("_ec_ts", "")
            logger.debug(f"Bot '{bot.get('name')}': {err_msg} — skipping symbol")
            return False

        # For any broker error, stamp the ema_cross dedup key so the same bar
        # is not retried on the next 5-second cycle (avoids rapid 3-strike disable).
        if signal.get("_ec_sym"):
            bot[f"_ec_{signal['_ec_sym']}_ts"] = signal.get("_ec_ts", "")

        # ── Error tracking on bot ─────────────────────────────────
        bot["error_count"]   = (bot.get("error_count") or 0) + 1
        bot["last_error"]    = err_msg
        bot["last_error_ts"] = now_ts
        if not bot.get("first_error_ts"):
            bot["first_error_ts"] = now_ts

        # Auto-disable after 3 consecutive errors within 1 hour
        first_ts = bot.get("first_error_ts", now_ts)
        age_s = (datetime.fromisoformat(now_ts) - datetime.fromisoformat(first_ts)).total_seconds()
        if bot["error_count"] >= 3 and age_s <= 3600:
            bot["enabled"]         = False
            bot["disabled_reason"] = f"Auto-disabled after {bot['error_count']} broker errors: {err_msg[:80]}"
            await manager.send_to_user(uid, {
                "type":     "bot_auto_disabled",
                "bot_id":   bot["id"],
                "bot_name": bot.get("name"),
                "reason":   bot["disabled_reason"],
            })
            logger.warning(f"🚫 Bot '{bot.get('name')}' auto-disabled: {err_msg}")

        logger.error(f"Bot '{bot.get('name')}' broker error ({bot['error_count']}×): {err_msg}")
        return False

    # ── Broker order placed successfully ──────────────────────────
    result_status = "SIMULATED" if broker_result.get("paper") else "PLACED"
    execution["status"] = result_status
    execs[0] = execution
    state.set(f"/bot_executions/{uid}", execs[:200])

    # Reset error tracking on success
    bot["error_count"]   = 0
    bot["last_error"]    = None
    bot["last_error_ts"] = None
    bot["first_error_ts"] = None

    # ── Update bot state ──────────────────────────────────────────
    stats["trades_today"] = stats.get("trades_today", 0) + 1
    stats["total_trades"] = stats.get("total_trades", 0) + 1
    bot["stats"] = stats
    bot["state"] = "IN_POSITION"
    bot["last_execution"] = execution
    bot["last_execution_ts"] = execution["ts"]
    bot["last_signal_id"] = signal.get("signal_id")
    if signal.get("_rf_sym"):
        bot[f"_rf_{signal['_rf_sym']}_ts"] = signal.get("_rf_ts")
    if signal.get("_cs_sym"):
        bot[f"_cs_{signal['_cs_sym']}_ts"] = signal.get("_cs_ts")
    if signal.get("_ec_sym"):
        bot[f"_ec_{signal['_ec_sym']}_ts"] = signal.get("_ec_ts")
    # Mark TV / Chartink queue entry as consumed so it doesn't re-trigger on next cycle
    consumed_sig_id = signal.get("signal_id", "")
    if source == "tv_webhook":
        q = state.get(f"/tv_webhook/{uid}") or []
        for item in q:
            if item.get("signal_id") == consumed_sig_id:
                item["just_fired"] = False
        state.set(f"/tv_webhook/{uid}", q[:50], ttl=3600)
    elif source == "chartink":
        token_key = (bot.get("chartink_token") or "")[:12]
        q = state.get(f"/chartink_user/{uid}/{token_key}") or []
        for item in q:
            if item.get("signal_id") == consumed_sig_id:
                item["just_fired"] = False
        state.set(f"/chartink_user/{uid}/{token_key}", q[:100], ttl=86400)

    # ── Notify connected client ───────────────────────────────────
    await manager.send_to_user(uid, {
        "type":      "bot_execution",
        "bot_id":    bot["id"],
        "bot_name":  bot.get("name"),
        "symbol":    signal.get("symbol"),
        "side":      side,
        "qty":       qty,
        "price":     float(entry_price),
        "ts":        execution["ts"],
    })
    logger.info(f"🤖 Bot '{bot.get('name')}': {side} {qty}× {signal.get('symbol')} @ {entry_price} [{result_status}]")
    return True


# ─── WebSocket — authenticated real-time feed ────────────────────
class ConnectionManager:
    def __init__(self):
        self.active: dict[WebSocket, str] = {}  # ws -> user_id
        self._lock = asyncio.Lock()

    async def connect(self, ws: WebSocket, user_id: str):
        await ws.accept()
        async with self._lock:
            self.active[ws] = user_id

    async def disconnect(self, ws: WebSocket):
        async with self._lock:
            self.active.pop(ws, None)

    async def broadcast(self, data: dict):
        """Broadcast to all clients in parallel; prune dead connections."""
        async with self._lock:
            sockets = list(self.active.keys())
        if not sockets:
            return
        results = await asyncio.gather(
            *[ws.send_json(data) for ws in sockets],
            return_exceptions=True,
        )
        dead = [ws for ws, r in zip(sockets, results) if isinstance(r, Exception)]
        for ws in dead:
            await self.disconnect(ws)

    async def send_to_user(self, user_id: str, data: dict):
        """Send a message to all WebSocket connections belonging to a specific user."""
        async with self._lock:
            sockets = [ws for ws, uid in self.active.items() if uid == user_id]
        for ws in sockets:
            try:
                await ws.send_json(data)
            except Exception:
                await self.disconnect(ws)


manager = ConnectionManager()


# ─── Agent log ring buffer ────────────────────────────────────────
# Captures recent log lines for the /ws/agent-logs feed.
# Max 500 entries — older lines are dropped automatically.
_agent_log_buffer: collections.deque = collections.deque(maxlen=500)
_agent_log_subscribers: list[asyncio.Queue] = []


def _agent_log_sink(message) -> None:
    """Loguru sink that pushes formatted records into the ring buffer + active WS queues."""
    record = message.record
    level  = record["level"].name
    module = record["name"].split(".")[-1]
    entry  = {
        "ts":      record["time"].strftime("%H:%M:%S"),
        "level":   level,
        "module":  module,
        "msg":     record["message"],
        "is_agent": any(k in module for k in ("agent", "pipeline", "guardian", "rf_dw", "signal", "scanner")),
    }
    _agent_log_buffer.append(entry)
    for q in _agent_log_subscribers:
        try:
            q.put_nowait(entry)
        except asyncio.QueueFull:
            pass


class AgentLogManager:
    def __init__(self):
        self.active: dict[WebSocket, asyncio.Queue] = {}
        self._lock = asyncio.Lock()

    async def connect(self, ws: WebSocket) -> asyncio.Queue:
        await ws.accept()
        q: asyncio.Queue = asyncio.Queue(maxsize=200)
        async with self._lock:
            self.active[ws] = q
            _agent_log_subscribers.append(q)
        return q

    async def disconnect(self, ws: WebSocket):
        async with self._lock:
            q = self.active.pop(ws, None)
            if q and q in _agent_log_subscribers:
                _agent_log_subscribers.remove(q)


agent_log_manager = AgentLogManager()


@app.websocket("/ws/agent-logs")
async def websocket_agent_logs(ws: WebSocket, token: Optional[str] = Query(None)):
    """
    Authenticated WebSocket feed of real-time agent log lines.
    Sends the last 100 buffered entries on connect, then streams new ones.
    """
    if not token:
        await ws.close(code=status.WS_1008_POLICY_VIOLATION, reason="missing token")
        return
    try:
        user = verify_jwt_cached(token)
    except PermissionError:
        await ws.close(code=status.WS_1008_POLICY_VIOLATION, reason="invalid token")
        return

    q = await agent_log_manager.connect(ws)
    logger.info(f"Agent-log WS connected: user={user['email']}")

    try:
        # Send recent history first so the page isn't blank
        history = list(_agent_log_buffer)[-100:]
        await ws.send_json({"type": "history", "logs": history})

        while True:
            try:
                entry = await asyncio.wait_for(q.get(), timeout=30)
                await ws.send_json({"type": "log", "entry": entry})
            except asyncio.TimeoutError:
                # Keepalive ping
                await ws.send_json({"type": "ping"})
    except WebSocketDisconnect:
        pass
    finally:
        await agent_log_manager.disconnect(ws)
        logger.info(f"Agent-log WS disconnected: user={user['email']}")


@app.get("/agents/status")
async def agents_status(user: dict = Depends(get_current_user)):
    """
    Aggregated agent status: last run times, LLM cost today,
    scheduler state, and active signal counts.
    """
    # LLM cost from Redis
    llm_cost = state.get("/llm/cost_today_inr") or 0.0
    llm_budget = float(getattr(_settings, "DAILY_LLM_BUDGET_INR", 50))

    # Last scan times stored by scheduler
    last_scans = {
        "india_pipeline":  state.get("/scheduler/last_run/india_pipeline"),
        "india_chart":     state.get("/scheduler/last_run/india_chart"),
        "crypto_chart":    state.get("/scheduler/last_run/crypto_chart"),
        "rf_dw":           state.get("/scheduler/last_run/rf_dw"),
        "india_signal":    state.get("/scheduler/last_run/india_signal"),
        "crypto_signal":   state.get("/scheduler/last_run/crypto_signal"),
        "india_sentiment": state.get("/scheduler/last_run/india_sentiment"),
        "screener":        state.get("/scheduler/last_run/screener"),
        "conf_simple":     state.get("/scheduler/last_run/conf_simple"),
    }

    # Active signals count
    open_sigs = get_open_signals()
    sig_counts = {"total": len(open_sigs), "go": 0, "watch": 0}
    for s in open_sigs:
        v = (s.get("verdict") or "").upper()
        if v == "GO":
            sig_counts["go"] += 1
        elif v == "WATCH":
            sig_counts["watch"] += 1

    # RF[DW] state for all symbols
    from agents.rf_dw_agent import SCAN_SYMBOLS
    rf_states = {}
    for sym in SCAN_SYMBOLS:
        d = state.get(f"/rf_dw/crypto/{sym}")
        if d:
            rf_states[sym] = {"signal": d.get("signal"), "ts": d.get("timestamp")}

    return {
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "llm": {
            "cost_today_inr": round(llm_cost, 3),
            "budget_inr": llm_budget,
            "budget_pct": round((llm_cost / llm_budget) * 100, 1) if llm_budget else 0,
        },
        "last_scans": last_scans,
        "signals": sig_counts,
        "rf_dw": rf_states,
        "india_pipeline": state.get("/pipeline/india/status") or {"status": "idle"},
        "log_buffer_size": len(_agent_log_buffer),
    }


@app.websocket("/ws/live")
async def websocket_live(ws: WebSocket, token: Optional[str] = Query(None)):
    """
    Authenticated live feed.

    Browsers can't set Authorization headers on native WebSocket, so
    the token is passed as a query-string param. The handshake happens
    over TLS in prod, so the token isn't exposed on the wire.
    """
    if not token:
        await ws.close(code=status.WS_1008_POLICY_VIOLATION, reason="missing token")
        return
    try:
        user = verify_jwt_cached(token)
    except PermissionError:
        await ws.close(code=status.WS_1008_POLICY_VIOLATION, reason="invalid token")
        return

    await manager.connect(ws, user["id"])
    logger.info(f"WS connected: user={user['email']} clients={len(manager.active)}")
    try:
        # Send full snapshot immediately on connect
        await ws.send_json({
            "type":    "snapshot",
            "signals": get_open_signals(),
            "risk":    state.get("/risk") or {},
            "news":    (state.get("/news/feed") or [])[:30],
        })

        # All subsequent data arrives via:
        #   - _global_push_task()   → risk + India indices every 1s
        #   - event_bus.emit_ticker() → Delta/Binance ticks as they arrive
        # This handler just keeps the connection alive and detects disconnects.
        while True:
            try:
                msg = await asyncio.wait_for(ws.receive(), timeout=30.0)
                if msg.get("type") == "websocket.disconnect":
                    break
            except asyncio.TimeoutError:
                # Send a lightweight heartbeat to detect stale connections
                await ws.send_json({"type": "ping"})

    except WebSocketDisconnect:
        pass
    except Exception:
        pass
    finally:
        await manager.disconnect(ws)
        logger.info(f"WS disconnected: user={user['email']} clients={len(manager.active)}")


async def broadcast_ticker_update(symbol: str, data: dict):
    await manager.broadcast({"type": "ticker", "symbol": symbol, "data": data})


async def broadcast_news(item: dict):
    await manager.broadcast({"type": "news", "item": item})
