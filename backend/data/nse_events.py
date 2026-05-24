"""
data/nse_events.py
─────────────────────────────────────────────────────
Fetches NSE Corporate Events and Calendar:
  - Quarterly / Annual results dates
  - Dividend (record date, ex-date)
  - Bonus / Stock split / Rights issue
  - Board meetings / AGMs
  - Corporate actions

NSE Free APIs used:
  /api/event-calendar              → upcoming results & corporate events
  /api/corporates-corporateActions → dividends, splits, bonus, rights
"""
from __future__ import annotations

import asyncio
from datetime import datetime, date, timedelta, timezone
from typing import Optional

from loguru import logger

from core.config import INDIA_WATCHLIST
from data.nse_deals import _nse, _parse_nse_date  # reuse session + date parser

_EVENTS_API  = "https://www.nseindia.com/api/event-calendar"
_ACTIONS_API = "https://www.nseindia.com/api/corporates-corporateActions"

_WATCHLIST_SYMS: set[str] = {s.replace(".NS", "").replace(".BO", "") for s in INDIA_WATCHLIST}

EVENT_TYPE_MAP = {
    "Board Meeting": "board_meeting",
    "Quarterly Results": "results",
    "Annual Results": "results",
    "Dividend": "dividend",
    "Bonus": "bonus",
    "Stock Split": "split",
    "Rights": "rights",
    "AGM": "agm",
    "EGM": "egm",
}


# ─── Fetchers ─────────────────────────────────────────────────────

async def fetch_event_calendar(from_date: Optional[date] = None,
                               to_date: Optional[date] = None) -> list[dict]:
    """Fetch NSE event calendar for a date range (default: today + 14 days)."""
    today   = date.today()
    from_dt = from_date or today
    to_dt   = to_date or (today + timedelta(days=14))

    data = await _nse.get(_EVENTS_API, params={
        "index": "equities",
    })
    if not data:
        return []

    rows = data if isinstance(data, list) else data.get("data", [])
    events = []
    for r in rows:
        ev = _parse_event_row(r)
        if ev:
            events.append(ev)
    return events


async def fetch_corporate_actions(symbol: Optional[str] = None,
                                  from_date: Optional[date] = None,
                                  to_date: Optional[date] = None) -> list[dict]:
    """Fetch corporate actions (dividends, splits, bonus) from NSE."""
    today   = date.today()
    from_dt = from_date or today
    to_dt   = to_date or (today + timedelta(days=30))

    params = {
        "index":    "equities",
        "from_date": from_dt.strftime("%d-%m-%Y"),
        "to_date":   to_dt.strftime("%d-%m-%Y"),
    }
    if symbol:
        params["symbol"] = symbol.upper().replace(".NS", "")

    data = await _nse.get(_ACTIONS_API, params=params)
    if not data:
        return []

    rows = data if isinstance(data, list) else data.get("data", [])
    actions = []
    for r in rows:
        ac = _parse_action_row(r)
        if ac:
            actions.append(ac)
    return actions


# ─── Main agent entry point ───────────────────────────────────────

async def run_events_agent(lookahead_days: int = 7) -> dict:
    """
    Fetch upcoming corporate events + actions for the watchlist.
    Called by APScheduler at 08:30 AM IST daily.
    """
    logger.info("━━ AGENT: NSE Corporate Events ━━")

    today  = date.today()
    to_dt  = today + timedelta(days=lookahead_days)

    events, actions = await asyncio.gather(
        fetch_event_calendar(today, to_dt),
        fetch_corporate_actions(from_date=today, to_date=to_dt),
        return_exceptions=True,
    )

    if isinstance(events, Exception):
        logger.error(f"Event calendar fetch failed: {events}")
        events = []
    if isinstance(actions, Exception):
        logger.error(f"Corporate actions fetch failed: {actions}")
        actions = []

    all_events = events + actions

    # Filter to watchlist + today's events
    watchlist_events = [e for e in all_events if e.get("symbol") in _WATCHLIST_SYMS]
    today_events = [
        e for e in all_events
        if e.get("event_date") == today.isoformat()
    ]

    result = {
        "fetched_at":       datetime.now(timezone.utc).isoformat(),
        "all_events":       all_events,
        "watchlist_events": watchlist_events,
        "today_events":     today_events,
        "total":            len(all_events),
    }

    logger.info(
        f"  ✓ Events: {len(all_events)} total, "
        f"{len(watchlist_events)} on watchlist, "
        f"{len(today_events)} today"
    )
    return result


def build_morning_brief(events_result: dict) -> str:
    """Build a Telegram morning brief text from events result."""
    from notifications.telegram import _SEP, _ist_now
    today_events  = events_result.get("today_events", [])
    watchlist_evs = events_result.get("watchlist_events", [])
    today_str     = datetime.now(timezone.utc).strftime("%d %b %Y")

    event_type_emoji = {
        "results":   "📊",
        "dividend":  "💰",
        "agm":       "🏦",
        "board":     "📋",
        "bonus":     "📈",
        "split":     "📊",
        "rights":    "📋",
    }

    lines = [
        f"☀️ <b>MORNING BRIEF</b>",
        _SEP,
        f"<i>{today_str}  ·  India Markets</i>",
        "",
    ]

    if today_events:
        lines.append(f"<b>TODAY'S EVENTS ({len(today_events)})</b>")
        for ev in today_events[:8]:
            sym    = ev.get("symbol", "?")
            etype  = ev.get("event_type", "")
            elabel = ev.get("event_type_label", etype).strip() or "Event"
            detail = ev.get("details", "")
            wl_tag = " ⭐" if ev.get("on_watchlist") else ""
            icon   = event_type_emoji.get(etype, "📅")
            detail_str = f"  <i>{detail[:60]}</i>" if detail else ""
            lines.append(f"  {icon} <b>{sym}</b>{wl_tag} — {elabel}{detail_str}")
    else:
        lines.append("<b>TODAY'S EVENTS</b>")
        lines.append("  No major scheduled events today.")

    upcoming = [e for e in watchlist_evs if e.get("event_date", "") > date.today().isoformat()]
    if upcoming:
        upcoming.sort(key=lambda x: x.get("event_date", ""))
        lines.append("")
        lines.append(f"<b>UPCOMING — WATCHLIST ({len(upcoming)})</b>")
        for ev in upcoming[:5]:
            sym    = ev.get("symbol", "?")
            dt     = ev.get("event_date", "?")
            etype  = ev.get("event_type", "")
            elabel = ev.get("event_type_label", etype) or "Event"
            icon   = event_type_emoji.get(etype, "📅")
            lines.append(f"  {icon} <b>{sym}</b> — {elabel}  <i>{dt}</i>")

    lines.extend([
        "",
        _SEP,
        f"<i>TradeX Intelligence  ·  {_ist_now()}</i>",
    ])
    return "\n".join(lines)


# ─── Parsers ──────────────────────────────────────────────────────

def _parse_event_row(row: dict) -> dict | None:
    symbol = (row.get("symbol") or row.get("BD_SYMBOL") or "").upper().strip()
    if not symbol:
        return None

    company    = row.get("company") or row.get("companyName") or symbol
    raw_type   = row.get("purpose") or row.get("type") or row.get("eventType") or ""
    date_str   = row.get("date") or row.get("meetingDate") or row.get("bMDate") or ""
    details    = row.get("details") or row.get("description") or ""

    event_type = _map_event_type(raw_type)

    return {
        "symbol":           symbol,
        "company_name":     str(company).strip(),
        "event_type":       event_type,
        "event_type_label": raw_type.strip(),
        "event_date":       _parse_nse_date(date_str),
        "details":          str(details).strip()[:200],
        "source":           "nse_event_calendar",
        "on_watchlist":     symbol in _WATCHLIST_SYMS,
    }


def _parse_action_row(row: dict) -> dict | None:
    symbol = (row.get("symbol") or "").upper().strip()
    if not symbol:
        return None

    company   = row.get("comp") or row.get("companyName") or symbol
    raw_type  = row.get("subject") or row.get("purpose") or ""
    date_str  = row.get("exDate") or row.get("recDate") or row.get("date") or ""
    details   = row.get("faceVal") or row.get("remarks") or ""

    event_type = _map_event_type(raw_type)

    return {
        "symbol":           symbol,
        "company_name":     str(company).strip(),
        "event_type":       event_type,
        "event_type_label": raw_type.strip()[:100],
        "event_date":       _parse_nse_date(date_str),
        "details":          str(details).strip()[:200],
        "source":           "nse_corporate_actions",
        "on_watchlist":     symbol in _WATCHLIST_SYMS,
    }


def _map_event_type(raw: str) -> str:
    raw_lower = raw.lower()
    if "result" in raw_lower or "quarterly" in raw_lower or "annual" in raw_lower:
        return "results"
    if "dividend" in raw_lower or "interim" in raw_lower:
        return "dividend"
    if "bonus" in raw_lower:
        return "bonus"
    if "split" in raw_lower:
        return "split"
    if "rights" in raw_lower:
        return "rights"
    if "agm" in raw_lower:
        return "agm"
    if "egm" in raw_lower:
        return "egm"
    if "board" in raw_lower or "meeting" in raw_lower:
        return "board_meeting"
    return "other"


# ─── Quick test ───────────────────────────────────────────────────

if __name__ == "__main__":
    async def _test():
        result = await run_events_agent()
        from pprint import pprint
        pprint(result["today_events"])
        pprint(result["watchlist_events"][:5])
    asyncio.run(_test())
