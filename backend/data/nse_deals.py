"""
data/nse_deals.py
─────────────────────────────────────────────────────
Fetches NSE Block Deals and Bulk Deals.

Block Deal Windows (IST):
  Session 1: 08:45 – 09:00  (reference: prev close)
  Session 2: 14:05 – 14:20  (reference: 15-min VWAP 13:45–14:00)
  Minimum size: ₹25 crore per order (SEBI circular, Oct 2025)

Bulk Deals: executed during normal session hours
  Threshold: >0.5% of total listed equity in one session

NSE API Note:
  The /api/block-deal endpoint requires a valid browser session cookie.
  We obtain it by first hitting the NSE homepage, then poll the data endpoint.
  Rate limit: ~1–2 req/sec is safe; we add jitter to be polite.
"""
from __future__ import annotations

import asyncio
import re
from datetime import datetime, date, timedelta
from typing import Optional

import aiohttp
import pytz
from loguru import logger

from core.config import INDIA_WATCHLIST

IST = pytz.timezone("Asia/Kolkata")

_NSE_BASE    = "https://www.nseindia.com"
_BLOCK_API   = f"{_NSE_BASE}/api/block-deal"
_BULK_API    = f"{_NSE_BASE}/api/snapshot-capital-market-largedeal"
_HIST_API    = f"{_NSE_BASE}/api/historical/block-deals"

_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/124.0.0.0 Safari/537.36"
    ),
    "Accept":          "application/json, text/plain, */*",
    "Accept-Language": "en-US,en;q=0.9",
    "Accept-Encoding": "gzip, deflate",
    "Referer":         "https://www.nseindia.com/market-data/block-deal-watch",
    "Connection":      "keep-alive",
}

# Watchlist set for fast membership checks (bare symbols, no .NS)
_WATCHLIST_SYMS: set[str] = {s.replace(".NS", "").replace(".BO", "") for s in INDIA_WATCHLIST}


# ─── Session manager ──────────────────────────────────────────────

class NSESession:
    """
    Maintains a single aiohttp session with valid NSE cookies.
    NSE rejects API calls that don't have a valid homepage cookie.
    Refreshes cookies automatically every 30 minutes.
    """
    def __init__(self):
        self._session: Optional[aiohttp.ClientSession] = None
        self._last_refresh: float = 0.0
        self._lock = asyncio.Lock()

    async def _refresh(self) -> None:
        if self._session and not self._session.closed:
            await self._session.close()
        jar = aiohttp.CookieJar(unsafe=True)
        self._session = aiohttp.ClientSession(
            headers=_HEADERS,
            cookie_jar=jar,
            timeout=aiohttp.ClientTimeout(total=15),
        )
        try:
            async with self._session.get(_NSE_BASE, allow_redirects=True) as resp:
                await resp.read()
                self._last_refresh = asyncio.get_event_loop().time()
                logger.debug(f"NSESession: cookie refreshed, status={resp.status}")
        except Exception as e:
            logger.warning(f"NSESession: homepage hit failed: {e}")

    async def get(self, url: str, params: dict | None = None) -> dict | None:
        async with self._lock:
            now = asyncio.get_event_loop().time()
            if self._session is None or self._session.closed or (now - self._last_refresh) > 1800:
                await self._refresh()

        try:
            async with self._session.get(url, params=params, allow_redirects=True) as resp:
                if resp.status == 200:
                    return await resp.json(content_type=None)
                logger.warning(f"NSE API {url} returned status {resp.status}")
                return None
        except Exception as e:
            logger.error(f"NSESession.get({url}): {e}")
            return None

    async def close(self) -> None:
        if self._session and not self._session.closed:
            await self._session.close()


_nse = NSESession()


# ─── Raw fetchers ─────────────────────────────────────────────────

async def fetch_block_deals_today() -> list[dict]:
    """Fetch today's block deals from NSE API."""
    data = await _nse.get(_BLOCK_API)
    if not data:
        return []
    rows = data if isinstance(data, list) else data.get("data", [])
    return [_parse_block_row(r, "block") for r in rows if r]


async def fetch_bulk_deals_today() -> list[dict]:
    """Fetch today's bulk deals from NSE snapshot API."""
    data = await _nse.get(_BULK_API, params={"bandtype": "bulk_deals"})
    if not data:
        return []
    rows = data if isinstance(data, list) else data.get("data", [])
    return [_parse_block_row(r, "bulk") for r in rows if r]


async def fetch_historical_block_deals(from_date: date, to_date: date) -> list[dict]:
    """Fetch historical block deals for a date range (max 1 year)."""
    params = {
        "from": from_date.strftime("%d-%m-%Y"),
        "to":   to_date.strftime("%d-%m-%Y"),
    }
    data = await _nse.get(_HIST_API, params=params)
    if not data:
        return []
    rows = data if isinstance(data, list) else data.get("data", [])
    return [_parse_block_row(r, "block") for r in rows if r]


# ─── Main agent entry point ───────────────────────────────────────

async def run_deals_agent(session_num: int = 0) -> dict:
    """
    Fetch both block and bulk deals, normalise, and return structured result.
    session_num: 1 = post morning window (9:05 AM), 2 = post afternoon (2:25 PM), 0 = any
    Called by APScheduler jobs in api.py.
    """
    label = {1: "Session 1", 2: "Session 2", 0: "Ad-hoc"}.get(session_num, "")
    logger.info(f"━━ AGENT: NSE Deals [{label}] ━━")

    block_deals, bulk_deals = await asyncio.gather(
        fetch_block_deals_today(),
        fetch_bulk_deals_today(),
        return_exceptions=True,
    )

    if isinstance(block_deals, Exception):
        logger.error(f"Block deal fetch failed: {block_deals}")
        block_deals = []
    if isinstance(bulk_deals, Exception):
        logger.error(f"Bulk deal fetch failed: {bulk_deals}")
        bulk_deals = []

    all_deals  = block_deals + bulk_deals
    watchlist_hits = [d for d in all_deals if d.get("symbol") in _WATCHLIST_SYMS]

    result = {
        "fetched_at":     datetime.now(IST).isoformat(),
        "session":        session_num,
        "block_deals":    block_deals,
        "bulk_deals":     bulk_deals,
        "total":          len(all_deals),
        "watchlist_hits": watchlist_hits,
    }

    logger.info(
        f"  ✓ Deals: {len(block_deals)} block, {len(bulk_deals)} bulk, "
        f"{len(watchlist_hits)} watchlist hits"
    )
    return result


async def backfill_deals(days: int = 30) -> list[dict]:
    """Backfill last N days of block deals for historical data."""
    today    = date.today()
    from_dt  = today - timedelta(days=days)
    logger.info(f"Backfilling block deals from {from_dt} to {today}")
    rows = await fetch_historical_block_deals(from_dt, today)
    logger.info(f"  ✓ Backfill: {len(rows)} historical block deal records")
    return rows


# ─── Parsers ──────────────────────────────────────────────────────

def _parse_block_row(row: dict, deal_type: str) -> dict:
    """Normalise a raw NSE API row into a standard deal dict."""
    # NSE block deal field names
    symbol    = (row.get("BD_SYMBOL") or row.get("symbol") or "").upper().strip()
    company   = row.get("BD_SCRIP_NAME") or row.get("name") or symbol
    client    = row.get("BD_CLIENT_NAME") or row.get("clientName") or "—"
    direction = (row.get("BD_BUY_SELL") or row.get("buySell") or "").upper()
    qty_raw   = row.get("BD_QTY_TRD") or row.get("quantityTraded") or 0
    price_raw = row.get("BD_TP_WATP") or row.get("wAvgPrice") or 0
    remarks   = row.get("BD_REMARKS") or row.get("remarks") or ""
    date_str  = row.get("BD_DT_DATE") or row.get("date") or ""
    order_ts  = row.get("BD_DT_ORDER") or row.get("time") or ""

    qty   = _to_float(qty_raw)
    price = _to_float(price_raw)
    value_crore = round(qty * price / 1e7, 2) if qty and price else 0.0

    # Strip commas from NSE formatted numbers
    return {
        "symbol":       symbol,
        "company_name": str(company).strip(),
        "client_name":  str(client).strip(),
        "direction":    direction if direction in ("BUY", "SELL") else "—",
        "quantity":     qty,
        "price":        price,
        "value_crore":  value_crore,
        "deal_type":    deal_type,
        "trade_date":   _parse_nse_date(date_str),
        "traded_at":    str(order_ts),
        "remarks":      str(remarks),
        "on_watchlist": symbol in _WATCHLIST_SYMS,
    }


def _to_float(v) -> float:
    try:
        result = float(str(v).replace(",", "").replace("₹", "").strip())
        return result if result == result else 0.0  # guard against nan
    except (ValueError, TypeError):
        return 0.0


def _parse_nse_date(s: str) -> str:
    """Convert NSE date strings like '28-APR-2025' or '28-04-2025' to ISO."""
    if not s:
        return date.today().isoformat()
    s = str(s).strip()
    for fmt in ("%d-%b-%Y", "%d-%m-%Y", "%Y-%m-%d"):
        try:
            return datetime.strptime(s, fmt).date().isoformat()
        except ValueError:
            continue
    return date.today().isoformat()


# ─── Quick test ───────────────────────────────────────────────────

if __name__ == "__main__":
    async def _test():
        result = await run_deals_agent(session_num=1)
        from pprint import pprint
        pprint(result)
        await _nse.close()
    asyncio.run(_test())
