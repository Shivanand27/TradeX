"""
data/india_news.py
─────────────────────────────────────────────────────
India-specific news and sentiment aggregation (all free sources):
  - Economic Times RSS
  - Moneycontrol news RSS
  - NSE/BSE announcements (public)
  - Reddit r/IndiaInvestments (free API)
  - India VIX from NSE website
  - FII/DII flow data (NSE public data)

Uses Gemini Flash to classify news sentiment (free tier).
"""
from __future__ import annotations
import asyncio
import hashlib
from datetime import datetime, timedelta, timezone
from typing import Optional
import feedparser
import httpx
from loguru import logger

from core.state_store import state

# ─── Free RSS feeds ───────────────────────────────────────────────
RSS_FEEDS = {
    "economic_times":    "https://economictimes.indiatimes.com/markets/rss.cms",
    "moneycontrol":      "https://www.moneycontrol.com/rss/MCtopnews.xml",
    "business_standard": "https://www.business-standard.com/rss/markets-106.rss",
    "livemint":          "https://www.livemint.com/rss/markets",
    "financial_express": "https://www.financialexpress.com/market/feed/",
    "ndtv_profit":       "https://feeds.feedburner.com/ndtvprofit-latest",
    "zeebiz":            "https://www.zeebiz.com/market-news/rss",
}

# ─── Source badge + category mapping ─────────────────────────────
_SRC_MAP = {
    "economic_times":    ("ET",   "INDIA"),
    "moneycontrol":      ("MC",   "INDIA"),
    "business_standard": ("BS",   "INDIA"),
    "livemint":          ("LM",   "INDIA"),
    "financial_express": ("FE",   "INDIA"),
    "ndtv_profit":       ("NP",   "INDIA"),
    "zeebiz":            ("ZB",   "INDIA"),
}

# ─── NSE public data URLs ─────────────────────────────────────────
NSE_FII_DII_URL = "https://www.nseindia.com/api/fiidiiTradeReact"
NSE_INDICES_URL = "https://www.nseindia.com/api/allIndices"

# ─── Headers for NSE scraping ─────────────────────────────────────
NSE_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/120.0.0.0 Safari/537.36"
    ),
    "Accept":          "application/json",
    "Accept-Language": "en-US,en;q=0.9",
    "Accept-Encoding": "gzip, deflate",
    "Referer":         "https://www.nseindia.com/",
}


async def fetch_india_news_sentiment() -> dict:
    """
    Main entry point — fetches all India market news and sentiment.
    Returns aggregated sentiment snapshot.
    """
    tasks = [
        _fetch_rss_news(),
        _fetch_fii_dii_data(),
    ]
    news_items, fii_dii = await asyncio.gather(*tasks, return_exceptions=True)

    if isinstance(news_items, Exception):
        logger.error(f"RSS fetch failed: {news_items}")
        news_items = []
    if isinstance(fii_dii, Exception):
        logger.error(f"FII/DII fetch failed: {fii_dii}")
        fii_dii = {}

    # Classify sentiment via LLM (free Gemini Flash)
    classified = await _classify_news_llm(news_items[:15])

    # Compute aggregate scores
    sentiments    = [n.get("sentiment", "neutral") for n in classified]
    bull_count    = sentiments.count("bullish")
    bear_count    = sentiments.count("bearish")
    total         = max(len(sentiments), 1)
    sent_score    = (bull_count - bear_count) / total

    snapshot = {
        "timestamp":     datetime.now(timezone.utc).isoformat(),
        "news_items":    classified[:10],
        "sentiment_score": round(sent_score, 3),
        "overall_sentiment": (
            "bullish" if sent_score > 0.2 else
            "bearish" if sent_score < -0.2 else
            "neutral"
        ),
        "fii_flow_today_cr": fii_dii.get("fii_net_cr", 0),
        "dii_flow_today_cr": fii_dii.get("dii_net_cr", 0),
        "institutional_bias": fii_dii.get("bias", "neutral"),
    }

    return snapshot


async def _fetch_rss_news() -> list[dict]:
    """Fetch and parse all RSS feeds concurrently."""
    all_items = []
    async with httpx.AsyncClient(timeout=10) as client:
        tasks = []
        for source, url in RSS_FEEDS.items():
            tasks.append(_fetch_single_rss(client, source, url))
        results = await asyncio.gather(*tasks, return_exceptions=True)
        for result in results:
            if isinstance(result, list):
                all_items.extend(result)

    # Deduplicate by headline hash
    seen = set()
    unique = []
    for item in all_items:
        h = hashlib.md5(item["headline"].encode()).hexdigest()
        if h not in seen:
            seen.add(h)
            unique.append(item)

    # Sort by recency
    unique.sort(key=lambda x: x.get("age_hours", 999))
    return unique


async def _fetch_single_rss(client, source: str, url: str) -> list[dict]:
    """Fetch and parse one RSS feed."""
    try:
        resp  = await client.get(url, headers={"User-Agent": NSE_HEADERS["User-Agent"]})
        feed  = feedparser.parse(resp.text)
        items = []
        now   = datetime.now(timezone.utc)
        for entry in feed.entries[:8]:
            pub = entry.get("published_parsed")
            if pub:
                published = datetime(*pub[:6], tzinfo=timezone.utc)
                age_h     = (now - published).total_seconds() / 3600
            else:
                age_h = 24.0

            if age_h > 48:  # skip old news
                continue

            src_code, category = _SRC_MAP.get(source, ("IN", "INDIA"))
            if age_h < 1:
                time_str = f"{int(age_h * 60)}m ago"
            elif age_h < 24:
                time_str = f"{int(age_h)}h {int((age_h % 1) * 60)}m ago"
            else:
                time_str = f"{int(age_h / 24)}d ago"

            items.append({
                "headline":  entry.get("title", ""),
                "source":    source,
                "src":       src_code,
                "category":  category,
                "age_hours": round(age_h, 1),
                "time":      time_str,
                "url":       entry.get("link", ""),
                "sentiment": "neutral",
                "impact":    "MEDIUM",
                "tags":      ["INDIA"],
            })
        return items
    except Exception as e:
        logger.debug(f"RSS {source} failed: {e}")
        return []


async def _fetch_fii_dii_data() -> dict:
    """
    Fetch FII/DII daily net buy/sell data from NSE.
    FII buying → bullish signal; FII selling → bearish.
    """
    try:
        async with httpx.AsyncClient(
            timeout=10, headers=NSE_HEADERS
        ) as client:
            # First visit NSE homepage to get cookies
            await client.get("https://www.nseindia.com", timeout=5)
            resp = await client.get(NSE_FII_DII_URL)
            if resp.status_code == 200:
                data = resp.json()
                if isinstance(data, list) and data:
                    fii_row = next((r for r in data if r.get("category", "").upper() == "FII/FPI"), {})
                    dii_row = next((r for r in data if r.get("category", "").upper() == "DII"), {})
                    fii_net = float(fii_row.get("netValue", 0) or 0)
                    dii_net = float(dii_row.get("netValue", 0) or 0)
                    bias = (
                        "bullish" if fii_net > 500 else
                        "bearish" if fii_net < -500 else
                        "neutral"
                    )
                    return {
                        "fii_net_cr": round(fii_net, 2),
                        "dii_net_cr": round(dii_net, 2),
                        "bias": bias,
                        "date": fii_row.get("date") or dii_row.get("date", ""),
                    }
    except Exception as e:
        logger.debug(f"FII/DII fetch failed (NSE may block scraping): {e}")

    # Fallback: return zeros — won't break the platform
    return {"fii_net_cr": 0, "dii_net_cr": 0, "bias": "neutral"}


async def _classify_news_llm(news_items: list[dict]) -> list[dict]:
    """
    Use Gemini Flash (free tier) to classify news sentiment.
    Batches all headlines into one API call to save quota.
    """
    if not news_items:
        return []

    try:
        from utils.llm_router import fast_llm
        headlines = "\n".join(
            f"{i+1}. {item['headline']}"
            for i, item in enumerate(news_items)
        )
        prompt = (
            "Classify each India stock market news headline as: "
            "bullish, bearish, or neutral.\n"
            "Also classify impact as: high, medium, or low.\n"
            "Reply ONLY as JSON array: "
            '[{"sentiment":"bullish","impact":"high"}, ...]\n'
            "One entry per headline, same order.\n\n"
            f"Headlines:\n{headlines}"
        )
        raw = await fast_llm(prompt)

        # Parse JSON response
        import json, re
        match = re.search(r'\[.*?\]', raw, re.DOTALL)
        if match:
            classifications = json.loads(match.group())
            for i, cls in enumerate(classifications):
                if i < len(news_items):
                    news_items[i]["sentiment"] = cls.get("sentiment", "neutral")
                    news_items[i]["impact"]    = cls.get("impact", "medium").upper()
                    if news_items[i]["impact"] == "HIGH":
                        news_items[i]["tags"] = list(set(news_items[i].get("tags", []) + ["HIGH IMPACT"]))
    except Exception as e:
        logger.debug(f"News LLM classification failed: {e}")
        # Return as-is with neutral sentiment

    return news_items
