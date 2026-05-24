"""
data/india_market.py
─────────────────────────────────────────────────────
Fetches NSE/BSE market data using yfinance (free, no API key needed).
Writes structured snapshots to the Global State Store.

Data available via yfinance:
  - Real-time price (15-min delayed for free)
  - OHLCV history (full, going back years)
  - Basic fundamentals (P/E, market cap, 52w high/low)
  
For true real-time data: swap yfinance calls with Fyers API
after opening a free Fyers account.
"""
from __future__ import annotations
import asyncio
import logging
from datetime import datetime, timedelta, timezone
from typing import Optional
import pandas as pd
logging.getLogger("yfinance").setLevel(logging.CRITICAL)
logging.getLogger("peewee").setLevel(logging.CRITICAL)
import yfinance as yf
from loguru import logger
from tenacity import retry, stop_after_attempt, wait_exponential

from core.config import INDIA_WATCHLIST, INDIA_INDICES
from core.state_store import state


# ─── Sector / extra index maps ────────────────────────────────────
SECTOR_INDICES = {
    'BANK':   '^NSEBANK',
    'IT':     '^CNXIT',
    'AUTO':   '^CNXAUTO',
    'PHARMA': '^CNXPHARMA',
    'FMCG':   '^CNXFMCG',
    'METAL':  '^CNXMETAL',
    'ENERGY': '^CNXENERGY',
    'REALTY': '^CNXREALTY',
}

EXTRA_INDICES = {
    'SENSEX': '^BSESN',
    'MIDCAP': '^NSMIDCP',   # ^CNXMIDCAP broken on Yahoo Finance
    'SMALL':  '^CNXSC',
}


def fetch_sector_performance() -> dict:
    """Fetch daily % change for NSE sector indices via yfinance."""
    result = {}
    for key, symbol in {**SECTOR_INDICES, **EXTRA_INDICES}.items():
        try:
            t = yf.Ticker(symbol)
            h = t.history(period="5d", interval="1d")
            if len(h) >= 2:
                curr = float(h["Close"].iloc[-1])
                prev = float(h["Close"].iloc[-2])
                if prev > 0:
                    result[key] = round((curr - prev) / prev * 100, 2)
        except Exception as e:
            logger.debug(f"sector {key} ({symbol}): {e}")
    logger.info(f"fetch_sector_performance: {len(result)} sectors fetched")
    return result


def fetch_extra_indices_snapshot() -> dict:
    """Fetch price + % change for Sensex, Nifty Midcap, Nifty SmallCap."""
    result = {}
    for key, symbol in EXTRA_INDICES.items():
        try:
            t = yf.Ticker(symbol)
            h = t.history(period="5d", interval="1d")
            if len(h) >= 2:
                curr = float(h["Close"].iloc[-1])
                prev = float(h["Close"].iloc[-2])
                chg  = round((curr - prev) / prev * 100, 2) if prev else 0
                result[key] = {"price": round(curr, 2), "change": chg}
        except Exception as e:
            logger.debug(f"extra index {key} ({symbol}): {e}")
    return result


# ─── Main data fetcher ────────────────────────────────────────────

@retry(stop=stop_after_attempt(3), wait=wait_exponential(min=2, max=10))
def fetch_india_snapshot(symbol: str) -> dict | None:
    """
    Fetch current market snapshot for one NSE/BSE symbol.
    Returns structured dict or None on failure.
    
    symbol format: 'RELIANCE.NS' (NSE) or 'RELIANCE.BO' (BSE)
    """
    try:
        ticker = yf.Ticker(symbol)
        info   = ticker.fast_info   # lightweight — avoids full info() overhead
        hist   = ticker.history(period="20d", interval="1d", auto_adjust=True)

        if hist.empty:
            logger.warning(f"No data returned for {symbol}")
            return None

        latest  = hist.iloc[-1]
        prev    = hist.iloc[-2] if len(hist) >= 2 else hist.iloc[-1]

        # Volume ratio: today's volume vs 20-day average
        avg_vol = hist["Volume"].mean()
        vol_ratio = float(latest["Volume"] / avg_vol) if avg_vol > 0 else 1.0

        # Delivery % — not available in yfinance; set to None, fill from Fyers later
        delivery_pct = None

        snapshot = {
            "symbol":              symbol,
            "timestamp":           datetime.now(timezone.utc).isoformat(),
            "ltp":                 float(latest["Close"]),
            "open":                float(latest["Open"]),
            "high":                float(latest["High"]),
            "low":                 float(latest["Low"]),
            "close":               float(latest["Close"]),
            "prev_close":          float(prev["Close"]),
            "change_pct":          round(
                (float(latest["Close"]) - float(prev["Close"])) / float(prev["Close"]) * 100, 2
            ),
            "volume":              float(latest["Volume"]),
            "volume_ratio":        round(vol_ratio, 2),
            "52w_high":            float(getattr(info, "year_high", 0) or 0),
            "52w_low":             float(getattr(info, "year_low", 0) or 0),
            "pct_from_52w_high": round(
                (float(latest["Close"]) - float(getattr(info, "year_high", float(latest["Close"])) or float(latest["Close"])))
                / float(getattr(info, "year_high", float(latest["Close"])) or float(latest["Close"])) * 100, 2
            ),
            "market_cap_cr":       _safe_div(getattr(info, "market_cap", 0), 1e7),  # to crores
            "delivery_pct":        delivery_pct,
            # Fundamentals (from full info — cached daily)
            "pe_ratio":            None,
            "eps_growth_yoy":      None,
            "roe":                 None,
            "promoter_holding_pct": None,
            "dii_fii_flow_cr":     None,
        }

        return snapshot

    except Exception as e:
        logger.error(f"fetch_india_snapshot({symbol}) failed: {e}")
        return None


def fetch_india_ohlcv(symbol: str, period: str = "6mo",
                      interval: str = "1d") -> pd.DataFrame | None:
    """
    Fetch OHLCV history for technical analysis.
    
    period:   1d, 5d, 1mo, 3mo, 6mo, 1y, 2y, 5y, max
    interval: 1m, 2m, 5m, 15m, 30m, 60m, 90m, 1h, 1d, 5d, 1wk, 1mo
    """
    try:
        ticker = yf.Ticker(symbol)
        df     = ticker.history(period=period, interval=interval, auto_adjust=True)
        if df.empty:
            return None
        df.index = pd.to_datetime(df.index)
        df.columns = [c.lower() for c in df.columns]
        return df[["open", "high", "low", "close", "volume"]]
    except Exception as e:
        logger.error(f"fetch_india_ohlcv({symbol}, {period}, {interval}): {e}")
        return None


def fetch_india_fundamentals(symbol: str) -> dict:
    """
    Fetch fundamental data for a company.
    Uses yf.Ticker.info (heavier call — run once daily, cache 24h).
    """
    try:
        ticker = yf.Ticker(symbol)
        info   = ticker.info

        return {
            "symbol":          symbol,
            "pe_ratio":        info.get("trailingPE"),
            "forward_pe":      info.get("forwardPE"),
            "pb_ratio":        info.get("priceToBook"),
            "roe":             _pct(info.get("returnOnEquity")),
            "roa":             _pct(info.get("returnOnAssets")),
            "debt_to_equity":  info.get("debtToEquity"),
            "current_ratio":   info.get("currentRatio"),
            "revenue_growth":  _pct(info.get("revenueGrowth")),
            "earnings_growth": _pct(info.get("earningsGrowth")),
            "profit_margins":  _pct(info.get("profitMargins")),
            "dividend_yield":  _pct(info.get("dividendYield")),
            "market_cap_cr":   _safe_div(info.get("marketCap", 0), 1e7),
            "sector":          info.get("sector", ""),
            "industry":        info.get("industry", ""),
            "52w_high":        info.get("fiftyTwoWeekHigh"),
            "52w_low":         info.get("fiftyTwoWeekLow"),
            "fetched_at":      datetime.now(timezone.utc).isoformat(),
        }
    except Exception as e:
        logger.error(f"fetch_india_fundamentals({symbol}): {e}")
        return {"symbol": symbol, "error": str(e)}


def fetch_india_vix() -> float | None:
    """Fetch India VIX from NSE via yfinance."""
    try:
        vix  = yf.Ticker("^INDIAVIX")
        hist = vix.history(period="2d", interval="1d")
        if not hist.empty:
            return float(hist["Close"].iloc[-1])
    except Exception as e:
        logger.warning(f"India VIX fetch failed: {e}")
    return None


def fetch_nifty_trend() -> dict:
    """Fetch NIFTY 50 current state."""
    try:
        nifty = yf.Ticker("^NSEI")
        hist  = nifty.history(period="10d", interval="1d")
        if hist.empty:
            return {}
        latest  = hist.iloc[-1]
        prev    = hist.iloc[-2]
        ema_20  = hist["Close"].ewm(span=20).mean().iloc[-1]
        ema_50  = hist["Close"].ewm(span=50).mean().iloc[-1]
        return {
            "nifty_ltp":       float(latest["Close"]),
            "nifty_change_pct": round((float(latest["Close"]) - float(prev["Close"])) / float(prev["Close"]) * 100, 2),
            "nifty_above_ema20": float(latest["Close"]) > float(ema_20),
            "nifty_above_ema50": float(latest["Close"]) > float(ema_50),
            "nifty_trend":     "up" if float(latest["Close"]) > float(ema_20) > float(ema_50) else "mixed",
        }
    except Exception as e:
        logger.error(f"fetch_nifty_trend: {e}")
        return {}


# ─── Batch runner ─────────────────────────────────────────────────

async def run_india_market_data_agent() -> dict[str, dict]:
    """
    Main scheduled task: fetch all watchlist stocks and write to state store.
    Uses asyncio.gather for parallelism (all fetches happen concurrently).
    """
    logger.info("▶ UnifiedMarketDataAgent [India] — starting")
    results = {}

    # Fetch in batches of 5 to avoid rate limits
    batch_size = 5
    symbols    = INDIA_WATCHLIST + INDIA_INDICES

    for i in range(0, len(symbols), batch_size):
        batch = symbols[i : i + batch_size]
        tasks = [
            asyncio.to_thread(fetch_india_snapshot, sym)
            for sym in batch
        ]
        snapshots = await asyncio.gather(*tasks, return_exceptions=True)

        for sym, snap in zip(batch, snapshots):
            if isinstance(snap, Exception):
                logger.error(f"  ✗ {sym}: {snap}")
                continue
            if snap:
                state.write_market_data("india", sym, snap)
                results[sym] = snap
                logger.debug(f"  ✓ {sym}: ₹{snap['ltp']} ({snap['change_pct']:+.2f}%)")

        await asyncio.sleep(0.5)  # gentle rate limiting

    # Also fetch VIX, broad market, sector data, and extra indices
    vix, nifty_trend, sectors, extra_idx = await asyncio.gather(
        asyncio.to_thread(fetch_india_vix),
        asyncio.to_thread(fetch_nifty_trend),
        asyncio.to_thread(fetch_sector_performance),
        asyncio.to_thread(fetch_extra_indices_snapshot),
        return_exceptions=True,
    )

    state.set("/market/india_vix",    vix or 0.0 if not isinstance(vix, Exception) else 0.0)
    state.set("/market/nifty_trend",  nifty_trend if not isinstance(nifty_trend, Exception) else {})
    state.set("/market/sectors",      sectors if not isinstance(sectors, Exception) else {})
    state.set("/market/extra_indices", extra_idx if not isinstance(extra_idx, Exception) else {})

    logger.info(f"✓ UnifiedMarketDataAgent [India] — {len(results)}/{len(symbols)} symbols, {len(sectors) if isinstance(sectors, dict) else 0} sectors")
    return results


def run_india_fundamentals_agent() -> None:
    """
    Daily (post-market-close) fundamental data refresh.
    Writes 24h-cached data to state store.
    """
    logger.info("▶ IndiaFundamentalsAgent — starting (daily run)")
    for sym in INDIA_WATCHLIST:
        try:
            fund = fetch_india_fundamentals(sym)
            state.write_fundamentals(sym, fund)
            logger.debug(f"  ✓ {sym}: P/E={fund.get('pe_ratio', '?')}, ROE={fund.get('roe', '?')}%")
        except Exception as e:
            logger.error(f"  ✗ {sym}: {e}")
    logger.info("✓ IndiaFundamentalsAgent — done")


# ─── Helpers ──────────────────────────────────────────────────────

def _pct(v) -> float | None:
    if v is None:
        return None
    try:
        return round(float(v) * 100, 2)
    except (TypeError, ValueError):
        return None


def _safe_div(a, b) -> float:
    try:
        return round(float(a or 0) / float(b), 2)
    except (ZeroDivisionError, TypeError):
        return 0.0


# ─── Quick test ───────────────────────────────────────────────────

if __name__ == "__main__":
    import asyncio
    from pprint import pprint

    print("Testing India market data fetch...")
    snap = fetch_india_snapshot("RELIANCE.NS")
    if snap:
        pprint(snap)
    else:
        print("Fetch failed — check internet connection")

    print("\nFetching NIFTY trend...")
    pprint(fetch_nifty_trend())
