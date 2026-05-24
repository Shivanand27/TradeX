"""
data/nse_insider.py
─────────────────────────────────────────────────────
Fetches SEBI PIT (Prohibition of Insider Trading) disclosures from NSE.

Source: /api/corporates-pit?from_date=DD-MM-YYYY&to_date=DD-MM-YYYY
  Single call returns all disclosures for the date range.
  Key fields: symbol, company, acqName, personCategory,
              tdpTransactionType, secAcq, buyValue, sellValue,
              befAcqSharesPer, afterAcqSharesPer, acqfromDt, intimDt

Cluster Detection:
  If ≥3 distinct insiders BUY the same stock within a 5-day rolling window,
  emit a HIGH_CONVICTION cluster signal (statistically rare, historically bullish).
"""
from __future__ import annotations

import asyncio
from collections import defaultdict
from datetime import datetime, date, timedelta, timezone
from typing import Optional

from loguru import logger

from core.config import INDIA_WATCHLIST
from data.nse_deals import _nse, _parse_nse_date

_INSIDER_API = "https://www.nseindia.com/api/corporates-pit"

_WATCHLIST_SYMS: set[str] = {s.replace(".NS", "").replace(".BO", "") for s in INDIA_WATCHLIST}

CLUSTER_THRESHOLD   = 3   # minimum distinct insiders
CLUSTER_WINDOW_DAYS = 5   # rolling window for cluster detection


# ─── Fetchers ─────────────────────────────────────────────────────

async def fetch_insider_trades(symbol: Optional[str] = None,
                               days: int = 30) -> list[dict]:
    """
    Fetch recent insider trades from NSE (corporates-pit endpoint).
    Single API call returns all disclosures for the date range.
    If symbol is provided, filter client-side.
    """
    today   = date.today()
    from_dt = today - timedelta(days=days)
    params  = {
        "from_date": from_dt.strftime("%d-%m-%Y"),
        "to_date":   today.strftime("%d-%m-%Y"),
    }
    data = await _nse.get(_INSIDER_API, params=params)
    rows = _extract_rows(data)
    trades = [r for r in (_parse_insider_row(r) for r in rows if r) if r]

    if symbol:
        sym = symbol.upper().replace(".NS", "")
        trades = [t for t in trades if t["symbol"] == sym]

    return trades


def _extract_rows(data) -> list:
    if data is None:
        return []
    if isinstance(data, list):
        return data
    return data.get("data", [])


# ─── Cluster detection ────────────────────────────────────────────

def detect_clusters(trades: list[dict]) -> list[dict]:
    """
    Detect cluster-buy signals: ≥3 distinct insiders buying same stock
    within a CLUSTER_WINDOW_DAYS rolling window.
    Returns list of cluster events with details.
    """
    # Group BUY trades by symbol
    sym_trades: dict[str, list[dict]] = defaultdict(list)
    for t in trades:
        if t.get("trade_type") == "BUY" and t.get("symbol"):
            sym_trades[t["symbol"]].append(t)

    clusters = []
    for symbol, sym_list in sym_trades.items():
        sym_list.sort(key=lambda x: x.get("trade_date", ""))
        # Sliding window
        for i, anchor in enumerate(sym_list):
            anchor_date = anchor.get("trade_date", "")
            if not anchor_date:
                continue
            try:
                anchor_dt = datetime.fromisoformat(anchor_date).date()
            except ValueError:
                continue

            window_end = anchor_dt + timedelta(days=CLUSTER_WINDOW_DAYS)
            in_window  = [
                t for t in sym_list[i:]
                if _date_in_range(t.get("trade_date", ""), anchor_dt, window_end)
            ]
            distinct_insiders = {t.get("insider_name", "") for t in in_window}
            distinct_insiders.discard("")

            if len(distinct_insiders) >= CLUSTER_THRESHOLD:
                total_value = sum(t.get("value_lakh", 0) for t in in_window)
                clusters.append({
                    "symbol":          symbol,
                    "company_name":    anchor.get("company_name", symbol),
                    "cluster_type":    "BUY",
                    "insider_count":   len(distinct_insiders),
                    "insiders":        sorted(distinct_insiders),
                    "window_start":    anchor_date,
                    "window_end":      window_end.isoformat(),
                    "total_value_lakh": round(total_value, 2),
                    "trade_count":     len(in_window),
                    "on_watchlist":    symbol in _WATCHLIST_SYMS,
                })
                # Advance past this window to avoid duplicating
                break

    return clusters


def _date_in_range(date_str: str, start: date, end: date) -> bool:
    try:
        d = datetime.fromisoformat(date_str).date()
        return start <= d <= end
    except ValueError:
        return False


# ─── Main agent entry point ───────────────────────────────────────

async def run_insider_agent(days: int = 7) -> dict:
    """
    Fetch insider trades for the watchlist, detect clusters.
    Called by APScheduler at 07:00 PM IST Mon–Fri.
    """
    logger.info("━━ AGENT: Insider Trading Monitor ━━")

    trades   = await fetch_insider_trades(days=days)
    clusters = detect_clusters(trades)

    buy_trades  = [t for t in trades if t.get("trade_type") == "BUY"]
    sell_trades = [t for t in trades if t.get("trade_type") == "SELL"]
    wl_trades   = [t for t in trades if t.get("on_watchlist")]

    result = {
        "fetched_at":      datetime.now(timezone.utc).isoformat(),
        "trades":          trades,
        "clusters":        clusters,
        "buy_count":       len(buy_trades),
        "sell_count":      len(sell_trades),
        "watchlist_count": len(wl_trades),
        "cluster_count":   len(clusters),
    }

    logger.info(
        f"  ✓ Insider: {len(trades)} trades "
        f"({len(buy_trades)} buy / {len(sell_trades)} sell), "
        f"{len(clusters)} cluster signals"
    )

    if clusters:
        for cl in clusters:
            wl = " [WATCHLIST]" if cl.get("on_watchlist") else ""
            logger.warning(
                f"  🔥 CLUSTER BUY: {cl['symbol']}{wl} — "
                f"{cl['insider_count']} insiders, ₹{cl['total_value_lakh']:.1f}L"
            )

    return result


# ─── Parser ───────────────────────────────────────────────────────

def _parse_insider_row(row: dict) -> dict | None:
    symbol  = (row.get("symbol") or "").upper().strip()
    if not symbol:
        return None

    company  = row.get("company") or symbol
    insider  = row.get("acqName") or "—"
    category = row.get("personCategory") or "—"
    acq_mode = (row.get("acqMode") or "").upper()
    sec_type = row.get("secType") or "Equity"

    # corporates-pit has explicit tdpTransactionType: "Buy" / "Sell"
    txn = (row.get("tdpTransactionType") or "").strip().upper()
    if txn.startswith("BUY"):
        trade_type = "BUY"
    elif txn.startswith("SELL"):
        trade_type = "SELL"
    else:
        trade_type = "—"

    qty      = _to_float(row.get("secAcq") or 0)
    pre_pct  = _to_float(row.get("befAcqSharesPer") or 0)
    post_pct = _to_float(row.get("afterAcqSharesPer") or 0)

    # API provides rupee value directly; convert to lakhs
    raw_val    = _to_float(row.get("buyValue") or 0) + _to_float(row.get("sellValue") or 0)
    value_lakh = round(raw_val / 1e5, 2) if raw_val else 0.0

    from_date       = row.get("acqfromDt") or ""
    to_date         = row.get("acqtoDt") or from_date
    intimation_date = row.get("intimDt") or to_date

    return {
        "symbol":           symbol,
        "company_name":     str(company).strip(),
        "insider_name":     str(insider).strip(),
        "insider_role":     _normalise_role(category),
        "insider_role_raw": str(category).strip(),
        "trade_type":       trade_type,
        "quantity":         qty,
        "price":            0.0,
        "value_lakh":       value_lakh,
        "pre_holding_pct":  pre_pct,
        "post_holding_pct": post_pct,
        "security_type":    str(sec_type).strip(),
        "acquisition_mode": acq_mode,
        "trade_date":       _parse_nse_date(from_date),
        "disclosure_date":  _parse_nse_date(intimation_date),
        "remarks":          str(row.get("remarks") or "").strip()[:200],
        "on_watchlist":     symbol in _WATCHLIST_SYMS,
    }


def _normalise_role(raw: str) -> str:
    r = (raw or "").lower()
    if "promoter" in r:
        return "promoter"
    if "director" in r:
        return "director"
    if "kmp" in r or "key managerial" in r:
        return "kmp"
    if "employee" in r:
        return "employee"
    return "other"


def _to_float(v) -> float:
    try:
        return float(str(v).replace(",", "").strip())
    except (ValueError, TypeError):
        return 0.0


# ─── Quick test ───────────────────────────────────────────────────

if __name__ == "__main__":
    async def _test():
        result = await run_insider_agent(days=7)
        from pprint import pprint
        pprint(result["clusters"])
        pprint(result["trades"][:3])
    asyncio.run(_test())
