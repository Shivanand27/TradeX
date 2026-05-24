"""
core/database.py
─────────────────────────────────────────────────────
Supabase client + schema definitions.
Run create_schema() once to initialise all tables.
Free tier: 500MB, 50,000 rows — plenty for years of signals.
"""
from __future__ import annotations
import json
from datetime import datetime, timezone
from typing import Any
from loguru import logger
from supabase import create_client, Client
from core.config import SUPABASE_URL, SUPABASE_KEY


# ─── Schema SQL (run once via Supabase dashboard SQL editor) ──────
SCHEMA_SQL = """
-- ── signals ──────────────────────────────────────────────────────
-- Every trade signal ever generated (GO, NO_GO, WATCH)
CREATE TABLE IF NOT EXISTS signals (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    signal_id       TEXT UNIQUE NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    market          TEXT NOT NULL,          -- india_stock | india_fno | crypto_spot | crypto_futures
    symbol          TEXT NOT NULL,
    company_name    TEXT,
    verdict         TEXT NOT NULL,          -- GO | NO_GO | WATCH
    conviction      TEXT,                   -- HIGH | MEDIUM
    strategy        TEXT,
    narrative       TEXT,

    -- Trade setup
    entry_price     NUMERIC(20,4),
    entry_zone_low  NUMERIC(20,4),
    entry_zone_high NUMERIC(20,4),
    timeframe       TEXT,
    leverage        NUMERIC(5,2) DEFAULT 1.0,
    target_1        NUMERIC(20,4),
    target_1_pct    TEXT,
    target_2        NUMERIC(20,4),
    target_2_pct    TEXT,
    stop_loss       NUMERIC(20,4),
    stop_loss_pct   TEXT,
    trailing_stop   TEXT,
    time_exit       TEXT,
    invalidation    TEXT,
    max_hold_days   INTEGER,

    -- Risk
    position_size_pct   NUMERIC(5,2),
    max_loss_pct        NUMERIC(5,2),
    hedge_recommendation TEXT,

    -- Scores
    technical_score     NUMERIC(4,2),
    sentiment_score     NUMERIC(4,2),
    fundamental_score   NUMERIC(4,2),
    overall_score       NUMERIC(4,2),
    bull_conviction     INTEGER,
    bear_risk           INTEGER,
    debate_summary      TEXT,

    -- Full JSON payload for reference
    raw_payload     JSONB,

    -- Outcome tracking (filled later)
    outcome         TEXT,               -- win | loss | partial | open | expired
    actual_exit_price NUMERIC(20,4),
    actual_pnl_pct  NUMERIC(8,4),
    closed_at       TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_signals_symbol   ON signals(symbol);
CREATE INDEX IF NOT EXISTS idx_signals_market   ON signals(market);
CREATE INDEX IF NOT EXISTS idx_signals_verdict  ON signals(verdict);
CREATE INDEX IF NOT EXISTS idx_signals_created  ON signals(created_at DESC);

-- ── trades ────────────────────────────────────────────────────────
-- Actual executed trades (paper or live)
CREATE TABLE IF NOT EXISTS trades (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    signal_id       TEXT REFERENCES signals(signal_id),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    symbol          TEXT NOT NULL,
    market          TEXT NOT NULL,
    side            TEXT NOT NULL,          -- long | short
    trade_type      TEXT NOT NULL,          -- paper | live
    entry_price     NUMERIC(20,4),
    quantity        NUMERIC(20,4),
    capital_deployed NUMERIC(20,2),
    status          TEXT DEFAULT 'open',    -- open | closed | cancelled
    exit_price      NUMERIC(20,4),
    exit_reason     TEXT,                   -- tp1 | tp2 | stop | time | manual
    pnl_inr         NUMERIC(20,2),
    pnl_pct         NUMERIC(8,4),
    closed_at       TIMESTAMPTZ,
    broker_order_id TEXT,
    notes           TEXT
);

CREATE INDEX IF NOT EXISTS idx_trades_symbol  ON trades(symbol);
CREATE INDEX IF NOT EXISTS idx_trades_status  ON trades(status);

-- ── agent_memory ──────────────────────────────────────────────────
-- Persistent memory for agents (episodic + calibration)
CREATE TABLE IF NOT EXISTS agent_memory (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    agent_name      TEXT NOT NULL,
    memory_type     TEXT NOT NULL,          -- episodic | calibration | working
    key             TEXT NOT NULL,
    value           JSONB NOT NULL,
    expires_at      TIMESTAMPTZ,
    UNIQUE(agent_name, memory_type, key)
);

CREATE INDEX IF NOT EXISTS idx_memory_agent ON agent_memory(agent_name, memory_type);

-- ── market_snapshots ──────────────────────────────────────────────
-- Raw market data snapshots for backtesting and audit
CREATE TABLE IF NOT EXISTS market_snapshots (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    captured_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    market          TEXT NOT NULL,
    symbol          TEXT NOT NULL,
    data            JSONB NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_snapshots_symbol ON market_snapshots(symbol, captured_at DESC);

-- ── llm_cost_tracker ──────────────────────────────────────────────
-- Track daily LLM spending vs ₹50 budget
CREATE TABLE IF NOT EXISTS llm_cost_tracker (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    date            DATE NOT NULL DEFAULT CURRENT_DATE,
    model           TEXT NOT NULL,
    purpose         TEXT,
    input_tokens    INTEGER DEFAULT 0,
    output_tokens   INTEGER DEFAULT 0,
    cost_inr        NUMERIC(10,4) DEFAULT 0,
    UNIQUE(date, model, purpose)
);
"""


def get_client() -> Client:
    """Return a connected Supabase client."""
    if not SUPABASE_URL or not SUPABASE_KEY:
        raise RuntimeError(
            "SUPABASE_URL and SUPABASE_KEY must be set in .env\n"
            "Sign up free at https://supabase.com"
        )
    return create_client(SUPABASE_URL, SUPABASE_KEY)


def create_schema() -> None:
    """
    Print the schema SQL so you can paste it into the Supabase
    dashboard → SQL Editor → Run.
    (Supabase free tier doesn't expose direct DDL via Python client.)
    """
    print("═" * 60)
    print("PASTE THIS INTO SUPABASE SQL EDITOR:")
    print("https://supabase.com/dashboard/project/_/sql")
    print("═" * 60)
    print(SCHEMA_SQL)


# ─── Signal CRUD ──────────────────────────────────────────────────

def save_signal(signal: dict) -> str | None:
    """Insert a new signal into Supabase. Returns signal_id."""
    try:
        db = get_client()
        payload = _flatten_signal(signal)
        result = db.table("signals").upsert(payload).execute()
        if result.data:
            logger.info(f"Signal saved: {signal.get('signal_id')} [{signal.get('verdict')}]")
            return signal.get("signal_id")
    except Exception as e:
        logger.error(f"Failed to save signal: {e}")
    return None


def get_open_signals(market: str | None = None) -> list[dict]:
    """Fetch all GO signals that haven't been closed yet."""
    try:
        db = get_client()
        q = db.table("signals").select("*").eq("verdict", "GO").is_("closed_at", "null")
        if market:
            q = q.eq("market", market)
        result = q.order("created_at", desc=True).limit(50).execute()
        return result.data or []
    except Exception as e:
        logger.error(f"Failed to fetch open signals: {e}")
        return []


def update_signal_outcome(signal_id: str, outcome: str,
                          exit_price: float, pnl_pct: float) -> None:
    try:
        db = get_client()
        db.table("signals").update({
            "outcome": outcome,
            "actual_exit_price": exit_price,
            "actual_pnl_pct": pnl_pct,
            "closed_at": datetime.now(timezone.utc).isoformat(),
        }).eq("signal_id", signal_id).execute()
    except Exception as e:
        logger.error(f"Failed to update signal outcome: {e}")


# ─── Trade CRUD ───────────────────────────────────────────────────

def save_trade(trade: dict) -> None:
    try:
        db = get_client()
        db.table("trades").insert(trade).execute()
        logger.info(f"Trade saved: {trade.get('symbol')} [{trade.get('side')}]")
    except Exception as e:
        logger.error(f"Failed to save trade: {e}")


# ─── Agent Memory ─────────────────────────────────────────────────

def save_memory(agent_name: str, memory_type: str,
                key: str, value: Any) -> None:
    try:
        db = get_client()
        db.table("agent_memory").upsert({
            "agent_name": agent_name,
            "memory_type": memory_type,
            "key": key,
            "value": value if isinstance(value, dict) else {"data": value},
        }).execute()
    except Exception as e:
        logger.error(f"Failed to save memory [{agent_name}/{key}]: {e}")


def load_memory(agent_name: str, memory_type: str,
                key: str) -> Any | None:
    try:
        db = get_client()
        result = (db.table("agent_memory")
                  .select("value")
                  .eq("agent_name", agent_name)
                  .eq("memory_type", memory_type)
                  .eq("key", key)
                  .execute())
        if result.data:
            return result.data[0]["value"]
    except Exception as e:
        logger.error(f"Failed to load memory [{agent_name}/{key}]: {e}")
    return None


# ─── LLM Cost Tracking ────────────────────────────────────────────

def track_llm_cost(model: str, purpose: str,
                   input_tokens: int, output_tokens: int,
                   cost_inr: float) -> None:
    try:
        db = get_client()
        db.table("llm_cost_tracker").upsert({
            "date": datetime.now(timezone.utc).date().isoformat(),
            "model": model,
            "purpose": purpose,
            "input_tokens": input_tokens,
            "output_tokens": output_tokens,
            "cost_inr": cost_inr,
        }, on_conflict="date,model,purpose").execute()
    except Exception as e:
        logger.error(f"Failed to track LLM cost: {e}")


def get_today_llm_spend() -> float:
    """Return today's total LLM spend in INR."""
    try:
        db = get_client()
        today = datetime.now(timezone.utc).date().isoformat()
        result = (db.table("llm_cost_tracker")
                  .select("cost_inr")
                  .eq("date", today)
                  .execute())
        return sum(r["cost_inr"] for r in (result.data or []))
    except Exception as e:
        logger.error(f"Failed to get LLM spend: {e}")
        return 0.0


# ─── Helpers ──────────────────────────────────────────────────────

def _flatten_signal(s: dict) -> dict:
    """Flatten nested signal dict for Supabase insert."""
    setup   = s.get("TRADE SETUP", {})
    exits   = setup.get("EXIT RULES — MANDATORY", {})
    risk    = s.get("RISK MANAGEMENT", {})
    scores  = s.get("SCORE CARD", {})

    return {
        "signal_id":         s.get("signal_id"),
        "market":            s.get("market"),
        "symbol":            s.get("symbol"),
        "company_name":      s.get("company_name"),
        "verdict":           s.get("verdict"),
        "conviction":        s.get("conviction"),
        "strategy":          s.get("strategy"),
        "narrative":         s.get("narrative"),
        "entry_price":       setup.get("entry_price"),
        "entry_zone_low":    (setup.get("entry_zone") or [None])[0],
        "entry_zone_high":   (setup.get("entry_zone") or [None, None])[1],
        "timeframe":         setup.get("timeframe"),
        "leverage":          setup.get("leverage", 1.0),
        "target_1":          exits.get("target_1"),
        "target_1_pct":      exits.get("target_1_pct"),
        "target_2":          exits.get("target_2"),
        "target_2_pct":      exits.get("target_2_pct"),
        "stop_loss":         exits.get("stop_loss"),
        "stop_loss_pct":     exits.get("stop_loss_pct"),
        "trailing_stop":     exits.get("trailing_stop"),
        "time_exit":         exits.get("time_exit"),
        "invalidation":      exits.get("invalidation"),
        "max_hold_days":     exits.get("max_hold_days"),
        "position_size_pct": risk.get("position_size_pct"),
        "max_loss_pct":      risk.get("max_loss_if_stop_hit_pct"),
        "hedge_recommendation": risk.get("hedge_recommendation"),
        "technical_score":   scores.get("technical"),
        "sentiment_score":   scores.get("sentiment"),
        "fundamental_score": scores.get("fundamental"),
        "overall_score":     scores.get("overall"),
        "bull_conviction":   scores.get("bull_conviction"),
        "bear_risk":         scores.get("bear_risk"),
        "debate_summary":    s.get("debate_summary"),
        "raw_payload":       s,
    }


if __name__ == "__main__":
    create_schema()
