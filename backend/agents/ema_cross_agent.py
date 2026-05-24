"""
agents/ema_cross_agent.py
─────────────────────────────────────────────────────
9/15 EMA Crossover Trading Agent — dual-timeframe strategy.

Strategy rules:
  Signal timeframe  : 15-minute candles
  Entry timeframe   : 5-minute candles (trend alignment check)
  Regime filter     : 1-hour ADX(14) — trending vs ranging

LONG  : 15m EMA(9) crosses ABOVE EMA(15)
         + 5m EMA(9) > EMA(15) (aligned)
         + crossover candle volume >= VOL_THRESHOLD × 20-bar avg
SHORT : 15m EMA(9) crosses BELOW EMA(15)
         + 5m EMA(9) < EMA(15) (aligned)
         + same volume gate

Trade management:
  Stop-loss   : entry ± ATR(14) × ATR_SL_MULT
  Take-profit : entry ± ATR(14) × ATR_TP_MULT
  Trailing    : activates at +1 ATR profit, trails by 0.8 ATR
  Regime      : ADX > 25 → trending (full size)
                ADX < 20 → ranging  (50% size or skip)

Runs on Delta Exchange OHLCV.
Schedule: every 15 minutes via scheduler.py
Writes:
  • Redis  /ema_cross/crypto/{symbol}   (TTL 3600s)
  • Redis  /ema_cross/signals           (aggregated list, TTL 3600s)
  • WebSocket broadcast  type="ema_cross_signal"
  • Telegram alert on every new crossover signal
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

# ─── Strategy hyperparameters (optimisable) ───────────────────────
EMA_FAST          = 9
EMA_SLOW          = 15
ATR_LEN           = 14
VOL_LEN           = 20
ADX_LEN           = 14
MIN_BARS_15M      = 60    # need ≥ 60 × 15m bars to seed all indicators
MIN_BARS_5M       = 60
MIN_BARS_1H       = 50

# Default hyperparameters — bots can override via bot config
ATR_SL_MULT       = 1.5   # optimise: 1.0 – 2.5
ATR_TP_MULT       = 3.0   # optimise: 2.0 – 5.0
VOL_THRESHOLD     = 1.2   # crossover candle must be >= 1.2× 20-bar vol avg
POSITION_SIZE_PCT = 2.0   # default % of equity risked per trade
TRAIL_ACTIVATE    = 1.0   # activate trailing at +1 ATR profit
TRAIL_DISTANCE    = 0.8   # trail by 0.8 ATR

ADX_TRENDING      = 25.0
ADX_RANGING       = 20.0

SCAN_SYMBOLS = ["BTCUSD", "ETHUSD", "SOLUSD", "BNBUSD", "AVAXUSD", "XRPUSD"]


# ─── Indicator math ────────────────────────────────────────────────

def _ema(series: np.ndarray, period: int) -> np.ndarray:
    """Standard EMA — SMA seed on first bar, then recursive formula."""
    n = len(series)
    out = np.full(n, np.nan)
    if n < period:
        return out
    out[period - 1] = float(np.mean(series[:period]))
    alpha = 2.0 / (period + 1)
    for i in range(period, n):
        out[i] = series[i] * alpha + out[i - 1] * (1.0 - alpha)
    return out


def _atr(highs: np.ndarray, lows: np.ndarray, closes: np.ndarray,
         period: int = ATR_LEN) -> np.ndarray:
    """Wilder-smoothed ATR matching TradingView ta.atr()."""
    n = len(closes)
    tr = np.empty(n)
    tr[0] = highs[0] - lows[0]
    for i in range(1, n):
        tr[i] = max(
            highs[i]  - lows[i],
            abs(highs[i]  - closes[i - 1]),
            abs(lows[i]   - closes[i - 1]),
        )
    atr = np.full(n, np.nan)
    if n <= period:
        return atr
    atr[period - 1] = float(np.mean(tr[:period]))
    alpha = 1.0 / period
    for i in range(period, n):
        atr[i] = tr[i] * alpha + atr[i - 1] * (1.0 - alpha)
    return atr


def _adx(highs: np.ndarray, lows: np.ndarray, closes: np.ndarray,
         period: int = ADX_LEN) -> np.ndarray:
    """
    Wilder-smoothed ADX.
    Returns the ADX line (same length as input, NaN until enough bars).
    """
    n = len(closes)
    if n < period * 2 + 1:
        return np.full(n, np.nan)

    # True range
    tr = np.empty(n)
    tr[0] = highs[0] - lows[0]
    # Directional movement
    plus_dm  = np.zeros(n)
    minus_dm = np.zeros(n)
    for i in range(1, n):
        up   = highs[i]  - highs[i - 1]
        down = lows[i - 1] - lows[i]
        tr[i] = max(
            highs[i] - lows[i],
            abs(highs[i]  - closes[i - 1]),
            abs(lows[i]   - closes[i - 1]),
        )
        if up > down and up > 0:
            plus_dm[i] = up
        if down > up and down > 0:
            minus_dm[i] = down

    # Wilder smooth TR, +DM, −DM
    s_tr   = np.full(n, np.nan)
    s_plus = np.full(n, np.nan)
    s_minus= np.full(n, np.nan)
    s_tr[period - 1]    = float(np.sum(tr[:period]))
    s_plus[period - 1]  = float(np.sum(plus_dm[:period]))
    s_minus[period - 1] = float(np.sum(minus_dm[:period]))
    for i in range(period, n):
        s_tr[i]    = s_tr[i - 1]    - s_tr[i - 1]    / period + tr[i]
        s_plus[i]  = s_plus[i - 1]  - s_plus[i - 1]  / period + plus_dm[i]
        s_minus[i] = s_minus[i - 1] - s_minus[i - 1] / period + minus_dm[i]

    with np.errstate(divide='ignore', invalid='ignore'):
        pdi = np.where(s_tr > 0, 100 * s_plus  / s_tr, 0.0)
        mdi = np.where(s_tr > 0, 100 * s_minus / s_tr, 0.0)
        dx  = np.where((pdi + mdi) > 0, 100 * np.abs(pdi - mdi) / (pdi + mdi), 0.0)

    # Smooth DX → ADX
    adx = np.full(n, np.nan)
    seed_idx = 2 * period - 1
    if seed_idx >= n:
        return adx
    adx[seed_idx] = float(np.mean(dx[period - 1: seed_idx + 1]))
    for i in range(seed_idx + 1, n):
        adx[i] = (adx[i - 1] * (period - 1) + dx[i]) / period

    return adx


def _vol_avg(volumes: np.ndarray, period: int = VOL_LEN) -> np.ndarray:
    """Rolling mean volume — partial window at the start."""
    n = len(volumes)
    out = np.full(n, np.nan)
    for i in range(period - 1, n):
        out[i] = float(np.mean(volumes[i - period + 1: i + 1]))
    return out


# ─── Core signal computation ──────────────────────────────────────

def compute_ema_cross_signal(
    df_15m: pd.DataFrame,
    df_5m:  pd.DataFrame,
    df_1h:  pd.DataFrame,
    atr_sl_mult:   float = ATR_SL_MULT,
    atr_tp_mult:   float = ATR_TP_MULT,
    vol_threshold: float = VOL_THRESHOLD,
    pos_size_pct:  float = POSITION_SIZE_PCT,
) -> dict:
    """
    Run all indicator logic and return a structured trade decision.
    Never raises — returns action='HOLD' with reasoning on any error.
    """
    try:
        # ── 15-minute indicators ──────────────────────────────────
        c15 = df_15m["close"].values.astype(float)
        h15 = df_15m["high"].values.astype(float)
        l15 = df_15m["low"].values.astype(float)
        v15 = df_15m["volume"].values.astype(float)

        ef15  = _ema(c15, EMA_FAST)
        es15  = _ema(c15, EMA_SLOW)
        atr15 = _atr(h15, l15, c15, ATR_LEN)
        va15  = _vol_avg(v15, VOL_LEN)

        # ── 5-minute indicators ───────────────────────────────────
        c5  = df_5m["close"].values.astype(float)
        ef5 = _ema(c5, EMA_FAST)
        es5 = _ema(c5, EMA_SLOW)

        # ── 1-hour ADX (regime) ───────────────────────────────────
        c1h = df_1h["close"].values.astype(float)
        h1h = df_1h["high"].values.astype(float)
        l1h = df_1h["low"].values.astype(float)
        adx_arr = _adx(h1h, l1h, c1h, ADX_LEN)

        # ── Latest values ─────────────────────────────────────────
        cur_ef15  = float(ef15[-1])   if not np.isnan(ef15[-1])   else None
        cur_es15  = float(es15[-1])   if not np.isnan(es15[-1])   else None
        prev_ef15 = float(ef15[-2])   if not np.isnan(ef15[-2])   else None
        prev_es15 = float(es15[-2])   if not np.isnan(es15[-2])   else None
        cur_atr   = float(atr15[-1])  if not np.isnan(atr15[-1])  else None
        cur_vol   = float(v15[-1])
        cur_va    = float(va15[-1])   if not np.isnan(va15[-1])   else None
        cur_adx   = float(adx_arr[-1]) if not np.isnan(adx_arr[-1]) else None
        cur_ef5   = float(ef5[-1])    if not np.isnan(ef5[-1])    else None
        cur_es5   = float(es5[-1])    if not np.isnan(es5[-1])    else None
        close     = float(c15[-1])

        # ── Guard: need all values ────────────────────────────────
        if any(v is None for v in [cur_ef15, cur_es15, prev_ef15, prev_es15, cur_atr]):
            return _hold("Insufficient indicator data", close)

        # ── Crossover detection (15m) ─────────────────────────────
        cross_up   = prev_ef15 <= prev_es15 and cur_ef15 > cur_es15
        cross_down = prev_ef15 >= prev_es15 and cur_ef15 < cur_es15

        if cross_up:
            signal_15m = "crossover_up"
        elif cross_down:
            signal_15m = "crossover_down"
        else:
            signal_15m = "none"

        # ── 5m trend alignment ────────────────────────────────────
        if cur_ef5 is not None and cur_es5 is not None:
            aligned_long  = cur_ef5 > cur_es5
            aligned_short = cur_ef5 < cur_es5
        else:
            aligned_long = aligned_short = False

        if signal_15m == "crossover_up":
            signal_5m = "aligned" if aligned_long else "conflicting"
        elif signal_15m == "crossover_down":
            signal_5m = "aligned" if aligned_short else "conflicting"
        else:
            signal_5m = "none"

        # ── Volume confirmation ───────────────────────────────────
        volume_confirmed = (
            cur_va is not None and cur_va > 0
            and cur_vol >= vol_threshold * cur_va
        )

        # ── Market regime ─────────────────────────────────────────
        if cur_adx is None:
            regime = "neutral"
        elif cur_adx >= ADX_TRENDING:
            regime = "trending"
        elif cur_adx <= ADX_RANGING:
            regime = "ranging"
        else:
            regime = "neutral"

        # ── Size adjustment for ranging markets ───────────────────
        effective_size = pos_size_pct if regime != "ranging" else pos_size_pct * 0.5

        # ── Confidence score (0–1) ────────────────────────────────
        confidence = 0.0
        if signal_15m != "none":
            confidence += 0.4
        if signal_5m == "aligned":
            confidence += 0.3
        if volume_confirmed:
            confidence += 0.2
        if regime == "trending":
            confidence += 0.1
        elif regime == "ranging":
            confidence -= 0.1
        confidence = round(max(0.0, min(1.0, confidence)), 2)

        # ── Entry decision ────────────────────────────────────────
        go_long  = (signal_15m == "crossover_up"   and signal_5m == "aligned" and volume_confirmed)
        go_short = (signal_15m == "crossover_down" and signal_5m == "aligned" and volume_confirmed)

        # Skip signals in ranging market (low confidence)
        if regime == "ranging" and confidence < 0.5:
            return {
                "action":           "HOLD",
                "entry_price":      round(close, 4),
                "stop_loss":        None,
                "take_profit":      None,
                "position_size_pct": 0.0,
                "confidence_score": confidence,
                "signal_15m":       signal_15m,
                "signal_5m":        signal_5m,
                "volume_confirmed": volume_confirmed,
                "regime":           regime,
                "adx":              round(cur_adx, 2) if cur_adx else None,
                "ema_fast_15m":     round(cur_ef15, 4),
                "ema_slow_15m":     round(cur_es15, 4),
                "atr":              round(cur_atr, 4),
                "just_fired":       False,
                "reasoning":        f"Ranging market (ADX={cur_adx:.1f}) — signal suppressed",
            }

        if go_long:
            action     = "LONG"
            sl         = round(close - cur_atr * atr_sl_mult, 4)
            tp         = round(close + cur_atr * atr_tp_mult, 4)
            trail_act  = round(close + cur_atr * TRAIL_ACTIVATE, 4)
            trail_dist = round(cur_atr * TRAIL_DISTANCE, 4)
            reasoning  = (
                f"15m EMA({EMA_FAST}) crossed above EMA({EMA_SLOW}) | "
                f"5m aligned long | "
                f"Vol {cur_vol:.0f} ≥ {vol_threshold}× avg {cur_va:.0f} | "
                f"ATR={cur_atr:.2f} | Regime={regime} (ADX={cur_adx:.1f if cur_adx else 'n/a'})"
            )
        elif go_short:
            action     = "SHORT"
            sl         = round(close + cur_atr * atr_sl_mult, 4)
            tp         = round(close - cur_atr * atr_tp_mult, 4)
            trail_act  = round(close - cur_atr * TRAIL_ACTIVATE, 4)
            trail_dist = round(cur_atr * TRAIL_DISTANCE, 4)
            reasoning  = (
                f"15m EMA({EMA_FAST}) crossed below EMA({EMA_SLOW}) | "
                f"5m aligned short | "
                f"Vol {cur_vol:.0f} ≥ {vol_threshold}× avg {cur_va:.0f} | "
                f"ATR={cur_atr:.2f} | Regime={regime} (ADX={cur_adx:.1f if cur_adx else 'n/a'})"
            )
        else:
            parts = []
            if signal_15m == "none":
                parts.append("no 15m crossover")
            elif signal_5m == "conflicting":
                parts.append("5m trend conflicting")
            elif not volume_confirmed:
                parts.append(f"vol {cur_vol:.0f} < {vol_threshold}× avg {cur_va:.0f if cur_va else 0}")
            return {
                "action":           "HOLD",
                "entry_price":      round(close, 4),
                "stop_loss":        None,
                "take_profit":      None,
                "position_size_pct": 0.0,
                "confidence_score": confidence,
                "signal_15m":       signal_15m,
                "signal_5m":        signal_5m,
                "volume_confirmed": volume_confirmed,
                "regime":           regime,
                "adx":              round(cur_adx, 2) if cur_adx else None,
                "ema_fast_15m":     round(cur_ef15, 4),
                "ema_slow_15m":     round(cur_es15, 4),
                "atr":              round(cur_atr, 4),
                "just_fired":       False,
                "reasoning":        "HOLD — " + "; ".join(parts) if parts else "HOLD — no valid signal",
            }

        return {
            "action":            action,
            "entry_price":       round(close, 4),
            "stop_loss":         sl,
            "take_profit":       tp,
            "trail_activate":    trail_act,
            "trail_distance":    trail_dist,
            "position_size_pct": round(effective_size, 2),
            "confidence_score":  confidence,
            "signal_15m":        signal_15m,
            "signal_5m":         signal_5m,
            "volume_confirmed":  volume_confirmed,
            "regime":            regime,
            "adx":               round(cur_adx, 2) if cur_adx else None,
            "ema_fast_15m":      round(cur_ef15, 4),
            "ema_slow_15m":      round(cur_es15, 4),
            "atr":               round(cur_atr, 4),
            "just_fired":        True,
            "reasoning":         reasoning,
        }

    except Exception as exc:
        logger.error(f"ema_cross compute error: {exc}")
        return _hold(f"Compute error: {exc}", 0.0)


def _hold(reason: str, price: float) -> dict:
    return {
        "action":            "HOLD",
        "entry_price":       round(price, 4),
        "stop_loss":         None,
        "take_profit":       None,
        "position_size_pct": 0.0,
        "confidence_score":  0.0,
        "signal_15m":        "none",
        "signal_5m":         "none",
        "volume_confirmed":  False,
        "regime":            "neutral",
        "adx":               None,
        "ema_fast_15m":      None,
        "ema_slow_15m":      None,
        "atr":               None,
        "just_fired":        False,
        "reasoning":         reason,
    }


# ─── Data fetchers ────────────────────────────────────────────────

def _fetch_ohlcv(symbol: str, resolution: str, limit: int,
                 bar_seconds: int) -> Optional[pd.DataFrame]:
    """Fetch OHLCV from Delta Exchange and return a clean DataFrame."""
    try:
        end   = int(time.time())
        start = end - limit * bar_seconds
        candles = delta_rest.get_candlestick(symbol, resolution, start, end)
        if not candles or len(candles) < 30:
            return None
        df = pd.DataFrame(candles)
        df["timestamp"] = pd.to_datetime(df["timestamp"])
        df = df.sort_values("timestamp").reset_index(drop=True)
        for col in ("open", "high", "low", "close", "volume"):
            df[col] = pd.to_numeric(df[col], errors="coerce")
        return df.dropna(subset=["close", "high", "low", "volume"])
    except Exception as e:
        logger.error(f"ema_cross _fetch_ohlcv [{symbol} {resolution}]: {e}")
        return None


def analyse_symbol(
    symbol: str,
    atr_sl_mult:   float = ATR_SL_MULT,
    atr_tp_mult:   float = ATR_TP_MULT,
    vol_threshold: float = VOL_THRESHOLD,
    pos_size_pct:  float = POSITION_SIZE_PCT,
) -> Optional[dict]:
    """Fetch data, run all indicators, return trade decision dict."""
    df_15m = _fetch_ohlcv(symbol, "15m", MIN_BARS_15M + 5, 15 * 60)
    if df_15m is None or len(df_15m) < MIN_BARS_15M:
        logger.debug(f"ema_cross [{symbol}]: insufficient 15m data")
        return None

    df_5m = _fetch_ohlcv(symbol, "5m", MIN_BARS_5M + 5, 5 * 60)
    if df_5m is None or len(df_5m) < MIN_BARS_5M:
        logger.debug(f"ema_cross [{symbol}]: insufficient 5m data")
        return None

    df_1h = _fetch_ohlcv(symbol, "1h", MIN_BARS_1H + 5, 60 * 60)
    if df_1h is None or len(df_1h) < 30:
        # 1h ADX is optional; fall back to empty df (regime will be neutral)
        df_1h = pd.DataFrame(
            {"close": [0.0], "high": [0.0], "low": [0.0]}
        )

    result = compute_ema_cross_signal(
        df_15m, df_5m, df_1h,
        atr_sl_mult=atr_sl_mult,
        atr_tp_mult=atr_tp_mult,
        vol_threshold=vol_threshold,
        pos_size_pct=pos_size_pct,
    )

    result["symbol"]    = symbol
    result["timeframe"] = "15m/5m"
    result["source"]    = "ema_cross"
    result["timestamp"] = datetime.now(timezone.utc).isoformat()
    result["bar_time"]  = df_15m["timestamp"].iloc[-1].isoformat()

    return result


# ─── Main scan ────────────────────────────────────────────────────

async def run_ema_cross_scan(
    symbols: list[str] = None,
    atr_sl_mult:   float = ATR_SL_MULT,
    atr_tp_mult:   float = ATR_TP_MULT,
    vol_threshold: float = VOL_THRESHOLD,
    pos_size_pct:  float = POSITION_SIZE_PCT,
) -> dict[str, dict]:
    """
    Scan all crypto symbols with the 9/15 EMA crossover strategy.
    Called every 15 minutes by scheduler.py.
    Returns map of symbol → result dict.
    """
    watch = symbols or SCAN_SYMBOLS
    logger.info(f"▶ EMA Cross Agent — 15m/5m dual-TF scan ({len(watch)} symbols)")
    result_map:  dict[str, dict] = {}
    new_signals: list[dict]      = []

    for symbol in watch:
        try:
            result = await asyncio.to_thread(
                analyse_symbol, symbol,
                atr_sl_mult, atr_tp_mult, vol_threshold, pos_size_pct,
            )
            if result is None:
                continue

            prev       = state.get(f"/ema_cross/crypto/{symbol}") or {}
            prev_action = prev.get("action", "HOLD")
            is_new_signal = (
                result.get("just_fired")
                and result["action"] != "HOLD"
                and result["action"] != prev_action
            )

            # Store per-symbol result
            state.set(f"/ema_cross/crypto/{symbol}", result, ttl=3600)
            result_map[symbol] = result

            icon = "🔔" if is_new_signal else "  "
            logger.info(
                f"  {icon} {symbol:<8} 15m  {result['action']:<5} "
                f"conf={result['confidence_score']:.2f}  "
                f"regime={result['regime']:<8} "
                f"sig15m={result['signal_15m']}"
            )

            if is_new_signal:
                new_signals.append(result)

        except Exception as e:
            logger.error(f"  ✗ EMA Cross [{symbol}]: {e}")

    # Persist aggregated signals list (last 50)
    existing: list = state.get("/ema_cross/signals") or []
    for sig in new_signals:
        existing.insert(0, sig)
    state.set("/ema_cross/signals", existing[:50], ttl=3600)

    if new_signals:
        await _notify(new_signals)

    await _broadcast(result_map)

    fired_count = len(new_signals)
    logger.info(
        f"✓ EMA Cross — {len(result_map)} symbols scanned, "
        f"{fired_count} new signal(s)"
    )
    return result_map


# ─── Synchronous wrapper (for scheduler.py thread) ────────────────

def run_ema_cross_scan_sync(symbols: list[str] = None) -> None:
    """Synchronous entry point called by the scheduler thread."""
    asyncio.run(run_ema_cross_scan(symbols))


# ─── Telegram notification ────────────────────────────────────────

async def _notify(signals: list[dict]) -> None:
    try:
        from notifications.telegram import send_message, _SEP, _ist_now
    except ImportError:
        return

    for s in signals:
        is_long = s["action"] == "LONG"
        emoji   = "📈" if is_long else "📉"
        action  = "LONG  ▲" if is_long else "SHORT ▼"
        regime_icon = {"trending": "📊", "ranging": "↔️", "neutral": "➖"}.get(s["regime"], "")

        sl_str = f"${s['stop_loss']:,.4f}"  if s.get("stop_loss")  else "—"
        tp_str = f"${s['take_profit']:,.4f}" if s.get("take_profit") else "—"

        msg = "\n".join([
            f"{emoji} <b>EMA CROSS {action} — {s['symbol']}</b>",
            _SEP,
            f"<i>15m signal · 5m confirmed · {s['regime'].title()} {regime_icon}</i>",
            "",
            f"Entry    <b>${s['entry_price']:,.4f}</b>",
            f"Stop     {sl_str}",
            f"Target   {tp_str}",
            f"Size     {s.get('position_size_pct', 0):.1f}% equity",
            "",
            f"EMA(9)   {s.get('ema_fast_15m', '—')}",
            f"EMA(15)  {s.get('ema_slow_15m', '—')}",
            f"ATR(14)  {s.get('atr', '—')}",
            f"ADX(14)  {s.get('adx', '—')}",
            f"Vol conf {'✅' if s.get('volume_confirmed') else '❌'}",
            f"Conf     {s.get('confidence_score', 0):.0%}",
            "",
            f"<i>{s.get('reasoning', '')}</i>",
            _SEP,
            f"<i>EMA Cross Agent · {_ist_now()}</i>",
        ])
        try:
            await send_message(msg, _msg_type="ema_cross_alert")
        except Exception as e:
            logger.warning(f"EMA Cross Telegram error: {e}")


# ─── WebSocket broadcast ──────────────────────────────────────────

async def _broadcast(result_map: dict[str, dict]) -> None:
    try:
        from api import manager
        await manager.broadcast({
            "type":    "ema_cross_signal",
            "symbols": {sym: {
                "action":    r.get("action"),
                "signal_15m": r.get("signal_15m"),
                "signal_5m":  r.get("signal_5m"),
                "confidence": r.get("confidence_score"),
                "regime":    r.get("regime"),
                "entry":     r.get("entry_price"),
                "sl":        r.get("stop_loss"),
                "tp":        r.get("take_profit"),
                "atr":       r.get("atr"),
                "ts":        r.get("timestamp"),
                "just_fired": r.get("just_fired", False),
            } for sym, r in result_map.items()},
        })
    except Exception:
        pass  # WS not available in scheduler process
