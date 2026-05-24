"""
agents/screener_agent.py
─────────────────────────────────────────────────────
Stock & Crypto Screener — classifies all watchlist symbols into
technical-analysis categories every 15 minutes.

Categories (12 total):
  Breakouts   : bullish_breakout, bearish_breakdown
  Levels      : consolidation, near_resistance, near_support
  Reversals   : oversold_bounce, overbought_reversal
  Momentum    : volume_surge, gap_up, gap_down
  Trend Cross : golden_cross, death_cross

Methodology (daily bars for India, 1h bars for crypto):
  • Swing High/Low: 20-bar rolling high/low excluding current bar
  • RSI(14):        Wilder-smoothed, matches TradingView
  • Bollinger(20,2): bandwidth squeeze = consolidation
  • EMA(50/200):    crossover detection within last 10 bars
  • ATR(14):        volatility filter for consolidation
  • Volume MA(20):  volume confirmation for breakouts/surges

Writes:
  • Redis  /screener/results  (TTL 86400s / 24h — extended since Supabase now persists)
  • Redis  /screener/last_scan (timestamp)
  • Supabase  screener_snapshots (market=all, persistent across restarts)
  • WebSocket broadcast  type="screener_update"
"""
from __future__ import annotations

import asyncio
import logging
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone, timedelta
from typing import Optional

import numpy as np
import pandas as pd
from loguru import logger

# Suppress yfinance's noisy "possibly delisted" / "No data found" warnings
logging.getLogger("yfinance").setLevel(logging.CRITICAL)
logging.getLogger("peewee").setLevel(logging.CRITICAL)

from core.state_store import state

# Symbols confirmed broken on Yahoo Finance — skip without retrying every scan
_BAD_SYMBOLS: set[str] = set()

# ─── Supabase persistence helpers ────────────────────────────────

def _save_screener_to_db(result: dict) -> None:
    """Upsert screener snapshot to Supabase so it survives server restarts."""
    try:
        from core.supabase_pool import admin_client
        total_hits = sum(c.get("count", 0) for c in result.get("categories", {}).values())
        admin_client().table("screener_snapshots").upsert(
            {
                "market":        result.get("market", "all"),
                "snapshot":      result,
                "total_scanned": result.get("total_scanned", 0),
                "total_hits":    total_hits,
                "scanned_at":    result.get("timestamp") or datetime.now(timezone.utc).isoformat(),
            },
            on_conflict="market",
        ).execute()
        logger.info(f"✓ Screener snapshot saved to DB (market={result.get('market')})")
    except Exception as e:
        logger.warning(f"_save_screener_to_db failed: {e}")


def _load_screener_from_db(market: str = "all") -> dict | None:
    """Load the latest screener snapshot from Supabase (fallback when Redis is cold)."""
    try:
        from core.supabase_pool import admin_client
        rec = (
            admin_client()
            .table("screener_snapshots")
            .select("snapshot")
            .eq("market", market)
            .limit(1)
            .execute()
        )
        if rec.data and rec.data[0].get("snapshot"):
            return rec.data[0]["snapshot"]
    except Exception as e:
        logger.warning(f"_load_screener_from_db failed: {e}")
    return None

# ─── Category definitions ─────────────────────────────────────────

CATEGORIES: dict[str, dict] = {
    "bullish_breakout": {
        "label":       "Bullish — Resistance Breakout",
        "short":       "Bullish Breakout",
        "type":        "bullish",
        "icon":        "▲",
        "description": "Closed above 20-bar swing high with volume confirmation (≥1.5× avg)",
    },
    "bearish_breakdown": {
        "label":       "Bearish — Break of Support",
        "short":       "Bearish Breakdown",
        "type":        "bearish",
        "icon":        "▼",
        "description": "Closed below 20-bar swing low with volume confirmation (≥1.5× avg)",
    },
    "consolidation": {
        "label":       "Under Consolidation",
        "short":       "Consolidation",
        "type":        "neutral",
        "icon":        "↔",
        "description": "Bollinger Band squeeze (width < 25th pct of 50-bar range) + low ATR — breakout imminent",
    },
    "near_resistance": {
        "label":       "Near Resistance",
        "short":       "Near Resistance",
        "type":        "watch",
        "icon":        "↑",
        "description": "Within 1.5% below 20-bar swing high — watch for breakout or rejection",
    },
    "near_support": {
        "label":       "Near Support",
        "short":       "Near Support",
        "type":        "watch",
        "icon":        "↓",
        "description": "Within 1.5% above 20-bar swing low — watch for bounce or breakdown",
    },
    "oversold_bounce": {
        "label":       "Oversold Bounce Setup",
        "short":       "Oversold",
        "type":        "bullish",
        "icon":        "⟳",
        "description": "RSI(14) < 35 + price at/below lower Bollinger Band — potential reversal long",
    },
    "overbought_reversal": {
        "label":       "Overbought — Reversal Risk",
        "short":       "Overbought",
        "type":        "bearish",
        "icon":        "⚠",
        "description": "RSI(14) > 70 + price at/above upper Bollinger Band — pullback or reversal risk",
    },
    "volume_surge": {
        "label":       "Volume Surge",
        "short":       "Volume Surge",
        "type":        "momentum",
        "icon":        "⬆",
        "description": "Volume ≥2.5× 20-bar average — strong directional conviction",
    },
    "golden_cross": {
        "label":       "Golden Cross",
        "short":       "Golden Cross",
        "type":        "bullish",
        "icon":        "+",
        "description": "EMA(50) crossed above EMA(200) within last 10 bars — long-term trend turning bullish",
    },
    "death_cross": {
        "label":       "Death Cross",
        "short":       "Death Cross",
        "type":        "bearish",
        "icon":        "×",
        "description": "EMA(50) crossed below EMA(200) within last 10 bars — long-term trend turning bearish",
    },
    "gap_up": {
        "label":       "Gap Up — Momentum",
        "short":       "Gap Up",
        "type":        "bullish",
        "icon":        "↑↑",
        "description": "Today's open ≥1.5% above prior close — strong buying overnight",
    },
    "gap_down": {
        "label":       "Gap Down — Weakness",
        "short":       "Gap Down",
        "type":        "bearish",
        "icon":        "↓↓",
        "description": "Today's open ≥1.5% below prior close — strong selling overnight",
    },
    # ── Multi-timeframe ───────────────────────────────────────────
    "weekly_high_breakout": {
        "label":       "Weekly High Breakout",
        "short":       "Wkly Breakout",
        "type":        "bullish",
        "icon":        "W↑",
        "description": "Closed above prior week's high with volume confirmation — momentum continuation",
    },
    "weekly_low_breakdown": {
        "label":       "Weekly Low Breakdown",
        "short":       "Wkly Breakdown",
        "type":        "bearish",
        "icon":        "W↓",
        "description": "Closed below prior week's low with volume confirmation — bearish continuation",
    },
    "weekly_consolidation_breakout": {
        "label":       "Weekly Consol. Breakout",
        "short":       "Wkly Consol.",
        "type":        "bullish",
        "icon":        "W⤴",
        "description": "3-week price range < 7% ATR-adjusted, now breaking above range high with volume",
    },
    "monthly_consolidation_breakout": {
        "label":       "Monthly Consol. Breakout",
        "short":       "Mthly Consol.",
        "type":        "bullish",
        "icon":        "M⤴",
        "description": "21-day price range < 12%, now closing above monthly range high with volume",
    },
    "4h_near_high": {
        "label":       "4H High — Watch Level",
        "short":       "Near 4H High",
        "type":        "watch",
        "icon":        "4H↑",
        "description": "Within 0.5% of most recent 4-hour candle high — potential resistance or breakout zone",
    },
    "4h_near_low": {
        "label":       "4H Low — Watch Level",
        "short":       "Near 4H Low",
        "type":        "watch",
        "icon":        "4H↓",
        "description": "Within 0.5% of most recent 4-hour candle low — potential support or breakdown zone",
    },
}


# ─── Indicator math ────────────────────────────────────────────────

def _ema(series: np.ndarray, period: int) -> np.ndarray:
    n = len(series)
    result = np.full(n, np.nan)
    if n < period:
        return result
    result[period - 1] = float(np.mean(series[:period]))
    alpha = 2.0 / (period + 1)
    for i in range(period, n):
        result[i] = series[i] * alpha + result[i - 1] * (1.0 - alpha)
    return result


def _rsi(closes: np.ndarray, period: int = 14) -> np.ndarray:
    n = len(closes)
    result = np.full(n, np.nan)
    if n <= period:
        return result
    delta  = np.diff(closes, prepend=closes[0])
    gains  = np.where(delta > 0, delta,  0.0)
    losses = np.where(delta < 0, -delta, 0.0)
    avg_gain = float(np.mean(gains[1:period + 1]))
    avg_loss = float(np.mean(losses[1:period + 1]))
    for i in range(period, n):
        if i > period:
            avg_gain = (avg_gain * (period - 1) + gains[i])  / period
            avg_loss = (avg_loss * (period - 1) + losses[i]) / period
        rs = avg_gain / avg_loss if avg_loss > 0 else 100.0
        result[i] = 100.0 - 100.0 / (1.0 + rs)
    return result


def _atr(highs: np.ndarray, lows: np.ndarray, closes: np.ndarray, period: int = 14) -> np.ndarray:
    n = len(closes)
    tr = np.empty(n)
    tr[0] = highs[0] - lows[0]
    for i in range(1, n):
        tr[i] = max(highs[i] - lows[i],
                    abs(highs[i] - closes[i - 1]),
                    abs(lows[i]  - closes[i - 1]))
    atr = np.full(n, np.nan)
    if n < period:
        return atr
    atr[period - 1] = float(np.mean(tr[:period]))
    for i in range(period, n):
        atr[i] = atr[i - 1] * (period - 1) / period + tr[i] / period
    return atr


def _bollinger(closes: np.ndarray, period: int = 20, k: float = 2.0):
    """Returns (upper, middle, lower, width_pct) arrays."""
    n = len(closes)
    mid = np.full(n, np.nan)
    upper = np.full(n, np.nan)
    lower = np.full(n, np.nan)
    for i in range(period - 1, n):
        window = closes[i - period + 1:i + 1]
        m = float(np.mean(window))
        s = float(np.std(window, ddof=0))
        mid[i]   = m
        upper[i] = m + k * s
        lower[i] = m - k * s
    width = np.where(mid > 0, (upper - lower) / mid * 100, np.nan)
    return upper, mid, lower, width


# ─── Core classifier ──────────────────────────────────────────────

def classify_symbol(symbol: str, df: pd.DataFrame, market: str, intraday: dict = None) -> tuple[list[str], dict]:
    """
    Classify symbol into applicable categories.
    Returns (category_list, metrics_dict).
    metrics_dict is appended to each stock row so the UI can show RSI, vol_ratio, etc.
    """
    if df is None or len(df) < 50:
        return [], {}

    closes  = df["close"].values.astype(float)
    highs   = df["high"].values.astype(float)
    lows    = df["low"].values.astype(float)
    volumes = df["volume"].values.astype(float)
    opens   = df["open"].values.astype(float)
    n       = len(closes)

    # ── Indicators ────────────────────────────────────────────────
    rsi_vals  = _rsi(closes, 14)
    atr_vals  = _atr(highs, lows, closes, 14)
    ema50     = _ema(closes, 50)
    ema200    = _ema(closes, min(200, n))
    bb_upper, bb_mid, bb_lower, bb_width = _bollinger(closes, 20)

    vol_ma20 = np.array([
        float(np.mean(volumes[max(0, i - 20):i])) if i >= 20 else np.nan
        for i in range(n)
    ])

    # Latest bar values
    price     = float(closes[-1])
    rsi       = float(rsi_vals[-1]) if not np.isnan(rsi_vals[-1]) else 50.0
    atr       = float(atr_vals[-1]) if not np.isnan(atr_vals[-1]) else 0.0
    atr_pct   = atr / price * 100 if price > 0 else 0.0
    vol       = float(volumes[-1])
    vol_avg   = float(vol_ma20[-1]) if not np.isnan(vol_ma20[-1]) else 0.0
    vol_ratio = round(vol / vol_avg, 2) if vol_avg > 0 else 1.0

    bb_u = float(bb_upper[-1]) if not np.isnan(bb_upper[-1]) else price * 1.05
    bb_l = float(bb_lower[-1]) if not np.isnan(bb_lower[-1]) else price * 0.95
    bw   = float(bb_width[-1]) if not np.isnan(bb_width[-1]) else 10.0

    e50  = float(ema50[-1])   if not np.isnan(ema50[-1])  else price
    e200 = float(ema200[-1])  if not np.isnan(ema200[-1]) else price

    # 20-bar swing high/low (exclude current bar to avoid self-reference)
    lookback     = min(21, n - 1)
    swing_high   = float(np.max(highs[-lookback - 1:-1])) if lookback > 0 else price
    swing_low    = float(np.min(lows[-lookback - 1:-1]))  if lookback > 0 else price

    # Gap: compare today's open vs yesterday's close
    gap_pct = (opens[-1] - closes[-2]) / closes[-2] * 100 if n >= 2 else 0.0

    # ── Multi-timeframe levels (derived from daily bars) ──────────
    # Prior week ≈ bars -10..-5  |  Current week ≈ bars -5..-1
    if n >= 10:
        prior_wk_high = float(np.max(highs[-10:-5]))
        prior_wk_low  = float(np.min(lows[-10:-5]))
    else:
        prior_wk_high = swing_high
        prior_wk_low  = swing_low

    curr_wk_high = float(np.max(highs[-5:]))  if n >= 5 else float(highs[-1])
    curr_wk_low  = float(np.min(lows[-5:]))   if n >= 5 else float(lows[-1])

    # Monthly ≈ last 21 trading days
    m_start      = max(0, n - 21)
    monthly_high = float(np.max(highs[m_start:])) if n >= 5 else float(highs[-1])
    monthly_low  = float(np.min(lows[m_start:]))  if n >= 5 else float(lows[-1])

    # 3-week range for consolidation detection (bars -15..-1, exclude today)
    w3_start  = max(0, n - 15)
    wk3_high  = float(np.max(highs[w3_start:-1])) if n > 15 else swing_high
    wk3_low   = float(np.min(lows[w3_start:-1]))  if n > 15 else swing_low
    wk3_range = (wk3_high - wk3_low) / wk3_low * 100 if wk3_low > 0 else 100.0

    # Monthly consolidation range
    mth_range = (monthly_high - monthly_low) / monthly_low * 100 if monthly_low > 0 else 100.0

    # 4H high/low: from intraday fetch if available, else fallback to today's daily candle
    h4_high = float(intraday.get("4h_high", highs[-1])) if intraday else float(highs[-1])
    h4_low  = float(intraday.get("4h_low",  lows[-1]))  if intraday else float(lows[-1])

    # BB width percentile over last 50 valid bars
    valid_bw = bb_width[~np.isnan(bb_width)]
    bw_25th  = float(np.percentile(valid_bw[-50:], 25)) if len(valid_bw) >= 20 else float("inf")

    # ── Classification ────────────────────────────────────────────
    cats: list[str] = []

    # Bullish breakout
    if price > swing_high and vol_ratio >= 1.5:
        cats.append("bullish_breakout")

    # Bearish breakdown
    if price < swing_low and vol_ratio >= 1.5:
        cats.append("bearish_breakdown")

    # Near resistance (within 1.5% below swing high, not above)
    if price <= swing_high and swing_high > 0 and (swing_high - price) / swing_high <= 0.015:
        cats.append("near_resistance")

    # Near support (within 1.5% above swing low, not below)
    if price >= swing_low and swing_low > 0 and (price - swing_low) / swing_low <= 0.015:
        cats.append("near_support")

    # Consolidation: BB squeeze + low ATR
    if bw < bw_25th and atr_pct < 2.0:
        cats.append("consolidation")

    # Oversold bounce: RSI < 35 and price at/below lower BB
    if rsi < 35 and price <= bb_l * 1.01:
        cats.append("oversold_bounce")

    # Overbought reversal: RSI > 70 and price at/above upper BB
    if rsi > 70 and price >= bb_u * 0.99:
        cats.append("overbought_reversal")

    # Volume surge: 2.5× average
    if vol_ratio >= 2.5:
        cats.append("volume_surge")

    # Golden cross: EMA50 crossed above EMA200 in last 10 bars
    if n >= 200:
        for i in range(1, min(11, n)):
            if not np.isnan(ema50[-i]) and not np.isnan(ema200[-i]) \
               and not np.isnan(ema50[-i - 1]) and not np.isnan(ema200[-i - 1]):
                if ema50[-i] > ema200[-i] and ema50[-i - 1] <= ema200[-i - 1]:
                    cats.append("golden_cross")
                    break

    # Death cross: EMA50 crossed below EMA200 in last 10 bars
    if n >= 200:
        for i in range(1, min(11, n)):
            if not np.isnan(ema50[-i]) and not np.isnan(ema200[-i]) \
               and not np.isnan(ema50[-i - 1]) and not np.isnan(ema200[-i - 1]):
                if ema50[-i] < ema200[-i] and ema50[-i - 1] >= ema200[-i - 1]:
                    cats.append("death_cross")
                    break

    # Gap up
    if gap_pct >= 1.5:
        cats.append("gap_up")

    # Gap down
    if gap_pct <= -1.5:
        cats.append("gap_down")

    # ── Multi-timeframe categories ────────────────────────────────
    # Weekly high breakout: closed above prior week's high with volume
    if price > prior_wk_high and vol_ratio >= 1.3:
        cats.append("weekly_high_breakout")

    # Weekly low breakdown: closed below prior week's low with volume
    if price < prior_wk_low and vol_ratio >= 1.3:
        cats.append("weekly_low_breakdown")

    # Weekly consolidation breakout: 3-week tight range → price breaks above
    if wk3_range < 7.0 and price > wk3_high and vol_ratio >= 1.2:
        cats.append("weekly_consolidation_breakout")

    # Monthly consolidation breakout: 21-day tight range → price breaks above
    if mth_range < 12.0 and price > monthly_high and vol_ratio >= 1.2:
        cats.append("monthly_consolidation_breakout")

    # Near 4H high: within 0.5% below the 4H candle high
    if h4_high > 0 and price <= h4_high and (h4_high - price) / h4_high <= 0.005:
        cats.append("4h_near_high")

    # Near 4H low: within 0.5% above the 4H candle low
    if h4_low > 0 and price >= h4_low and (price - h4_low) / h4_low <= 0.005:
        cats.append("4h_near_low")

    metrics = {
        "price":          round(price, 4),
        "change_pct":     round(gap_pct, 2),
        "rsi":            round(rsi, 1),
        "vol_ratio":      vol_ratio,
        "atr_pct":        round(atr_pct, 2),
        "bb_width":       round(bw, 2),
        "ema50":          round(e50, 2),
        "ema200":         round(e200, 2),
        "swing_high":     round(swing_high, 2),
        "swing_low":      round(swing_low, 2),
        # Multi-timeframe levels
        "4h_high":        round(h4_high, 2),
        "4h_low":         round(h4_low, 2),
        "weekly_high":    round(curr_wk_high, 2),
        "weekly_low":     round(curr_wk_low, 2),
        "prior_wk_high":  round(prior_wk_high, 2),
        "prior_wk_low":   round(prior_wk_low, 2),
        "monthly_high":   round(monthly_high, 2),
        "monthly_low":    round(monthly_low, 2),
    }
    return cats, metrics


# ─── Data fetchers ────────────────────────────────────────────────

def _fetch_india_symbol(symbol: str) -> tuple[str, Optional[pd.DataFrame]]:
    """Fetch 6 months of daily OHLCV for one India NSE stock via yfinance."""
    if symbol in _BAD_SYMBOLS:
        return symbol, None
    try:
        import yfinance as yf
        bare = symbol.replace(".NS", "").replace(".BO", "")
        ticker = yf.Ticker(f"{bare}.NS")
        df = ticker.history(period="6mo", interval="1d", auto_adjust=True)
        if df.empty or len(df) < 50:
            _BAD_SYMBOLS.add(symbol)
            logger.warning(f"Screener: skipping {symbol} — no data from Yahoo Finance")
            return symbol, None
        df = df.rename(columns=str.lower)[["open", "high", "low", "close", "volume"]].dropna()
        return symbol, df
    except Exception as e:
        logger.debug(f"Screener India fetch [{symbol}]: {e}")
        return symbol, None


def _fetch_india_batch(symbols: list[str]) -> dict[str, pd.DataFrame]:
    """Fetch all India symbols in parallel threads."""
    result: dict[str, pd.DataFrame] = {}
    with ThreadPoolExecutor(max_workers=8) as pool:
        futures = {pool.submit(_fetch_india_symbol, sym): sym for sym in symbols}
        for fut in as_completed(futures, timeout=90):
            sym, df = fut.result()
            if df is not None:
                result[sym] = df
    return result


def _fetch_india_intraday_single(symbol: str) -> tuple[str, Optional[dict]]:
    """Fetch 5d of 60m OHLCV, return 4H candle high/low (last 4 hourly bars)."""
    if symbol in _BAD_SYMBOLS:
        return symbol, None
    try:
        import yfinance as yf
        bare = symbol.replace(".NS", "").replace(".BO", "")
        df = yf.Ticker(f"{bare}.NS").history(period="5d", interval="60m", auto_adjust=True)
        if df.empty or len(df) < 4:
            return symbol, None
        df = df.rename(columns=str.lower).dropna(subset=["high", "low"])
        if len(df) < 4:
            return symbol, None
        h4 = df.iloc[-4:]
        return symbol, {
            "4h_high": round(float(h4["high"].max()), 2),
            "4h_low":  round(float(h4["low"].min()),  2),
        }
    except Exception:
        return symbol, None


def _fetch_india_4h_batch(symbols: list[str]) -> dict[str, dict]:
    """Parallel 4H intraday fetch for all India symbols."""
    result: dict[str, dict] = {}
    with ThreadPoolExecutor(max_workers=8) as pool:
        futures = {pool.submit(_fetch_india_intraday_single, sym): sym for sym in symbols}
        for fut in as_completed(futures, timeout=60):
            sym, data = fut.result()
            if data is not None:
                result[sym] = data
    return result


def _fetch_crypto_ohlcv(symbol: str) -> Optional[pd.DataFrame]:
    """Fetch 4 days of 1h OHLCV for a crypto symbol via Delta Exchange REST."""
    try:
        from data.delta_client import delta_rest
        end   = int(time.time())
        start = end - 4 * 24 * 3600  # 4 days
        candles = delta_rest.get_candlestick(symbol, "1h", start, end)
        if not candles or len(candles) < 50:
            return None
        df = pd.DataFrame(candles)
        df["timestamp"] = pd.to_datetime(df["timestamp"])
        df = df.sort_values("timestamp").reset_index(drop=True)
        for col in ("open", "high", "low", "close", "volume"):
            df[col] = pd.to_numeric(df[col], errors="coerce")
        return df[["open", "high", "low", "close", "volume"]].dropna()
    except Exception as e:
        logger.debug(f"Screener crypto fetch [{symbol}]: {e}")
        return None


# ─── Main scan ────────────────────────────────────────────────────

async def run_screener_scan(market: str = "all") -> dict:
    """
    Scan all watchlist symbols and group them by screening category.
    market: 'india' | 'crypto' | 'all'
    """
    from core.config import INDIA_WATCHLIST, CRYPTO_WATCHLIST

    logger.info(f"▶ Screener — {market.upper()} scan")

    # Initialise empty category buckets
    categories: dict[str, dict] = {
        cat_id: {
            **meta,
            "stocks": [],
            "count": 0,
        }
        for cat_id, meta in CATEGORIES.items()
    }

    scan_errors = 0
    scan_total  = 0

    # ── India stocks ──────────────────────────────────────────────
    if market in ("india", "all"):
        logger.info(f"  Fetching {len(INDIA_WATCHLIST)} India stocks …")
        india_map: dict[str, pd.DataFrame]
        india_map, intraday_map = await asyncio.gather(
            asyncio.to_thread(_fetch_india_batch, INDIA_WATCHLIST),
            asyncio.to_thread(_fetch_india_4h_batch, INDIA_WATCHLIST),
        )
        logger.info(f"  4H intraday data: {len(intraday_map)}/{len(INDIA_WATCHLIST)} symbols")
        for symbol in INDIA_WATCHLIST:
            df = india_map.get(symbol)
            if df is None:
                scan_errors += 1
                continue
            try:
                cats, metrics = classify_symbol(symbol, df, "india", intraday=intraday_map.get(symbol))
                scan_total += 1
                # Fetch live price from state store (updated by groww/yfinance tasks)
                mkt_data = state.read_market_data("india", symbol) or {}
                live_price  = mkt_data.get("ltp") or mkt_data.get("price") or metrics["price"]
                live_change = mkt_data.get("change_pct") or metrics["change_pct"]

                row = {
                    "symbol":     symbol,
                    "market":     "india",
                    "price":      live_price,
                    "change_pct": round(float(live_change or 0), 2),
                    **metrics,
                }
                for cat in cats:
                    categories[cat]["stocks"].append(row)
            except Exception as e:
                logger.warning(f"  Screener classify [{symbol}]: {e}")
                scan_errors += 1

    # ── Crypto ────────────────────────────────────────────────────
    if market in ("crypto", "all"):
        logger.info(f"  Fetching {len(CRYPTO_WATCHLIST)} crypto symbols …")
        for symbol in CRYPTO_WATCHLIST:
            # Delta Exchange uses BTCUSD; CRYPTO_WATCHLIST uses Binance-style BTCUSDT
            delta_sym = symbol.replace("USDT", "USD")
            df = await asyncio.to_thread(_fetch_crypto_ohlcv, delta_sym)
            if df is None:
                scan_errors += 1
                continue
            try:
                cats, metrics = classify_symbol(delta_sym, df, "crypto")
                scan_total += 1
                mkt_data = state.read_market_data("crypto", delta_sym) or {}
                live_price  = mkt_data.get("ltp") or mkt_data.get("price") or metrics["price"]
                live_change = mkt_data.get("change_pct") or metrics["change_pct"]

                row = {
                    "symbol":     delta_sym,
                    "market":     "crypto",
                    "price":      live_price,
                    "change_pct": round(float(live_change or 0), 2),
                    **metrics,
                }
                for cat in cats:
                    categories[cat]["stocks"].append(row)
            except Exception as e:
                logger.warning(f"  Screener classify [{delta_sym}]: {e}")
                scan_errors += 1

    # Update counts
    for cat in categories.values():
        cat["count"] = len(cat["stocks"])

    import pytz
    ist_now = datetime.now(pytz.timezone("Asia/Kolkata")).strftime("%H:%M IST")

    result = {
        "timestamp":  datetime.now(timezone.utc).isoformat(),
        "last_scan":  ist_now,
        "market":     market,
        "total_scanned": scan_total,
        "categories": categories,
    }

    # Redis: 24h TTL — Supabase is now the authoritative persistent store
    state.set("/screener/results", result, ttl=86400)
    state.set("/screener/last_scan", ist_now, ttl=86400)

    # Supabase: persist so data survives server restarts
    _save_screener_to_db(result)

    # Broadcast lightweight update notification
    await _broadcast()

    total_hits = sum(cat["count"] for cat in categories.values())
    logger.info(
        f"✓ Screener — {scan_total} symbols, {scan_errors} errors, "
        f"{total_hits} category hits"
    )
    return result


async def _broadcast() -> None:
    try:
        from api import manager
        last = state.get("/screener/last_scan") or "—"
        await manager.broadcast({"type": "screener_update", "last_scan": last})
    except Exception:
        pass


# ─── Phase 5: Intraday screener ───────────────────────────────────

INTRADAY_CATEGORIES: dict[str, dict] = {
    "volume_spike_5m": {
        "label":       "Volume Spike (5-min)",
        "short":       "Vol Spike 5m",
        "type":        "momentum",
        "icon":        "⚡",
        "description": "Volume in last 5-min bar ≥3× the 20-bar 5-min average — unusual activity",
    },
    "rsi_crossover_15m": {
        "label":       "RSI Crossover (15-min)",
        "short":       "RSI Cross 15m",
        "type":        "bullish",
        "icon":        "⟳",
        "description": "RSI crossed above 50 on 15-min chart — intraday momentum shift bullish",
    },
    "near_vwap": {
        "label":       "Near VWAP",
        "short":       "Near VWAP",
        "type":        "watch",
        "icon":        "⊗",
        "description": "Price within 0.3% of intraday VWAP — institutional reference level",
    },
    "intraday_momentum": {
        "label":       "Intraday Momentum",
        "short":       "ID Momentum",
        "type":        "bullish",
        "icon":        "▶",
        "description": "Up ≥1.5% from day open + volume accelerating — trend in motion",
    },
    "intraday_reversal": {
        "label":       "Intraday Reversal",
        "short":       "ID Reversal",
        "type":        "watch",
        "icon":        "↩",
        "description": "Down ≥1.5% from day open then bouncing — potential intraday reversal",
    },
    "pivot_r1_breakout": {
        "label":       "Pivot R1 Breakout",
        "short":       "Pivot R1",
        "type":        "bullish",
        "icon":        "R1↑",
        "description": "Price crossed above Pivot Point R1 level — classic intraday breakout",
    },
    "near_day_high": {
        "label":       "Near Day High",
        "short":       "Near High",
        "type":        "watch",
        "icon":        "DH↑",
        "description": "Within 0.3% of today's high — watch for breakout or rejection",
    },
    "near_day_low": {
        "label":       "Near Day Low",
        "short":       "Near Low",
        "type":        "watch",
        "icon":        "DL↓",
        "description": "Within 0.3% of today's low — watch for bounce or breakdown",
    },
}


def _calc_pivot_points(prev_high: float, prev_low: float, prev_close: float) -> dict:
    """Calculate classic pivot points from prior day's H/L/C."""
    pp = (prev_high + prev_low + prev_close) / 3
    r1 = 2 * pp - prev_low
    s1 = 2 * pp - prev_high
    r2 = pp + (prev_high - prev_low)
    s2 = pp - (prev_high - prev_low)
    return {"pp": pp, "r1": r1, "s1": s1, "r2": r2, "s2": s2}


def _calc_vwap(df_5m: pd.DataFrame) -> float | None:
    """Calculate intraday VWAP from a 5-min bar DataFrame."""
    try:
        typical_price = (df_5m["high"] + df_5m["low"] + df_5m["close"]) / 3
        vwap = (typical_price * df_5m["volume"]).sum() / df_5m["volume"].sum()
        return float(vwap)
    except Exception:
        return None


def classify_intraday(symbol: str, df_5m: pd.DataFrame,
                      df_15m: pd.DataFrame, df_daily: pd.DataFrame) -> tuple[list[str], dict]:
    """
    Classify a symbol into intraday screener categories.
    df_5m:   today's 5-min bars
    df_15m:  today's 15-min bars
    df_daily: recent daily bars (for pivot calculation)
    """
    cats: list[str] = []
    metrics: dict = {}

    if df_5m is None or len(df_5m) < 5:
        return cats, metrics
    if df_15m is None or len(df_15m) < 3:
        return cats, metrics

    closes_5m  = df_5m["close"].values.astype(float)
    volumes_5m = df_5m["volume"].values.astype(float)
    highs_5m   = df_5m["high"].values.astype(float)
    lows_5m    = df_5m["low"].values.astype(float)

    closes_15m = df_15m["close"].values.astype(float)

    price     = float(closes_5m[-1])
    day_open  = float(df_5m["open"].values[0])   # first 5m bar open = day open
    day_high  = float(highs_5m.max())
    day_low   = float(lows_5m.min())

    # 5-min volume spike
    vol_avg_5m = float(np.mean(volumes_5m[-21:-1])) if len(volumes_5m) > 20 else float(np.mean(volumes_5m[:-1] or [1]))
    vol_ratio_5m = float(volumes_5m[-1]) / vol_avg_5m if vol_avg_5m > 0 else 1.0
    if vol_ratio_5m >= 3.0:
        cats.append("volume_spike_5m")

    # RSI crossover on 15m
    if len(closes_15m) >= 16:
        rsi_15m = _rsi(closes_15m, 14)
        if (not np.isnan(rsi_15m[-1]) and not np.isnan(rsi_15m[-2])
                and rsi_15m[-1] > 50 and rsi_15m[-2] <= 50):
            cats.append("rsi_crossover_15m")

    # VWAP proximity
    vwap = _calc_vwap(df_5m)
    if vwap and vwap > 0:
        dist_pct = abs(price - vwap) / vwap * 100
        if dist_pct <= 0.3:
            cats.append("near_vwap")

    # Intraday momentum: up ≥1.5% from open + last 3 bars trending up
    open_chg_pct = (price - day_open) / day_open * 100 if day_open > 0 else 0.0
    if open_chg_pct >= 1.5 and vol_ratio_5m >= 1.2:
        cats.append("intraday_momentum")

    # Intraday reversal: down ≥1.5% from open then current bar up
    if open_chg_pct <= -1.5 and len(closes_5m) >= 3:
        last_3_up = closes_5m[-1] > closes_5m[-2] > closes_5m[-3]
        if last_3_up:
            cats.append("intraday_reversal")

    # Pivot R1 breakout
    if df_daily is not None and len(df_daily) >= 2:
        prev_high  = float(df_daily["high"].values[-2])
        prev_low   = float(df_daily["low"].values[-2])
        prev_close = float(df_daily["close"].values[-2])
        pivots = _calc_pivot_points(prev_high, prev_low, prev_close)
        r1 = pivots["r1"]
        if (not np.isnan(r1) and closes_5m[-1] > r1 and closes_5m[-2] <= r1):
            cats.append("pivot_r1_breakout")
        metrics.update({k: round(v, 2) for k, v in pivots.items()})

    # Near day high / low
    if day_high > 0 and (day_high - price) / day_high <= 0.003:
        cats.append("near_day_high")
    if day_low > 0 and price > day_low and (price - day_low) / day_low <= 0.003:
        cats.append("near_day_low")

    metrics.update({
        "price":          round(price, 2),
        "day_open":       round(day_open, 2),
        "day_high":       round(day_high, 2),
        "day_low":        round(day_low, 2),
        "open_chg_pct":   round(open_chg_pct, 2),
        "vol_ratio_5m":   round(vol_ratio_5m, 2),
        "vwap":           round(vwap, 2) if vwap else None,
    })
    return cats, metrics


def _fetch_india_intraday_full(symbol: str) -> tuple[str, dict | None]:
    """Fetch 5-min and 15-min intraday data for one India symbol + daily for pivots."""
    if symbol in _BAD_SYMBOLS:
        return symbol, None
    try:
        import yfinance as yf
        bare   = symbol.replace(".NS", "").replace(".BO", "")
        ticker = yf.Ticker(f"{bare}.NS")

        df_5m   = ticker.history(period="1d", interval="5m",  auto_adjust=True)
        df_15m  = ticker.history(period="1d", interval="15m", auto_adjust=True)
        df_day  = ticker.history(period="5d", interval="1d",  auto_adjust=True)

        def _clean(df):
            if df.empty:
                return None
            df = df.rename(columns=str.lower)
            for col in ["open", "high", "low", "close", "volume"]:
                if col not in df.columns:
                    return None
            return df[["open", "high", "low", "close", "volume"]].dropna()

        return symbol, {
            "5m":    _clean(df_5m),
            "15m":   _clean(df_15m),
            "daily": _clean(df_day),
        }
    except Exception as e:
        logger.debug(f"Intraday fetch [{symbol}]: {e}")
        return symbol, None


async def run_intraday_screener_scan() -> dict:
    """
    Intraday screener scan — runs every 15 min during market hours.
    Returns intraday category buckets with live price context.
    """
    from core.config import INDIA_WATCHLIST
    import pytz as _tz

    logger.info("▶ Intraday Screener scan")

    categories: dict[str, dict] = {
        cat_id: {**meta, "stocks": [], "count": 0}
        for cat_id, meta in INTRADAY_CATEGORIES.items()
    }

    scan_total  = 0
    scan_errors = 0

    def _fetch_batch(symbols):
        result = {}
        with ThreadPoolExecutor(max_workers=8) as pool:
            futures = {pool.submit(_fetch_india_intraday_full, sym): sym for sym in symbols}
            for fut in as_completed(futures, timeout=90):
                sym, data = fut.result()
                if data is not None:
                    result[sym] = data
        return result

    intraday_map = await asyncio.to_thread(_fetch_batch, INDIA_WATCHLIST)

    for symbol in INDIA_WATCHLIST:
        data = intraday_map.get(symbol)
        if not data:
            scan_errors += 1
            continue
        try:
            cats, metrics = classify_intraday(
                symbol,
                data.get("5m"),
                data.get("15m"),
                data.get("daily"),
            )
            if not cats:
                scan_total += 1
                continue
            mkt_data   = state.read_market_data("india", symbol) or {}
            live_price = mkt_data.get("ltp") or mkt_data.get("price") or metrics.get("price")
            row = {
                "symbol":     symbol,
                "market":     "india",
                "price":      live_price,
                "change_pct": mkt_data.get("change_pct", metrics.get("open_chg_pct", 0)),
                **metrics,
            }
            for cat in cats:
                if cat in categories:
                    categories[cat]["stocks"].append(row)
            scan_total += 1
        except Exception as e:
            logger.warning(f"  Intraday classify [{symbol}]: {e}")
            scan_errors += 1

    for cat in categories.values():
        cat["count"] = len(cat["stocks"])

    ist_now = datetime.now(_tz.timezone("Asia/Kolkata")).strftime("%H:%M IST")
    result  = {
        "timestamp":     datetime.now(timezone.utc).isoformat(),
        "last_scan":     ist_now,
        "market":        "india",
        "total_scanned": scan_total,
        "categories":    categories,
    }

    state.set("/screener/intraday", result, ttl=900)
    state.set("/screener/intraday_last_scan", ist_now, ttl=900)

    # Persist to Supabase so data survives backend restart
    try:
        from core.supabase_pool import admin_client
        db = admin_client()
        db.table("intraday_screener_results").insert({
            "total_scanned": scan_total,
            "last_scan":     ist_now,
            "categories":    categories,
        }).execute()
        # Prune scans older than 24 hours to keep the table small
        cutoff = (datetime.now(timezone.utc) - timedelta(hours=24)).isoformat()
        db.table("intraday_screener_results").delete().lt("scanned_at", cutoff).execute()
    except Exception as _db_err:
        logger.debug(f"Intraday DB persist failed (non-fatal): {_db_err}")

    total_hits = sum(cat["count"] for cat in categories.values())
    logger.info(
        f"✓ Intraday Screener — {scan_total} symbols, "
        f"{scan_errors} errors, {total_hits} category hits"
    )
    return result


# ─── Sync wrapper for scheduler ───────────────────────────────────

def run_screener_scan_sync(market: str = "all") -> None:
    asyncio.run(run_screener_scan(market))
    import pytz
    state.set(
        "/scheduler/last_run/screener",
        datetime.now(pytz.timezone("Asia/Kolkata")).strftime("%H:%M:%S IST"),
        ttl=86400,
    )
