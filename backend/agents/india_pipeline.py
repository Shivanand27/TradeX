"""
agents/india_pipeline.py
────────────────────────────────────────────────────────────
India Stock Analysis Pipeline — three linked stages:

  Stage 1  Chart Pattern    always runs
  Stage 2  Fundamentals     only if cached data is >= 7 days old
  Stage 3  Sentiment/News   always runs

Triggered by:
  • Scheduler at 09:30 IST daily
  • POST /agents/india/pipeline/run  (ad-hoc)

Pipeline state is persisted to /pipeline/india/status in Redis
so the frontend can display progress and last-run outcome.
"""
from __future__ import annotations

import asyncio
from datetime import datetime, timezone
from loguru import logger

import pytz

from core.config import INDIA_WATCHLIST
from core.state_store import state

IST = pytz.timezone("Asia/Kolkata")
FUNDAMENTALS_STALE_DAYS = 7


# ─── Staleness check ─────────────────────────────────────────────────────────

def _fundamentals_stale() -> tuple[bool, str]:
    """
    Returns (is_stale, human_readable_reason).
    Stale = any symbol is missing OR oldest timestamp >= FUNDAMENTALS_STALE_DAYS.
    """
    symbols = [s.replace(".NS", "") for s in INDIA_WATCHLIST]
    oldest_days = 0.0
    missing: list[str] = []

    for sym in symbols:
        data = state.read_fundamentals(sym)
        if data is None:
            missing.append(sym)
            continue
        ts_str = data.get("timestamp", "")
        if not ts_str:
            missing.append(sym)
            continue
        try:
            ts = datetime.fromisoformat(ts_str.replace("Z", "+00:00"))
            if ts.tzinfo is None:
                ts = ts.replace(tzinfo=timezone.utc)
            age_days = (datetime.now(timezone.utc) - ts).total_seconds() / 86400
            oldest_days = max(oldest_days, age_days)
        except Exception:
            missing.append(sym)

    if missing:
        return True, f"{len(missing)} symbol(s) missing fundamentals"
    if oldest_days >= FUNDAMENTALS_STALE_DAYS:
        return True, f"data is {oldest_days:.0f}d old (threshold: {FUNDAMENTALS_STALE_DAYS}d)"
    return False, f"data is {oldest_days:.1f}d old (fresh)"


# ─── Pipeline runner ──────────────────────────────────────────────────────────

async def run_india_analysis_pipeline(triggered_by: str = "scheduler") -> dict:
    """
    Execute the India stock analysis pipeline sequentially.
    Writes stage-level status to state store after each stage.
    Returns the final pipeline status dict.
    """
    start_dt = datetime.now(timezone.utc)
    start_ts = start_dt.isoformat()
    ist_now  = datetime.now(IST).strftime("%H:%M:%S IST")

    logger.info(f"▶ IndiaAnalysisPipeline — triggered_by={triggered_by}")

    stages: dict = {
        "chart_pattern": {"status": "pending"},
        "fundamentals":  {"status": "pending"},
        "sentiment":     {"status": "pending"},
    }

    def _persist(overall: str, current_stage: str) -> None:
        state.set("/pipeline/india/status", {
            "status":        overall,
            "current_stage": current_stage,
            "started_at":    start_ts,
            "triggered_by":  triggered_by,
            "stages":        stages,
        }, ttl=86400)

    _persist("running", "chart_pattern")

    # ── Stage 1: Chart Pattern ────────────────────────────────────────────────
    stages["chart_pattern"]["status"] = "running"
    _persist("running", "chart_pattern")
    logger.info("▶ IndiaAnalysisPipeline [1/3] — Chart Pattern scan")
    t0 = datetime.now(timezone.utc)
    try:
        from agents.chart_pattern_agent import run_chart_pattern_agent
        result = await run_chart_pattern_agent("india")
        elapsed = round((datetime.now(timezone.utc) - t0).total_seconds())
        stages["chart_pattern"] = {
            "status":      "complete",
            "duration_s":  elapsed,
            "symbols":     len(result),
        }
        logger.info(f"✓ IndiaAnalysisPipeline [1/3] Chart Pattern — {len(result)} symbols in {elapsed}s")
    except Exception as e:
        stages["chart_pattern"] = {"status": "error", "error": str(e)}
        logger.error(f"✗ IndiaAnalysisPipeline [1/3] Chart Pattern failed: {e}")

    # ── Stage 2: Fundamentals (staleness-gated) ───────────────────────────────
    is_stale, reason = _fundamentals_stale()
    if is_stale:
        stages["fundamentals"]["status"] = "running"
        _persist("running", "fundamentals")
        logger.info(f"▶ IndiaAnalysisPipeline [2/3] — Fundamentals ({reason})")
        t0 = datetime.now(timezone.utc)
        try:
            from agents.fundamentals_agent import run_india_fundamentals_agent
            result = await run_india_fundamentals_agent()
            elapsed = round((datetime.now(timezone.utc) - t0).total_seconds())
            stages["fundamentals"] = {
                "status":     "complete",
                "duration_s": elapsed,
                "symbols":    len(result),
                "reason":     reason,
            }
            logger.info(f"✓ IndiaAnalysisPipeline [2/3] Fundamentals — {len(result)} symbols in {elapsed}s")
        except Exception as e:
            stages["fundamentals"] = {"status": "error", "error": str(e)}
            logger.error(f"✗ IndiaAnalysisPipeline [2/3] Fundamentals failed: {e}")
    else:
        stages["fundamentals"] = {"status": "skipped", "reason": reason}
        logger.info(f"✓ IndiaAnalysisPipeline [2/3] Fundamentals skipped — {reason}")

    # ── Stage 3: Sentiment & News ─────────────────────────────────────────────
    stages["sentiment"]["status"] = "running"
    _persist("running", "sentiment")
    logger.info("▶ IndiaAnalysisPipeline [3/3] — India Sentiment & News")
    t0 = datetime.now(timezone.utc)
    try:
        from data.india_market import fetch_india_vix, fetch_nifty_trend
        from data.india_news import fetch_india_news_sentiment

        vix, trend, news = await asyncio.gather(
            asyncio.to_thread(fetch_india_vix),
            asyncio.to_thread(fetch_nifty_trend),
            fetch_india_news_sentiment(),
            return_exceptions=True,
        )
        if isinstance(vix, Exception):
            logger.warning(f"  VIX fetch failed: {vix}")
            vix = None
        if isinstance(trend, Exception):
            logger.warning(f"  NIFTY trend fetch failed: {trend}")
            trend = None
        if isinstance(news, Exception):
            logger.warning(f"  News fetch failed: {news}")
            news = None

        if vix:
            state.set("/market/india_vix", vix)
        if trend:
            state.set("/market/nifty_trend", trend)

        news_count = 0
        if news:
            state.write_sentiment("india", "global", news)
            new_items = news.get("news_items", [])
            news_count = len(new_items)
            # merge into aggregated /news/feed
            existing = state.get("/news/feed") or []
            seen = {n.get("headline") for n in existing}
            fresh = [n for n in new_items if n.get("headline") not in seen]
            merged = (fresh + existing)[:200]
            merged.sort(key=lambda n: n.get("age_hours", 9999))
            state.set("/news/feed", merged, ttl=3600)

        elapsed = round((datetime.now(timezone.utc) - t0).total_seconds())
        stages["sentiment"] = {
            "status":     "complete",
            "duration_s": elapsed,
            "news_items": news_count,
        }
        logger.info(f"✓ IndiaAnalysisPipeline [3/3] Sentiment — {news_count} items in {elapsed}s")
    except Exception as e:
        stages["sentiment"] = {"status": "error", "error": str(e)}
        logger.error(f"✗ IndiaAnalysisPipeline [3/3] Sentiment failed: {e}")

    # ── Finalise ──────────────────────────────────────────────────────────────
    has_error  = any(s.get("status") == "error" for s in stages.values())
    final_status = "error" if has_error else "complete"
    completed_at = datetime.now(timezone.utc).isoformat()

    final = {
        "status":        final_status,
        "current_stage": "done",
        "started_at":    start_ts,
        "completed_at":  completed_at,
        "triggered_by":  triggered_by,
        "stages":        stages,
    }
    state.set("/pipeline/india/status", final, ttl=86400)
    state.set("/scheduler/last_run/india_pipeline", ist_now, ttl=86400)

    total_s = round((datetime.now(timezone.utc) - start_dt).total_seconds())
    logger.info(f"✓ IndiaAnalysisPipeline — {final_status} in {total_s}s")
    return final
