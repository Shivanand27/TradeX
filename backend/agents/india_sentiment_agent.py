"""
agents/india_sentiment_agent.py
─────────────────────────────────────────────────────
IndiaSentimentNewsAgent — aggregates and scores sentiment for
every India watchlist stock individually.

Sources (all free):
  - Economic Times / Moneycontrol / Business Standard RSS
  - NSE corporate announcements (free public API)
  - NSE FII/DII net flow data
  - Reddit r/IndiaInvestments, r/DalalStreetTalks
  - India VIX from NSE
  - Promoter/insider activity proxy via BSE disclosures

LLM: Gemini Flash only (fast, free) — batch classify all headlines
     in one API call to conserve quota.
"""
from __future__ import annotations
import asyncio
import re
from datetime import datetime, timezone
from typing import Optional
import httpx
from loguru import logger

from core.config import INDIA_WATCHLIST, FNO_SYMBOLS
from core.state_store import state
from data.india_news import fetch_india_news_sentiment, _fetch_rss_news, NSE_HEADERS
from utils.llm_router import fast_llm

# ─── NSE public endpoints ─────────────────────────────────────────
NSE_CORP_ACTIONS  = "https://www.nseindia.com/api/corporateActions"
NSE_ANNOUNCEMENTS = "https://www.nseindia.com/api/latest-notice"
BSE_DISCLOSURES   = "https://api.bseindia.com/BseIndiaAPI/api/AnnSubCategoryGetData/w"

# ─── Upcoming earnings calendar keywords ─────────────────────────
EARNINGS_KEYWORDS = [
    "results", "quarterly", "q1", "q2", "q3", "q4",
    "revenue", "profit", "earnings", "EPS", "PAT", "EBITDA",
]
BULLISH_KEYWORDS = [
    "buy", "outperform", "upgrade", "beat", "strong", "growth",
    "record", "higher", "positive", "expansion", "order win",
    "acquisition", "partnership", "launch", "dividend",
]
BEARISH_KEYWORDS = [
    "sell", "underperform", "downgrade", "miss", "weak", "decline",
    "loss", "negative", "slowdown", "regulation", "probe", "SEBI",
    "FIR", "debt", "pledge", "resignation", "recall",
]


async def run_india_sentiment_agent() -> dict[str, dict]:
    """
    Main entry: compute sentiment snapshot for every stock in watchlist.
    Returns {symbol: sentiment_snapshot}
    """
    logger.info("▶ IndiaSentimentNewsAgent — starting")

    # Fetch all news in one batch (shared across stocks)
    all_news = await _fetch_rss_news()

    # Fetch macro data
    macro = await _fetch_macro_india()

    results = {}
    symbols = [s.replace(".NS", "") for s in INDIA_WATCHLIST]

    for sym in symbols:
        try:
            snapshot = await _analyse_symbol(sym, all_news, macro)
            state.write_sentiment("india", sym, snapshot)
            results[sym] = snapshot
            _log_sentiment(sym, snapshot)
        except Exception as e:
            logger.error(f"  ✗ Sentiment {sym}: {e}")

    # Write market-wide sentiment
    market_sent = _aggregate_market_sentiment(results, macro)
    state.write_sentiment("india", "global",      market_sent)  # fix: API reads "global"
    state.write_sentiment("india", "market_wide", market_sent)  # keep for compatibility

    logger.info(
        f"✓ IndiaSentimentNewsAgent — {len(results)} symbols  "
        f"VIX={macro.get('india_vix', '?')}  "
        f"FII={macro.get('fii_flow_today_cr', 0):+.0f}Cr"
    )
    return results


async def _analyse_symbol(symbol: str, all_news: list[dict],
                          macro: dict) -> dict:
    """Build a complete sentiment snapshot for one symbol."""

    # Filter news relevant to this symbol
    sym_lower = symbol.lower()
    company_name = _symbol_to_company(symbol)
    relevant = [
        n for n in all_news
        if (sym_lower in n["headline"].lower() or
            company_name.lower() in n["headline"].lower())
    ]

    # Classify relevant headlines via LLM (if any)
    if relevant:
        relevant = await _batch_classify(relevant)

    # Score from keywords (fast, no LLM cost)
    kw_score = _keyword_score(all_news, symbol, company_name)

    # Combine sentiment
    item_scores = [
        {"bullish": 1, "neutral": 0, "bearish": -1}.get(
            n.get("sentiment", "neutral"), 0)
        for n in relevant
    ]
    llm_score = (sum(item_scores) / len(item_scores)) if item_scores else 0.0
    final_score = (llm_score * 0.6 + kw_score * 0.4) if relevant else kw_score

    # Impact classification
    high_impact = [n for n in relevant if n.get("impact") == "high"]
    earnings_soon = any(
        k in n["headline"].lower()
        for n in relevant
        for k in EARNINGS_KEYWORDS
    )

    return {
        "symbol":              symbol,
        "timestamp":           datetime.now(timezone.utc).isoformat(),
        "news_items":          relevant[:5],
        "high_impact_news":    high_impact[:2],
        "sentiment_score":     round(final_score, 3),
        "overall_sentiment":   (
            "bullish" if final_score > 0.20 else
            "bearish" if final_score < -0.20 else
            "neutral"
        ),
        "earnings_next_days":  7 if earnings_soon else 99,
        "last_eps_beat_miss":  "unknown",
        "fii_flow_today_cr":   macro.get("fii_flow_today_cr", 0),
        "dii_flow_today_cr":   macro.get("dii_flow_today_cr", 0),
        "india_vix":           macro.get("india_vix", 15),
        "india_vix_signal":    macro.get("india_vix_signal", "neutral"),
        "promoter_activity":   "neutral",  # enhanced with BSE API later
        "nifty_trend":         macro.get("nifty_trend", "mixed"),
    }


async def _batch_classify(news_items: list[dict]) -> list[dict]:
    """Classify a batch of headlines in one LLM call — saves quota."""
    if not news_items:
        return news_items

    headlines = "\n".join(
        f"{i+1}. {n['headline']}" for i, n in enumerate(news_items)
    )
    prompt = (
        "You are an India stock market analyst. "
        "Classify each news headline as: bullish, bearish, or neutral. "
        "Also classify impact as: high, medium, or low.\n"
        "Respond ONLY as a JSON array (no markdown, no explanation):\n"
        '[{"sentiment":"bullish","impact":"high"}, ...]\n'
        "One entry per headline, same order as input.\n\n"
        f"Headlines:\n{headlines}"
    )
    try:
        raw = await fast_llm(prompt, max_tokens=512)
        match = re.search(r'\[.*?\]', raw, re.DOTALL)
        if match:
            import json
            classifications = json.loads(match.group())
            for i, cls in enumerate(classifications):
                if i < len(news_items):
                    news_items[i]["sentiment"] = cls.get("sentiment", "neutral")
                    news_items[i]["impact"]    = cls.get("impact", "medium")
    except Exception as e:
        logger.debug(f"Batch classify failed: {e}")

    return news_items


async def _fetch_macro_india() -> dict:
    """Fetch India VIX, NIFTY trend, and FII/DII data."""
    from data.india_market import fetch_india_vix, fetch_nifty_trend
    from data.india_news import _fetch_fii_dii_data

    tasks = [
        asyncio.to_thread(fetch_india_vix),
        asyncio.to_thread(fetch_nifty_trend),
        _fetch_fii_dii_data(),
    ]
    vix, nifty, fii_dii = await asyncio.gather(*tasks, return_exceptions=True)

    vix = vix if isinstance(vix, float) else 15.0
    nifty = nifty if isinstance(nifty, dict) else {}
    fii_dii = fii_dii if isinstance(fii_dii, dict) else {}

    vix_signal = (
        "extreme_fear" if vix > 30 else
        "fear"         if vix > 22 else
        "complacent"   if vix < 12 else
        "neutral"
    )

    return {
        "india_vix":          vix,
        "india_vix_signal":   vix_signal,
        "nifty_trend":        nifty.get("nifty_trend", "mixed"),
        "nifty_ltp":          nifty.get("nifty_ltp", 0),
        "nifty_change_pct":   nifty.get("nifty_change_pct", 0),
        "fii_flow_today_cr":  fii_dii.get("fii_net_cr", 0),
        "dii_flow_today_cr":  fii_dii.get("dii_net_cr", 0),
        "institutional_bias": fii_dii.get("bias", "neutral"),
    }


def _keyword_score(news: list[dict], symbol: str,
                   company: str) -> float:
    """Fast keyword-based sentiment score without LLM."""
    sym_lower  = symbol.lower()
    comp_lower = company.lower()
    relevant   = [
        n["headline"] for n in news
        if sym_lower in n["headline"].lower() or
           comp_lower in n["headline"].lower()
    ]
    if not relevant:
        return 0.0

    bull = sum(
        1 for h in relevant
        for kw in BULLISH_KEYWORDS if kw in h.lower()
    )
    bear = sum(
        1 for h in relevant
        for kw in BEARISH_KEYWORDS if kw in h.lower()
    )
    total = max(bull + bear, 1)
    return round((bull - bear) / total, 3)


def _aggregate_market_sentiment(results: dict, macro: dict) -> dict:
    """Compute market-wide sentiment from all individual stocks."""
    from core.state_store import state as _state

    scores = [v.get("sentiment_score", 0) for v in results.values()]
    avg    = sum(scores) / len(scores) if scores else 0.0
    bull   = sum(1 for s in scores if s > 0.2)
    bear   = sum(1 for s in scores if s < -0.2)

    sector_performance = _state.get("/market/sectors") or {}
    extra_indices      = _state.get("/market/extra_indices") or {}

    return {
        "timestamp":           datetime.now(timezone.utc).isoformat(),
        "avg_sentiment_score": round(avg, 3),
        "bullish_stocks":      bull,
        "bearish_stocks":      bear,
        "neutral_stocks":      len(scores) - bull - bear,
        "market_mood":         (
            "risk_on"  if avg > 0.15  else
            "risk_off" if avg < -0.15 else
            "mixed"
        ),
        "sector_performance":  sector_performance,
        "extra_indices":       extra_indices,
        "overall_sentiment":   (
            "bullish" if avg > 0.15 else
            "bearish" if avg < -0.15 else
            "neutral"
        ),
        **macro,
    }


def _symbol_to_company(symbol: str) -> str:
    """Map symbol to rough company name for news matching."""
    _MAP = {
        "RELIANCE": "Reliance", "HDFCBANK": "HDFC Bank",
        "TCS": "TCS", "INFY": "Infosys", "ICICIBANK": "ICICI Bank",
        "BAJFINANCE": "Bajaj Finance", "ASIANPAINT": "Asian Paints",
        "HINDUNILVR": "Hindustan Unilever", "MARUTI": "Maruti",
        "WIPRO": "Wipro", "ITC": "ITC", "SBIN": "SBI",
        "ADANIPORTS": "Adani Ports", "ONGC": "ONGC",
        "TECHM": "Tech Mahindra",
    }
    return _MAP.get(symbol.upper(), symbol)


def _log_sentiment(sym: str, snap: dict) -> None:
    score = snap.get("sentiment_score", 0)
    mood  = snap.get("overall_sentiment", "?")
    news_count = len(snap.get("news_items", []))
    icon  = "📈" if mood == "bullish" else "📉" if mood == "bearish" else "➡️"
    logger.debug(
        f"  {icon} {sym:15s}  score={score:+.2f}  mood={mood:8s}  "
        f"news={news_count}"
    )
