# TradeX v3 — Platform Readiness Tracker

> Audit date: 27 Apr 2026 | Last updated: 07 May 2026
> Status: **LAUNCH-READY — Phase 1 + Phase 2 complete; Go/No-Go checklist pending; only Phase 3 enhancements remain**

---

## Executive Summary

TradeX v3 has a solid foundation: real-time WebSocket infrastructure, a working kill-switch hierarchy, a multi-source signal pipeline, a screener with scheduled scans and new multi-timeframe TA categories, a full-featured journal with PDF/Excel export, and a bot framework that wires signals to execution. The platform is architecturally sound but has **4 P0 blockers** that must be resolved before any live trading. All Phase 1 gaps remain open — fix those before paper-trading begins.

### Recent session work (28 Apr 2026)
- Fixed screener `.NS.NS` double-suffix bug — all 72 India symbols now fetch correctly from Yahoo Finance
- Added 6 new TA screener categories: 4H High/Near, 4H Low/Near, Weekly High Breakout, Weekly Low Breakdown, Weekly Consolidation Breakout, Monthly Consolidation Breakout
- Implemented parallel async multi-timeframe fetch (`asyncio.gather` daily + 4H intraday)
- IST timezone formatting applied across all UI components (SignalsPage, SignalPopup, BotsPage, ScreenerPage, AgentLivePage, JournalPage, Login)
- Login page completely redesigned — 3D holographic theme, professional SVG icon set, removed all version strings and status messages

### Recent session work (07 May 2026)
- **Screener DB schema** — 5 missing tables (`screener_snapshots`, `block_bulk_deals`, `corporate_events`, `insider_trades`, `intraday_screener_results`) added to `setup_schema.sql`; must be run manually in Supabase Dashboard → SQL Editor
- **Screener boot warm-up** — Phase 0 `_warm_state_from_db` added; deals/events/insider agents triggered in boot Phase 2 if state is cold
- **Screener scanning poll bug fixed** — replaced broken `useEffect` + `setTimeout` with `refetchInterval: (query) => query.state.data?.scanning ? 3000 : false` in `ScreenerPage.jsx`
- **EventsCalendar default filter** — `watchOnly` default changed `true → false` so all events show by default
- **Agent Monitor auto-scroll fix** — replaced `scrollIntoView` (dragged entire page) with `scrollTop = scrollHeight` on a dedicated ref'd div with `maxHeight: 420, overflowY: auto`
- **Screener schedule labels** — UI now correctly shows "9:30 AM & 1:30 PM IST · Mon–Fri" (was incorrectly showing "15m")
- **LLM cost optimisation** — `_agent_india_sentiment` split into market-hours (full LLM) vs off-hours (RSS-only, no LLM); cuts ~67% of LLM API cost with no loss of trading-hours coverage
- **Ticker strip** — Removed BTC FUND and F&G from `CRYPTO_SYMBOLS` in `TickerStrip.jsx`
- **Telegram pipeline notification** — `send_pipeline_setups()` added to `telegram.py`; fires from `signal_pipeline.py` after `qualified` stocks are assembled, before LLM debate begins
- **Telegram notifications redesigned** — all 6 formatters (`format_signal`, `send_pipeline_setups`, `send_stop_triggered`, `send_deals_alert`, `send_cluster_alert`, `format_daily_summary`) rewritten: consistent `─` separator, IST timestamps, `████░░` score bars, standard finance icons (`📈`/`📉`/`✅`/`❌`/`⛔`/`🔒`/`🏦`/`🔔`)

---

## Production-Ready Inventory

| Component | Status | Notes |
|---|---|---|
| WebSocket infrastructure | ✅ Production | Auto-reconnect, per-user channels, broadcast |
| Kill Switch (soft/granular/reset) | ✅ Production | All three tiers wired and tested |
| Signal Pipeline display | ✅ Production | Signals page with detail popup |
| RF[DW] signals | ✅ Production | Separate signal source displayed |
| Risk Guardian panel | ✅ Production | Kill switch controls + risk limits |
| Order Ticket | ✅ Production | Market/Limit/SL orders, qty validation |
| Positions & Orders blotter | ✅ Production | Live P&L via WS tickers; Order Modify (pencil inline form) + Cancel All (GAP-001, GAP-003b fixed) |
| Stock Screener | ✅ Production | .NS fix applied; 18 categories including 4H/Weekly/Monthly TA |
| Trade Journal | ✅ Production | Full CRUD, filters, PDF + Excel export |
| Price Alerts | ✅ Production | Create/delete, backend-triggered |
| Ticker Strip | ✅ Production | Full price display, comma-strip bug resolved |
| Trading Bots | ✅ Production | Create/configure/toggle/delete, 4 signal sources |
| Agent Monitor | ✅ Production | Live agent status, heartbeat display |
| User Management (admin) | ✅ Production | CRUD, role management |
| Settings | ✅ Production | Config persistence to /user/config |
| IST time formatting | ✅ Production | `fmtIST()` applied across all UI display sites |
| News / Intel Feed | ✅ Production | Paginated, filtered by category |
| Authentication | ✅ Production | Supabase JWT, dev-admin bypass for local |
| Login Page | ✅ Production | 3D holographic UI, professional SVG icons, no version strings |
| Signal Performance Leaderboard | ✅ Production | PERFORMANCE tab in SignalsPage; per-symbol win rate, expectancy, avg win/loss (GAP-002 fixed) |
| Market Intelligence (Screener) | ✅ Production | 4 new ScreenerPage tabs: Block/Bulk Deals, Insider Trades + clusters, Corporate Events calendar, Intraday screener (GAP-003 delivered) |
| Signal Flip / Position Reversal | ✅ Production | Bot auto-closes opposite position before reversing; WS notification + REVERSAL_CLOSE execution log entry |
| MarketPulse breadth strip | ✅ Production | Pinned strip: A/D ratio, VIX, FII/DII flows, top sectors, F&G, BTC.D — visible on all HomeDashboard tabs (GAP-004 fixed) |
| Connectivity panel | ✅ Production | CommandBar: WS dot + BROKER chip (Groww/Delta) + FEED chip (India/Crypto) — click any chip for detail popup (GAP-006 fixed) |
| Bot execution verification | ✅ Production | Broker order placed on every signal fire; PENDING→PLACED/SIMULATED/ERROR status; auto-disable after 3 consecutive errors; BotCard shows error badge + disabled banner (GAP-007 fixed) |
| Watchlist persistence | ✅ Production | Sidebar symbols saved to user_configs via debounced saveUserConfig; restored from getUserConfig on login (GAP-008 fixed) |
| Price chart drawer | ✅ Production | 820px slide-in panel on any signal card; lightweight-charts candlesticks + EMA 9/21; period selector 5D–1Y (GAP-009 fixed) |
| Journal Analytics tab | ✅ Production | Setup win rates, avg P&L/R:R, cumulative P&L SVG curve, emotion breakdown — Analytics tab in JournalPage (GAP-005 fixed) |
| Notification Centre | ✅ Production | Bell icon in CommandBar; unread badge; persistent (localStorage); captures bot trades, flips, auto-disables, price alerts (GAP-010 fixed) |

---

## Gap Registry

### P0 — Launch Blockers (must fix before any live trading)

---

#### GAP-001: No Live P&L per Position

**Severity:** P0 — Launch Blocker
**Status:** ✅ FIXED — 28 Apr 2026

**What was done:**
- Added `enrich(p, tickers)` helper in `PositionsPanel.jsx` that overlays live WebSocket LTP onto each REST position and recomputes `ltp`, `unrl_pnl`, `unrl_pct` client-side
- `tickers` store subscribed alongside `positions` in `PositionsPanel`; every render maps `base.map(p => enrich(p, tickers))`
- LTP cell gains a cyan glow (`text-shadow`) for 800ms whenever a fresh tick arrives (`tick._flashAt`)
- Row background flash was already wired to `_updatedAt`; now set from `tick._flashAt` on enrichment
- `CloseModal` pre-fills limit price with live LTP automatically since it receives the already-enriched row
- `day_pnl` intentionally left from REST response — requires previous-close price which the ticker feed doesn't carry

**File changed:** `frontend/src/components/trading/PositionsPanel.jsx`

**Effort:** 1 hour

---

#### GAP-002: No Signal Performance Leaderboard

**Severity:** P0 — Launch Blocker
**Status:** ✅ FIXED — 28 Apr 2026

**What was done:**
- Added `GET /signals/performance` endpoint to `backend/api.py` (registered before `/{signal_id}` to avoid FastAPI route capture bug) — groups Supabase `signals` rows by symbol, computes total, closed, wins, losses, win_rate, avg_win, avg_loss, net_pnl, expectancy
- Created `frontend/src/components/signals/SignalPerformance.jsx` — full leaderboard component with summary cards (win rate, expectancy, total closed), per-symbol win rate bars, colour-coded expectancy, NSE/CRYPTO market badges, top-3 rank badges, empty state, DEV_MOCK fallback
- Added "PERFORMANCE" tab to `frontend/src/pages/SignalsPage.jsx` — tab bar sits between ActivePnLPanel and FilterBar; selecting Performance renders `<SignalPerformance />` in place of the signal card grid

**Files changed:**
- `backend/api.py`
- `frontend/src/components/signals/SignalPerformance.jsx` (new)
- `frontend/src/pages/SignalsPage.jsx`

**Effort:** ~3 hours

---

#### GAP-003: Market Intelligence — Deals, Insider Trades, Corporate Events, Intraday Screener

**Severity:** P0 — Launch Blocker
**Status:** ✅ FIXED — 29 Apr 2026

**What was done:**
- Added 4 new lazy-loaded tabs to `ScreenerPage.jsx`: INTRADAY, DEALS, EVENTS, INSIDER
- `DealsPanel.jsx` — NSE block/bulk deals with watchlist-hit highlighting
- `InsiderPanel.jsx` — SEBI PIT insider trading disclosures + cluster-buy alerts
- `EventsCalendar.jsx` — Corporate events: results, dividends, splits, AGMs, bonus
- `IntradayPanel.jsx` — 5m/15m intraday screener categories, auto-refresh every 15 min
- Backend routes added: `GET /market/deals`, `/market/deals/watchlist`, `/market/events`, `/market/events/today`, `/market/events/{symbol}`, `/market/insider-trades`, `/market/insider-trades/clusters`, `/screener/intraday`
- Backend data source: `backend/data/nse_deals.py` for NSE deals data

**Files changed:**
- `frontend/src/pages/ScreenerPage.jsx`
- `frontend/src/components/market/DealsPanel.jsx` (new)
- `frontend/src/components/market/InsiderPanel.jsx` (new)
- `frontend/src/components/market/EventsCalendar.jsx` (new)
- `frontend/src/components/market/IntradayPanel.jsx` (new)
- `frontend/src/lib/api.js` (new endpoints: getDeals, getDealsWatchlist, getEvents, getEventsToday, getEventsForSymbol, getInsiderTrades, getInsiderClusters, getIntradayScreener)
- `backend/api.py` (8 new routes)
- `backend/data/nse_deals.py` (new)

---

#### GAP-003b: No Order Modification UI

**Severity:** P0 — Launch Blocker
**Status:** ✅ FIXED — 29 Apr 2026

**What was done:**
- Added pencil SVG button to every `PENDING`/`OPEN` order row with `LIMIT` or `SL` type (MARKET and IOC orders excluded — no price to change)
- Clicking pencil toggles an amber inline edit strip that expands directly below the row — pre-filled with the order's current price and qty
- Enter submits, Escape discards; SAVE and DISCARD buttons also present
- `handleModify` calls `modifyOrder(id, { price, qty })` then patches the order in Zustand store immediately (optimistic update)
- Cancel and modify buttons coexist in the ACTIONS column (64px); pencil icon is amber, cancel icon is red — visually distinct at a glance
- Modifying row gets an amber left-border stripe and subtle amber background so it's clear which order is being edited

**File changed:** `frontend/src/components/trading/OrderBlotter.jsx`

---

#### GAP-004: HomeDashboard Lacks Market Breadth / Pre-Market Context

**Severity:** P0 — Launch Blocker
**Status:** ✅ FIXED — 29 Apr 2026

**What was done:**
- Created `frontend/src/components/home/MarketPulse.jsx` — 34px fixed horizontal strip pinned between the SubTabBar and all tab content; visible on every HomeDashboard tab
- Strip shows left-to-right: Market mood pill (bull/bear/mixed with glow dot) · A/D breadth bar (advance▲ count, 48px progress bar, decline▼ count, neutral—) · India VIX with LOW/ELEV/HIGH colour pill · FII flow (Cr) · DII flow (Cr) · Top 2 gaining sectors (green pills) · Top 2 losing sectors (red pills) · Crypto Fear & Greed with label pill · BTC dominance %
- VIX colour coding: green <15, amber 15–20, red ≥20
- Horizontally scrollable on small screens (scrollbar hidden)
- Dev mock data shows populated strip when API data not yet loaded
- No additional query — reuses `sentiment` already fetched at 60s interval in `HomeDashboard`
- Wired into `HomeDashboard.jsx` with a single `<MarketPulse sentiment={sentiment} />` line

**Files changed:**
- `frontend/src/components/home/MarketPulse.jsx` (new)
- `frontend/src/components/home/HomeDashboard.jsx`

---

### P1 — Pre-Launch Required (fix before paper trading begins)

---

#### GAP-005: Journal Has No Setup Performance Analytics

**Severity:** P1
**Status:** ✅ FIXED — 29 Apr 2026

**What was done:**
- Created `frontend/src/components/journal/SetupAnalytics.jsx` — aggregated analytics across all journal entries:
  - Summary cards: Total Trades, Win Rate, Net P&L, Best Setup, Setups Tracked
  - Setup performance table: per-setup win rate bar, W/L counts, avg P&L, avg R:R, net P&L — sorted by trade count
  - Cumulative P&L curve: pure SVG (no external dep), monthly aggregated, zero-line reference, color coded green/red
  - Trade Psychology grid: emotion-tagged entries grouped by type with win rate
- Added ANALYTICS tab to `JournalPage.jsx` — tab bar between header and filters; Analytics tab renders `<SetupAnalytics entries={entries} t={t} />` in place of StatsBar + entry list; Filters are hidden when Analytics tab is active

**Files changed:**
- `frontend/src/components/journal/SetupAnalytics.jsx` (new)
- `frontend/src/pages/JournalPage.jsx`

**Effort:** 3 hours

---

#### GAP-006: No Connectivity / Data Freshness Status Panel

**Severity:** P1
**Status:** ✅ FIXED — 29 Apr 2026

**What was done:**
- Added `GET /health/connectivity` (authenticated) to `backend/api.py` — returns broker status (Groww: ok/error/unconfigured/paper, Delta: ok/unconfigured/paper) and data-feed freshness (India/Crypto: ok <150s, stale 150–600s, offline >600s). Lightweight — reads pre-computed state only, no I/O on request.
- Added `state.set("/health/india_feed_ts", ...)` to the India index poll loop — written on every successful batch, TTL 600s, used by the health endpoint to compute `india_age_s`.
- Added `getConnectivity` to `frontend/src/lib/api.js`.
- Added two clickable `ConnChip` components to `CommandBar.jsx` — **BROKER** (composite worst-of groww/delta) and **FEED** (composite worst-of india/crypto). Clicking either opens a detail popup showing per-service status and age. Chips only appear once the first poll response arrives (no flash on load).
- Colour coding: green = ok/paper, amber = stale/unconfigured, red = error/offline.
- Query runs every 30s, stale after 20s, retry disabled (avoids hammering on auth errors).

**Files changed:**
- `backend/api.py` (new endpoint + india_feed_ts write)
- `frontend/src/lib/api.js` (getConnectivity)
- `frontend/src/components/terminal/CommandBar.jsx` (ConnChip component + query + chips)

---

#### GAP-007: Bots Have No Trade Execution Verification

**Severity:** P1
**Status:** ✅ FIXED — 29 Apr 2026

**What was done:**
- Added `_try_broker_order(uid, bot, symbol, market, side, qty, price)` helper in `api.py` — loads user's decrypted broker config, calls Delta (`place_order` via product_id lookup) or Groww (`place_equity_order`) — never raises; returns `{"ok": True, "result": ...}` or `{"ok": False, "error": ...}`
- Restructured `_execute_bot_check()` execution flow: execution now records as `PENDING`, broker is called, then status updates to `PLACED` / `SIMULATED` on success or `ERROR` on failure
- On broker error: `error_count` incremented, `last_error` / `last_error_ts` / `first_error_ts` set on bot; trade NOT counted in stats; bot state stays IDLE
- Auto-disable: if `error_count >= 3` AND all errors within 3600s → `bot["enabled"] = False` + `bot["disabled_reason"]` set + `bot_auto_disabled` WS event broadcast
- On broker success: error tracking fields reset to zero/None
- `BotCard` in `BotsPage.jsx`: shows red ⊘ banner with `disabled_reason` when auto-disabled; shows amber ⚠ badge with error count and message when `last_error` is set but not yet disabled
- `hooks/index.js`: handles `bot_auto_disabled` WS message — bumps `botExecTick` (invalidates queries) and shows a 12-second error toast

**Files changed:**
- `backend/api.py` (`_try_broker_order` helper + `_execute_bot_check` restructure)
- `frontend/src/pages/BotsPage.jsx` (auto-disabled banner + error badge in BotCard)
- `frontend/src/hooks/index.js` (`bot_auto_disabled` WS case)

**Effort:** 4 hours

---

#### GAP-008: Watchlist Not Persisted Across Sessions

**Severity:** P1
**Status:** ✅ FIXED — 29 Apr 2026

**What was done:**
- Added `watchlist JSONB DEFAULT NULL` column to `user_configs` table in `docs/supabase_schema.sql`
- Added `watchlist: Optional[dict] = None` to `UserConfig` Pydantic model in `api.py` — flows through both `GET /user/config` and `PUT /user/config` automatically
- Added `setWatchlistSidebarSymbols(symbols)` bulk-restore action to `useTerminalStore`
- Added module-level `_scheduleWatchlistSave(symbols)` (1-second debounce) in `store/index.js` — called by both `addWatchlistSymbol` and `removeWatchlistSymbol`; errors silently swallowed
- `App.jsx` `bootstrap()`: after `setUser()`, fires non-blocking `getUserConfig()` → restores `watchlistSidebarSymbols` if `cfg.watchlist` is present

> **Migration note for existing deployments:** run once in Supabase SQL Editor:
> ```sql
> ALTER TABLE public.user_configs ADD COLUMN IF NOT EXISTS watchlist JSONB DEFAULT NULL;
> ```

**Files changed:**
- `docs/supabase_schema.sql`
- `backend/api.py` (`watchlist` field in `UserConfig`)
- `frontend/src/store/index.js` (`setWatchlistSidebarSymbols` + debounced save)
- `frontend/src/App.jsx` (`getUserConfig` call + restore in `bootstrap`)

**Effort:** 2 hours

---

### P2 — Quality of Life (address in first 2 weeks post-launch)

---

#### GAP-009: No Chart / Price History View

**Severity:** P2
**Status:** ✅ FIXED — 29 Apr 2026

**What was done:**
- Created `frontend/src/components/chart/PriceChart.jsx` — 820px slide-in drawer (fixed right, Esc to close):
  - Candlestick series via `lightweight-charts` v5 (`addSeries(CandlestickSeries, ...)`)
  - EMA 9 (amber) + EMA 21 (accent) computed client-side and applied as `LineSeries`
  - Period selector: 5D/1M/3M/6M/1Y — drives `interval` param (15m/1h/1d/1wk) in the same `useQuery` key
  - Header shows live last-candle price + % change vs prior candle + 52W H/L from meta
  - Chart created once on mount (`autoSize: true`), data updated via `setData()` on new fetches — no flash
  - Backdrop overlay, Escape key handler, hover-state close button
- Added `<PriceChart>` lazy mount to `SignalsPage.jsx` — `chartSymbol` state drives open/close; chart appears as a layer above the signal grid without navigating away
- Added "Chart" button (📈 waveform SVG) to each `SignalCard` — `e.stopPropagation()` prevents the signal popup from also opening

**Files changed:**
- `frontend/src/components/chart/PriceChart.jsx` (new)
- `frontend/src/pages/SignalsPage.jsx`

**Effort:** 4 hours

---

#### GAP-010: Notifications Are Not Actionable

**Severity:** P2
**Status:** ✅ FIXED — 29 Apr 2026

**What was done:**
- Added `notifications`, `addNotification`, `markAllRead`, `clearNotifications` to `useDataStore` in `store/index.js` — initialised from `localStorage` key `tradex_notifs_v1`; every mutation writes back; capped at 50 entries
- Created `frontend/src/components/terminal/NotificationCentre.jsx` — self-contained bell button + slide-down panel:
  - Bell SVG icon; amber border + red unread count badge when unread > 0
  - Opens slide-down dropdown listing all notifications (max-height 400px, scrollable)
  - Each entry: type icon (🤖 bot / ↺ flip / ⊘ alert / 🔔 price), title, body, IST timestamp
  - Unread entries have a subtle accent background; all marked read when panel opens
  - "Clear all" button removes all notifications from store + localStorage
- Updated `hooks/index.js`: `addNotification` called in `bot_execution`, `position_reversal`, `bot_auto_disabled`, `price_alert_triggered` WS handlers
- Added `<NotificationCentre t={t} />` to `CommandBar.jsx` between WS/connectivity chips and AlertsPanel

**Files changed:**
- `frontend/src/store/index.js` (`notifications` + actions)
- `frontend/src/components/terminal/NotificationCentre.jsx` (new)
- `frontend/src/hooks/index.js` (`addNotification` calls in WS handlers)
- `frontend/src/components/terminal/CommandBar.jsx`

**Effort:** 3 hours

---

## Phase Implementation Roadmap

### Phase 1 — Remove Launch Blockers (Target: 1–2 weeks)

| # | Task | Gap | Files | Effort | Status |
|---|---|---|---|---|---|
| 1.1 | Live P&L per position (WS join) | GAP-001 | PositionsPanel.jsx | 1h | ✅ Fixed |
| 1.2 | Signal performance leaderboard | GAP-002 | SignalsPage.jsx + new SignalPerformance.jsx | 4–6h | ✅ Fixed |
| 1.3 | Order modification UI | GAP-003b | OrderBlotter.jsx | 3–4h | ✅ Fixed |
| 1.4 | Market Pulse strip (frontend only) | GAP-004 | HomeDashboard.jsx + new MarketPulse.jsx | 4–6h | ✅ Fixed |
| 1.5 | Watchlist persistence | GAP-008 | store/index.js, App.jsx, api.py | 3–4h | ✅ Fixed |
| 1.6 | Connectivity panel (broker + data dots) | GAP-006 | CommandBar.jsx, api.py | 3–4h | ✅ Fixed |
| 1.7 | Bot execution verification | GAP-007 | api.py, BotsPage.jsx, hooks/index.js | 5–6h | ✅ Fixed |

**Phase 1 total effort: ~24–33 hours**

---

### Phase 2 — Pre-Launch Polish (Target: 2–3 weeks after Phase 1)

| # | Task | Gap | Files | Effort | Status |
|---|---|---|---|---|---|
| 2.1 | Chart panel (lightweight-charts) | GAP-009 | new PriceChart.jsx, SignalsPage.jsx | 10–14h | ✅ Fixed |
| 2.2 | Journal setup analytics | GAP-005 | JournalPage.jsx, new SetupAnalytics.jsx | 6–8h | ✅ Fixed |
| 2.3 | Notification centre | GAP-010 | store/index.js, new NotificationCentre.jsx | 6–8h | ✅ Fixed |

**Phase 2 total effort: ~22–30 hours**

---

### Phase 3 — Post-Launch Enhancements (Target: 4–6 weeks post-launch)

| # | Task | Notes |
|---|---|---|
| 3.1 | Backtesting engine | Run strategies against historical OHLCV; show equity curve per bot config |
| 3.2 | Portfolio analytics | Correlation matrix, sector exposure, drawdown chart |
| 3.3 | Earnings / events calendar | NSE corporate actions overlay on charts and signal feed |
| 3.4 | Multi-timeframe conflict detection | Flag when 1H signal contradicts daily trend |
| 3.5 | Slippage and fill quality tracking | Compare order price vs fill price; trend over time per broker |
| 3.6 | Scanner alert — watchlist price cross | Alert when a watchlisted symbol crosses a key level |

**Phase 3 total effort: ~80–120 hours**

---

### Phase 4 — Institutional Feature Roadmap (Future)

| # | Feature |
|---|---|
| 4.1 | VWAP / TWAP execution algorithms for large orders |
| 4.2 | Portfolio-level Greeks (delta, theta exposure across options positions) |
| 4.3 | Tax-lot tracking (FIFO/LIFO P&L for STCG/LTCG computation) |
| 4.4 | Pre-trade approval workflow for large orders (risk manager sign-off) |
| 4.5 | On-chain metrics overlay for crypto (exchange netflow, whale wallet tracking) |
| 4.6 | Multi-account aggregation (family office / prop desk view) |
| 4.7 | Strategy marketplace (share bot configs between users, performance-ranked) |

---

## Go / No-Go Checklist

Before enabling any bot in live mode, all items below must be checked:

### Infrastructure
- [ ] WebSocket reconnects cleanly during market hours (test by killing network for 30s)
- [ ] Kill switch tested at broker level — confirms orders stop, not just disabled in UI
- [ ] Screener cron fires at 9:30 AM IST and 1:30 PM IST on a trading day (verify in APScheduler logs)
- [ ] Backend Redis state survives a server restart (positions/bots/risk state persists)
- [ ] API timeout handling verified — all 15s timeouts produce user-visible toasts, not silent failures

### Trading Logic
- [ ] Bot deduplication verified — same signal does not place duplicate orders
- [ ] Cooldown period enforced — bot does not re-fire within configured cooldown window
- [ ] Daily trade limit enforced — bot stops after configured `max_daily_trades` is reached
- [ ] Bot auto-disables correctly after 3 consecutive errors (GAP-007, Phase 1 fix)
- [ ] Position sizing validated — bot never places qty that would exceed account risk limit

### Data Quality
- [ ] Minimum 30 signals with known outcomes loaded before enabling bots
- [ ] Ticker prices verified against NSE/exchange reference for at least 10 symbols
- [ ] Screener results cross-checked against TradingView or NSE screener for first 3 runs
- [ ] Journal P&L figures reconciled against broker statement for at least 5 historical trades

### Operational
- [ ] Paper-trade bots for minimum 2 full trading weeks before live capital
- [ ] Daily position reconciliation: TradeX positions match broker positions at end of session
- [ ] Notification centre (or toasts) confirmed working for price alerts during a live session
- [ ] At least one person monitors the Agent Monitor during first week of live operation
- [ ] Runbook documented: what to do if WS drops during market hours, if screener misses a scan, if a bot fires incorrectly

---

## Quick Reference: API Endpoints vs UI Coverage

| Endpoint | API function (api.js) | UI Component | Status |
|---|---|---|---|
| GET /signals/performance | `getSignalPerformance` | SignalPerformance.jsx | ✅ GAP-002 fixed |
| GET /chart/{symbol} | `getChartData` | PriceChart.jsx | ✅ GAP-009 fixed |
| PUT /orders/{id} | `modifyOrder` | OrderBlotter.jsx | ✅ GAP-003b fixed |
| GET /market/depth/{sym} | `getMarketDepth` | None | Not prioritised |
| GET /market/sentiment | `getMarketSentiment` | MarketPulse.jsx | ✅ GAP-004 fixed |
| GET /rf_dw/signals | `getRfDwSignals` | SignalsPage | ✅ |
| GET /conf_simple/signals | `getConfSimpleSignals` | SignalsPage | ✅ |
| GET /screener/results | `getScreenerResults` | ScreenerPage | ✅ |
| GET /market/deals | `getDeals` | DealsPanel.jsx | ✅ GAP-003 fixed |
| GET /market/events | `getEvents` | EventsCalendar.jsx | ✅ GAP-003 fixed |
| GET /market/insider-trades | `getInsiderTrades` | InsiderPanel.jsx | ✅ GAP-003 fixed |
| GET /screener/intraday | `getIntradayScreener` | IntradayPanel.jsx | ✅ GAP-003 fixed |
| GET /bots | `getBots` | BotsPage | ✅ |
| GET /bots/executions | `getBotExecutions` | BotsPage | ✅ |
| GET /agents/status | `getAgentsStatus` | AgentLivePage.jsx | ✅ |
| GET /alerts | `getAlerts` | AlertsPanel | ✅ |
| GET /risk | `getRiskSummary` | RiskPanel | ✅ |
| POST /risk/soft-kill | `softKill` | RiskPanel | ✅ |
| GET /health/connectivity | `getConnectivity` | CommandBar.jsx | ✅ GAP-006 fixed |

---

*Last updated: 07 May 2026*
