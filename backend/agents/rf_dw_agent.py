"""
agents/rf_dw_agent.py
─────────────────────────────────────────────────────
RF [DW] Signal Agent — Python implementation of the
"RF [DW] & Labels" TradingView indicator by David Winkler.

How the indicator works:
  • Computes a "Relative Filter" — an adaptive tracking line that
    moves by exactly `threshold` each bar, hugging price but only
    when price breaks outside the noise band.
  • threshold = ATR(atr_len) × atr_mult   (TV defaults: ATR(5) × 1.0)
  • rf[t] = clamp(close[t], rf[t-1] - threshold, rf[t-1] + threshold)
  • BUY label  → close crosses above rf  (direction flips +1)
  • SELL label → close crosses below rf  (direction flips -1)

Runs on 3-minute crypto OHLCV from Delta Exchange.
Schedule: every 3 minutes via scheduler.py
Writes:
  • Redis   /rf_dw/crypto/{symbol}   (TTL 3600s)
  • Telegram alert on every new direction flip
  • WebSocket broadcast  type="rf_signal"
"""
from __future__ import annotations

import asyncio
import time
from datetime import datetime, timezone
from typing import Optional

import numpy as np
import pandas as pd
from loguru import logger

from core.state_store import state
from data.delta_client import delta_rest

# ─── Indicator parameters (match TradingView defaults) ───────────
ATR_LEN   = 5
ATR_MULT  = 1.0
MIN_BARS  = 50
TIMEFRAME = "3m"

SCAN_SYMBOLS = ["BTCUSD", "ETHUSD", "SOLUSD", "BNBUSD", "AVAXUSD", "XRPUSD"]


# ─── Core RF [DW] computation ─────────────────────────────────────

def compute_rf_dw(
    closes: np.ndarray,
    highs:  np.ndarray,
    lows:   np.ndarray,
    atr_len: int   = ATR_LEN,
    mult:    float = ATR_MULT,
) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """
    Vectorised RF [DW].

    Returns
    -------
    rf          : filter line (same length as input)
    direction   : +1 bullish / -1 bearish per bar
    signal_bars : True where direction just flipped
    """
    n = len(closes)

    # True Range
    tr = np.empty(n)
    tr[0] = highs[0] - lows[0]
    for i in range(1, n):
        tr[i] = max(
            highs[i] - lows[i],
            abs(highs[i] - closes[i - 1]),
            abs(lows[i]  - closes[i - 1]),
        )

    # Wilder-smoothed ATR (matches ta.atr in Pine Script)
    atr = np.empty(n)
    atr[:atr_len] = np.mean(tr[:atr_len])
    alpha = 1.0 / atr_len
    for i in range(atr_len, n):
        atr[i] = atr[i - 1] * (1 - alpha) + tr[i] * alpha

    threshold = atr * mult

    # Relative Filter — clamp close within ±threshold of previous rf
    rf = np.empty(n)
    rf[0] = closes[0]
    for i in range(1, n):
        lo = rf[i - 1] - threshold[i]
        hi = rf[i - 1] + threshold[i]
        rf[i] = max(lo, min(hi, closes[i]))

    # Direction and flip detection
    direction   = np.where(closes >= rf, np.int8(1), np.int8(-1))
    signal_bars = np.zeros(n, dtype=bool)
    for i in range(1, n):
        if direction[i] != direction[i - 1]:
            signal_bars[i] = True

    return rf, direction, signal_bars


# ─── Data fetch ───────────────────────────────────────────────────

def _fetch_3m_ohlcv(symbol: str, limit: int = 200) -> Optional[pd.DataFrame]:
    """Fetch 3-minute OHLCV for symbol from Delta Exchange REST."""
    try:
        end   = int(time.time())
        start = end - limit * 3 * 60
        candles = delta_rest.get_candlestick(symbol, "3m", start, end)
        if not candles or len(candles) < MIN_BARS:
            return None
        df = pd.DataFrame(candles)
        df["timestamp"] = pd.to_datetime(df["timestamp"])
        df = df.sort_values("timestamp").reset_index(drop=True)
        for col in ("open", "high", "low", "close", "volume"):
            df[col] = pd.to_numeric(df[col], errors="coerce")
        return df.dropna(subset=["close"])
    except Exception as e:
        logger.error(f"RF [DW] fetch [{symbol}]: {e}")
        return None


# ─── Per-symbol analysis ──────────────────────────────────────────

def analyse_symbol(symbol: str) -> Optional[dict]:
    """Run RF [DW] on latest 3m data. Returns None if data unavailable."""
    df = _fetch_3m_ohlcv(symbol)
    if df is None or len(df) < MIN_BARS:
        return None

    closes = df["close"].values.astype(float)
    highs  = df["high"].values.astype(float)
    lows   = df["low"].values.astype(float)

    rf, direction, signal_bars = compute_rf_dw(closes, highs, lows)

    current_dir   = int(direction[-1])
    current_close = float(closes[-1])
    current_rf    = float(rf[-1])
    just_fired    = bool(signal_bars[-1])

    rf_dist_pct = round(
        (current_close - current_rf) / current_rf * 100, 3
    ) if current_rf else 0.0

    # Last 10 signal flips (newest first)
    recent = []
    for i in range(len(signal_bars) - 1, max(0, len(signal_bars) - 150), -1):
        if signal_bars[i]:
            recent.append({
                "type":      "BUY"  if direction[i] == 1 else "SELL",
                "price":     round(float(closes[i]), 4),
                "rf":        round(float(rf[i]), 4),
                "timestamp": df["timestamp"].iloc[i].isoformat(),
            })
            if len(recent) >= 10:
                break

    return {
        "symbol":          symbol,
        "timeframe":       TIMEFRAME,
        "timestamp":       datetime.now(timezone.utc).isoformat(),
        "bar_time":        df["timestamp"].iloc[-1].isoformat(),
        "close":           round(current_close, 4),
        "rf":              round(current_rf, 4),
        "direction":       current_dir,
        "signal":          "BUY" if current_dir == 1 else "SELL",
        "just_fired":      just_fired,
        "rf_distance_pct": rf_dist_pct,
        "recent_signals":  recent,
        "params":          {"atr_len": ATR_LEN, "atr_mult": ATR_MULT},
        "source":          "rf_dw_python",
    }


# ─── Main scan ────────────────────────────────────────────────────

async def run_rf_dw_scan() -> dict[str, dict]:
    """
    Scan all crypto symbols on 3m bars with RF [DW].
    Called every 3 minutes by scheduler.py.
    """
    logger.info("▶ RF [DW] — 3m crypto scan")
    results:     dict[str, dict] = {}
    new_signals: list[dict]      = []

    for symbol in SCAN_SYMBOLS:
        try:
            result = await asyncio.to_thread(analyse_symbol, symbol)
            if result is None:
                continue

            # Detect flip vs previous stored state
            prev        = state.get(f"/rf_dw/crypto/{symbol}") or {}
            prev_signal = prev.get("signal")
            is_new_flip = result["just_fired"] or bool(
                prev_signal and prev_signal != result["signal"]
            )

            state.set(f"/rf_dw/crypto/{symbol}", result, ttl=3600)
            results[symbol] = result

            dir_str = "▲ BULLISH" if result["direction"] == 1 else "▼ BEARISH"
            flag    = "🔔" if is_new_flip else " "
            logger.info(
                f"  {flag} {symbol:<8} 3m  RF={result['rf']:.2f}  "
                f"close={result['close']:.2f}  {dir_str}"
                + (f"  ← {result['signal']}" if is_new_flip else "")
            )

            if is_new_flip:
                result["new_flip"] = True
                new_signals.append(result)

        except Exception as e:
            logger.error(f"  ✗ RF [DW] [{symbol}]: {e}")

    if new_signals:
        await _notify(new_signals)

    await _broadcast(results)

    logger.info(
        f"✓ RF [DW] — {len(results)} symbols scanned, "
        f"{len(new_signals)} new signal(s)"
    )
    return results


# ─── Telegram notification ────────────────────────────────────────

async def _notify(signals: list[dict]) -> None:
    from notifications.telegram import send_message, _ist_now

    SEP_HEAVY = "━" * 36
    SEP_LIGHT = "─" * 36

    for s in signals:
        is_buy  = s["signal"] == "BUY"
        dist    = s["rf_distance_pct"]
        dist_s  = f"+{dist:.3f}%" if dist >= 0 else f"{dist:.3f}%"

        # Direction badges
        side_tag   = "🟢 <b>LONG  ▲</b>" if is_buy else "🔴 <b>SHORT ▼</b>"
        header_ico = "📈" if is_buy else "📉"
        bias_line  = "Bullish breakout above RF filter" if is_buy else "Bearish breakdown below RF filter"

        # Recent flip history (last 3, newest first)
        recent = s.get("recent_signals", [])[:3]
        flip_lines = []
        for r in recent:
            r_ico  = "▲" if r["type"] == "BUY" else "▼"
            r_time = r["timestamp"][:16].replace("T", " ") + " UTC"
            flip_lines.append(f"  {r_ico} {r['type']:<4}  ${r['price']:,.4f}  <i>{r_time}</i>")

        # Price display — use monospace block for alignment
        price_block = (
            f"<code>"
            f"{'Price':<8} ${s['close']:>12,.4f}\n"
            f"{'RF':<8} ${s['rf']:>12,.4f}\n"
            f"{'Δ Filter':<8} {dist_s:>13}"
            f"</code>"
        )

        lines = [
            f"{header_ico} <b>RF [DW] SIGNAL — {s['symbol']}</b>",
            SEP_HEAVY,
            f"{side_tag}  ·  {s['symbol']}  ·  Crypto Perpetual",
            f"<i>{bias_line}</i>",
            "",
            price_block,
            "",
            f"⏱  <b>3-Min</b>  ·  ATR({ATR_LEN}) × {ATR_MULT}  ·  Delta Exchange",
        ]

        if flip_lines:
            lines += [
                "",
                SEP_LIGHT,
                "<b>Recent Flips</b>",
            ] + flip_lines

        try:
            await send_message("\n".join(lines), _msg_type="rf_dw_alert")
        except Exception as e:
            logger.warning(f"RF [DW] Telegram send failed: {e}")


# ─── WebSocket broadcast ──────────────────────────────────────────

async def _broadcast(results: dict[str, dict]) -> None:
    try:
        from api import manager
        for symbol, data in results.items():
            await manager.broadcast({"type": "rf_signal", "symbol": symbol, "data": data})
    except Exception:
        pass


# ─── Sync wrapper for scheduler ───────────────────────────────────

def run_rf_dw_scan_sync() -> None:
    asyncio.run(run_rf_dw_scan())
    from core.state_store import state
    from datetime import datetime
    import pytz
    state.set("/scheduler/last_run/rf_dw", datetime.now(pytz.timezone("Asia/Kolkata")).strftime("%H:%M:%S IST"), ttl=86400)