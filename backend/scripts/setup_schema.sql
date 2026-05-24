-- ============================================================
-- TradeX v3 — Supabase schema
-- Paste this entire file into:
--   Supabase Dashboard → SQL Editor → New query → Run
-- ============================================================

-- ── users ────────────────────────────────────────────────────
-- Extends Supabase Auth users with app-level fields.
-- Row inserted by admin via POST /admin/users.
CREATE TABLE IF NOT EXISTS users (
    id              UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    email           TEXT UNIQUE NOT NULL,
    full_name       TEXT,
    plan            TEXT NOT NULL DEFAULT 'basic',   -- basic | pro | admin
    status          TEXT NOT NULL DEFAULT 'active',  -- active | suspended | expired
    is_admin        BOOLEAN NOT NULL DEFAULT FALSE,
    payment_ref     TEXT,
    amount_paid     NUMERIC(10,2),
    valid_until     DATE,
    created_by      UUID REFERENCES users(id)
);

CREATE INDEX IF NOT EXISTS idx_users_email  ON users(email);
CREATE INDEX IF NOT EXISTS idx_users_status ON users(status);

-- ── signals ──────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS signals (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    signal_id       TEXT UNIQUE NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    market          TEXT NOT NULL,
    symbol          TEXT NOT NULL,
    company_name    TEXT,
    verdict         TEXT NOT NULL,
    conviction      TEXT,
    strategy        TEXT,
    narrative       TEXT,
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
    position_size_pct   NUMERIC(5,2),
    max_loss_pct        NUMERIC(5,2),
    hedge_recommendation TEXT,
    technical_score     NUMERIC(4,2),
    sentiment_score     NUMERIC(4,2),
    fundamental_score   NUMERIC(4,2),
    overall_score       NUMERIC(4,2),
    bull_conviction     INTEGER,
    bear_risk           INTEGER,
    debate_summary      TEXT,
    raw_payload     JSONB,
    outcome         TEXT,
    actual_exit_price NUMERIC(20,4),
    actual_pnl_pct  NUMERIC(8,4),
    closed_at       TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_signals_symbol   ON signals(symbol);
CREATE INDEX IF NOT EXISTS idx_signals_market   ON signals(market);
CREATE INDEX IF NOT EXISTS idx_signals_verdict  ON signals(verdict);
CREATE INDEX IF NOT EXISTS idx_signals_created  ON signals(created_at DESC);

-- ── trades ───────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS trades (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    signal_id       TEXT REFERENCES signals(signal_id),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    symbol          TEXT NOT NULL,
    market          TEXT NOT NULL,
    side            TEXT NOT NULL,
    trade_type      TEXT NOT NULL,
    entry_price     NUMERIC(20,4),
    quantity        NUMERIC(20,4),
    capital_deployed NUMERIC(20,2),
    status          TEXT DEFAULT 'open',
    exit_price      NUMERIC(20,4),
    exit_reason     TEXT,
    pnl_inr         NUMERIC(20,2),
    pnl_pct         NUMERIC(8,4),
    closed_at       TIMESTAMPTZ,
    broker_order_id TEXT,
    notes           TEXT
);

CREATE INDEX IF NOT EXISTS idx_trades_symbol ON trades(symbol);
CREATE INDEX IF NOT EXISTS idx_trades_status ON trades(status);

-- ── agent_memory ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS agent_memory (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    agent_name  TEXT NOT NULL,
    memory_type TEXT NOT NULL,
    key         TEXT NOT NULL,
    value       JSONB NOT NULL,
    expires_at  TIMESTAMPTZ,
    UNIQUE(agent_name, memory_type, key)
);

CREATE INDEX IF NOT EXISTS idx_memory_agent ON agent_memory(agent_name, memory_type);

-- ── market_snapshots ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS market_snapshots (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    captured_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    market      TEXT NOT NULL,
    symbol      TEXT NOT NULL,
    data        JSONB NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_snapshots_symbol ON market_snapshots(symbol, captured_at DESC);

-- ── llm_cost_tracker ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS llm_cost_tracker (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    date          DATE NOT NULL DEFAULT CURRENT_DATE,
    model         TEXT NOT NULL,
    purpose       TEXT,
    input_tokens  INTEGER DEFAULT 0,
    output_tokens INTEGER DEFAULT 0,
    cost_inr      NUMERIC(10,4) DEFAULT 0,
    UNIQUE(date, model, purpose)
);

-- ── audit_log ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS audit_log (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    actor_id    UUID REFERENCES users(id),
    actor_email TEXT,
    action      TEXT NOT NULL,
    target      TEXT,
    details     JSONB,
    ip          TEXT,
    request_id  TEXT
);

CREATE INDEX IF NOT EXISTS idx_audit_actor  ON audit_log(actor_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_action ON audit_log(action, created_at DESC);

-- ── user_configs ─────────────────────────────────────────────
-- Per-user encrypted broker credentials + app preferences
CREATE TABLE IF NOT EXISTS user_configs (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id             UUID UNIQUE REFERENCES users(id) ON DELETE CASCADE,
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    groww_api_key       TEXT,
    groww_totp_secret   TEXT,
    delta_api_key       TEXT,
    delta_api_secret    TEXT,
    delta_paper         BOOLEAN DEFAULT TRUE,
    delta_bot           BOOLEAN DEFAULT FALSE,
    delta_max_pct       FLOAT DEFAULT 30,
    twitter_handles     TEXT DEFAULT 'realDonaldTrump,elonmusk,SEBI_India,saylor,whale_alert',
    telegram_chat_id    TEXT,
    alert_signals       BOOLEAN DEFAULT TRUE,
    alert_stops         BOOLEAN DEFAULT TRUE,
    alert_news          BOOLEAN DEFAULT TRUE,
    daily_summary       BOOLEAN DEFAULT TRUE,
    watchlist           JSONB DEFAULT NULL,
    bots                JSONB DEFAULT '[]'::jsonb
);

-- Migration: add columns added after initial deploy
ALTER TABLE user_configs ADD COLUMN IF NOT EXISTS delta_paper       BOOLEAN DEFAULT TRUE;
ALTER TABLE user_configs ADD COLUMN IF NOT EXISTS delta_bot         BOOLEAN DEFAULT FALSE;
ALTER TABLE user_configs ADD COLUMN IF NOT EXISTS delta_max_pct     FLOAT DEFAULT 30;
ALTER TABLE user_configs ADD COLUMN IF NOT EXISTS twitter_handles   TEXT DEFAULT 'realDonaldTrump,elonmusk,SEBI_India,saylor,whale_alert';
ALTER TABLE user_configs ADD COLUMN IF NOT EXISTS telegram_chat_id  TEXT;
ALTER TABLE user_configs ADD COLUMN IF NOT EXISTS alert_signals     BOOLEAN DEFAULT TRUE;
ALTER TABLE user_configs ADD COLUMN IF NOT EXISTS alert_stops       BOOLEAN DEFAULT TRUE;
ALTER TABLE user_configs ADD COLUMN IF NOT EXISTS alert_news        BOOLEAN DEFAULT TRUE;
ALTER TABLE user_configs ADD COLUMN IF NOT EXISTS daily_summary     BOOLEAN DEFAULT TRUE;
ALTER TABLE user_configs ADD COLUMN IF NOT EXISTS watchlist         JSONB DEFAULT NULL;
ALTER TABLE user_configs ADD COLUMN IF NOT EXISTS bots              JSONB DEFAULT '[]'::jsonb;

-- ── screener_snapshots ───────────────────────────────────────────
-- One row per market ('all' | 'india' | 'crypto') — upserted on every scan.
CREATE TABLE IF NOT EXISTS screener_snapshots (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    market        TEXT UNIQUE NOT NULL,
    snapshot      JSONB NOT NULL,
    total_scanned INTEGER DEFAULT 0,
    total_hits    INTEGER DEFAULT 0,
    scanned_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── block_bulk_deals ─────────────────────────────────────────────
-- NSE Block & Bulk Deals fetched twice daily by _agent_block_deals.
CREATE TABLE IF NOT EXISTS block_bulk_deals (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    symbol       TEXT NOT NULL,
    company_name TEXT,
    client_name  TEXT,
    direction    TEXT,
    quantity     NUMERIC(20,2) DEFAULT 0,
    price        NUMERIC(20,4) DEFAULT 0,
    value_crore  NUMERIC(12,2) DEFAULT 0,
    deal_type    TEXT NOT NULL,
    session_num  INTEGER DEFAULT 0,
    trade_date   DATE NOT NULL,
    traded_at    TEXT,
    remarks      TEXT,
    on_watchlist BOOLEAN DEFAULT FALSE,
    UNIQUE(symbol, client_name, direction, trade_date, deal_type)
);
CREATE INDEX IF NOT EXISTS idx_deals_symbol ON block_bulk_deals(symbol);
CREATE INDEX IF NOT EXISTS idx_deals_date   ON block_bulk_deals(trade_date DESC);

-- ── corporate_events ─────────────────────────────────────────────
-- NSE corporate events: results, dividends, splits, bonus, AGMs.
CREATE TABLE IF NOT EXISTS corporate_events (
    id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    symbol           TEXT NOT NULL,
    company_name     TEXT,
    event_type       TEXT NOT NULL,
    event_type_label TEXT,
    event_date       DATE NOT NULL,
    details          TEXT,
    source           TEXT,
    on_watchlist     BOOLEAN DEFAULT FALSE,
    UNIQUE(symbol, event_type, event_date)
);
CREATE INDEX IF NOT EXISTS idx_events_symbol ON corporate_events(symbol);
CREATE INDEX IF NOT EXISTS idx_events_date   ON corporate_events(event_date);

-- ── insider_trades ───────────────────────────────────────────────
-- SEBI PIT insider trading disclosures.
CREATE TABLE IF NOT EXISTS insider_trades (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    symbol            TEXT NOT NULL,
    company_name      TEXT,
    insider_name      TEXT NOT NULL,
    insider_role      TEXT,
    insider_role_raw  TEXT,
    trade_type        TEXT NOT NULL,
    quantity          NUMERIC(20,2) DEFAULT 0,
    price             NUMERIC(20,4) DEFAULT 0,
    value_lakh        NUMERIC(12,2) DEFAULT 0,
    pre_holding_pct   NUMERIC(8,4) DEFAULT 0,
    post_holding_pct  NUMERIC(8,4) DEFAULT 0,
    security_type     TEXT,
    acquisition_mode  TEXT,
    trade_date        DATE NOT NULL,
    disclosure_date   DATE,
    remarks           TEXT,
    on_watchlist      BOOLEAN DEFAULT FALSE,
    UNIQUE(symbol, insider_name, trade_type, trade_date)
);
CREATE INDEX IF NOT EXISTS idx_insider_symbol ON insider_trades(symbol);
CREATE INDEX IF NOT EXISTS idx_insider_date   ON insider_trades(trade_date DESC);

-- ── intraday_screener_results ────────────────────────────────────
-- Each row is one 15-min intraday screener snapshot (categories JSONB).
CREATE TABLE IF NOT EXISTS intraday_screener_results (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    scanned_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    total_scanned INTEGER DEFAULT 0,
    last_scan     TEXT,
    categories    JSONB NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS idx_intraday_scanned ON intraday_screener_results(scanned_at DESC);

-- ============================================================
-- Row Level Security
-- ============================================================
ALTER TABLE users              ENABLE ROW LEVEL SECURITY;
ALTER TABLE signals            ENABLE ROW LEVEL SECURITY;
ALTER TABLE trades             ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_memory       ENABLE ROW LEVEL SECURITY;
ALTER TABLE market_snapshots   ENABLE ROW LEVEL SECURITY;
ALTER TABLE llm_cost_tracker   ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_log          ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_configs        ENABLE ROW LEVEL SECURITY;

-- Service role bypasses RLS (backend uses service role key)
-- Anon/authenticated users get no direct table access — all goes through the API

-- ============================================================
-- Seed: first admin user
-- Replace the UUID and email below with your Supabase Auth user ID
-- after creating your account via Supabase Auth dashboard.
-- ============================================================
-- INSERT INTO users (id, email, full_name, plan, status, is_admin)
-- VALUES (
--   '<your-supabase-auth-user-uuid>',
--   'your@email.com',
--   'Admin',
--   'admin',
--   'active',
--   true
-- );
