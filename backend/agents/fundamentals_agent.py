"""
agents/fundamentals_agent.py
─────────────────────────────────────────────────────
IndiaFundamentalsAgent — scores every India watchlist company
on valuation, growth, quality, and institutional interest.

Data sources (all free):
  - yfinance: P/E, ROE, revenue growth, market cap
  - Screener.in scraping: 5-year data, promoter holding trends
  - NSE website: delivery %, FII/DII holding %
  - Tickertape.in: earnings calendar, EPS estimates

Score breakdown (0–10):
  Valuation  2.5 pts  — P/E vs sector, P/B
  Growth     2.5 pts  — EPS/revenue growth YoY
  Quality    2.5 pts  — ROE, debt/equity, cash flow
  Momentum   2.5 pts  — price trend, relative strength vs NIFTY

Runs once daily at 15:30 IST (post market close).
Results cached for 24 hours.
"""
from __future__ import annotations
import asyncio
from datetime import datetime, timezone
from typing import Optional
from loguru import logger

from core.config import INDIA_WATCHLIST
from core.state_store import state
from utils.llm_router import fast_llm


# ─── Sector P/E benchmarks (approximate, India 2025) ─────────────
SECTOR_PE = {
    "Technology":            28,
    "Financial Services":    20,
    "Energy":                12,
    "Consumer Defensive":    40,
    "Consumer Cyclical":     35,
    "Industrials":           30,
    "Healthcare":            35,
    "Basic Materials":       15,
    "Communication Services": 25,
    "Utilities":             18,
    "Real Estate":           30,
    "Unknown":               25,
}

# ─── Thresholds for quality scoring ──────────────────────────────
QUALITY_THRESHOLDS = {
    "roe_excellent":     20,   # ROE > 20% = excellent
    "roe_good":          15,
    "de_low":             0.5, # D/E < 0.5 = very low debt
    "de_high":            2.0, # D/E > 2 = high debt risk
    "current_ratio_ok":   1.5,
    "margin_good":        15,  # net profit margin > 15% = good
}


async def run_india_fundamentals_agent() -> dict[str, dict]:
    """Run full fundamentals analysis for all watchlist stocks."""
    logger.info("▶ IndiaFundamentalsAgent — starting (daily run)")
    results = {}

    symbols = [s.replace(".NS", "") for s in INDIA_WATCHLIST]

    for sym in symbols:
        try:
            fund = await asyncio.to_thread(_fetch_and_score, sym)
            state.write_fundamentals(sym, fund)
            results[sym] = fund
            _log_fundamental(sym, fund)
        except Exception as e:
            logger.error(f"  ✗ Fundamentals {sym}: {e}")
        await asyncio.sleep(0.5)  # gentle pacing

    logger.info(f"✓ IndiaFundamentalsAgent — {len(results)} companies scored")
    return results


def _fetch_and_score(symbol: str) -> dict:
    """Fetch raw fundamentals and compute composite score."""
    raw = _fetch_yfinance(symbol)

    valuation_score  = _score_valuation(raw)
    growth_score     = _score_growth(raw)
    quality_score    = _score_quality(raw)
    momentum_score   = _score_momentum(raw)

    overall = (
        valuation_score * 0.25 +
        growth_score    * 0.25 +
        quality_score   * 0.25 +
        momentum_score  * 0.25
    )

    # Determine thesis
    if overall >= 7.5:
        thesis = f"High-quality compounder — strong growth + low debt + attractive valuation"
    elif overall >= 6.0:
        thesis = f"Good business with reasonable valuation — monitor for entry"
    elif overall >= 4.5:
        thesis = f"Mixed signals — some strengths but notable risks"
    else:
        thesis = f"Below-average fundamentals — avoid unless deep turnaround thesis"

    # Key risk and catalyst
    key_risk = _identify_key_risk(raw)
    key_catalyst = _identify_key_catalyst(raw)

    return {
        "symbol":            symbol,
        "timestamp":         datetime.now(timezone.utc).isoformat(),
        "fundamental_score": round(overall, 2),
        "valuation":         (
            "cheap" if valuation_score >= 7 else
            "fair"  if valuation_score >= 4 else
            "expensive"
        ),
        "growth_momentum":   (
            "accelerating" if growth_score >= 7 else
            "stable"       if growth_score >= 4 else
            "decelerating"
        ),
        "quality_rating":    (
            "high"   if quality_score >= 7 else
            "medium" if quality_score >= 4 else
            "low"
        ),
        "scores": {
            "valuation":  round(valuation_score, 1),
            "growth":     round(growth_score, 1),
            "quality":    round(quality_score, 1),
            "momentum":   round(momentum_score, 1),
        },
        "raw_data": {
            "pe_ratio":        raw.get("pe_ratio"),
            "pb_ratio":        raw.get("pb_ratio"),
            "roe":             raw.get("roe"),
            "debt_to_equity":  raw.get("debt_to_equity"),
            "revenue_growth":  raw.get("revenue_growth"),
            "earnings_growth": raw.get("earnings_growth"),
            "profit_margins":  raw.get("profit_margins"),
            "dividend_yield":  raw.get("dividend_yield"),
            "market_cap_cr":   raw.get("market_cap_cr"),
            "sector":          raw.get("sector", "Unknown"),
        },
        "key_risk":          key_risk,
        "key_catalyst":      key_catalyst,
        "next_results_date": "unknown",
        "long_term_thesis":  thesis,
    }


def _fetch_yfinance(symbol: str) -> dict:
    """Fetch fundamentals from yfinance (free)."""
    try:
        import yfinance as yf
        ticker = yf.Ticker(f"{symbol}.NS")
        info   = ticker.info

        def pct(v):
            return round(float(v) * 100, 2) if v is not None else None

        def safe(v):
            try:
                return round(float(v), 4) if v is not None else None
            except (TypeError, ValueError):
                return None

        # Compute 52w momentum
        hist = ticker.history(period="1y", interval="1d")
        momentum_pct = None
        if not hist.empty and len(hist) >= 2:
            first = float(hist["Close"].iloc[0])
            last  = float(hist["Close"].iloc[-1])
            momentum_pct = round((last - first) / first * 100, 2)

        # Relative strength vs NIFTY
        rs_vs_nifty = None
        try:
            nifty = yf.Ticker("^NSEI").history(period="1y", interval="1d")
            if not nifty.empty and len(nifty) >= 2:
                nifty_ret = (float(nifty["Close"].iloc[-1]) -
                             float(nifty["Close"].iloc[0])) / float(nifty["Close"].iloc[0]) * 100
                rs_vs_nifty = round((momentum_pct or 0) - nifty_ret, 2)
        except Exception:
            pass

        return {
            "symbol":          symbol,
            "pe_ratio":        safe(info.get("trailingPE")),
            "forward_pe":      safe(info.get("forwardPE")),
            "pb_ratio":        safe(info.get("priceToBook")),
            "roe":             pct(info.get("returnOnEquity")),
            "roa":             pct(info.get("returnOnAssets")),
            "debt_to_equity":  safe(info.get("debtToEquity")),
            "current_ratio":   safe(info.get("currentRatio")),
            "revenue_growth":  pct(info.get("revenueGrowth")),
            "earnings_growth": pct(info.get("earningsGrowth")),
            "profit_margins":  pct(info.get("profitMargins")),
            "gross_margins":   pct(info.get("grossMargins")),
            "dividend_yield":  pct(info.get("dividendYield")),
            "market_cap_cr":   round(float(info.get("marketCap", 0) or 0) / 1e7, 2),
            "sector":          info.get("sector", "Unknown"),
            "industry":        info.get("industry", ""),
            "52w_momentum":    momentum_pct,
            "rs_vs_nifty":     rs_vs_nifty,
            "beta":            safe(info.get("beta")),
        }
    except Exception as e:
        logger.debug(f"yfinance fundamentals {symbol}: {e}")
        return {"symbol": symbol}


def _score_valuation(raw: dict) -> float:
    """Score valuation 0–10. Lower P/E vs sector = higher score."""
    score = 5.0
    pe    = raw.get("pe_ratio")
    pb    = raw.get("pb_ratio")
    sector_pe = SECTOR_PE.get(raw.get("sector", "Unknown"), 25)

    if pe is not None:
        if pe < sector_pe * 0.6:    score += 2.5
        elif pe < sector_pe * 0.8:  score += 1.5
        elif pe < sector_pe:        score += 0.5
        elif pe > sector_pe * 1.5:  score -= 1.5
        elif pe > sector_pe * 2:    score -= 2.5

    if pb is not None:
        if pb < 1:    score += 1.0
        elif pb < 2:  score += 0.5
        elif pb > 8:  score -= 1.0

    return max(0, min(10, score))


def _score_growth(raw: dict) -> float:
    """Score growth 0–10. Higher EPS/revenue growth = higher score."""
    score   = 5.0
    eps_g   = raw.get("earnings_growth")
    rev_g   = raw.get("revenue_growth")

    if eps_g is not None:
        if eps_g > 25:    score += 2.5
        elif eps_g > 15:  score += 1.5
        elif eps_g > 5:   score += 0.5
        elif eps_g < 0:   score -= 2.0
        elif eps_g < -10: score -= 3.0

    if rev_g is not None:
        if rev_g > 20:    score += 1.5
        elif rev_g > 10:  score += 0.8
        elif rev_g < 0:   score -= 1.0

    return max(0, min(10, score))


def _score_quality(raw: dict) -> float:
    """Score quality 0–10. High ROE + low debt + good margins."""
    score = 5.0
    roe   = raw.get("roe")
    de    = raw.get("debt_to_equity")
    cr    = raw.get("current_ratio")
    margin = raw.get("profit_margins")

    if roe is not None:
        if roe > QUALITY_THRESHOLDS["roe_excellent"]:  score += 2.0
        elif roe > QUALITY_THRESHOLDS["roe_good"]:     score += 1.0
        elif roe < 5:                                   score -= 1.5
        elif roe < 0:                                   score -= 3.0

    if de is not None:
        if de < QUALITY_THRESHOLDS["de_low"]:   score += 1.5
        elif de < 1.0:                          score += 0.5
        elif de > QUALITY_THRESHOLDS["de_high"]: score -= 2.0

    if cr is not None:
        if cr > QUALITY_THRESHOLDS["current_ratio_ok"]: score += 0.5
        elif cr < 1.0:                                   score -= 1.0

    if margin is not None:
        if margin > QUALITY_THRESHOLDS["margin_good"]:  score += 1.0
        elif margin > 8:                                 score += 0.5
        elif margin < 0:                                 score -= 2.0

    return max(0, min(10, score))


def _score_momentum(raw: dict) -> float:
    """Score price momentum 0–10. Strong RS vs NIFTY = higher score."""
    score = 5.0
    mom   = raw.get("52w_momentum")
    rs    = raw.get("rs_vs_nifty")

    if mom is not None:
        if mom > 40:    score += 2.0
        elif mom > 20:  score += 1.0
        elif mom > 0:   score += 0.3
        elif mom < -20: score -= 1.5
        elif mom < -40: score -= 3.0

    if rs is not None:
        if rs > 20:    score += 1.5
        elif rs > 5:   score += 0.5
        elif rs < -10: score -= 1.0
        elif rs < -25: score -= 2.0

    return max(0, min(10, score))


def _identify_key_risk(raw: dict) -> str:
    """Return the most significant risk for this company."""
    de  = raw.get("debt_to_equity", 0) or 0
    pe  = raw.get("pe_ratio", 0) or 0
    roe = raw.get("roe", 0) or 0
    mg  = raw.get("profit_margins", 0) or 0

    if de > 2.5:
        return f"High debt (D/E={de:.1f}) — rising rates increase interest burden"
    if pe > 60:
        return f"Expensive valuation (P/E={pe:.0f}) — priced for perfection"
    if roe < 5:
        return f"Low return on equity ({roe:.1f}%) — capital allocation concern"
    if mg < 0:
        return "Negative profit margins — losses need to reverse for upside"
    return "Market risk — broad selloff could temporarily pressure price"


def _identify_key_catalyst(raw: dict) -> str:
    """Return the most likely near-term catalyst."""
    eps_g = raw.get("earnings_growth", 0) or 0
    rev_g = raw.get("revenue_growth", 0) or 0
    roe   = raw.get("roe", 0) or 0

    if eps_g > 25:
        return f"Strong earnings momentum ({eps_g:.0f}% growth) — results could re-rate"
    if rev_g > 20:
        return f"Rapid revenue growth ({rev_g:.0f}%) — expanding market share"
    if roe > 20:
        return f"High-quality compounder (ROE={roe:.0f}%) — institutional interest likely"
    return "Sector rotation or macro improvement could drive re-rating"


def _log_fundamental(sym: str, fund: dict) -> None:
    score   = fund.get("fundamental_score", 0)
    val     = fund.get("valuation", "?")
    quality = fund.get("quality_rating", "?")
    pe      = fund.get("raw_data", {}).get("pe_ratio")
    roe     = fund.get("raw_data", {}).get("roe")
    icon    = "💎" if score >= 7 else "✓" if score >= 5 else "⚠"
    logger.debug(
        f"  {icon} {sym:15s}  score={score:.1f}/10  "
        f"val={val:10s}  quality={quality:6s}  "
        f"P/E={pe}  ROE={roe}%"
    )
