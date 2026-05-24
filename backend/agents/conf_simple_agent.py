"""
agents/conf_simple_agent.py
─────────────────────────────────────────────────────
Confirmation Signals [Simple] — multi-indicator confluence scanner.

Checks four indicators per bar:
  1. RSI(14)            — above 55 = bullish, below 45 = bearish
  2. EMA crossover      — EMA(9) > EMA(21) = bullish
  3. MACD histogram     — positive = bullish, negative = bearish
  4. Volume             — above 20-bar SMA = confirming (adds to dominant side)

Signal output per symbol:
  ≥3 bullish → BUY    (strength: STRONG if 4/4, else MODERATE)
  ≥3 bearish → SELL   (strength: STRONG if 4/4, else MODERATE)
  else       → NEUTRAL

Runs on 5-minute crypto OHLCV from Delta Exchange.
Schedule: every 5 minutes via scheduler.py
Writes:
  • Redis  /conf_simple/crypto/{symbol}  (TTL 3600s)
  • WebSocket broadcast  type="conf_simple_signal"
  • Telegram alert on signal direction flip
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

# ─── Indicator parameters ─────────────────────────────────────────
RSI_LEN          = 14
EMA_FAST         = 9
EMA_SLOW         = 21
MACD_FAST_LEN    = 12
MACD_SLOW_LEN    = 26
MACD_SIGNAL_LEN  = 9
VOL_LEN          = 20
MIN_BARS         = 80
TIMEFRAME        = "5m"

RSI_BULL_THRESH  = 55.0
RSI_BEAR_THRESH  = 45.0

SCAN_SYMBOLS = ["BTCUSD", "ETHUSD", "SOLUSD", "BNBUSD", "AVAXUSD", "XRPUSD"]


# ─── Indicator math ────────────────────────────────────────────────

def _ema(series: np.ndarray, period: int) -> np.ndarray:
    """Standard EMA with SMA seed for the first bar."""
    n = len(series)
    result = np.full(n, np.nan)
    if n < period:
        return result
    result[period - 1] = float(np.mean(series[:period]))
    alpha = 2.0 / (period + 1)
    for i in range(period, n):
        result[i] = series[i] * alpha + result[i - 1] * (1.0 - alpha)
    return result


def _ema_of_series(series: np.ndarray, period: int) -> np.ndarray:
    """EMA that skips leading NaNs before seeding (needed for MACD signal line)."""
    n = len(series)
    result = np.full(n, np.nan)
    valid = np.where(~np.isnan(series))[0]
    if len(valid) < period:
        return result
    seed_start = valid[0]
    seed_end   = seed_start + period
    if seed_end > n:
        return result
    result[seed_end - 1] = float(np.mean(series[seed_start:seed_end]))
    alpha = 2.0 / (period + 1)
    for i in range(seed_end, n):
        if not np.isnan(series[i]):
            result[i] = series[i] * alpha + result[i - 1] * (1.0 - alpha)
        else:
            result[i] = result[i - 1]
    return result


def _rsi(closes: np.ndarray, period: int = RSI_LEN) -> np.ndarray:
    """Wilder-smoothed RSI to match TradingView ta.rsi()."""
    n = len(closes)
    delta  = np.diff(closes, prepend=closes[0])
    gains  = np.where(delta > 0, delta,  0.0)
    losses = np.where(delta < 0, -delta, 0.0)

    avg_gain = np.full(n, np.nan)
    avg_loss = np.full(n, np.nan)
    if n <= period:
        return avg_gain  # all NaN

    avg_gain[period] = float(np.mean(gains[1:period + 1]))
    avg_loss[period] = float(np.mean(losses[1:period + 1]))
    for i in range(period + 1, n):
        avg_gain[i] = (avg_gain[i - 1] * (period - 1) + gains[i])  / period
        avg_loss[i] = (avg_loss[i - 1] * (period - 1) + losses[i]) / period

    with np.errstate(divide='ignore', invalid='ignore'):
        rs  = np.where(avg_loss == 0, np.inf, avg_gain / avg_loss)
        rsi = np.where(np.isinf(rs), 100.0, 100.0 - 100.0 / (1.0 + rs))

    rsi[:period] = np.nan
    return rsi


def compute_conf_simple(closes: np.ndarray, volumes: np.ndarray) -> dict:
    """
    Compute confluence confirmations on the latest bar.
    Returns per-indicator state + aggregate signal.
    """
    # RSI
    rsi_vals = _rsi(closes, RSI_LEN)

    # EMA crossover
    ef = _ema(closes, EMA_FAST)
    es = _ema(closes, EMA_SLOW)

    # MACD
    macd_line = _ema(closes, MACD_FAST_LEN) - _ema(closes, MACD_SLOW_LEN)
    macd_sig  = _ema_of_series(macd_line, MACD_SIGNAL_LEN)
    macd_hist = macd_line - macd_sig

    # Volume MA
    vol_avg = np.array([
        float(np.mean(volumes[max(0, i - VOL_LEN):i])) if i >= VOL_LEN else np.nan
        for i in range(len(volumes))
    ])

    # Latest bar values
    rsi = float(rsi_vals[-1]) if not np.isnan(rsi_vals[-1]) else None
    ef_ = float(ef[-1])       if not np.isnan(ef[-1])       else None
    es_ = float(es[-1])       if not np.isnan(es[-1])       else None
    mh  = float(macd_hist[-1]) if not np.isnan(macd_hist[-1]) else None
    vol = float(volumes[-1])
    va  = float(vol_avg[-1])  if not np.isnan(vol_avg[-1])  else None

    # Per-indicator direction
    rsi_bull  = rsi is not None and rsi > RSI_BULL_THRESH
    rsi_bear  = rsi is not None and rsi < RSI_BEAR_THRESH
    ema_bull  = ef_ is not None and es_ is not None and ef_ > es_
    ema_bear  = ef_ is not None and es_ is not None and ef_ < es_
    macd_bull = mh is not None and mh > 0
    macd_bear = mh is not None and mh < 0
    vol_conf  = va is not None and va > 0 and vol > va

    bull_score = sum([rsi_bull, ema_bull, macd_bull])
    bear_score = sum([rsi_bear, ema_bear, macd_bear])

    # Volume boosts the dominant side
    if vol_conf:
        if bull_score > bear_score:
            bull_score += 1
        elif bear_score > bull_score:
            bear_score += 1

    if bull_score >= 3:
        signal   = "BUY"
        strength = "STRONG" if bull_score >= 4 else "MODERATE"
    elif bear_score >= 3:
        signal   = "SELL"
        strength = "STRONG" if bear_score >= 4 else "MODERATE"
    else:
        signal   = "NEUTRAL"
        strength = "WEAK"

    return {
        "signal":   signal,
        "strength": strength,
        "bull_score": bull_score,
        "bear_score": bear_score,
        "confirmations": {
            "rsi":    {
                "value": round(rsi, 2) if rsi is not None else None,
                "bull": rsi_bull, "bear": rsi_bear,
                "label": f"RSI({RSI_LEN})",
            },
            "ema":    {
                "fast": round(ef_, 4) if ef_ is not None else None,
                "slow": round(es_, 4) if es_ is not None else None,
                "bull": ema_bull, "bear": ema_bear,
                "label": f"EMA({EMA_FAST}/{EMA_SLOW})",
            },
            "macd":   {
                "hist": round(mh, 6) if mh is not None else None,
                "bull": macd_bull, "bear": macd_bear,
                "label": f"MACD({MACD_FAST_LEN},{MACD_SLOW_LEN},{MACD_SIGNAL_LEN})",
            },
            "volume": {
                "value": round(vol, 2),
                "avg":   round(va, 2) if va is not None else None,
                "confirming": vol_conf,
                "label": f"VOL>{VOL_LEN}MA",
            },
        },
    }


# ─── Data fetch ───────────────────────────────────────────────────

def _fetch_5m_ohlcv(symbol: str, limit: int = 200) -> Optional[pd.DataFrame]:
    try:
        end   = int(time.time())
        start = end - limit * 5 * 60
        candles = delta_rest.get_candlestick(symbol, "5m", start, end)
        if not candles or len(candles) < MIN_BARS:
            return None
        df = pd.DataFrame(candles)
        df["timestamp"] = pd.to_datetime(df["timestamp"])
        df = df.sort_values("timestamp").reset_index(drop=True)
        for col in ("open", "high", "low", "close", "volume"):
            df[col] = pd.to_numeric(df[col], errors="coerce")
        return df.dropna(subset=["close", "volume"])
    except Exception as e:
        logger.error(f"Conf Simple fetch [{symbol}]: {e}")
        return None


# ─── Per-symbol analysis ──────────────────────────────────────────

def analyse_symbol(symbol: str) -> Optional[dict]:
    df = _fetch_5m_ohlcv(symbol)
    if df is None or len(df) < MIN_BARS:
        return None

    closes  = df["close"].values.astype(float)
    volumes = df["volume"].values.astype(float)

    result = compute_conf_simple(closes, volumes)

    return {
        "symbol":    symbol,
        "timeframe": TIMEFRAME,
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "bar_time":  df["timestamp"].iloc[-1].isoformat(),
        "close":     round(float(closes[-1]), 4),
        "source":    "conf_simple",
        **result,
    }


# ─── Main scan ────────────────────────────────────────────────────

async def run_conf_simple_scan() -> dict[str, dict]:
    """
    Scan all crypto symbols on 5m bars with Confirmation Signals [Simple].
    Called every 5 minutes by scheduler.py.
    """
    logger.info("▶ Confirmation Signals [Simple] — 5m crypto scan")
    result_map:  dict[str, dict] = {}
    new_signals: list[dict]      = []

    for symbol in SCAN_SYMBOLS:
        try:
            result = await asyncio.to_thread(analyse_symbol, symbol)
            if result is None:
                continue

            prev        = state.get(f"/conf_simple/crypto/{symbol}") or {}
            prev_signal = prev.get("signal")
            is_new_flip = bool(
                prev_signal
                and prev_signal != result["signal"]
                and result["signal"] != "NEUTRAL"
            )

            state.set(f"/conf_simple/crypto/{symbol}", result, ttl=3600)
            result_map[symbol] = result

            icon = "🔔" if is_new_flip else " "
            logger.info(
                f"  {icon} {symbol:<8} 5m  {result['signal']:<7} "
                f"({result['strength']})  "
                f"B:{result['bull_score']} / S:{result['bear_score']}"
            )

            if is_new_flip:
                new_signals.append(result)

        except Exception as e:
            logger.error(f"  ✗ Conf Simple [{symbol}]: {e}")

    if new_signals:
        await _notify(new_signals)

    await _broadcast(result_map)

    logger.info(
        f"✓ Conf Simple — {len(result_map)} symbols scanned, "
        f"{len(new_signals)} new signal(s)"
    )
    return result_map


# ─── Telegram notification ────────────────────────────────────────

async def _notify(signals: list[dict]) -> None:
    from notifications.telegram import send_message, _SEP, _ist_now, _bar

    for s in signals:
        is_buy = s["signal"] == "BUY"
        emoji  = "📈" if is_buy else "📉"
        action = "BUY  ▲" if is_buy else "SELL ▼"
        conf   = s["confirmations"]
        bull_s = s["bull_score"]
        bear_s = s["bear_score"]

        def _tick(bull_ok: bool, bear_ok: bool) -> str:
            return "✅" if (is_buy and bull_ok) or (not is_buy and bear_ok) else "❌"

        rsi_tick  = _tick(conf["rsi"]["bull"],    conf["rsi"]["bear"])
        ema_tick  = _tick(conf["ema"]["bull"],    conf["ema"]["bear"])
        macd_tick = _tick(conf["macd"]["bull"],   conf["macd"]["bear"])
        vol_tick  = "✅" if conf["volume"]["confirming"] else "—"

        msg = "\n".join([
            f"{emoji} <b>CONF SIGNALS {action} — {s['symbol']}</b>",
            _SEP,
            f"<i>5-Minute  ·  {s['strength']}  ·  Crypto</i>",
            "",
            f"Price   <b>${s['close']:,.4f}</b>",
            "",
            f"Bull  {_bar(bull_s * 2.5, 10)}  {bull_s}/4",
            f"Bear  {_bar(bear_s * 2.5, 10)}  {bear_s}/4",
            "",
            "<b>CONFIRMATIONS</b>",
            f"  RSI      {conf['rsi']['value']}  {rsi_tick}",
            f"  EMA      fast/slow cross  {ema_tick}",
            f"  MACD     hist {conf['macd']['hist']}  {macd_tick}",
            f"  Volume   {'above average' if conf['volume']['confirming'] else 'below average'}  {vol_tick}",
            "",
            _SEP,
            f"<i>Confirmation Signals [Simple]  ·  {_ist_now()}</i>",
        ])
        try:
            await send_message(msg, _msg_type="conf_simple_alert")
        except Exception as e:
            logger.warning(f"Conf Simple Telegram send failed: {e}")


# ─── WebSocket broadcast ──────────────────────────────────────────

async def _broadcast(results: dict[str, dict]) -> None:
    try:
        from api import manager
        for symbol, data in results.items():
            await manager.broadcast(
                {"type": "conf_simple_signal", "symbol": symbol, "data": data}
            )
    except Exception:
        pass


# ─── Sync wrapper for scheduler ───────────────────────────────────

def run_conf_simple_scan_sync() -> None:
    asyncio.run(run_conf_simple_scan())
    import pytz
    state.set(
        "/scheduler/last_run/conf_simple",
        datetime.now(pytz.timezone("Asia/Kolkata")).strftime("%H:%M:%S IST"),
        ttl=86400,
    )
