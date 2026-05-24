"""
agents/chart_pattern_agent.py
─────────────────────────────────────────────────────
UnifiedChartPatternAgent — detects chart patterns + computes
technical indicators for ALL instruments (India stocks + crypto).

Uses pandas-ta (pure Python TA-Lib replacement — no C build needed).
Runs on a schedule; writes results to Global State Store.

Timeframes analysed:
  India stocks: 15m, 1h, 4h, 1d
  Crypto:       15m, 1h, 4h, 1d  (24/7)
"""
from __future__ import annotations
import asyncio
import time
from datetime import datetime, timedelta, timezone
from typing import Optional
import logging
import numpy as np
import pandas as pd
logging.getLogger("pandas_ta").setLevel(logging.CRITICAL)
import pandas_ta as ta  # noqa: E402
from loguru import logger

from core.config import (
    INDIA_WATCHLIST, CRYPTO_WATCHLIST,
    MIN_TECHNICAL_SCORE_FOR_DEBATE, MIN_PATTERN_SUCCESS_RATE,
    MTF_WEIGHTS, MTF_BIAS_VALUE, MTF_INDIA_FETCH, MTF_CRYPTO_FETCH,
)
from data.delta_client import DELTA_PERPS
from core.state_store import state
from data.groww_client import groww as groww_client
from data.delta_client import delta_rest


# ─── Pattern success rates (historical, across markets) ──────────
PATTERN_SUCCESS_RATES = {
    "inverse_head_and_shoulders": 0.84,
    "head_and_shoulders":          0.82,
    "double_bottom":               0.82,
    "double_top":                  0.78,
    "cup_and_handle":              0.76,
    "ascending_triangle":          0.73,
    "bull_flag":                   0.73,
    "channel_up":                  0.73,
    "channel_down":                0.72,
    "descending_triangle":         0.72,
    "falling_wedge":               0.71,
    "rising_wedge":                0.68,
    "rounding_bottom":             0.67,
    "bear_flag":                   0.66,
    "pennant":                     0.65,
    "symmetrical_triangle":        0.60,
    "doji":                        0.55,
    "hammer":                      0.60,
    "bullish_engulfing":           0.63,
    "bearish_engulfing":           0.63,
    "morning_star":                0.70,
    "evening_star":                0.70,
    "shooting_star":               0.58,
    "inverted_hammer":             0.60,
}


# ─── Main agent function ─────────────────────────────────────────

async def run_chart_pattern_agent(market: str = "india") -> dict:
    """
    Run full chart pattern scan for all instruments in a market.
    market: "india" | "crypto"
    """
    logger.info(f"▶ UnifiedChartPatternAgent [{market}] — scanning")
    results = {}

    if market == "india":
        symbols = [s.replace(".NS", "") for s in INDIA_WATCHLIST]
        for sym in symbols:
            try:
                data = await _fetch_india_ohlcv(sym, "1d", 200)
                if data is not None and len(data) >= 50:
                    analysis = analyse(data, sym, "india", "1d")
                    state.write_chart_data("india", sym, analysis)
                    results[sym] = analysis
                    _log_analysis(sym, analysis)
            except Exception as e:
                logger.error(f"  ✗ {sym}: {e}")
            await asyncio.sleep(0.3)

    elif market == "crypto":
        for symbol in list(DELTA_PERPS.values()):
            try:
                data = await _fetch_crypto_ohlcv(symbol, "1D", 200)
                if data is not None and len(data) >= 50:
                    analysis = analyse(data, symbol, "crypto", "1d")
                    state.write_chart_data("crypto", symbol, analysis)
                    results[symbol] = analysis
                    _log_analysis(symbol, analysis)
            except Exception as e:
                logger.error(f"  ✗ {symbol}: {e}")
            await asyncio.sleep(0.3)

    # Find debate-worthy setups (1D filter)
    high_score = [
        {"symbol": sym, **res}
        for sym, res in results.items()
        if res.get("technical_score", 0) >= MIN_TECHNICAL_SCORE_FOR_DEBATE
        and res.get("overall_bias") in ("strong_bullish", "bullish")
    ]
    high_score.sort(key=lambda x: x.get("technical_score", 0), reverse=True)
    top_candidates = high_score[:10]

    # ── MTF pass: 4H / 1H / 15m / 5m analysis for top candidates only ──
    if top_candidates:
        logger.info(
            f"  MTF analysis — {len(top_candidates)} candidates "
            f"({market}): {[s['symbol'] for s in top_candidates]}"
        )
        mtf_tasks = [
            analyse_multi_timeframe(s["symbol"], market)
            for s in top_candidates
        ]
        mtf_results = await asyncio.gather(*mtf_tasks, return_exceptions=True)

        aligned_watch = []
        for entry, mtf in zip(top_candidates, mtf_results):
            sym = entry["symbol"]
            if isinstance(mtf, Exception) or not isinstance(mtf, dict):
                logger.debug(f"  MTF failed for {sym}: {mtf}")
                entry["mtf_alignment"]    = 0.0
                entry["higher_tf_aligned"]= False
                entry["entry_tf"]         = "1d"
                entry["mtf_summary"]      = "no data"
                aligned_watch.append(entry)
                continue

            state.set(f"/chart_mtf/{market}/{sym}", mtf, ttl=3600)
            entry["mtf_alignment"]    = mtf["alignment_score"]
            entry["higher_tf_aligned"]= mtf["higher_tf_aligned"]
            entry["entry_tf"]         = mtf["entry_tf"]
            entry["mtf_summary"]      = mtf["mtf_summary"]
            entry["consensus_bias"]   = mtf["consensus_bias"]

            logger.info(
                f"  MTF {sym}: {mtf['mtf_summary']}  "
                f"aligned={mtf['higher_tf_aligned']}  "
                f"entry_tf={mtf['entry_tf']}"
            )
            aligned_watch.append(entry)

        # Sort: prefer 1D+4H aligned candidates first
        aligned_watch.sort(
            key=lambda x: (x.get("higher_tf_aligned", False), x.get("mtf_alignment", 0)),
            reverse=True,
        )
        state.set(f"/watch_list/{market}", aligned_watch, ttl=900)
    else:
        state.set(f"/watch_list/{market}", [], ttl=900)

    aligned_count = sum(1 for s in top_candidates if s.get("higher_tf_aligned", False))
    logger.info(
        f"✓ ChartPatternAgent [{market}] — {len(results)} scanned, "
        f"{len(top_candidates)} 1D setups, {aligned_count} MTF-aligned"
    )
    return results


# ─── Core analysis function ───────────────────────────────────────

def analyse(df: pd.DataFrame, symbol: str,
            market: str, timeframe: str) -> dict:
    """
    Run full technical analysis on a OHLCV DataFrame.
    Returns the standard chart analysis dict.
    """
    df = df.copy()

    # ── Compute indicators via pandas-ta ──────────────────────────
    df.ta.rsi(length=14, append=True)
    df.ta.macd(fast=12, slow=26, signal=9, append=True)
    df.ta.bbands(length=20, std=2, append=True)
    df.ta.ema(length=20, append=True)
    df.ta.ema(length=50, append=True)
    df.ta.ema(length=200, append=True)
    df.ta.adx(length=14, append=True)
    df.ta.stoch(k=14, d=3, append=True)
    df.ta.atr(length=14, append=True)
    df.ta.vwap(append=True) if "volume" in df.columns else None

    # ── Candlestick patterns via pandas-ta ────────────────────────
    df.ta.cdl_pattern(name="all", append=True)

    latest = df.iloc[-1]

    # ── RSI ───────────────────────────────────────────────────────
    rsi = _safe(latest, "RSI_14")
    rsi_signal = (
        "oversold"   if rsi and rsi < 30 else
        "overbought" if rsi and rsi > 70 else
        "neutral"
    )
    rsi_divergence = _detect_rsi_divergence(df)

    # ── MACD ──────────────────────────────────────────────────────
    macd_line   = _safe(latest, "MACD_12_26_9")
    macd_signal = _safe(latest, "MACDs_12_26_9")
    macd_hist   = _safe(latest, "MACDh_12_26_9")
    prev_hist   = _safe(df.iloc[-2], "MACDh_12_26_9") if len(df) > 1 else 0

    macd_sig = "neutral"
    if macd_line and macd_signal:
        prev_macd = _safe(df.iloc[-2], "MACD_12_26_9") if len(df) > 1 else 0
        prev_ms   = _safe(df.iloc[-2], "MACDs_12_26_9") if len(df) > 1 else 0
        if prev_macd and prev_ms:
            if prev_macd < prev_ms and macd_line >= macd_signal:
                macd_sig = "bullish_cross"
            elif prev_macd > prev_ms and macd_line <= macd_signal:
                macd_sig = "bearish_cross"
        macd_sig = "bullish" if macd_line > macd_signal else "bearish" if macd_sig == "neutral" else macd_sig

    hist_dir = "expanding" if (macd_hist and prev_hist and abs(macd_hist) > abs(prev_hist)) else "contracting"

    # ── Bollinger Bands ───────────────────────────────────────────
    bb_upper = _safe(latest, "BBU_20_2.0")
    bb_lower = _safe(latest, "BBL_20_2.0")
    bb_mid   = _safe(latest, "BBM_20_2.0")
    close    = float(latest.get("close", latest.get("Close", 0)))

    bb_pos = "middle"
    if bb_upper and bb_lower and close:
        bb_width = (bb_upper - bb_lower) / bb_mid if bb_mid else 0
        if bb_width < 0.015:
            bb_pos = "squeeze"
        elif close >= bb_upper:
            bb_pos = "upper"
        elif close <= bb_lower:
            bb_pos = "lower"

    # ── EMA Alignment ─────────────────────────────────────────────
    ema20  = _safe(latest, "EMA_20")
    ema50  = _safe(latest, "EMA_50")
    ema200 = _safe(latest, "EMA_200")

    ema_alignment = "mixed"
    if ema20 and ema50 and ema200 and close:
        if close > ema20 > ema50 > ema200:
            ema_alignment = "full_bull"
        elif close < ema20 < ema50 < ema200:
            ema_alignment = "full_bear"

    # ── ADX (Trend Strength) ──────────────────────────────────────
    adx = _safe(latest, "ADX_14")
    trend_strength = (
        "strong"   if adx and adx > 30 else
        "moderate" if adx and adx > 20 else
        "ranging"
    )

    # ── Volume ────────────────────────────────────────────────────
    vol_col = "volume" if "volume" in df.columns else "Volume"
    volume  = float(latest.get(vol_col, 0))
    avg_vol = df[vol_col].rolling(20).mean().iloc[-1] if vol_col in df.columns else 0
    vol_ratio = volume / avg_vol if avg_vol > 0 else 1.0
    vol_signal = (
        "high_conviction" if vol_ratio > 2.0 else
        "low_conviction"  if vol_ratio < 0.5 else
        "normal"
    )

    # ── ATR (for stop placement) ──────────────────────────────────
    atr = _safe(latest, "ATRr_14")

    # ── Key Levels ────────────────────────────────────────────────
    support, resistance = _find_key_levels(df, close)
    fib_levels          = _calculate_fibonacci(df)

    # ── SMC Analysis ─────────────────────────────────────────────
    smc = _detect_smc(df, close, atr, fib_levels)

    # ── Chart Pattern Detection ───────────────────────────────────
    patterns = _detect_chart_patterns(df, close, support, resistance, atr)

    # Supplement with pandas-ta candlestick patterns
    patterns += _extract_cdl_patterns(df)

    # Filter by minimum success rate
    patterns = [p for p in patterns
                if p.get("success_rate", 0) >= MIN_PATTERN_SUCCESS_RATE]

    # ── Overall Bias Score (0–10) ─────────────────────────────────
    tech_score = _compute_technical_score(
        rsi, rsi_signal, rsi_divergence,
        macd_sig, hist_dir,
        bb_pos, ema_alignment,
        vol_signal, adx, patterns,
        smc=smc,
    )

    overall_bias = (
        "strong_bullish" if tech_score >= 8 else
        "bullish"        if tech_score >= 6 else
        "neutral"        if tech_score >= 4 else
        "bearish"        if tech_score >= 2 else
        "strong_bearish"
    )

    return {
        "symbol":    symbol,
        "market":    market,
        "timeframe": timeframe,
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "patterns_active": patterns,
        "indicators": {
            "rsi":                     round(rsi, 2) if rsi else None,
            "rsi_signal":              rsi_signal,
            "rsi_divergence":          rsi_divergence,
            "macd_signal":             macd_sig,
            "macd_histogram_direction": hist_dir,
            "bb_position":             bb_pos,
            "ema_alignment":           ema_alignment,
            "ema20":   round(ema20,  2) if ema20  else None,
            "ema50":   round(ema50,  2) if ema50  else None,
            "ema200":  round(ema200, 2) if ema200 else None,
            "adx":     round(adx, 2) if adx else None,
            "trend_strength":          trend_strength,
            "volume_ratio":            round(vol_ratio, 2),
            "volume_signal":           vol_signal,
            "atr":     round(atr, 2) if atr else None,
            "atr_stop_long":  round(close - 1.5 * atr, 2) if (atr and close) else None,
            "atr_stop_short": round(close + 1.5 * atr, 2) if (atr and close) else None,
        },
        "key_levels": {
            "current_price": round(close, 2),
            "support":       [round(s, 2) for s in support[:2]],
            "resistance":    [round(r, 2) for r in resistance[:2]],
            "fib_23":        fib_levels.get("23.6"),
            "fib_38":        fib_levels.get("38.2"),
            "fib_50":        fib_levels.get("50.0"),
            "fib_61":        fib_levels.get("61.8"),
            "fib_78":        fib_levels.get("78.6"),
            "fib_ext_127":   fib_levels.get("127.2"),
            "fib_ext_161":   fib_levels.get("161.8"),
        },
        "overall_bias":    overall_bias,
        "technical_score": round(tech_score, 2),
        "smc":             smc,
    }


# ─── Pattern detectors ────────────────────────────────────────────

def _detect_chart_patterns(df: pd.DataFrame, close: float,
                            support: list, resistance: list,
                            atr: Optional[float]) -> list[dict]:
    """Detect multi-candle chart patterns from price structure."""
    patterns = []
    highs  = df["high"].values  if "high"  in df.columns else df["High"].values
    lows   = df["low"].values   if "low"   in df.columns else df["Low"].values
    closes = df["close"].values if "close" in df.columns else df["Close"].values
    vols   = df["volume"].values if "volume" in df.columns else (
             df["Volume"].values if "Volume" in df.columns else np.ones(len(closes)))
    avg_vol = np.mean(vols[-20:])

    tol = 0.02  # 2% tolerance for pattern matching

    # ── Double Bottom ─────────────────────────────────────────────
    if len(lows) >= 30:
        recent_lows = lows[-30:]
        l1_idx = np.argmin(recent_lows[:15])
        l2_idx = 15 + np.argmin(recent_lows[15:])
        l1, l2  = recent_lows[l1_idx], recent_lows[l2_idx]
        if l1 > 0 and abs(l1 - l2) / l1 < tol:
            neckline   = max(recent_lows[l1_idx:l2_idx]) if l2_idx > l1_idx else close
            vol_ok     = vols[-1] > avg_vol * 1.5
            target     = neckline + (neckline - l2)
            patterns.append({
                "name": "double_bottom", "type": "reversal",
                "direction": "bullish", "completion": "complete",
                "volume_confirmed": bool(vol_ok),
                "success_rate": PATTERN_SUCCESS_RATES["double_bottom"],
                "price_target": round(target, 2),
                "invalidation": round(min(l1, l2) * 0.99, 2),
            })

    # ── Double Top ────────────────────────────────────────────────
    if len(highs) >= 30:
        recent_highs = highs[-30:]
        h1_idx = np.argmax(recent_highs[:15])
        h2_idx = 15 + np.argmax(recent_highs[15:])
        h1, h2  = recent_highs[h1_idx], recent_highs[h2_idx]
        if h1 > 0 and abs(h1 - h2) / h1 < tol:
            neckline = min(recent_highs[h1_idx:h2_idx]) if h2_idx > h1_idx else close
            target   = neckline - (h2 - neckline)
            patterns.append({
                "name": "double_top", "type": "reversal",
                "direction": "bearish", "completion": "complete",
                "volume_confirmed": True,
                "success_rate": PATTERN_SUCCESS_RATES["double_top"],
                "price_target": round(target, 2),
                "invalidation": round(max(h1, h2) * 1.01, 2),
            })

    # ── Bull Flag ─────────────────────────────────────────────────
    if len(closes) >= 20:
        pole_pct = (closes[-10] - closes[-20]) / closes[-20] if closes[-20] > 0 else 0
        flag_max = max(closes[-10:])
        flag_min = min(closes[-10:])
        flag_range = (flag_max - flag_min) / flag_max if flag_max > 0 else 1
        if pole_pct > 0.08 and flag_range < 0.05:
            target = close + (closes[-10] - closes[-20])
            patterns.append({
                "name": "bull_flag", "type": "continuation",
                "direction": "bullish", "completion": "forming",
                "volume_confirmed": bool(vols[-1] > avg_vol * 0.8),
                "success_rate": PATTERN_SUCCESS_RATES["bull_flag"],
                "price_target": round(target, 2),
                "invalidation": round(flag_min * 0.99, 2),
            })

    # ── Ascending Triangle ────────────────────────────────────────
    if len(highs) >= 20 and len(lows) >= 20:
        flat_top = np.std(highs[-10:]) / np.mean(highs[-10:]) < 0.01
        rising_lows = np.polyfit(range(10), lows[-10:], 1)[0] > 0
        if flat_top and rising_lows:
            target = np.mean(highs[-10:]) + (np.mean(highs[-10:]) - min(lows[-10:]))
            patterns.append({
                "name": "ascending_triangle", "type": "continuation",
                "direction": "bullish", "completion": "forming",
                "volume_confirmed": bool(vols[-1] > avg_vol),
                "success_rate": PATTERN_SUCCESS_RATES["ascending_triangle"],
                "price_target": round(target, 2),
                "invalidation": round(min(lows[-5:]) * 0.99, 2),
            })

    # ── Descending Triangle ───────────────────────────────────────
    if len(highs) >= 20 and len(lows) >= 20:
        flat_bot   = np.std(lows[-10:]) / np.mean(lows[-10:]) < 0.01
        lower_highs = np.polyfit(range(10), highs[-10:], 1)[0] < 0
        if flat_bot and lower_highs:
            target = np.mean(lows[-10:]) - (max(highs[-10:]) - np.mean(lows[-10:]))
            patterns.append({
                "name": "descending_triangle", "type": "continuation",
                "direction": "bearish", "completion": "forming",
                "volume_confirmed": True,
                "success_rate": PATTERN_SUCCESS_RATES["descending_triangle"],
                "price_target": round(target, 2),
                "invalidation": round(max(highs[-5:]) * 1.01, 2),
            })

    # ── Multi-year Breakout (India stocks special case) ───────────
    if len(highs) >= 120 and close > 0:
        year_high = max(highs[-120:])
        if close >= year_high * 0.99 and vols[-1] > avg_vol * 2:
            target = close * 1.5  # 50% move
            patterns.append({
                "name": "multi_year_breakout", "type": "continuation",
                "direction": "bullish", "completion": "complete",
                "volume_confirmed": True,
                "success_rate": 0.75,
                "price_target": round(target, 2),
                "invalidation": round(year_high * 0.97, 2),
            })

    return patterns


def _extract_cdl_patterns(df: pd.DataFrame) -> list[dict]:
    """Extract candlestick patterns detected by pandas-ta cdl_pattern."""
    patterns = []
    cdl_cols = [c for c in df.columns if c.startswith("CDL_")]
    latest   = df.iloc[-1]

    cdl_map = {
        "CDL_HAMMER":           ("hammer",          "bullish", "reversal"),
        "CDL_INVERTED_HAMMER":  ("inverted_hammer",  "bullish", "reversal"),
        "CDL_MORNINGSTAR":      ("morning_star",      "bullish", "reversal"),
        "CDL_EVENINGSTAR":      ("evening_star",      "bearish", "reversal"),
        "CDL_ENGULFING":        ("bullish_engulfing", "bullish", "reversal"),
        "CDL_SHOOTINGSTAR":     ("shooting_star",     "bearish", "reversal"),
        "CDL_DOJI_10_0.1":      ("doji",              "neutral", "reversal"),
    }

    for col, (name, direction, ptype) in cdl_map.items():
        matching = [c for c in cdl_cols if col in c]
        if not matching:
            continue
        val = latest.get(matching[0], 0)
        if val and abs(val) > 0:
            actual_dir = "bullish" if val > 0 else "bearish"
            patterns.append({
                "name": name, "type": ptype,
                "direction": actual_dir,
                "completion": "complete",
                "volume_confirmed": False,  # candlestick doesn't use volume
                "success_rate": PATTERN_SUCCESS_RATES.get(name, 0.60),
                "price_target": None,
                "invalidation": None,
            })
    return patterns


# ─── Technical Score ─────────────────────────────────────────────

def _compute_technical_score(rsi, rsi_signal, rsi_div,
                              macd_sig, hist_dir,
                              bb_pos, ema_align,
                              vol_signal, adx, patterns,
                              smc: dict | None = None) -> float:
    """
    Compute composite technical score 0–10.
    Weighted across classic indicators + SMC structure signals.
    """
    score = 5.0  # Start neutral

    # RSI contribution (±1.5)
    if rsi_signal == "oversold":        score += 1.0
    elif rsi_signal == "overbought":    score -= 1.0
    if rsi_div == "bullish":            score += 0.5
    elif rsi_div == "bearish":          score -= 0.5

    # MACD contribution (±1.5)
    if macd_sig in ("bullish", "bullish_cross"):   score += 1.0
    elif macd_sig in ("bearish", "bearish_cross"):  score -= 1.0
    if hist_dir == "expanding" and macd_sig in ("bullish", "bullish_cross"):
        score += 0.5

    # EMA alignment (±1.5)
    if ema_align == "full_bull":   score += 1.5
    elif ema_align == "full_bear": score -= 1.5

    # Bollinger Bands (±0.5)
    if bb_pos == "lower":    score += 0.5  # potential mean-reversion
    elif bb_pos == "upper":  score -= 0.3

    # Volume (±0.5)
    if vol_signal == "high_conviction":   score += 0.5
    elif vol_signal == "low_conviction":  score -= 0.3

    # Patterns (each strong pattern ±0.5)
    for p in patterns:
        sr    = p.get("success_rate", 0.5)
        bonus = (sr - 0.5) * 2  # 0.70 sr → +0.40 bonus
        if p.get("direction") == "bullish":
            score += bonus
        elif p.get("direction") == "bearish":
            score -= bonus

    # SMC structure contribution (±1.6 max)
    if smc:
        struct = smc.get("structure", "")
        if struct in ("bullish_bos", "choch_bullish"):
            score += 0.6
        elif struct in ("bearish_bos", "choch_bearish"):
            score -= 0.6
        if smc.get("in_discount"):
            score += 0.3    # below 50% fib — demand zone
        elif smc.get("in_premium"):
            score -= 0.3    # above 50% fib — supply zone
        swept = smc.get("liquidity_swept")
        if swept == "sell_side":
            score += 0.5    # smart money swept stops → reversal likely
        elif swept == "buy_side":
            score -= 0.5
        if smc.get("nearest_bullish_ob"):
            score += 0.2    # demand OB supporting price
        if smc.get("nearest_bearish_ob"):
            score -= 0.2    # supply OB pressing from above

    return max(0.0, min(10.0, score))


# ─── Helper functions ─────────────────────────────────────────────

def _detect_rsi_divergence(df: pd.DataFrame) -> Optional[str]:
    """Detect bullish or bearish RSI divergence over last 20 candles."""
    try:
        rsi_col   = "RSI_14"
        close_col = "close" if "close" in df.columns else "Close"
        if rsi_col not in df.columns or len(df) < 20:
            return None
        recent = df.tail(20)
        p_low  = recent[close_col].iloc[-1] < recent[close_col].iloc[:-1].min()
        r_high = recent[rsi_col].iloc[-1]   > recent[rsi_col].iloc[:-1].min()
        if p_low and r_high:
            return "bullish"
        p_high = recent[close_col].iloc[-1] > recent[close_col].iloc[:-1].max()
        r_low  = recent[rsi_col].iloc[-1]   < recent[rsi_col].iloc[:-1].max()
        if p_high and r_low:
            return "bearish"
    except Exception:
        pass
    return None


def _find_key_levels(df: pd.DataFrame, close: float) -> tuple[list, list]:
    """Find nearest support and resistance levels from historical price."""
    high_col  = "high" if "high" in df.columns else "High"
    low_col   = "low"  if "low"  in df.columns else "Low"
    recent    = df.tail(60)
    all_highs = recent[high_col].values
    all_lows  = recent[low_col].values

    # Simple approach: find local maxima/minima
    resistance = sorted([h for h in all_highs if h > close * 1.005], reverse=False)[:3]
    support    = sorted([l for l in all_lows   if l < close * 0.995], reverse=True)[:3]
    return support, resistance


def _detect_smc(df: pd.DataFrame, close: float,
                atr: Optional[float], fib_levels: dict) -> dict:
    """
    Smart Money Concepts engine.

    Detects:
      - Swing highs/lows → market structure (BOS / CHoCH)
      - Order Blocks (OB): last opposing candle before an impulse move
      - Fair Value Gaps (FVG): three-candle price imbalances
      - Liquidity levels: SSL (equal lows) and BSL (equal highs)
      - Liquidity sweeps: wick through level + close back inside
      - Premium / Discount zone via 50% Fibonacci midpoint
    """
    h_col = "high"  if "high"  in df.columns else "High"
    l_col = "low"   if "low"   in df.columns else "Low"
    o_col = "open"  if "open"  in df.columns else "Open"
    c_col = "close" if "close" in df.columns else "Close"

    highs  = df[h_col].values.astype(float)
    lows   = df[l_col].values.astype(float)
    opens  = df[o_col].values.astype(float)
    closes = df[c_col].values.astype(float)
    n = len(closes)
    if n < 20:
        return {}

    # ── Swing Highs / Lows (lookback = 5 bars each side) ─────────
    lb = 5
    swing_highs: list[tuple[int, float]] = []
    swing_lows:  list[tuple[int, float]] = []
    for i in range(lb, n - lb):
        if highs[i] == max(highs[i - lb: i + lb + 1]):
            swing_highs.append((i, float(highs[i])))
        if lows[i] == min(lows[i - lb: i + lb + 1]):
            swing_lows.append((i, float(lows[i])))

    # ── Market Trend (HH+HL = uptrend; LH+LL = downtrend) ────────
    trend = "ranging"
    if len(swing_highs) >= 2 and len(swing_lows) >= 2:
        hh = swing_highs[-1][1] > swing_highs[-2][1]
        hl = swing_lows[-1][1]  > swing_lows[-2][1]
        lh = swing_highs[-1][1] < swing_highs[-2][1]
        ll = swing_lows[-1][1]  < swing_lows[-2][1]
        if hh and hl:
            trend = "uptrend"
        elif lh and ll:
            trend = "downtrend"

    last_sh = swing_highs[-1][1] if swing_highs else None
    last_sl = swing_lows[-1][1]  if swing_lows  else None

    # ── BOS / CHoCH ───────────────────────────────────────────────
    structure = "ranging"
    if trend == "uptrend":
        if last_sh and close > last_sh:
            structure = "bullish_bos"       # continuation
        elif last_sl and close < last_sl:
            structure = "choch_bearish"     # trend reversal
    elif trend == "downtrend":
        if last_sl and close < last_sl:
            structure = "bearish_bos"       # continuation
        elif last_sh and close > last_sh:
            structure = "choch_bullish"     # trend reversal
    else:
        if last_sh and close > last_sh:
            structure = "choch_bullish"
        elif last_sl and close < last_sl:
            structure = "choch_bearish"

    # ── Order Blocks (last 50 candles) ────────────────────────────
    impulse_min = (atr * 1.0) if atr else (close * 0.01)
    bullish_obs: list[dict] = []
    bearish_obs: list[dict] = []

    for i in range(max(0, n - 50), n - 3):
        move = abs(float(closes[i + 3]) - float(closes[i]))
        if move < impulse_min:
            continue
        # Bullish OB: bearish candle immediately before an up-impulse
        if closes[i] < opens[i] and closes[i + 3] > closes[i]:
            ob = {
                "high":     round(float(max(opens[i], closes[i])), 2),
                "low":      round(float(min(opens[i], closes[i])), 2),
                "strength": "strong" if move > impulse_min * 2 else "weak",
                "age_bars": n - 1 - i,
            }
            if close >= ob["low"] * 0.99:   # not yet invalidated
                bullish_obs.append(ob)
        # Bearish OB: bullish candle immediately before a down-impulse
        if closes[i] > opens[i] and closes[i + 3] < closes[i]:
            ob = {
                "high":     round(float(max(opens[i], closes[i])), 2),
                "low":      round(float(min(opens[i], closes[i])), 2),
                "strength": "strong" if move > impulse_min * 2 else "weak",
                "age_bars": n - 1 - i,
            }
            if close <= ob["high"] * 1.01:   # not yet invalidated
                bearish_obs.append(ob)

    # Nearest OBs relative to current price
    bull_obs_below = sorted(
        [o for o in bullish_obs if o["high"] <= close * 1.01],
        key=lambda x: close - x["high"],
    )[:2]
    bear_obs_above = sorted(
        [o for o in bearish_obs if o["low"] >= close * 0.99],
        key=lambda x: x["low"] - close,
    )[:2]

    # ── Fair Value Gaps (three-candle imbalance) ──────────────────
    min_gap = close * 0.002   # at least 0.2% to be meaningful
    bullish_fvgs: list[dict] = []
    bearish_fvgs: list[dict] = []

    for i in range(2, n):
        # Bullish FVG: candle[i-2].high < candle[i].low
        if lows[i] > highs[i - 2] and (lows[i] - highs[i - 2]) >= min_gap:
            bullish_fvgs.append({
                "top":      round(float(lows[i]), 2),
                "bottom":   round(float(highs[i - 2]), 2),
                "filled":   bool(close <= float(lows[i]) and close >= float(highs[i - 2])),
                "age_bars": n - 1 - i,
            })
        # Bearish FVG: candle[i-2].low > candle[i].high
        if highs[i] < lows[i - 2] and (lows[i - 2] - highs[i]) >= min_gap:
            bearish_fvgs.append({
                "top":      round(float(lows[i - 2]), 2),
                "bottom":   round(float(highs[i]), 2),
                "filled":   bool(close >= float(highs[i]) and close <= float(lows[i - 2])),
                "age_bars": n - 1 - i,
            })

    # Keep only recent unfilled FVGs
    bullish_fvgs = sorted(
        [f for f in bullish_fvgs if not f["filled"] and f["age_bars"] <= 30],
        key=lambda x: x["age_bars"],
    )[:2]
    bearish_fvgs = sorted(
        [f for f in bearish_fvgs if not f["filled"] and f["age_bars"] <= 30],
        key=lambda x: x["age_bars"],
    )[:2]

    # ── Liquidity Levels (SSL / BSL) ─────────────────────────────
    # SSL = sell-side liquidity (equal lows cluster below price)
    # BSL = buy-side liquidity (equal highs cluster above price)
    ssl = sorted(
        list({round(float(sl[1]), 2) for sl in swing_lows[-8:] if sl[1] < close * 0.997}),
        reverse=True,
    )[:3]
    bsl = sorted(
        list({round(float(sh[1]), 2) for sh in swing_highs[-8:] if sh[1] > close * 1.003}),
    )[:3]

    # ── Liquidity Sweeps (last 5 candles) ────────────────────────
    liquidity_swept = None
    for level in ssl[:2]:
        for i in range(max(0, n - 5), n):
            if lows[i] < level and closes[i] > level:
                liquidity_swept = "sell_side"
                break
        if liquidity_swept:
            break
    if not liquidity_swept:
        for level in bsl[:2]:
            for i in range(max(0, n - 5), n):
                if highs[i] > level and closes[i] < level:
                    liquidity_swept = "buy_side"
                    break
            if liquidity_swept:
                break

    # ── Premium / Discount ────────────────────────────────────────
    mid_fib    = fib_levels.get("50.0")
    in_discount = bool(mid_fib and close < mid_fib)
    in_premium  = bool(mid_fib and close > mid_fib)

    # ── Nearest relevant levels ───────────────────────────────────
    nearest_bullish_ob = bull_obs_below[0] if bull_obs_below else None
    nearest_bearish_ob = bear_obs_above[0] if bear_obs_above else None

    unfilled_bull_below = [f for f in bullish_fvgs if f["top"] < close]
    nearest_fvg = (
        max(unfilled_bull_below, key=lambda x: x["top"])
        if unfilled_bull_below else None
    )

    return {
        "structure":          structure,
        "trend":              trend,
        "swing_high":         round(float(last_sh), 2) if last_sh else None,
        "swing_low":          round(float(last_sl), 2) if last_sl else None,
        "bullish_obs":        bull_obs_below,
        "bearish_obs":        bear_obs_above,
        "bullish_fvgs":       bullish_fvgs,
        "bearish_fvgs":       bearish_fvgs,
        "ssl":                ssl,
        "bsl":                bsl,
        "liquidity_swept":    liquidity_swept,
        "in_discount":        in_discount,
        "in_premium":         in_premium,
        "nearest_bullish_ob": nearest_bullish_ob,
        "nearest_bearish_ob": nearest_bearish_ob,
        "nearest_fvg":        nearest_fvg,
    }


def _calculate_fibonacci(df: pd.DataFrame) -> dict:
    """Calculate Fibonacci retracement levels from last swing high/low."""
    high_col = "high"  if "high"  in df.columns else "High"
    low_col  = "low"   if "low"   in df.columns else "Low"
    recent   = df.tail(60)
    swing_h  = float(recent[high_col].max())
    swing_l  = float(recent[low_col].min())
    diff     = swing_h - swing_l
    if diff <= 0:
        return {}
    return {
        "23.6":  round(swing_h - diff * 0.236, 2),
        "38.2":  round(swing_h - diff * 0.382, 2),
        "50.0":  round(swing_h - diff * 0.500, 2),
        "61.8":  round(swing_h - diff * 0.618, 2),
        "78.6":  round(swing_h - diff * 0.786, 2),
        "127.2": round(swing_l + diff * 1.272, 2),
        "161.8": round(swing_l + diff * 1.618, 2),
    }


def _safe(row, col: str) -> Optional[float]:
    try:
        v = row.get(col)
        return None if (v is None or pd.isna(v)) else float(v)
    except Exception:
        return None


def _log_analysis(sym: str, a: dict) -> None:
    score    = a.get("technical_score", 0)
    bias     = a.get("overall_bias", "?")
    patterns = [p["name"] for p in a.get("patterns_active", [])]
    flag     = "▲" if score >= 7 else "·"
    logger.debug(
        f"  {flag} {sym:15s}  score={score:.1f}  bias={bias:15s}  "
        f"patterns={patterns or 'none'}"
    )


# ─── Multi-Timeframe (MTF) Analysis ──────────────────────────────
# Top-down cascade: 1D → 4H → 1H → 15m → 5m
# Only called for the top-scoring candidates after the 1D scan, so
# the extra API calls are bounded to ~10 symbols per run.

async def analyse_multi_timeframe(symbol: str, market: str) -> dict:
    """
    Run SMC analysis on 4H, 1H, 15m, 5m for a single symbol and combine
    with the already-computed 1D result from state.

    Returns an MTF alignment dict:
      {
        "tfs": { "1d": {...}, "4h": {...}, ... },
        "alignment_score": 1.23,   # weighted bias sum (-2 .. +2)
        "higher_tf_aligned": bool, # 1D + 4H both bullish
        "consensus_bias": "bullish",
        "entry_tf": "15m",         # lowest TF that is >= bullish
        "entry_ob": {...},         # entry TF OB (None if not found)
        "entry_fvg": {...},        # entry TF FVG (None if not found)
        "entry_zone": [low, high], # refined entry zone from lower TF
        "mtf_summary": "1D↑ 4H↑ 1H→ 15m↑ 5m↑",
      }
    """
    tf_results: dict[str, dict] = {}

    # 1D: reuse what was just written to state (no extra API call)
    d1 = state.read_chart_data(market, symbol) or {}
    if d1:
        tf_results["1d"] = _slim_tf_result(d1)

    # Lower TFs — fetch and analyse in parallel
    lower_tfs = ["4h", "1h", "15m", "5m"]
    if market == "india":
        tasks = [_fetch_and_analyse_india_tf(symbol, tf) for tf in lower_tfs]
    else:
        tasks = [_fetch_and_analyse_crypto_tf(symbol, tf) for tf in lower_tfs]

    results = await asyncio.gather(*tasks, return_exceptions=True)
    for tf, res in zip(lower_tfs, results):
        if isinstance(res, dict):
            tf_results[tf] = res
        else:
            logger.debug(f"  MTF {symbol} {tf}: {res}")

    return _compute_mtf_alignment(tf_results)


def _slim_tf_result(full: dict) -> dict:
    """Extract only what MTF alignment needs from a full chart analysis dict."""
    return {
        "bias":       full.get("overall_bias", "neutral"),
        "score":      full.get("technical_score", 5.0),
        "smc":        full.get("smc", {}),
        "key_levels": full.get("key_levels", {}),
        "indicators": {
            k: full.get("indicators", {}).get(k)
            for k in ("rsi", "rsi_signal", "ema_alignment", "macd_signal", "adx", "trend_strength")
        },
    }


async def _fetch_and_analyse_india_tf(symbol: str, tf: str) -> dict | None:
    """Fetch yfinance OHLCV for a lower TF and run full analysis."""
    cfg = MTF_INDIA_FETCH.get(tf)
    if not cfg:
        return None
    try:
        import yfinance as yf
        ticker = yf.Ticker(f"{symbol}.NS" if not symbol.endswith(".NS") else symbol)
        df = await asyncio.to_thread(
            ticker.history,
            period=cfg["period"], interval=cfg["interval"], auto_adjust=True,
        )
        if df.empty or len(df) < 20:
            return None
        df.columns = [c.lower() for c in df.columns]
        df = df[["open", "high", "low", "close", "volume"]].dropna()

        if cfg.get("resample"):
            # Resample 1H → 4H
            ohlc_dict = {"open": "first", "high": "max", "low": "min",
                         "close": "last", "volume": "sum"}
            df = df.resample(cfg["resample"]).agg(ohlc_dict).dropna()

        if len(df) < cfg["min_bars"]:
            return None

        result = analyse(df, symbol, "india", tf)
        return _slim_tf_result(result)
    except Exception as e:
        logger.debug(f"  MTF india {symbol} {tf}: {e}")
        return None


async def _fetch_and_analyse_crypto_tf(symbol: str, tf: str) -> dict | None:
    """Fetch Delta Exchange OHLCV for a lower TF and run full analysis."""
    cfg = MTF_CRYPTO_FETCH.get(tf)
    if not cfg:
        return None
    try:
        end   = int(time.time())
        # Rough start time: limit × seconds-per-bar
        secs  = {"4h": 14400, "1h": 3600, "15m": 900, "5m": 300}.get(tf, 3600)
        start = end - cfg["limit"] * secs
        candles = await asyncio.to_thread(
            delta_rest.get_candlestick,
            symbol, cfg["resolution"], start, end,
        )
        if not candles or len(candles) < 20:
            return None
        df = pd.DataFrame(candles)
        df.set_index("timestamp", inplace=True)
        for col in ("open", "high", "low", "close", "volume"):
            df[col] = pd.to_numeric(df.get(col, df.get(col.capitalize(), 0)),
                                    errors="coerce")
        df = df.dropna(subset=["close"])
        if len(df) < 20:
            return None
        result = analyse(df, symbol, "crypto", tf)
        return _slim_tf_result(result)
    except Exception as e:
        logger.debug(f"  MTF crypto {symbol} {tf}: {e}")
        return None


def _compute_mtf_alignment(tf_results: dict[str, dict]) -> dict:
    """
    Aggregate per-TF bias into a single alignment picture.

    alignment_score: weighted sum of bias values, range approximately -2 .. +2
      > +0.8  → strong bullish alignment
      > +0.3  → bullish alignment
      < -0.3  → bearish alignment
    """
    arrow = {"strong_bullish": "↑↑", "bullish": "↑", "neutral": "→",
             "bearish": "↓", "strong_bearish": "↓↓"}

    alignment_score = 0.0
    summary_parts   = []

    for tf in ["1d", "4h", "1h", "15m", "5m"]:
        tf_data = tf_results.get(tf)
        if not tf_data:
            continue
        bias  = tf_data.get("bias", "neutral")
        val   = MTF_BIAS_VALUE.get(bias, 0.0)
        wt    = MTF_WEIGHTS.get(tf, 0.0)
        alignment_score += val * wt
        summary_parts.append(f"{tf.upper()}{arrow.get(bias, '?')}")

    # Hard gate: both 1D and 4H must be at least "bullish"
    d1_bias = tf_results.get("1d", {}).get("bias", "neutral")
    d4_bias = tf_results.get("4h", {}).get("bias", "neutral")
    higher_tf_aligned = (
        MTF_BIAS_VALUE.get(d1_bias, 0) >= 1.0 and
        MTF_BIAS_VALUE.get(d4_bias, 0) >= 1.0
    )

    # Consensus bias label
    if alignment_score >= 1.2:
        consensus_bias = "strong_bullish"
    elif alignment_score >= 0.4:
        consensus_bias = "bullish"
    elif alignment_score <= -1.2:
        consensus_bias = "strong_bearish"
    elif alignment_score <= -0.4:
        consensus_bias = "bearish"
    else:
        consensus_bias = "neutral"

    # Find best (lowest) TF that is bullish → use its OB/FVG for entry
    entry_tf   = "1d"
    entry_ob   = tf_results.get("1d", {}).get("smc", {}).get("nearest_bullish_ob")
    entry_fvg  = tf_results.get("1d", {}).get("smc", {}).get("nearest_fvg")

    for tf in ["4h", "1h", "15m", "5m"]:
        tf_data = tf_results.get(tf)
        if not tf_data:
            continue
        if MTF_BIAS_VALUE.get(tf_data.get("bias", "neutral"), 0) >= 1.0:
            smc = tf_data.get("smc", {})
            ob  = smc.get("nearest_bullish_ob")
            fvg = smc.get("nearest_fvg")
            if ob or fvg:
                entry_tf  = tf
                entry_ob  = ob
                entry_fvg = fvg

    # Build entry zone from entry TF OB or FVG
    entry_zone = None
    if entry_ob:
        entry_zone = [entry_ob["low"], entry_ob["high"]]
    elif entry_fvg:
        entry_zone = [entry_fvg["bottom"], entry_fvg["top"]]

    return {
        "tfs":               tf_results,
        "alignment_score":   round(alignment_score, 3),
        "higher_tf_aligned": higher_tf_aligned,
        "consensus_bias":    consensus_bias,
        "entry_tf":          entry_tf,
        "entry_ob":          entry_ob,
        "entry_fvg":         entry_fvg,
        "entry_zone":        entry_zone,
        "mtf_summary":       "  ".join(summary_parts) or "no data",
        "d1_bias":           d1_bias,
        "d4_bias":           d4_bias,
        "d1h_bias":          tf_results.get("1h", {}).get("bias", "—"),
        "d15m_bias":         tf_results.get("15m", {}).get("bias", "—"),
        "d5m_bias":          tf_results.get("5m",  {}).get("bias", "—"),
    }


# ─── Data fetchers ────────────────────────────────────────────────

async def _fetch_india_ohlcv(symbol: str, interval: str,
                              periods: int) -> Optional[pd.DataFrame]:
    """Fetch India stock OHLCV — Groww API with yfinance fallback."""
    try:
        # Try Groww first (live data)
        if groww_client.is_connected:
            from datetime import date
            end   = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
            start = (datetime.now() - timedelta(days=periods + 50)).strftime("%Y-%m-%d %H:%M:%S")
            candles = await asyncio.to_thread(
                groww_client.get_historical_candles,
                symbol, start, end, interval,
            )
            if candles and len(candles) >= 50:
                df = pd.DataFrame(candles)
                df.set_index("timestamp", inplace=True)
                return df

        # Fallback to yfinance
        import yfinance as yf
        ticker = yf.Ticker(f"{symbol}.NS")
        df     = ticker.history(period="1y", interval="1d", auto_adjust=True)
        if not df.empty:
            df.columns = [c.lower() for c in df.columns]
            return df[["open", "high", "low", "close", "volume"]]
    except Exception as e:
        logger.error(f"_fetch_india_ohlcv({symbol}): {e}")
    return None


async def _fetch_crypto_ohlcv(symbol: str, resolution: str,
                               limit: int) -> Optional[pd.DataFrame]:
    """Fetch crypto OHLCV from Delta Exchange."""
    try:
        end   = int(time.time())
        start = end - (limit * 86400)  # approximate
        candles = await asyncio.to_thread(
            delta_rest.get_candlestick,
            symbol, resolution, start, end,
        )
        if candles and len(candles) >= 50:
            df = pd.DataFrame(candles)
            df.set_index("timestamp", inplace=True)
            return df
    except Exception as e:
        logger.error(f"_fetch_crypto_ohlcv({symbol}): {e}")
    return None

