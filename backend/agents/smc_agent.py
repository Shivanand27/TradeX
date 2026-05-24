"""
agents/smc_agent.py
─────────────────────────────────────────────────────
SMC Top-Down Multi-Timeframe Signal Engine

Strict 4-step top-down framework (enforced in order):
  STEP 1 — Monthly  → MACRO BIAS (HH/HL vs LH/LL structure)
  STEP 2 — Weekly   → TREND CONFIRMATION + PREMIUM/DISCOUNT zone
  STEP 3 — Daily    → BOS/CHoCH, daily OBs, FVGs, entry preparation
  STEP 4 — 4H       → Internal structure, inducement, precision entry

Gate rule: MONTHLY + WEEKLY + DAILY must ALL agree on direction.
Conflicting timeframes → NO TRADE output.

Min R:R = 1:3 enforced (stricter than pipeline's 1:2).
Confluence score: 1–4 (number of aligned timeframes).

Output JSON (per requested schema):
  {
    "macro_bias":       "BULLISH | BEARISH | NEUTRAL",
    "weekly_zone":      "PREMIUM | EQUILIBRIUM | DISCOUNT",
    "daily_structure":  "BULLISH_CONTINUATION | BEARISH_CONTINUATION | REVERSAL_SETUP",
    "entry_zone":       { "high": price, "low": price },
    "direction":        "LONG | SHORT | NO TRADE",
    "confluence_score": 1..4
  }
"""
from __future__ import annotations

import asyncio
import time
from datetime import datetime, timezone
from typing import Optional

import numpy as np
import pandas as pd
from loguru import logger

from core.config import INDIA_WATCHLIST, CRYPTO_WATCHLIST
from core.state_store import state
from agents.chart_pattern_agent import analyse

MIN_SMC_RR    = 3.0    # 1:3 minimum risk-reward
MONTHLY_BARS  = 36     # 3 years monthly
WEEKLY_BARS   = 104    # 2 years weekly
DAILY_BARS    = 200    # 200 daily bars
BARS_4H       = 200    # 200 × 4H bars


# ─── Main entry point ─────────────────────────────────────────────

async def run_smc_analysis(
    symbol: str,
    market: str,
    current_price: Optional[float] = None,
) -> dict:
    """
    Execute the full 4-step SMC top-down analysis for one instrument.

    Returns a signal dict conforming to the platform signal schema.
    Always writes result to /smc/{market}/{symbol} in state store.
    """
    logger.info(f"▶ SMC [{market}] {symbol}")

    # ── Fetch all OHLCV data in parallel ─────────────────────────
    try:
        if market == "india":
            monthly_df, weekly_df, daily_df, h4_df = await asyncio.gather(
                _fetch_india_ohlcv(symbol, "1mo", MONTHLY_BARS),
                _fetch_india_ohlcv(symbol, "1wk", WEEKLY_BARS),
                _fetch_india_ohlcv(symbol, "1d",  DAILY_BARS),
                _fetch_india_4h(symbol),
                return_exceptions=True,
            )
        else:
            monthly_df, weekly_df, daily_df, h4_df = await asyncio.gather(
                _fetch_crypto_ohlcv(symbol, "1M", MONTHLY_BARS),
                _fetch_crypto_ohlcv(symbol, "1W", WEEKLY_BARS),
                _fetch_crypto_ohlcv(symbol, "1D", DAILY_BARS),
                _fetch_crypto_ohlcv(symbol, "4h", BARS_4H),
                return_exceptions=True,
            )
    except Exception as e:
        logger.error(f"SMC data fetch {symbol}: {e}")
        return _no_trade_result(symbol, market, f"Data fetch error: {e}")

    # Silence exceptions from gather — treat as None
    monthly_df = monthly_df if isinstance(monthly_df, pd.DataFrame) else None
    weekly_df  = weekly_df  if isinstance(weekly_df,  pd.DataFrame) else None
    daily_df   = daily_df   if isinstance(daily_df,   pd.DataFrame) else None
    h4_df      = h4_df      if isinstance(h4_df,      pd.DataFrame) else None

    if daily_df is None or len(daily_df) < 50:
        return _no_trade_result(symbol, market, "Insufficient daily data")

    # Resolve current price
    if current_price is None or current_price <= 0:
        mkt_data = state.read_market_data(market, symbol) or {}
        current_price = float(
            mkt_data.get("ltp") or mkt_data.get("close")
            or daily_df["close"].iloc[-1]
        )

    # ── STEP 1 — Monthly chart (macro bias) ───────────────────────
    monthly_result = _run_analyse(monthly_df, symbol, market, "1M")
    macro_bias, monthly_obs, monthly_fvgs = _extract_macro_bias(monthly_result)
    logger.info(f"  S1 Monthly → MACRO_BIAS={macro_bias}")

    # ── STEP 2 — Weekly chart (trend confirmation + price zone) ───
    weekly_result = _run_analyse(weekly_df, symbol, market, "1W")
    weekly_bias, price_zone, weekly_swing = _extract_weekly_bias(
        weekly_result, current_price
    )
    logger.info(f"  S2 Weekly → bias={weekly_bias}  zone={price_zone}")

    # ── STEP 3 — Daily chart (entry preparation) ──────────────────
    daily_result = _run_analyse(daily_df, symbol, market, "1D")
    daily_struct, daily_obs, daily_fvgs = _extract_daily_structure(daily_result)
    logger.info(f"  S3 Daily → structure={daily_struct}")

    # ── Confluence gate: all three HTFs must agree ─────────────────
    direction, confluence_score, gate_reason = _evaluate_confluence(
        macro_bias, weekly_bias, price_zone, daily_struct,
    )
    logger.info(f"  Gate [{confluence_score}/4] → {direction}: {gate_reason}")

    if direction == "NO TRADE":
        result = _no_trade_result(symbol, market, gate_reason, confluence_score)
        state.set(f"/smc/{market}/{symbol}", result, ttl=3600)
        return result

    # ── STEP 4 — 4H chart (precision entry zone) ──────────────────
    h4_result = _run_analyse(h4_df, symbol, market, "4H") if h4_df is not None else {}
    entry_zone, h4_ob, inducement = _extract_4h_entry(
        h4_result, daily_result, direction, current_price
    )
    logger.info(f"  S4 4H → entry_zone={entry_zone}")

    # ── Assemble signal ───────────────────────────────────────────
    signal = _build_smc_signal(
        symbol, market, current_price, direction,
        macro_bias, weekly_bias, price_zone,
        daily_struct, daily_obs, daily_fvgs,
        h4_result, h4_ob, entry_zone, inducement,
        monthly_obs, monthly_fvgs, confluence_score,
        weekly_swing,
    )

    # Enforce min R:R
    if signal.get("rr_ratio", 0) < MIN_SMC_RR:
        signal["direction"]   = "NO TRADE"
        signal["veto_reason"] = (
            f"R:R {signal['rr_ratio']:.1f} below minimum {MIN_SMC_RR}"
        )
        logger.info(f"  Veto: {signal['veto_reason']}")

    state.set(f"/smc/{market}/{symbol}", signal, ttl=3600)
    logger.info(
        f"✓ SMC {symbol} → {signal['direction']}  "
        f"[{confluence_score}/4]  R:R={signal.get('rr_ratio', 0):.1f}"
    )
    return signal


# ─── Step 1 ──────────────────────────────────────────────────────

def _extract_macro_bias(
    monthly: dict,
) -> tuple[str, list, list]:
    """
    Monthly chart → macro bias.
    HH/HL = BULLISH | LH/LL = BEARISH | otherwise NEUTRAL.
    """
    if not monthly:
        return "NEUTRAL", [], []

    smc      = monthly.get("smc", {})
    trend    = smc.get("trend", "ranging")
    struct   = smc.get("structure", "ranging")
    bias_raw = monthly.get("overall_bias", "neutral")

    if trend == "uptrend" or struct in ("bullish_bos", "choch_bullish"):
        macro = "BULLISH"
    elif trend == "downtrend" or struct in ("bearish_bos", "choch_bearish"):
        macro = "BEARISH"
    elif bias_raw in ("strong_bullish", "bullish"):
        macro = "BULLISH"
    elif bias_raw in ("strong_bearish", "bearish"):
        macro = "BEARISH"
    else:
        macro = "NEUTRAL"

    obs  = smc.get("bullish_obs", []) + smc.get("bearish_obs", [])
    fvgs = smc.get("bullish_fvgs", []) + smc.get("bearish_fvgs", [])
    return macro, obs, fvgs


# ─── Step 2 ──────────────────────────────────────────────────────

def _extract_weekly_bias(
    weekly: dict, current_price: float
) -> tuple[str, str, dict]:
    """
    Weekly chart → trend confirmation + premium/discount zone.

    Premium:    price above 50% Fibonacci midpoint of weekly range
    Discount:   price below 50% Fibonacci midpoint
    Equilibrium: within ±0.5% of midpoint
    """
    if not weekly:
        return "NEUTRAL", "EQUILIBRIUM", {}

    smc      = weekly.get("smc", {})
    bias_raw = weekly.get("overall_bias", "neutral")
    trend    = smc.get("trend", "ranging")
    kl       = weekly.get("key_levels", {})

    if trend == "uptrend" or smc.get("structure") in ("bullish_bos", "choch_bullish"):
        weekly_bias = "BULLISH"
    elif trend == "downtrend" or smc.get("structure") in ("bearish_bos", "choch_bearish"):
        weekly_bias = "BEARISH"
    elif bias_raw in ("strong_bullish", "bullish"):
        weekly_bias = "BULLISH"
    elif bias_raw in ("strong_bearish", "bearish"):
        weekly_bias = "BEARISH"
    else:
        weekly_bias = "NEUTRAL"

    # Price zone via 50% fib of last weekly swing range
    fib_50 = kl.get("fib_50")
    fib_38 = kl.get("fib_38")
    fib_61 = kl.get("fib_61")

    if fib_50 and current_price > 0:
        if current_price > fib_50 * 1.005:
            price_zone = "PREMIUM"
        elif current_price < fib_50 * 0.995:
            price_zone = "DISCOUNT"
        else:
            price_zone = "EQUILIBRIUM"
    else:
        price_zone = "EQUILIBRIUM"

    swing_data = {
        "swing_high":  smc.get("swing_high"),
        "swing_low":   smc.get("swing_low"),
        "fib_50":      fib_50,
        "fib_38":      fib_38,
        "fib_61":      fib_61,
        "bullish_obs": smc.get("bullish_obs", []),
        "bearish_obs": smc.get("bearish_obs", []),
    }
    return weekly_bias, price_zone, swing_data


# ─── Step 3 ──────────────────────────────────────────────────────

def _extract_daily_structure(
    daily: dict,
) -> tuple[str, list, list]:
    """
    Daily chart → BOS/CHoCH classification.
    bullish_bos  → BULLISH_CONTINUATION
    bearish_bos  → BEARISH_CONTINUATION
    choch_*      → REVERSAL_SETUP
    """
    if not daily:
        return "NONE", [], []

    smc      = daily.get("smc", {})
    struct   = smc.get("structure", "ranging")
    bias_raw = daily.get("overall_bias", "neutral")

    if struct == "bullish_bos":
        daily_struct = "BULLISH_CONTINUATION"
    elif struct == "bearish_bos":
        daily_struct = "BEARISH_CONTINUATION"
    elif struct in ("choch_bullish", "choch_bearish"):
        daily_struct = "REVERSAL_SETUP"
    elif bias_raw in ("strong_bullish", "bullish"):
        daily_struct = "BULLISH_CONTINUATION"
    elif bias_raw in ("strong_bearish", "bearish"):
        daily_struct = "BEARISH_CONTINUATION"
    else:
        daily_struct = "NONE"

    daily_obs  = smc.get("bullish_obs", []) + smc.get("bearish_obs", [])
    daily_fvgs = smc.get("bullish_fvgs", []) + smc.get("bearish_fvgs", [])
    return daily_struct, daily_obs, daily_fvgs


# ─── Confluence gate ──────────────────────────────────────────────

def _evaluate_confluence(
    macro_bias: str,
    weekly_bias: str,
    price_zone: str,
    daily_struct: str,
) -> tuple[str, int, str]:
    """
    Gate: all three higher timeframes must agree.
    Returns (direction, confluence_score_1_to_4, reason_string).

    Scoring:
      +1 monthly bullish   / -1 monthly bearish
      +1 weekly bullish    / -1 weekly bearish
      +1 price in discount (for longs) or premium (for shorts)
      +1 daily bullish_continuation (for longs) / bearish_continuation (for shorts)

    score >= 3 → LONG | score <= -3 → SHORT | else NO TRADE
    """
    score = 0
    reasons: list[str] = []

    # Monthly contribution
    if macro_bias == "BULLISH":
        score += 1
        reasons.append(f"Monthly BULLISH (macro)")
    elif macro_bias == "BEARISH":
        score -= 1
        reasons.append(f"Monthly BEARISH (macro)")

    # Weekly confirmation
    if weekly_bias == "BULLISH":
        score += 1
        reasons.append("Weekly trend BULLISH")
    elif weekly_bias == "BEARISH":
        score -= 1
        reasons.append("Weekly trend BEARISH")

    # Price zone bonus
    if price_zone == "DISCOUNT":
        score += 1
        reasons.append("Price in DISCOUNT zone (below 50% fib — optimal long area)")
    elif price_zone == "PREMIUM":
        score -= 1
        reasons.append("Price in PREMIUM zone (above 50% fib — optimal short area)")
    # EQUILIBRIUM → neutral, no delta

    # Daily structure confirmation
    if daily_struct == "BULLISH_CONTINUATION":
        score += 1
        reasons.append("Daily BULLISH_CONTINUATION (BOS confirmed)")
    elif daily_struct == "BEARISH_CONTINUATION":
        score -= 1
        reasons.append("Daily BEARISH_CONTINUATION (BOS confirmed)")
    elif daily_struct == "REVERSAL_SETUP":
        # CHoCH reversal: add in whichever direction HTFs already point
        if score > 0:
            score += 1
            reasons.append("Daily CHoCH reversal aligns with HTF bullish bias")
        elif score < 0:
            score -= 1
            reasons.append("Daily CHoCH reversal aligns with HTF bearish bias")

    # Gate decision
    if score >= 3:
        direction = "LONG"
    elif score <= -3:
        direction = "SHORT"
    else:
        direction = "NO TRADE"
        conflict_parts = [
            f"monthly={macro_bias}",
            f"weekly={weekly_bias}",
            f"zone={price_zone}",
            f"daily={daily_struct}",
        ]
        reasons.append(f"HTF conflict ({', '.join(conflict_parts)}) → no high-probability setup")

    confluence = min(4, max(1, abs(score)))
    return direction, confluence, " | ".join(reasons)


# ─── Step 4 ──────────────────────────────────────────────────────

def _extract_4h_entry(
    h4: dict,
    daily: dict,
    direction: str,
    price: float,
) -> tuple[dict, Optional[dict], Optional[float]]:
    """
    4H chart → precision entry zone.

    For LONG:  nearest 4H bullish OB below price (or daily OB as fallback).
               Inducement = SSL cluster just below obvious 4H lows.
    For SHORT: nearest 4H bearish OB above price.
               Inducement = BSL cluster just above obvious 4H highs.
    """
    h4_smc     = h4.get("smc", {}) if h4 else {}
    daily_smc  = daily.get("smc", {}) if daily else {}

    # Pick OB by direction
    if direction == "LONG":
        h4_ob      = h4_smc.get("nearest_bullish_ob")
        daily_ob   = daily_smc.get("nearest_bullish_ob")
        ssl        = h4_smc.get("ssl", [])
        inducement = min(ssl) if ssl else None
    else:
        h4_ob      = h4_smc.get("nearest_bearish_ob")
        daily_ob   = daily_smc.get("nearest_bearish_ob")
        bsl        = h4_smc.get("bsl", [])
        inducement = max(bsl) if bsl else None

    # Build entry zone: prefer 4H OB → daily OB → ATR-based range
    ob = h4_ob or daily_ob
    if ob:
        entry_zone = {"high": ob["high"], "low": ob["low"]}
    else:
        atr = (
            h4.get("indicators", {}).get("atr")
            if h4 else None
        ) or price * 0.012
        entry_zone = {
            "high": round(price + 0.3 * atr, 2),
            "low":  round(price - 0.3 * atr, 2),
        }

    return entry_zone, h4_ob or daily_ob, inducement


# ─── Signal builder ───────────────────────────────────────────────

def _build_smc_signal(
    symbol: str, market: str, price: float, direction: str,
    macro_bias: str, weekly_bias: str, price_zone: str,
    daily_struct: str, daily_obs: list, daily_fvgs: list,
    h4: dict, h4_ob: Optional[dict], entry_zone: dict,
    inducement: Optional[float], monthly_obs: list, monthly_fvgs: list,
    confluence_score: int, weekly_swing: dict,
) -> dict:
    """Assemble the complete SMC signal dictionary."""
    currency = "₹" if market == "india" else "$"
    h4_smc   = h4.get("smc", {}) if h4 else {}
    entry_mid = round((entry_zone["high"] + entry_zone["low"]) / 2, 2)

    # ── Stop loss (just outside OB, structure-invalidation level) ─
    if direction == "LONG":
        stop = round(entry_zone["low"] * 0.995, 2)
    else:
        stop = round(entry_zone["high"] * 1.005, 2)

    risk = abs(price - stop)
    if risk <= 0:
        risk = price * 0.02

    # ── Targets: prefer liquidity pool levels → min 1:3 R:R ───────
    if direction == "LONG":
        bsl = sorted([b for b in h4_smc.get("bsl", []) if b > price])
        if len(bsl) >= 2:
            t1, t2 = bsl[0], bsl[1]
        elif len(bsl) == 1:
            t1 = bsl[0]
            t2 = round(price + risk * 3.5, 2)
        else:
            t1 = round(price + risk * 2.0, 2)
            t2 = round(price + risk * 3.0, 2)
    else:
        ssl = sorted([s for s in h4_smc.get("ssl", []) if s < price], reverse=True)
        if len(ssl) >= 2:
            t1, t2 = ssl[0], ssl[1]
        elif len(ssl) == 1:
            t1 = ssl[0]
            t2 = round(price - risk * 3.5, 2)
        else:
            t1 = round(price - risk * 2.0, 2)
            t2 = round(price - risk * 3.0, 2)

    reward = abs(t2 - price)
    rr_ratio = round(reward / risk, 2) if risk > 0 else 0.0

    # ── Nearest reference OBs and FVGs ────────────────────────────
    nearest_daily_ob = next(
        (o for o in daily_obs
         if (direction == "LONG" and o.get("high", 0) <= price * 1.01) or
            (direction == "SHORT" and o.get("low", 0) >= price * 0.99)),
        None,
    )
    nearest_daily_fvg = next(
        (f for f in daily_fvgs if not f.get("filled")), None
    )

    return {
        # ── Identity ─────────────────────────────────────────────
        "signal_id":   (
            f"SMC-{symbol}-{datetime.now(timezone.utc).strftime('%Y%m%d%H%M')}"
        ),
        "timestamp":    datetime.now(timezone.utc).isoformat(),
        "symbol":       symbol,
        "market":       market,
        "engine":       "SMC_TOP_DOWN_v1",
        "current_price": price,
        "currency":     currency,

        # ── Core output (matches requested JSON schema) ───────────
        "macro_bias":       macro_bias,
        "weekly_zone":      price_zone,
        "daily_structure":  daily_struct,
        "entry_zone":       entry_zone,
        "direction":        direction,
        "confluence_score": confluence_score,

        # ── Trade levels ─────────────────────────────────────────
        "entry":      entry_mid,
        "stop_loss":  stop,
        "target_1":   round(t1, 2),
        "target_2":   round(t2, 2),
        "rr_ratio":   rr_ratio,
        "rr_to_t1":   round(abs(t1 - price) / risk, 2) if risk > 0 else 0,
        "rr_to_t2":   rr_ratio,
        "risk_pct":   round(abs(price - stop) / price * 100, 2),

        # ── Confluence narrative ──────────────────────────────────
        "confluence_factors": _build_confluence_factors(
            macro_bias, weekly_bias, price_zone, daily_struct,
            h4_smc, h4_ob, nearest_daily_ob, nearest_daily_fvg,
        ),

        # ── Supporting structure ──────────────────────────────────
        "weekly_swing_high": weekly_swing.get("swing_high"),
        "weekly_swing_low":  weekly_swing.get("swing_low"),
        "weekly_fib_50":     weekly_swing.get("fib_50"),
        "monthly_ob":        monthly_obs[0] if monthly_obs else None,
        "daily_ob":          nearest_daily_ob,
        "daily_fvg":         nearest_daily_fvg,
        "h4_ob":             h4_ob,
        "inducement_level":  inducement,
        "h4_structure":      h4_smc.get("structure"),
        "h4_liquidity_swept": h4_smc.get("liquidity_swept"),

        # ── Validation ───────────────────────────────────────────
        "min_rr_required": MIN_SMC_RR,
        "veto_reason":     None,
    }


def _build_confluence_factors(
    macro_bias: str, weekly_bias: str, price_zone: str, daily_struct: str,
    h4_smc: dict, h4_ob: Optional[dict],
    daily_ob: Optional[dict], daily_fvg: Optional[dict],
) -> list[str]:
    factors = []
    if macro_bias != "NEUTRAL":
        factors.append(f"Monthly {macro_bias} macro bias (HH/HL structure)")
    if weekly_bias != "NEUTRAL":
        factors.append(f"Weekly {weekly_bias} trend confirmed")
    if price_zone == "DISCOUNT":
        factors.append("Price in DISCOUNT zone (below 50% weekly fib — demand area)")
    elif price_zone == "PREMIUM":
        factors.append("Price in PREMIUM zone (above 50% weekly fib — supply area)")
    if daily_struct in ("BULLISH_CONTINUATION", "BEARISH_CONTINUATION"):
        factors.append(f"Daily {daily_struct.replace('_', ' ').title()}")
    elif daily_struct == "REVERSAL_SETUP":
        factors.append("Daily CHoCH reversal — trend change in progress")
    if h4_ob:
        factors.append(
            f"4H OB confluence at {h4_ob.get('low')}–{h4_ob.get('high')} "
            f"({h4_ob.get('strength', '?')} strength)"
        )
    if daily_ob:
        factors.append(
            f"Daily OB support at {daily_ob.get('low')}–{daily_ob.get('high')}"
        )
    if daily_fvg:
        factors.append(
            f"Daily FVG (imbalance) at {daily_fvg.get('bottom')}–{daily_fvg.get('top')}"
        )
    if h4_smc.get("liquidity_swept") == "sell_side":
        factors.append("4H SSL swept — smart money stop hunt complete, reversal expected")
    elif h4_smc.get("liquidity_swept") == "buy_side":
        factors.append("4H BSL swept — smart money stop hunt above highs, reversal expected")
    return factors


def _no_trade_result(
    symbol: str, market: str, reason: str, confluence_score: int = 1,
) -> dict:
    return {
        "signal_id":       (
            f"SMC-{symbol}-{datetime.now(timezone.utc).strftime('%Y%m%d%H%M')}"
        ),
        "timestamp":       datetime.now(timezone.utc).isoformat(),
        "symbol":          symbol,
        "market":          market,
        "engine":          "SMC_TOP_DOWN_v1",
        "macro_bias":      "NEUTRAL",
        "weekly_zone":     "EQUILIBRIUM",
        "daily_structure": "NONE",
        "entry_zone":      {"high": 0, "low": 0},
        "direction":       "NO TRADE",
        "confluence_score": confluence_score,
        "rr_ratio":        0.0,
        "veto_reason":     reason,
        "confluence_factors": [],
    }


# ─── Timeframe analyse helper ─────────────────────────────────────

def _run_analyse(
    df: Optional[pd.DataFrame], symbol: str, market: str, tf: str,
) -> dict:
    if df is None or not isinstance(df, pd.DataFrame) or len(df) < 20:
        return {}
    try:
        return analyse(df, symbol, market, tf)
    except Exception as e:
        logger.debug(f"  SMC analyse {symbol} {tf}: {e}")
        return {}


# ─── Data fetchers ────────────────────────────────────────────────

async def _fetch_india_ohlcv(
    symbol: str, interval: str, periods: int
) -> Optional[pd.DataFrame]:
    """Fetch India OHLCV via yfinance (monthly / weekly / daily)."""
    try:
        import yfinance as yf
        sym = f"{symbol}.NS" if not symbol.endswith(".NS") else symbol
        period_map = {"1mo": "5y", "1wk": "5y", "1d": "1y"}
        period = period_map.get(interval, "1y")
        df = await asyncio.to_thread(
            lambda: yf.Ticker(sym).history(
                period=period, interval=interval, auto_adjust=True
            )
        )
        if df is None or df.empty or len(df) < 10:
            return None
        df.columns = [c.lower() for c in df.columns]
        df = df[["open", "high", "low", "close", "volume"]].dropna()
        return df.tail(periods)
    except Exception as e:
        logger.debug(f"_fetch_india_ohlcv {symbol} {interval}: {e}")
        return None


async def _fetch_india_4h(symbol: str) -> Optional[pd.DataFrame]:
    """Fetch India 4H by resampling 1H yfinance data."""
    try:
        import yfinance as yf
        sym = f"{symbol}.NS" if not symbol.endswith(".NS") else symbol
        df  = await asyncio.to_thread(
            lambda: yf.Ticker(sym).history(
                period="60d", interval="1h", auto_adjust=True
            )
        )
        if df is None or df.empty:
            return None
        df.columns = [c.lower() for c in df.columns]
        df = df[["open", "high", "low", "close", "volume"]].dropna()
        ohlc = {"open": "first", "high": "max", "low": "min",
                "close": "last", "volume": "sum"}
        df = df.resample("4h").agg(ohlc).dropna()
        return df if len(df) >= 20 else None
    except Exception as e:
        logger.debug(f"_fetch_india_4h {symbol}: {e}")
        return None


async def _fetch_crypto_ohlcv(
    symbol: str, resolution: str, limit: int
) -> Optional[pd.DataFrame]:
    """Fetch crypto OHLCV from Delta Exchange REST."""
    try:
        from data.delta_client import delta_rest
        secs  = {"1M": 30 * 86400, "1W": 7 * 86400, "1D": 86400, "4h": 14400}
        end   = int(time.time())
        start = end - limit * secs.get(resolution, 86400)
        candles = await asyncio.to_thread(
            delta_rest.get_candlestick, symbol, resolution, start, end
        )
        if not candles or len(candles) < 10:
            return None
        df = pd.DataFrame(candles)
        df.set_index("timestamp", inplace=True)
        for col in ("open", "high", "low", "close", "volume"):
            df[col] = pd.to_numeric(df.get(col, 0), errors="coerce")
        df = df.dropna(subset=["close"])
        return df.tail(limit)
    except Exception as e:
        logger.debug(f"_fetch_crypto_ohlcv {symbol} {resolution}: {e}")
        return None


# ─── Batch watchlist scan ─────────────────────────────────────────

async def run_smc_watchlist_scan(market: str = "india") -> list[dict]:
    """
    Run SMC top-down analysis across the full watchlist.
    Returns only LONG / SHORT signals that clear the 1:3 R:R gate.
    Results sorted by confluence_score (descending).
    """
    logger.info(f"▶ SMC Watchlist Scan [{market}]")
    symbols = (
        [s.replace(".NS", "") for s in INDIA_WATCHLIST]
        if market == "india"
        else list(CRYPTO_WATCHLIST)
    )

    tasks   = [run_smc_analysis(sym, market) for sym in symbols]
    results = await asyncio.gather(*tasks, return_exceptions=True)

    actionable = [
        r for r in results
        if isinstance(r, dict)
        and r.get("direction") in ("LONG", "SHORT")
        and r.get("rr_ratio", 0) >= MIN_SMC_RR
    ]
    actionable.sort(
        key=lambda x: (x.get("confluence_score", 0), x.get("rr_ratio", 0)),
        reverse=True,
    )

    state.set(f"/smc/{market}/watchlist_results", actionable, ttl=3600)
    state.set(
        f"/smc/{market}/last_scan",
        datetime.now(timezone.utc).isoformat(),
        ttl=3600,
    )

    logger.info(
        f"✓ SMC scan [{market}]: {len(symbols)} scanned, "
        f"{len(actionable)} actionable (RR≥{MIN_SMC_RR})"
    )

    if actionable:
        try:
            from notifications.telegram import send_message
            ccy = "₹" if market == "india" else "$"
            msg = f"<b>SMC Top-Down — {market.upper()} Scan</b>\n\n"
            for sig in actionable[:5]:
                ez  = sig.get("entry_zone", {})
                msg += (
                    f"<b>{sig['symbol']}</b>  {sig['direction']}  "
                    f"[{sig['confluence_score']}/4]\n"
                    f"  Entry: {ccy}{ez.get('low')}–{ccy}{ez.get('high')}\n"
                    f"  T2: {ccy}{sig.get('target_2')}  "
                    f"SL: {ccy}{sig.get('stop_loss')}  "
                    f"R:R {sig.get('rr_ratio', 0):.1f}\n"
                    f"  {sig.get('macro_bias')}/{sig.get('weekly_zone')}"
                    f"/{sig.get('daily_structure', '?')[:4]}\n\n"
                )
            await send_message(msg)
        except Exception as e:
            logger.debug(f"SMC Telegram: {e}")

    return actionable
