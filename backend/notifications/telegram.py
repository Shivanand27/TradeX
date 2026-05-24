"""
notifications/telegram.py
─────────────────────────────────────────────────────
Telegram Bot API — completely free, unlimited messages.

Setup (takes 60 seconds):
  1. Message @BotFather on Telegram → /newbot
  2. Copy the token → TELEGRAM_BOT_TOKEN in .env
  3. Message @userinfobot → copy your ID → TELEGRAM_CHAT_ID in .env
"""
from __future__ import annotations
import asyncio
import os
from datetime import datetime, timezone, timedelta
from typing import Optional
from loguru import logger
import httpx
from core.config import TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID

BASE_URL = f"https://api.telegram.org/bot{TELEGRAM_BOT_TOKEN}"

# When True the bot only sends trade signals and stop/exit alerts.
# All other messages (morning briefings, budget alerts, daily summaries) are suppressed.
SIGNAL_ONLY = os.environ.get("TELEGRAM_SIGNAL_ONLY", "true").lower() in ("1", "true", "yes")

# Message type tags — used to enforce SIGNAL_ONLY mode
_ALLOWED_TYPES = {"signal", "stop_triggered", "rf_dw_alert", "tv_webhook",
                  "block_deal_alert", "cluster_buy_alert", "morning_brief",
                  "pipeline_setups", "ema_cross_alert"}

_IST = timezone(timedelta(hours=5, minutes=30))
_SEP = "─" * 36


# ─── Core send function ───────────────────────────────────────────

async def send_message(text: str, chat_id: str = TELEGRAM_CHAT_ID,
                       parse_mode: str = "HTML",
                       _msg_type: str = "misc") -> bool:
    """Send a plain text or HTML message.

    _msg_type is an internal routing tag. When SIGNAL_ONLY=true, only types
    in _ALLOWED_TYPES are delivered; all others are logged and dropped.
    """
    if SIGNAL_ONLY and _msg_type not in _ALLOWED_TYPES:
        logger.debug(f"Telegram suppressed (SIGNAL_ONLY): type={_msg_type}")
        return False

    if not TELEGRAM_BOT_TOKEN:
        logger.warning("Telegram not configured — message not sent")
        logger.info(f"[TELEGRAM PREVIEW]\n{text}")
        return False

    try:
        async with httpx.AsyncClient(timeout=10) as client:
            resp = await client.post(f"{BASE_URL}/sendMessage", json={
                "chat_id": chat_id,
                "text": text,
                "parse_mode": parse_mode,
                "disable_web_page_preview": True,
            })
            if resp.status_code == 200:
                return True
            logger.error(f"Telegram send failed: {resp.text}")
    except Exception as e:
        logger.error(f"Telegram error: {e}")
    return False


def send_sync(text: str) -> bool:
    """Sync wrapper for send_message (use from non-async code)."""
    return asyncio.run(send_message(text))


# ─── Signal formatter ─────────────────────────────────────────────

def format_signal(signal: dict) -> str:
    """Format a verdict signal into a clean, professional Telegram message."""
    s      = signal
    setup  = s.get("TRADE SETUP", {})
    exits  = setup.get("EXIT RULES — MANDATORY", {})
    risk   = s.get("RISK MANAGEMENT", {})
    scores = s.get("SCORE CARD", {})

    verdict   = s.get("verdict", "WATCH")
    conviction= s.get("conviction", "MEDIUM")
    market    = s.get("market", "")
    currency  = "₹" if "india" in market else "$"

    verdict_emoji = {"GO": "✅", "WATCH": "🔔", "NO_GO": "❌"}.get(verdict, "◆")
    market_label  = {
        "india_stock":    "India Stock",
        "india_fno":      "India F&O",
        "crypto_spot":    "Crypto Spot",
        "crypto_futures": "Crypto Futures",
    }.get(market, market.replace("_", " ").title())

    # Entry zone
    ez = setup.get("entry_zone") or []
    if len(ez) == 2 and ez[0]:
        entry_str = f"{currency}{_fmt(ez[0])} – {currency}{_fmt(ez[1])}"
    else:
        entry_str = f"{currency}{_fmt(setup.get('entry_price'))}"

    # Score bars
    tech  = scores.get("technical")
    sent  = scores.get("sentiment")
    fund  = scores.get("fundamental")
    bull  = scores.get("bull_conviction")
    bear  = scores.get("bear_risk")

    # Build message
    lines = [
        f"{verdict_emoji} <b>{verdict} — {conviction} CONVICTION</b>",
        _SEP,
        f"<b>{s.get('symbol', '?').replace('.NS', '')}</b>  ·  {s.get('company_name', '')}  ·  <i>{market_label}</i>",
        "",
        f"<b>ENTRY</b>   {entry_str}",
        f"<b>HOLD</b>    {setup.get('timeframe', '—').replace('_', ' ')}",
        "",
        "<b>TARGETS</b>",
        f"  ▶ TP1  {currency}{_fmt(exits.get('target_1'))}  "
        f"({exits.get('target_1_pct', '—')})  → {exits.get('target_1_action', 'exit 50%')}",
        f"  ▶ TP2  {currency}{_fmt(exits.get('target_2'))}  "
        f"({exits.get('target_2_pct', '—')})  → {exits.get('target_2_action', 'exit rest')}",
        "",
        f"⛔ <b>STOP LOSS</b>  {currency}{_fmt(exits.get('stop_loss'))}  "
        f"({exits.get('stop_loss_pct', '—')})  ← EXIT IMMEDIATELY",
    ]

    trailing = exits.get("trailing_stop")
    time_exit = exits.get("time_exit")
    invalidation = exits.get("invalidation")
    if trailing:
        lines.append(f"  Trailing   <i>{trailing}</i>")
    if time_exit:
        lines.append(f"  Time exit  <i>{time_exit}</i>")
    if invalidation:
        lines.append(f"  Invalidate <i>{invalidation}</i>")

    compact_scores = [
        f"{label} {float(val):.1f}/10"
        for label, val in [("Tech", tech), ("Sent", sent), ("Fund", fund)]
        if val is not None
    ]
    if bull is not None and bear is not None:
        compact_scores.append(f"Bull {int(bull)}  Bear {int(bear)}")
    if compact_scores:
        lines.append("")
        lines.append(f"<b>SCORES</b>  {'  ·  '.join(compact_scores)}")

    narrative = s.get("narrative", "")
    debate    = s.get("debate_summary", "")
    if narrative:
        lines.append("")
        lines.append(f"<b>WHY</b>")
        lines.append(f"<i>{narrative}</i>")
    if debate:
        lines.append("")
        lines.append(f"⚠️ <b>KEY RISK</b>")
        lines.append(f"<i>{debate}</i>")

    lines.append("")
    pos_size = risk.get("position_size_pct", "?")
    max_loss = risk.get("max_loss_if_stop_hit_pct", "?")
    lines.append(f"<b>POSITION</b>  Size: <b>{pos_size}%</b> of capital  ·  Max loss: <b>{max_loss}%</b>")

    hedge = risk.get("hedge_recommendation", "")
    if hedge and hedge.lower() not in ("none", "—", ""):
        lines.append(f"🔒 Hedge: <i>{hedge}</i>")

    lines.extend([
        "",
        _SEP,
        f"<code>{s.get('signal_id', '?')}</code>  ·  <i>{_ist_now()}</i>",
    ])

    return "\n".join(lines)


async def send_signal(signal: dict) -> bool:
    """Format and send a signal to Telegram."""
    msg = format_signal(signal)
    return await send_message(msg, _msg_type="signal")


# ─── Pipeline setup alert ─────────────────────────────────────────

async def send_pipeline_setups(setups: list[dict], market: str) -> bool:
    """
    Notify when the India Analysis Pipeline identifies stocks aligned for a trade.
    Fires before the LLM debate so the user knows what's being analysed.
    """
    if not setups:
        return False

    market_label = {"india": "🇮🇳 India", "crypto": "₿ Crypto"}.get(market, market.upper())

    trigger_label = {
        "technical_breakout":       "Technical breakout",
        "fundamental_quality":      "Fundamental quality",
        "news_event":               "News catalyst",
        "technical_breakout+news":  "Technical + News",
        "fundamental_quality+news": "Fundamental + News",
    }
    trigger_emoji = {
        "technical_breakout":       "📊",
        "fundamental_quality":      "🏦",
        "news_event":               "📰",
        "technical_breakout+news":  "📊",
        "fundamental_quality+news": "🏦",
    }
    bias_badge = {
        "strong_bullish": "📈📈 Strong Bullish",
        "bullish":        "📈 Bullish",
        "neutral":        "➡️ Neutral",
        "bearish":        "📉 Bearish",
        "strong_bearish": "📉📉 Strong Bearish",
    }

    count = len(setups)
    lines = [
        f"🔔 <b>PIPELINE ALERT — {market_label}</b>",
        _SEP,
        f"<b>{count} setup{'s' if count != 1 else ''}</b> identified for Bull vs Bear debate",
        "<i>GO signals will follow once debate completes.</i>",
        "",
    ]

    for i, s in enumerate(setups, 1):
        sym     = s.get("symbol", "?").replace(".NS", "")
        score   = s.get("technical_score")
        bias    = s.get("overall_bias", "neutral")
        trigger = s.get("trigger_source", "unknown")
        fund    = s.get("fundamental_score")

        score_parts = []
        if score:
            score_parts.append(f"Tech {float(score):.1f}/10")
        if fund:
            score_parts.append(f"Fund {float(fund):.1f}/10")
        score_str = "  ·  ".join(score_parts) if score_parts else "—"

        lines.append(
            f"{trigger_emoji.get(trigger, '◆')} <b>{i}. {sym}</b>  "
            f"{bias_badge.get(bias, '◆ ' + bias.replace('_', ' ').title())}"
        )
        lines.append(f"   {trigger_label.get(trigger, trigger.replace('_', ' '))}  ·  {score_str}")

        headlines = s.get("news_headlines") or s.get("trigger_news_headlines") or []
        for h in headlines[:2]:
            lines.append(f"   📰 <i>{str(h)[:90]}</i>")
        lines.append("")

    lines.extend([
        _SEP,
        f"<i>{_ist_now()}</i>",
    ])

    return await send_message("\n".join(lines), _msg_type="pipeline_setups")


# ─── Stop / exit alert ────────────────────────────────────────────

async def send_stop_triggered(symbol: str, reason: str,
                              entry: float, exit_price: float) -> bool:
    pnl     = ((exit_price - entry) / entry) * 100 if entry else 0
    outcome = "PROFIT" if pnl >= 0 else "LOSS"
    emoji   = "📈" if pnl >= 0 else "📉"
    sign    = "+" if pnl >= 0 else ""

    msg = "\n".join([
        f"{emoji} <b>EXIT TRIGGERED — {symbol.replace('.NS', '')}</b>",
        _SEP,
        f"<b>Reason</b>   {reason}",
        "",
        f"Entry   {_fmt(entry)}",
        f"Exit    {_fmt(exit_price)}",
        f"P&L     <b>{sign}{pnl:.2f}%  [{outcome}]</b>",
        "",
        _SEP,
        f"<i>{_ist_now()}</i>",
    ])
    return await send_message(msg, _msg_type="stop_triggered")


# ─── Block Deal alert ─────────────────────────────────────────────

async def send_deals_alert(hits: list[dict], session_num: int = 0) -> bool:
    """Format and send a block/bulk deal watchlist hit notification."""
    if not hits:
        return False

    session_label = {
        1: "Morning session  8:45 – 9:00",
        2: "Afternoon session  14:05 – 14:20",
    }.get(session_num, "")

    lines = [
        "🏦 <b>BLOCK / BULK DEALS — WATCHLIST HIT</b>",
        _SEP,
    ]
    if session_label:
        lines.append(f"<i>{session_label}</i>")
        lines.append("")

    for d in hits[:10]:
        direction = d.get("direction", "")
        dir_tag   = "📈 <b>BUY</b> " if direction == "BUY" else "📉 <b>SELL</b>" if direction == "SELL" else "  "
        deal_type = d.get("deal_type", "block").upper()
        value_cr  = d.get("value_crore", 0)

        lines.append(
            f"{dir_tag}  <b>{d.get('symbol', '?').replace('.NS', '')}</b>  [{deal_type}]"
        )
        lines.append(f"   {d.get('client_name', '—')}")
        lines.append(
            f"   ₹{_fmt(d.get('price', 0))}  ×  {int(d.get('quantity', 0)):,} shares"
            f"  =  ₹{_fmt(value_cr)} Cr"
        )
        lines.append("")

    if len(hits) > 10:
        lines.append(f"<i>+{len(hits) - 10} more deals not shown</i>")
        lines.append("")

    lines.extend([
        _SEP,
        f"Total deals: <b>{len(hits)}</b>  ·  <i>{_ist_now()}</i>",
    ])

    return await send_message("\n".join(lines), _msg_type="block_deal_alert")


# ─── Insider cluster alert ────────────────────────────────────────

async def send_cluster_alert(cluster: dict) -> bool:
    """Send a cluster-buy insider trading alert."""
    sym      = cluster.get("symbol", "?").replace(".NS", "")
    company  = cluster.get("company_name", sym)
    count    = cluster.get("insider_count", 0)
    value    = cluster.get("total_value_lakh", 0)
    insiders = cluster.get("insiders", [])
    wl_tag   = "  ⭐ <b>WATCHLIST</b>" if cluster.get("on_watchlist") else ""

    lines = [
        f"🏦 <b>INSIDER CLUSTER BUY</b>{wl_tag}",
        _SEP,
        f"<b>{sym}</b>  ·  {company}",
        "",
        f"<b>{count} insiders</b> bought within a 5-day window",
        f"Total value: <b>₹{_fmt(value)} L</b>",
        "",
        "<b>Buyers</b>",
    ]
    for name in insiders[:5]:
        lines.append(f"  · {name}")
    if len(insiders) > 5:
        lines.append(f"  + {len(insiders) - 5} more")

    win_start = cluster.get("window_start", "?")
    win_end   = cluster.get("window_end", "?")
    lines.extend([
        "",
        f"📅 Window: {win_start} → {win_end}",
        _SEP,
        f"<i>Source: SEBI PIT Disclosures  ·  {_ist_now()}</i>",
    ])

    return await send_message("\n".join(lines), _msg_type="cluster_buy_alert")


# ─── Daily summary formatter ──────────────────────────────────────

def format_daily_summary(
    open_signals: list[dict],
    watch_list: list[dict],
    events_tomorrow: list[str],
    date: Optional[str] = None,
) -> str:
    """Format the 8 PM IST end-of-day summary."""
    date = date or datetime.now(_IST).strftime("%d %b %Y")

    lines = [
        f"📋 <b>END OF DAY SUMMARY</b>",
        f"<i>{date}</i>",
        _SEP,
    ]

    # Open signals
    lines.append(f"<b>OPEN SIGNALS ({len(open_signals)})</b>")
    if open_signals:
        for sig in open_signals:
            sym   = sig.get("symbol", "?").replace(".NS", "")
            entry = sig.get("entry_price", 0)
            tp1   = sig.get("target_1", 0)
            sl    = sig.get("stop_loss", 0)
            lines.append(
                f"  ◆ <b>{sym}</b>  Entry {_fmt(entry)}  "
                f"·  TP1 {_fmt(tp1)}  ·  SL {_fmt(sl)}"
            )
    else:
        lines.append("  No open signals.")

    # Forming setups
    lines.append("")
    lines.append(f"<b>SETUPS FORMING ({len(watch_list)})</b>")
    if watch_list:
        for w in watch_list[:5]:
            sym   = w.get("symbol", "?").replace(".NS", "")
            strat = w.get("strategy", "—")
            score = w.get("overall_score")
            score_str = f"  {float(score):.1f}/10" if score is not None else ""
            lines.append(f"  ◆ <b>{sym}</b>  {strat}{score_str}")
    else:
        lines.append("  No setups forming.")

    # Tomorrow's events
    lines.append("")
    lines.append("<b>TOMORROW'S KEY EVENTS</b>")
    if events_tomorrow:
        for ev in events_tomorrow[:6]:
            lines.append(f"  📅 {ev}")
    else:
        lines.append("  No major scheduled events.")

    lines.extend([
        "",
        _SEP,
        f"<i>Trading Intelligence Platform  ·  {_ist_now()}</i>",
    ])

    return "\n".join(lines)


async def send_daily_summary(open_signals: list[dict],
                             watch_list: list[dict],
                             events_tomorrow: list[str]) -> bool:
    msg = format_daily_summary(open_signals, watch_list, events_tomorrow)
    return await send_message(msg, _msg_type="daily_summary")


# ─── Generic alert ────────────────────────────────────────────────

async def send_alert(title: str, body: str, level: str = "INFO",
                     _msg_type: str = "misc") -> bool:
    level_emoji = {"INFO": "ℹ️", "WARNING": "⚠️", "CRITICAL": "🚨"}.get(level, "📢")
    msg = "\n".join([
        f"{level_emoji} <b>{title}</b>",
        _SEP,
        body,
        "",
        f"<i>{_ist_now()}</i>",
    ])
    return await send_message(msg, _msg_type=_msg_type)


async def send_budget_alert(spent_inr: float, budget_inr: float) -> bool:
    pct = (spent_inr / budget_inr) * 100
    return await send_alert(
        "LLM BUDGET ALERT",
        f"Spent: ₹{spent_inr:.2f} / ₹{budget_inr:.2f}  ({pct:.0f}%)\n"
        "Switching to free-tier models only.",
        level="WARNING",
        _msg_type="budget_alert",
    )


# ─── Helpers ──────────────────────────────────────────────────────

def _fmt(v) -> str:
    if v is None:
        return "—"
    try:
        f = float(v)
        if f >= 1_000:
            return f"{f:,.2f}"
        return f"{f:.4g}"
    except (TypeError, ValueError):
        return str(v)


def _bar(score, width: int = 10) -> str:
    """Unicode block progress bar.  _bar(8.2) → '████████░░'"""
    try:
        n = round(float(score) * width / 10)
        n = max(0, min(width, n))
    except (TypeError, ValueError):
        return "░" * width
    return "█" * n + "░" * (width - n)


def _ist_now() -> str:
    return datetime.now(_IST).strftime("%d %b %Y · %H:%M IST")


# ─── Quick test ───────────────────────────────────────────────────

if __name__ == "__main__":
    sample_signal = {
        "signal_id": "TEST-001",
        "market": "india_stock",
        "symbol": "RELIANCE.NS",
        "company_name": "Reliance Industries Ltd",
        "verdict": "GO",
        "conviction": "HIGH",
        "strategy": "Positional Long — Multi-year Breakout",
        "narrative": (
            "RELIANCE has broken above ₹3,000 resistance on 3× average volume, "
            "confirming a multi-year ascending triangle breakout with institutional backing. "
            "FII net buying of ₹450 Cr in 5 days signals smart money accumulation."
        ),
        "debate_summary": "Bear risk: earnings disappointment in O2C segment could cap upside.",
        "TRADE SETUP": {
            "entry_price": 3020.0,
            "entry_zone": [3000.0, 3040.0],
            "timeframe": "positional_1_3m",
            "leverage": 1.0,
            "EXIT RULES — MANDATORY": {
                "target_1": 3450.0,
                "target_1_pct": "+14%",
                "target_1_action": "exit 50% of position",
                "target_2": 4200.0,
                "target_2_pct": "+39%",
                "target_2_action": "exit remaining 50%",
                "stop_loss": 2840.0,
                "stop_loss_pct": "–6%",
                "trailing_stop": "Trail 8% below highest weekly close after TP1 hit",
                "time_exit": "Exit by 30-Sep-2026 if neither TP hit",
                "invalidation": "Close below ₹2,900 on daily candle",
                "max_hold_days": 120,
            },
        },
        "RISK MANAGEMENT": {
            "position_size_pct": 8.0,
            "max_loss_if_stop_hit_pct": 0.48,
            "hedge_recommendation": "Buy RELIANCE 2900 PE for ₹1 L+ position",
        },
        "SCORE CARD": {
            "technical": 8.2,
            "sentiment": 7.1,
            "fundamental": 7.8,
            "overall": 7.9,
            "bull_conviction": 8,
            "bear_risk": 4,
        },
    }

    print(format_signal(sample_signal))
    print()

    sample_pipeline = [
        {
            "symbol": "HDFC.NS",
            "technical_score": 7.9,
            "fundamental_score": 8.1,
            "overall_bias": "bullish",
            "trigger_source": "technical_breakout",
            "news_headlines": [],
        },
        {
            "symbol": "TCS.NS",
            "technical_score": 6.8,
            "overall_bias": "strong_bullish",
            "trigger_source": "news_event",
            "news_headlines": [
                "TCS wins $1.5B deal with European bank",
                "TCS Q4 PAT beats estimates by 8%",
            ],
        },
    ]
    import asyncio
    asyncio.run(send_pipeline_setups.__wrapped__(sample_pipeline, "india")
                if hasattr(send_pipeline_setups, "__wrapped__")
                else print(
                    "Pipeline preview:\n" + "\n".join([
                        f"🎯 PIPELINE ALERT — 🇮🇳 India",
                        "2 setups identified for Bull vs Bear debate",
                    ])
                ))
    print("[Would send to Telegram if token is set]")
