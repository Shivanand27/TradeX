"""
scheduler.py
─────────────────────────────────────────────────────
Master scheduler — runs ALL agents on their IST schedule.

Run locally:    python scheduler.py
On Render:      Set as Background Worker service
Keep-alive:     Register URL at https://cron-job.org (free)
                to ping the /health endpoint every 10 minutes

IST Schedule:
  08:00 — Morning briefing (crypto overnight + India pre-market)
  09:00 — Refresh Groww access token (daily expiry)
  09:15 — India market open: full data collection
  09:20 — Opening candle chart scan
  11:00 — Mid-morning scan
  13:30 — Lunch scan
  15:00 — Pre-close scan
  15:30 — India market close: fundamentals update
  16:00 — End-of-day signal generation
  20:00 — Big-move spot trade scanner
  20:00 — Daily summary to Telegram

Crypto: 24/7 background WebSocket + 30-min REST snapshots
"""
from __future__ import annotations
import asyncio
import signal
import sys
import threading
from datetime import datetime
import pytz
import schedule
import time
from loguru import logger

from core.config import LOG_LEVEL, IST_TIMEZONE, PAPER_TRADING
from core.state_store import state

# ── Logging setup ─────────────────────────────────────────────────
logger.remove()
logger.add(
    sys.stdout, level=LOG_LEVEL,
    format="<green>{time:HH:mm:ss IST}</green> | <level>{level:<8}</level> | {message}",
)
logger.add("logs/platform.log", level="DEBUG",
           rotation="00:00", retention="7 days", compression="zip")

IST = pytz.timezone(IST_TIMEZONE)


def _mark_task_run(key: str) -> None:
    """Record last-run timestamp for a scheduler task so the UI can display it."""
    state.set(f"/scheduler/last_run/{key}", datetime.now(IST).strftime("%H:%M:%S IST"), ttl=86400)


# ── Scheduled task wrappers ───────────────────────────────────────

def task_refresh_groww_token():
    """Refresh Groww access token at 09:00 IST (tokens expire daily)."""
    logger.info("━━ TASK: Refresh Groww Token ━━")
    from data.groww_client import groww
    success = groww.refresh_token()
    status = "✓ connected" if success else "⚠ fallback to yfinance"
    logger.info(f"  Groww token: {status}")
    asyncio.run(_alert_if_failed(success, "Groww token refresh"))


def task_morning_briefing():
    """08:00 IST — crypto overnight recap + India pre-market mood."""
    logger.info("━━ TASK: Morning Briefing ━━")

    # Crypto overnight snapshot
    task_delta_snapshot()

    snap = state.get("/sentiment/crypto/delta_snapshot") or {}
    vix  = state.get("/market/india_vix") or "?"

    tickers = snap.get("tickers", {})
    btc  = tickers.get("BTCUSD", {})
    eth  = tickers.get("ETHUSD", {})

    briefing = (
        f"🌅 <b>Morning Briefing — {_ist_now()}</b>\n\n"
        f"₿ <b>BTC:</b> ${btc.get('ltp', 0):,.0f}  "
        f"({btc.get('change_pct', 0):+.2f}%)\n"
        f"Ξ <b>ETH:</b> ${eth.get('ltp', 0):,.0f}  "
        f"({eth.get('change_pct', 0):+.2f}%)\n\n"
        f"📊 <b>India VIX:</b> {vix}\n"
        f"Fear & Greed: {snap.get('fear_greed', '?')} "
        f"({snap.get('fear_greed_signal', '?')})\n\n"
        f"{'🟢 Conditions look OK for trading today' if float(vix or 25) < 20 else '⚠️ High VIX — trade carefully'}"
    )
    asyncio.run(_send(briefing))


def task_india_data():
    """Fetch all NSE/BSE watchlist data via Groww API."""
    logger.info("━━ TASK: India Market Data ━━")
    asyncio.run(_run_india_data())


async def _run_india_data():
    from data.india_market import run_india_market_data_agent
    await run_india_market_data_agent()


def task_india_chart_scan():
    """Run chart pattern analysis for all India stocks."""
    logger.info("━━ TASK: India Chart Pattern Scan ━━")
    from agents.chart_pattern_agent import run_chart_pattern_agent
    asyncio.run(run_chart_pattern_agent("india"))
    _mark_task_run("india_chart")


def task_crypto_chart_scan():
    """Run chart pattern analysis for all crypto symbols."""
    logger.info("━━ TASK: Crypto Chart Pattern Scan ━━")
    from agents.chart_pattern_agent import run_chart_pattern_agent
    asyncio.run(run_chart_pattern_agent("crypto"))
    _mark_task_run("crypto_chart")


def task_india_pipeline():
    """09:30 IST — full India analysis pipeline: Chart Pattern → Fundamentals (if stale) → Sentiment."""
    logger.info("━━ TASK: India Analysis Pipeline ━━")
    asyncio.run(_run_india_pipeline_task())


async def _run_india_pipeline_task():
    from agents.india_pipeline import run_india_analysis_pipeline
    await run_india_analysis_pipeline(triggered_by="scheduler_09:30")
    _mark_task_run("india_pipeline")


def task_india_sentiment():
    """Fetch India news, macro events, FII/DII flows (intraday refresh only)."""
    logger.info("━━ TASK: India Sentiment & News ━━")
    asyncio.run(_run_india_sentiment())


async def _run_india_sentiment():
    from data.india_market import fetch_india_vix, fetch_nifty_trend
    from data.india_news import fetch_india_news_sentiment
    vix   = await asyncio.to_thread(fetch_india_vix)
    trend = await asyncio.to_thread(fetch_nifty_trend)
    news  = await fetch_india_news_sentiment()
    if vix:
        state.set("/market/india_vix", vix)
    if trend:
        state.set("/market/nifty_trend", trend)
    if news:
        state.write_sentiment("india", "global", news)
        # Write news items to the aggregated feed key the API reads from
        existing = state.get("/news/feed") or []
        new_items = news.get("news_items", [])
        seen = {n.get("headline") for n in existing}
        fresh = [n for n in new_items if n.get("headline") not in seen]
        merged = (fresh + existing)[:200]
        merged.sort(key=lambda n: n.get("age_hours", 9999))
        state.set("/news/feed", merged, ttl=3600)
    logger.info(f"  VIX={vix}  NIFTY trend={trend.get('nifty_trend', '?')}")
    _mark_task_run("india_sentiment")


def task_delta_snapshot():
    """Fetch Delta Exchange crypto snapshot (funding, OI, prices)."""
    logger.info("━━ TASK: Delta Exchange Snapshot ━━")
    from data.delta_client import build_delta_snapshot
    build_delta_snapshot()


def task_crypto_sentiment():
    """Fetch crypto on-chain snapshot: F&G, BTC dom, funding, OI, news."""
    logger.info("━━ TASK: Crypto Sentiment & News ━━")
    from data.crypto_market import build_crypto_onchain_snapshot
    snapshot = build_crypto_onchain_snapshot()
    _write_crypto_news_to_feed(snapshot.get("crypto_news", []))


def _write_crypto_news_to_feed(raw_items: list) -> None:
    """Normalize crypto news and merge into the shared /news/feed key."""
    from datetime import datetime, timezone
    _CRYPTO_SRC_MAP = {
        "CoinTelegraph":      "CT",
        "CoinDesk":           "CD",
        "Decrypt":            "DC",
        "The Block":          "TB",
        "NewsBTC":            "NB",
        "AMBCrypto":          "AC",
        "CryptoSlate":        "CS",
        "CoinGecko Trending": "CG",
    }
    now = datetime.now(timezone.utc)
    formatted = []
    for item in raw_items:
        src = _CRYPTO_SRC_MAP.get(item.get("source", ""), "CP")
        pub = item.get("published", "")
        try:
            from dateutil import parser as dparser
            pub_dt = dparser.parse(pub)
            if pub_dt.tzinfo is None:
                pub_dt = pub_dt.replace(tzinfo=timezone.utc)
            age_h = (now - pub_dt).total_seconds() / 3600
        except Exception:
            age_h = 2.0
        if age_h < 1:
            time_str = f"{int(age_h * 60)}m ago"
        elif age_h < 24:
            time_str = f"{int(age_h)}h {int((age_h % 1) * 60)}m ago"
        else:
            time_str = f"{int(age_h / 24)}d ago"

        sentiment = item.get("sentiment", "neutral")
        impact = "HIGH" if sentiment == "bullish" and age_h < 1 else "MEDIUM"
        formatted.append({
            "headline": item.get("title", ""),
            "source":   item.get("source", ""),
            "src":      src,
            "category": "CRYPTO",
            "time":     time_str,
            "age_hours": round(age_h, 1),
            "url":      item.get("url", ""),
            "sentiment": sentiment,
            "impact":   impact,
            "tags":     ["CRYPTO"],
        })

    existing = state.get("/news/feed") or []
    seen = {n.get("headline") for n in existing}
    fresh = [n for n in formatted if n.get("headline") not in seen]
    merged = (fresh + existing)[:300]
    merged.sort(key=lambda n: n.get("age_hours", 9999))
    state.set("/news/feed", merged, ttl=7200)
    logger.info(f"  Crypto news: {len(fresh)} new items → /news/feed")


def task_india_fundamentals():
    """Daily fundamentals refresh — runs after market close."""
    logger.info("━━ TASK: India Fundamentals (daily) ━━")
    from agents.fundamentals_agent import run_india_fundamentals_agent
    asyncio.run(run_india_fundamentals_agent())


def task_signal_generation(market: str = "both"):
    """
    Main signal generation pipeline:
      1. Check which instruments pass debate gate
      2. Run Bull/Bear debate (Gemini Pro, ≤2 rounds)
      3. Issue Verdict → Telegram + DB
    """
    logger.info(f"━━ TASK: Signal Generation [{market}] ━━")
    asyncio.run(_run_signal_pipeline(market))


async def _run_signal_pipeline(market: str):
    from agents.signal_pipeline import run_signal_pipeline
    await run_signal_pipeline(market)
    _mark_task_run(f"{market}_signal" if market != "both" else "india_signal")
    if market == "both":
        _mark_task_run("crypto_signal")


def task_smc_scan(market: str = "india"):
    """SMC top-down watchlist scan (India: 16:15 IST daily / Crypto: every 6h)."""
    logger.info(f"━━ TASK: SMC Top-Down Scan [{market}] ━━")
    asyncio.run(_run_smc_scan(market))


async def _run_smc_scan(market: str):
    from agents.smc_agent import run_smc_watchlist_scan
    await run_smc_watchlist_scan(market)
    _mark_task_run(f"smc_{market}")


def task_spot_trade_scanner():
    """Evening scan for 40-100%+ move setups — India stocks + crypto."""
    logger.info("━━ TASK: Big-Move Spot Scanner ━━")
    asyncio.run(_run_spot_scanner())


async def _run_spot_scanner():
    from agents.signal_pipeline import run_spot_trade_scanner
    await run_spot_trade_scanner()


def task_daily_summary():
    """20:00 IST — send daily summary to Telegram."""
    logger.info("━━ TASK: Daily Summary ━━")
    asyncio.run(_send_daily_summary())


async def _send_daily_summary():
    from core.database import get_open_signals
    from notifications.telegram import send_daily_summary
    open_sigs = get_open_signals()
    india_watch  = state.get("/watch_list/india")  or []
    crypto_watch = state.get("/watch_list/crypto") or []
    watch = (india_watch + crypto_watch)[:5]
    events = state.get("/events/tomorrow") or []
    await send_daily_summary(open_sigs, watch, events)


def task_llm_budget_reset():
    """Midnight IST — reset daily LLM spend counter."""
    state.reset_llm_spend()
    logger.info("✓ LLM budget counter reset for new day")


# ── Delta WebSocket background thread ────────────────────────────

def _start_delta_ws_thread():
    """Run Delta WebSocket stream in a background asyncio thread."""
    def _ws_thread():
        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)
        try:
            from data.delta_client import start_delta_stream
            loop.run_until_complete(start_delta_stream())
        except Exception as e:
            logger.error(f"Delta WS thread error: {e}")
        finally:
            loop.close()

    t = threading.Thread(target=_ws_thread, daemon=True, name="DeltaWS")
    t.start()
    logger.info("✓ Delta WebSocket thread started")
    return t


# ── Risk Guardian position monitor background thread ─────────────

def _start_position_monitor_thread():
    """Run the Risk Guardian position monitor in a background asyncio thread."""
    def _monitor_thread():
        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)
        try:
            from agents.risk_guardian import run_position_monitor
            loop.run_until_complete(run_position_monitor())
        except Exception as e:
            logger.error(f"Position monitor thread error: {e}")
        finally:
            loop.close()

    t = threading.Thread(target=_monitor_thread, daemon=True, name="RiskMonitor")
    t.start()
    logger.info("✓ Risk Guardian position monitor thread started")
    return t


def task_rf_dw_scan():
    """RF [DW] 3-minute crypto signal scan — runs every 3 minutes, 24/7."""
    logger.info("━━ TASK: RF [DW] 3m Crypto Scan ━━")
    from agents.rf_dw_agent import run_rf_dw_scan_sync
    run_rf_dw_scan_sync()


def task_conf_simple_scan():
    """Confirmation Signals [Simple] 5-minute crypto scan — runs every 5 minutes, 24/7."""
    logger.info("━━ TASK: Confirmation Signals [Simple] 5m Crypto Scan ━━")
    from agents.conf_simple_agent import run_conf_simple_scan_sync
    run_conf_simple_scan_sync()


def task_screener_scan():
    """Stock screener — classifies all India + crypto symbols into technical categories."""
    logger.info("━━ TASK: Stock Screener Scan ━━")
    from agents.screener_agent import run_screener_scan_sync
    run_screener_scan_sync("all")


def task_ema_cross_scan():
    """9/15 EMA Crossover 15-minute crypto signal scan — runs every 15 minutes, 24/7."""
    logger.info("━━ TASK: EMA Cross 9/15 15m Crypto Scan ━━")
    from agents.ema_cross_agent import run_ema_cross_scan_sync
    run_ema_cross_scan_sync()


# ── Schedule definition ───────────────────────────────────────────

def build_schedule():
    """Register all scheduled jobs in IST timezone."""

    # ── India market hours ────────────────────────────────────────
    # Signal generation (LLM debate + verdicts) is owned by the API process
    # (api.py APScheduler). scheduler.py handles data collection, morning
    # briefing, auth, SMC scans, and daily summaries only.
    schedule.every().day.at("08:00").do(task_morning_briefing).tag("morning")
    schedule.every().day.at("09:00").do(task_refresh_groww_token).tag("auth")
    schedule.every().day.at("09:15").do(task_india_data).tag("data")   # price data only
    schedule.every().day.at("09:30").do(task_india_pipeline).tag("pipeline")   # chart + fund + sentiment
    schedule.every().day.at("11:00").do(task_india_data).tag("data")   # price data refresh
    schedule.every().day.at("13:30").do(task_india_data).tag("data")   # price data refresh
    schedule.every().day.at("15:00").do(task_india_data).tag("data")   # price data refresh
    # NOTE: 16:00 signal generation removed — api.py APScheduler runs it to avoid
    # duplicate LLM calls and double signals from two separate Python processes.
    schedule.every().day.at("16:15").do(lambda: task_smc_scan("india")).tag("smc")   # post-close SMC scan
    schedule.every().day.at("20:00").do(task_spot_trade_scanner).tag("scanner")
    schedule.every().day.at("20:00").do(task_daily_summary).tag("summary")
    schedule.every().day.at("00:00").do(task_llm_budget_reset).tag("budget")

    # ── Crypto lightweight scanners: run 24/7 in this process ───────
    # Delta snapshot, crypto chart, crypto signals and screener are owned by
    # the API in-process scheduler (api.py) so they appear in the WS log feed.
    # Only the sub-minute / high-frequency scanners that don't need LLM logs
    # stay here to avoid duplicating Redis writes.
    schedule.every(3).minutes.do(task_rf_dw_scan).tag("rf_dw")
    schedule.every(5).minutes.do(task_conf_simple_scan).tag("conf_simple")
    schedule.every(15).minutes.do(task_ema_cross_scan).tag("ema_cross")
    schedule.every(6).hours.do(lambda: task_smc_scan("crypto")).tag("smc")

    # India sentiment is NOT scheduled separately — it runs only as
    # Stage 3 of the India pipeline (09:30 IST or on-demand trigger).

    logger.info("✓ Schedule built — all jobs registered")
    _print_schedule()


def _run_india_sentiment_if_market_open():
    """Only fetch India sentiment during market hours (9:15–15:30 IST)."""
    now = datetime.now(IST)
    if now.weekday() < 5:  # Mon–Fri
        hour   = now.hour
        minute = now.minute
        market_open  = (hour > 9) or (hour == 9 and minute >= 15)
        market_close = (hour < 15) or (hour == 15 and minute <= 30)
        if market_open and market_close:
            task_india_sentiment()


def _print_schedule():
    """Log next-run times for all jobs."""
    logger.info("📅 Scheduled jobs:")
    for job in sorted(schedule.get_jobs(), key=lambda j: str(j.next_run)):
        logger.info(f"  {str(job.next_run)[:19]}  {job.tags}")


# ── Helpers ───────────────────────────────────────────────────────

def _ist_now() -> str:
    return datetime.now(IST).strftime("%d %b %Y %H:%M IST")


async def _send(text: str) -> None:
    from notifications.telegram import send_message
    await send_message(text)


async def _alert_if_failed(success: bool, task: str) -> None:
    if not success:
        from notifications.telegram import send_alert
        await send_alert(f"Task Failed: {task}",
                         "Check logs for details.", level="WARNING")


# ── Graceful shutdown ──────────────────────────────────────────────

_shutdown = False


def _handle_signal(signum, frame):
    global _shutdown
    logger.info(f"Received signal {signum} — shutting down gracefully...")
    _shutdown = True


# ── Main entry point ──────────────────────────────────────────────

def main():
    global _shutdown

    signal.signal(signal.SIGINT, _handle_signal)
    signal.signal(signal.SIGTERM, _handle_signal)

    from core.trading_mode import is_paper_trading as _is_paper
    mode = "PAPER TRADING" if _is_paper() else "LIVE TRADING"
    logger.info("=" * 55)
    logger.info(f"  TRADING INTELLIGENCE PLATFORM — {mode}")
    logger.info(f"  Brokers: Groww (India) + Delta Exchange (Crypto)")
    logger.info(f"  Time: {_ist_now()}")
    logger.info("=" * 55)

    # Send startup notification
    asyncio.run(_send(
        f"🚀 <b>Platform Started</b>\n"
        f"Mode: <b>{mode}</b>\n"
        f"Time: {_ist_now()}\n"
        f"Brokers: Groww + Delta Exchange India\n"
        f"Agents: Chart Patterns · Sentiment · Fundamentals · Debate · Verdict"
    ))

    # Start Delta WebSocket in background thread (crypto perps — real-time)
    _start_delta_ws_thread()

    # Start Binance WebSocket in background thread (crypto spot/perp prices — real-time)
    def _start_binance_ws_thread():
        def _binance_thread():
            loop = asyncio.new_event_loop()
            asyncio.set_event_loop(loop)
            try:
                from data.crypto_market import start_crypto_stream
                loop.run_until_complete(start_crypto_stream())
            except Exception as e:
                logger.error(f"Binance WS thread error: {e}")
            finally:
                loop.close()
        t = threading.Thread(target=_binance_thread, daemon=True, name="BinanceWS")
        t.start()
        logger.info("✓ Binance WebSocket thread started")

    _start_binance_ws_thread()

    # Start Risk Guardian position monitor in background thread
    _start_position_monitor_thread()

    # Build the full schedule
    build_schedule()

    # Run initial data collection immediately on startup
    logger.info("▶ Running initial data collection...")
    task_delta_snapshot()
    task_crypto_sentiment()   # fear/greed + crypto news on first boot
    task_india_sentiment()
    task_india_data()         # fetch real stock prices right away

    logger.info("✓ Scheduler running — waiting for jobs...")
    logger.info(f"  Next job: {schedule.next_run()}")

    # Main loop
    while not _shutdown:
        schedule.run_pending()
        time.sleep(1)

    logger.info("Scheduler stopped cleanly.")


if __name__ == "__main__":
    main()
