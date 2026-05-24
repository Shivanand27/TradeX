// src/pages/DocsPage.jsx
// Platform documentation — accessible via Profile → Docs or /docs command.

import { useState, useRef, useEffect } from 'react'
import { useTheme, useTerminalStore } from '../store'

// ── Section registry ──────────────────────────────────────────────
const SECTIONS = [
  { id: 'getting-started',  label: 'Getting Started',         icon: '▶' },
  { id: 'command-palette',  label: 'Command Palette',         icon: '⌘' },
  { id: 'keyboard',         label: 'Keyboard Shortcuts',      icon: '⌨' },
  { id: 'dashboard',        label: 'Dashboard',               icon: '⬛' },
  { id: 'signals',          label: 'Signals',                 icon: '◈' },
  { id: 'agents',           label: 'AI Agent Pipeline',       icon: '◉' },
  { id: 'screener',         label: 'Screener',                icon: '⊞' },
  { id: 'trades',           label: 'Orders & Positions',      icon: '◷' },
  { id: 'risk',             label: 'Risk Management',         icon: '⚡' },
  { id: 'bots',             label: 'Trading Bots',            icon: '⟳' },
  { id: 'alerts',           label: 'Price Alerts',            icon: '◎' },
  { id: 'intel',            label: 'Intel / News Feed',       icon: '◈' },
  { id: 'feeds',            label: 'Market Feeds',            icon: '⬤' },
  { id: 'settings',         label: 'Settings & Brokers',      icon: '⚙' },
]

// ── Primitives ────────────────────────────────────────────────────
function SectionHeading({ children, t }) {
  return (
    <div style={{
      fontSize: 16, fontWeight: 700, color: t.text, fontFamily: t.fontUI,
      marginBottom: 4,
    }}>
      {children}
    </div>
  )
}

function Sub({ children, t }) {
  return (
    <p style={{
      fontSize: 13, color: t.textMuted, fontFamily: t.fontUI,
      lineHeight: 1.7, margin: '0 0 16px',
    }}>
      {children}
    </p>
  )
}

function Card({ children, t, accent }) {
  return (
    <div style={{
      background: t.bgCard, border: `1px solid ${accent ? accent + '30' : t.border}`,
      borderRadius: t.radiusLg, padding: '16px 20px', marginBottom: 12,
      borderLeft: accent ? `3px solid ${accent}` : undefined,
    }}>
      {children}
    </div>
  )
}

function KbdKey({ k, t }) {
  return (
    <span style={{
      display: 'inline-block', padding: '2px 7px', borderRadius: 4,
      background: t.bgPanel, border: `1px solid ${t.borderStrong}`,
      fontSize: 11, fontFamily: t.font, color: t.accent,
      boxShadow: `0 1px 0 ${t.border}`,
    }}>
      {k}
    </span>
  )
}

function KbdRow({ keys, desc, t }) {
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 8,
      padding: '8px 0', borderBottom: `1px solid ${t.border}`,
    }}>
      <div style={{ display: 'flex', gap: 4, minWidth: 120, flexShrink: 0 }}>
        {keys.map(k => <KbdKey key={k} k={k} t={t} />)}
      </div>
      <span style={{ fontSize: 12, color: t.textMuted, fontFamily: t.fontUI }}>{desc}</span>
    </div>
  )
}

function Pill({ label, color, t }) {
  return (
    <span style={{
      display: 'inline-block', padding: '1px 8px', borderRadius: 20,
      fontSize: 10, fontWeight: 600, fontFamily: t.font,
      background: `${color}18`, color, border: `1px solid ${color}30`,
      marginRight: 4,
    }}>
      {label}
    </span>
  )
}

function StepList({ steps, t }) {
  return (
    <ol style={{ margin: '8px 0 16px', paddingLeft: 0, listStyle: 'none', display: 'flex', flexDirection: 'column', gap: 8 }}>
      {steps.map((step, i) => (
        <li key={i} style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
          <span style={{
            flexShrink: 0, width: 22, height: 22, borderRadius: '50%',
            background: t.accentBg, border: `1px solid ${t.accent}40`,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontSize: 10, fontWeight: 700, color: t.accent, fontFamily: t.font,
          }}>
            {i + 1}
          </span>
          <span style={{ fontSize: 13, color: t.textMuted, fontFamily: t.fontUI, lineHeight: 1.6, paddingTop: 2 }}>
            {step}
          </span>
        </li>
      ))}
    </ol>
  )
}

function Table({ headers, rows, t }) {
  return (
    <div style={{ overflowX: 'auto', marginBottom: 16 }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12, fontFamily: t.fontUI }}>
        <thead>
          <tr style={{ background: t.bgPanel }}>
            {headers.map(h => (
              <th key={h} style={{
                padding: '8px 12px', textAlign: 'left',
                color: t.accent, fontSize: 10, fontWeight: 600, letterSpacing: '0.05em',
                borderBottom: `1px solid ${t.border}`,
              }}>
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={i} style={{ borderBottom: `1px solid ${t.border}` }}>
              {row.map((cell, j) => (
                <td key={j} style={{ padding: '8px 12px', color: j === 0 ? t.text : t.textMuted, verticalAlign: 'top' }}>
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

// ── Section components ────────────────────────────────────────────
function GettingStarted({ t }) {
  return (
    <>
      <SectionHeading t={t}>Getting Started</SectionHeading>
      <Sub t={t}>
        TradeX is a multi-market trading intelligence terminal for Indian equities (NSE/BSE) and
        crypto perpetuals (Delta Exchange India). It combines real-time market data, an AI analysis
        pipeline, rule-based scanners, and broker integration into a single interface.
      </Sub>

      <Card t={t} accent={t.bull}>
        <div style={{ fontSize: 12, fontWeight: 600, color: t.bull, marginBottom: 8, fontFamily: t.fontUI }}>
          Quick Setup — 4 steps
        </div>
        <StepList t={t} steps={[
          'Open Settings (F9 or /settings) and enter your Groww API key + TOTP secret for Indian stocks.',
          'Add your Delta Exchange India API key and secret for crypto perpetuals. Enable Paper Trading to start without real money.',
          'Configure your Telegram Chat ID to receive signal alerts, stop-loss hits, and the daily summary.',
          'Set capital limits: Groww Max % and Delta Max % control how much of your total capital any single trade can deploy.',
        ]} />
      </Card>

      <Card t={t}>
        <div style={{ fontSize: 12, fontWeight: 600, color: t.text, marginBottom: 10, fontFamily: t.fontUI }}>
          What runs automatically
        </div>
        <Table t={t}
          headers={['Component', 'Frequency', 'Description']}
          rows={[
            ['India Market Data', 'Every 5 min (market hours)', 'Live price data for your watchlist via Groww'],
            ['India Analysis Pipeline', '09:30 IST daily', 'Chart patterns → Fundamentals (weekly) → News sentiment'],
            ['Delta Snapshot', 'Every 15 min, 24/7', 'Crypto funding rates, open interest, mark prices'],
            ['RF[DW] Scanner', 'Every 3 min, 24/7', 'Rule-based crypto momentum scanner'],
            ['Conf Signals', 'Every 5 min, 24/7', 'Multi-indicator confirmation scanner'],
            ['Stock Screener', 'Twice daily (09:30, 13:30)', 'NSE-wide pattern and momentum screen'],
            ['Risk Guardian', 'Continuous', 'Monitors portfolio exposure and enforces kill switches'],
          ]}
        />
      </Card>
    </>
  )
}

function CommandPalette({ t }) {
  return (
    <>
      <SectionHeading t={t}>Command Palette</SectionHeading>
      <Sub t={t}>
        The search box at the top of every page is a command palette. Type a symbol or a slash
        command and press Enter. Suggestions appear as you type.
      </Sub>
      <Card t={t}>
        <div style={{ fontSize: 12, fontWeight: 600, color: t.text, marginBottom: 10, fontFamily: t.fontUI }}>
          Slash navigation commands
        </div>
        <Table t={t}
          headers={['Command', 'Goes to']}
          rows={[
            ['/home', 'Dashboard'],
            ['/signals', 'Signals page'],
            ['/orders', 'Orders page'],
            ['/pos', 'Positions'],
            ['/risk', 'Risk panel'],
            ['/news', 'Intel / News feed'],
            ['/bots', 'Trading Bots'],
            ['/users', 'User management (admin)'],
            ['/settings', 'Settings'],
            ['/docs', 'This documentation page'],
            ['/logout', 'Sign out'],
            ['/help', 'Show available commands (toast)'],
          ]}
        />
      </Card>
      <Card t={t} accent={t.accent}>
        <div style={{ fontSize: 12, fontWeight: 600, color: t.accent, marginBottom: 8, fontFamily: t.fontUI }}>
          Symbol search
        </div>
        <Sub t={t}>
          Type any ticker (e.g. <code style={{ color: t.cyan, fontFamily: t.font }}>RELIANCE</code> or{' '}
          <code style={{ color: t.cyan, fontFamily: t.font }}>BTCUSD</code>) and press Enter to open
          its signal detail panel. The search matches against all active signals in the current session.
          Autocomplete shows up to 5 matching results.
        </Sub>
      </Card>
    </>
  )
}

function KeyboardShortcuts({ t }) {
  return (
    <>
      <SectionHeading t={t}>Keyboard Shortcuts</SectionHeading>
      <Sub t={t}>All shortcuts are global — they work from any page without clicking first.</Sub>
      <Card t={t}>
        <div style={{ fontSize: 11, color: t.textDim, fontFamily: t.fontUI, marginBottom: 12, fontWeight: 600 }}>
          PAGE NAVIGATION
        </div>
        <KbdRow t={t} keys={['F1']} desc="Dashboard (Home)" />
        <KbdRow t={t} keys={['F2']} desc="Signals" />
        <KbdRow t={t} keys={['F3']} desc="Screener" />
        <KbdRow t={t} keys={['F4']} desc="Orders & Positions" />
        <KbdRow t={t} keys={['F5']} desc="Risk Panel" />
        <KbdRow t={t} keys={['F6']} desc="Intel / News Feed" />
        <KbdRow t={t} keys={['F7']} desc="Trading Bots" />
        <KbdRow t={t} keys={['F8']} desc="User Management (admin only)" />
        <KbdRow t={t} keys={['F9']} desc="Settings" />
      </Card>
      <Card t={t}>
        <div style={{ fontSize: 11, color: t.textDim, fontFamily: t.fontUI, marginBottom: 12, fontWeight: 600 }}>
          ACTIONS
        </div>
        <KbdRow t={t} keys={['Ctrl', 'O']} desc="Open order ticket (quick order entry)" />
        <KbdRow t={t} keys={['Esc']} desc="Clear command bar / close popups" />
        <KbdRow t={t} keys={['Enter']} desc="Execute command in the search bar" />
      </Card>
    </>
  )
}

function Dashboard({ t }) {
  return (
    <>
      <SectionHeading t={t}>Dashboard</SectionHeading>
      <Sub t={t}>
        The dashboard (F1) is the main overview. It combines live market data, portfolio status,
        signals, and news into a single view.
      </Sub>
      <Card t={t}>
        <div style={{ fontSize: 12, fontWeight: 600, color: t.text, marginBottom: 10, fontFamily: t.fontUI }}>
          Dashboard tabs
        </div>
        <Table t={t}
          headers={['Tab', 'Content']}
          rows={[
            ['OVERVIEW', 'NIFTY50 / SENSEX / BANKNIFTY indices, top GO signals, portfolio P&L, live news'],
            ['STOCKS', 'India watchlist prices, sector heat-map, NSE block/bulk deals, corporate events'],
            ['CRYPTO', 'Delta Exchange perps (BTC, ETH, SOL, BNB, AVAX, XRP) with funding rates and OI'],
            ['COMMODITIES', 'Gold, Silver, Crude Oil, DXY, USDINR live prices'],
          ]}
        />
      </Card>
      <Card t={t} accent={t.amber}>
        <div style={{ fontSize: 12, fontWeight: 600, color: t.amber, marginBottom: 8, fontFamily: t.fontUI }}>
          Status chips (top bar)
        </div>
        <Sub t={t}>
          The top bar shows live connection status at all times. Green = connected and fresh data.
          Yellow = stale (data is older than 2.5 min — normal after market close).
          Red = offline or error. Click any chip to see detailed age and sub-status.
        </Sub>
        <Table t={t}
          headers={['Chip', 'What it monitors']}
          rows={[
            ['WS', 'WebSocket connection to the backend — must be green for live ticks'],
            ['India Market Feed', 'NIFTY / SENSEX / VIX data freshness from yfinance'],
            ['Crypto Feed', 'Delta Exchange snapshot freshness'],
            ['Broker', 'Groww API connection (India) and Delta key presence (Crypto)'],
            ['KILL', 'Shown in red when a soft kill switch is active — all trading halted'],
          ]}
        />
      </Card>
    </>
  )
}

function Signals({ t }) {
  return (
    <>
      <SectionHeading t={t}>Signals</SectionHeading>
      <Sub t={t}>
        The Signals page (F2) shows all active trade setups generated by the three signal sources.
        Click any signal card to open its full detail panel with entry/stop/target and the AI
        reasoning behind the call.
      </Sub>
      <Card t={t}>
        <div style={{ fontSize: 12, fontWeight: 600, color: t.text, marginBottom: 10, fontFamily: t.fontUI }}>
          Signal sources
        </div>
        <Table t={t}
          headers={['Source', 'Badge', 'How it works', 'Frequency']}
          rows={[
            ['AI Agent Pipeline', <Pill key="a" label="AGENT" color={t.accent} t={t} />, 'Full chart pattern + fundamentals + sentiment analysis via LLM pipeline', 'Daily at 09:30 IST + on-demand'],
            ['RF[DW] Scanner', <Pill key="r" label="RF[DW]" color={t.cyan} t={t} />, 'Random Forest + Donchian-Williams breakout rule, zero LLM tokens', 'Every 3 min, 24/7'],
            ['Conf Signals', <Pill key="c" label="CONF[S]" color={t.amber} t={t} />, 'RSI + EMA + MACD + Volume confirmation, all four must agree', 'Every 5 min, 24/7'],
          ]}
        />
      </Card>
      <Card t={t}>
        <div style={{ fontSize: 12, fontWeight: 600, color: t.text, marginBottom: 10, fontFamily: t.fontUI }}>
          Verdict labels
        </div>
        <Table t={t}
          headers={['Verdict', 'Meaning']}
          rows={[
            [<Pill key="go" label="GO" color={t.bull} t={t} />, 'Strong conviction — entry conditions met, risk/reward favourable'],
            [<Pill key="wa" label="WATCH" color={t.amber} t={t} />, 'Setup forming — wait for confirmation before entry'],
            [<Pill key="sk" label="SKIP" color={t.textMuted} t={t} />, 'Pattern exists but conditions not favourable right now'],
            [<Pill key="ex" label="EXIT" color={t.bear} t={t} />, 'Active position — stop or target hit, consider closing'],
          ]}
        />
      </Card>
      <Card t={t} accent={t.bull}>
        <div style={{ fontSize: 12, fontWeight: 600, color: t.bull, marginBottom: 8, fontFamily: t.fontUI }}>
          Signal detail panel
        </div>
        <Sub t={t}>
          Click any signal to see: entry price, stop-loss, take-profit targets (R1/R2/R3),
          conviction score, chart pattern name, key levels, and the AI reasoning summary.
          Use the "Place Order" button in the panel to send directly to your broker.
        </Sub>
      </Card>
    </>
  )
}

function Agents({ t }) {
  return (
    <>
      <SectionHeading t={t}>AI Agent Pipeline</SectionHeading>
      <Sub t={t}>
        The Agents page shows the India Analysis Pipeline — three stages that run sequentially
        each trading day to build a complete view of every stock on your watchlist.
      </Sub>
      <Card t={t}>
        <div style={{ fontSize: 12, fontWeight: 600, color: t.text, marginBottom: 10, fontFamily: t.fontUI }}>
          Pipeline stages
        </div>
        <Table t={t}
          headers={['Stage', 'Agent', 'What it does', 'When it runs']}
          rows={[
            ['1', 'Chart Pattern Agent', 'Scans OHLCV data for 30+ candlestick and chart patterns, computes RSI/MACD/EMA/volume profile', 'Always'],
            ['2', 'Fundamentals Agent', 'Fetches P/E, P/B, EPS, debt ratios, promoter holding from NSE and Screener.in', 'Only when saved data is ≥ 7 days old'],
            ['3', 'Sentiment Agent', 'Pulls recent news headlines, scores sentiment, and generates the final signal with AI reasoning', 'Always'],
          ]}
        />
      </Card>
      <Card t={t} accent={t.accent}>
        <div style={{ fontSize: 12, fontWeight: 600, color: t.accent, marginBottom: 8, fontFamily: t.fontUI }}>
          Trigger button
        </div>
        <Sub t={t}>
          The pipeline runs automatically at 09:30 IST on trading days. You can also trigger it
          manually using the "Run Pipeline" button on the Agents page. The three stage nodes show
          live status (idle → running → complete/failed) as the pipeline executes. Logs from the
          last run are saved and shown even after page refresh.
        </Sub>
      </Card>
      <Card t={t}>
        <div style={{ fontSize: 12, fontWeight: 600, color: t.text, marginBottom: 10, fontFamily: t.fontUI }}>
          Other agents (always-on)
        </div>
        <Table t={t}
          headers={['Agent', 'Purpose', 'Interval']}
          rows={[
            ['Delta Snapshot', 'Crypto funding rates, OI, mark prices from Delta Exchange', '15 min'],
            ['Crypto Chart', 'Chart pattern scan for BTC/ETH/SOL/BNB/AVAX/XRP', '30 min'],
            ['Crypto Signals', 'Combined signal generation for all crypto instruments', '2 hours'],
            ['Stock Screener', 'NSE-wide momentum and breakout screen', 'Twice daily'],
            ['Intraday Screener', 'Short-term pattern scan during market hours', '15 min'],
          ]}
        />
      </Card>
    </>
  )
}

function Screener({ t }) {
  return (
    <>
      <SectionHeading t={t}>Screener</SectionHeading>
      <Sub t={t}>
        The Screener (F3) gives a broad market view across India stocks and crypto. It filters
        the entire NSE universe down to actionable setups using momentum, pattern, and
        volume criteria.
      </Sub>
      <Card t={t}>
        <div style={{ fontSize: 12, fontWeight: 600, color: t.text, marginBottom: 10, fontFamily: t.fontUI }}>
          Screener tabs
        </div>
        <Table t={t}
          headers={['Tab', 'What it shows']}
          rows={[
            ['All Markets', 'Combined results across India stocks and crypto'],
            ['India', 'NSE/BSE stocks passing the pattern + momentum filter'],
            ['Crypto', 'Crypto perps with breakout or reversal setups'],
            ['Intraday', 'Short-term setups updated every 15 min during market hours'],
          ]}
        />
      </Card>
      <Card t={t} accent={t.amber}>
        <div style={{ fontSize: 12, fontWeight: 600, color: t.amber, marginBottom: 8, fontFamily: t.fontUI }}>
          Refresh
        </div>
        <Sub t={t}>
          Results auto-refresh twice daily. Use the refresh button on the page to trigger
          an on-demand scan. RF[DW] and Conf Signals panels on the Signals page provide
          higher-frequency crypto screening (every 3–5 min).
        </Sub>
      </Card>
    </>
  )
}

function Trades({ t }) {
  return (
    <>
      <SectionHeading t={t}>Orders & Positions</SectionHeading>
      <Sub t={t}>
        The Trades page (F4) shows all open orders and active positions across both Groww
        (India equities) and Delta Exchange (crypto perps).
      </Sub>
      <Card t={t}>
        <div style={{ fontSize: 12, fontWeight: 600, color: t.text, marginBottom: 10, fontFamily: t.fontUI }}>
          Order types
        </div>
        <Table t={t}
          headers={['Type', 'Description']}
          rows={[
            ['MARKET', 'Execute immediately at best available price'],
            ['LIMIT', 'Execute only at the specified price or better'],
            ['SL', 'Stop-loss — triggers a market order when the trigger price is hit'],
            ['SL-M', 'Stop-loss market — triggers at the stop price, executes at market'],
          ]}
        />
      </Card>
      <Card t={t}>
        <div style={{ fontSize: 12, fontWeight: 600, color: t.text, marginBottom: 10, fontFamily: t.fontUI }}>
          Quick order entry
        </div>
        <Sub t={t}>
          Press <KbdKey k="Ctrl+O" t={t} /> or click the order ticket icon to open the quick
          entry panel. Pre-fill symbol, quantity, type, and price. The order goes directly to
          your configured broker (Groww for .NS symbols, Delta Exchange for crypto).
        </Sub>
      </Card>
      <Card t={t} accent={t.bull}>
        <div style={{ fontSize: 12, fontWeight: 600, color: t.bull, marginBottom: 8, fontFamily: t.fontUI }}>
          Position management
        </div>
        <Sub t={t}>
          Open positions show unrealised P&L, average price, and current LTP in real time via
          the WebSocket feed. Use "Close" to send a market close order. "Partial close" lets
          you specify a quantity to reduce the position without closing it fully.
        </Sub>
      </Card>
    </>
  )
}

function Risk({ t }) {
  return (
    <>
      <SectionHeading t={t}>Risk Management</SectionHeading>
      <Sub t={t}>
        The Risk panel (F5) shows the portfolio-level risk picture and lets you activate kill
        switches to halt all trading instantly.
      </Sub>
      <Card t={t} accent={t.bear}>
        <div style={{ fontSize: 12, fontWeight: 600, color: t.bear, marginBottom: 10, fontFamily: t.fontUI }}>
          Kill switches
        </div>
        <Table t={t}
          headers={['Switch', 'Effect']}
          rows={[
            ['Soft Kill', 'Blocks all new orders for all markets. Existing positions remain open.'],
            ['Crypto Kill', 'Blocks new crypto orders only.'],
            ['Shorts Kill', 'Blocks all new short/sell entries.'],
            ['Longs Kill', 'Blocks all new long/buy entries.'],
          ]}
        />
        <Sub t={t}>
          All kill switches are reversible. Each one requires a reason string for audit. The
          KILL badge in the top bar turns red when any switch is active.
        </Sub>
      </Card>
      <Card t={t}>
        <div style={{ fontSize: 12, fontWeight: 600, color: t.text, marginBottom: 10, fontFamily: t.fontUI }}>
          Exposure limits
        </div>
        <Table t={t}
          headers={['Limit', 'Where it is set', 'What it does']}
          rows={[
            ['Groww Max %', 'Settings → India', 'Max % of total capital in any single India trade'],
            ['Delta Max %', 'Settings → Crypto', 'Max % of total capital deployed in crypto at once'],
            ['Sector Exposure', 'Auto-computed', 'Risk Guardian warns when a single sector exceeds 30%'],
          ]}
        />
      </Card>
    </>
  )
}

function Bots({ t }) {
  return (
    <>
      <SectionHeading t={t}>Trading Bots</SectionHeading>
      <Sub t={t}>
        Bots (F7) automate signal-to-order execution. When a signal matches a bot's criteria,
        it places the order automatically on your behalf.
      </Sub>
      <Card t={t}>
        <div style={{ fontSize: 12, fontWeight: 600, color: t.text, marginBottom: 10, fontFamily: t.fontUI }}>
          Bot configuration
        </div>
        <Table t={t}
          headers={['Field', 'Description']}
          rows={[
            ['Name', 'Identifier for the bot — shown in execution logs'],
            ['Market', 'india, crypto, or both'],
            ['Signal Source', 'AGENT, RF[DW], CONF[S], or ALL'],
            ['Min Conviction', 'Only act on signals above this threshold (0–100)'],
            ['Max Capital %', 'Cap on capital per trade (overrides global limit)'],
            ['Verdict Filter', 'Only act on GO, or include WATCH setups'],
            ['Enabled', 'Toggle to pause/resume without deleting the bot'],
          ]}
        />
      </Card>
      <Card t={t} accent={t.amber}>
        <div style={{ fontSize: 12, fontWeight: 600, color: t.amber, marginBottom: 8, fontFamily: t.fontUI }}>
          Paper trading
        </div>
        <Sub t={t}>
          When Delta Paper Trading is enabled in Settings, all bot orders are simulated — no
          real money is deployed. Simulated executions still appear in the Trades page.
          Test bot configurations in paper mode before enabling live trading.
        </Sub>
      </Card>
    </>
  )
}

function Alerts({ t }) {
  return (
    <>
      <SectionHeading t={t}>Price Alerts</SectionHeading>
      <Sub t={t}>
        Price alerts notify you (via Telegram and in-app) when any symbol crosses a price
        level you set. Alerts work for both India stocks and crypto perps 24/7.
      </Sub>
      <Card t={t}>
        <StepList t={t} steps={[
          'Click the bell icon in the top bar or open the Alerts panel.',
          'Select a symbol, choose Above or Below, and enter the target price.',
          'When the price crosses the threshold, you receive an in-app notification and a Telegram message (if configured).',
          'Triggered alerts are marked as fired and do not re-trigger. Delete them to clean up the list.',
        ]} />
      </Card>
      <Card t={t} accent={t.accent}>
        <Sub t={t}>
          Alerts are checked every 30 seconds using the latest known LTP from the live WebSocket
          feed. They persist in the backend so they survive browser refreshes and reconnects.
        </Sub>
      </Card>
    </>
  )
}

function Intel({ t }) {
  return (
    <>
      <SectionHeading t={t}>Intel / News Feed</SectionHeading>
      <Sub t={t}>
        The Intel Feed (F6) aggregates macro news, earnings, regulatory updates, and geopolitical
        events. Each item is tagged with impact level and relevant market tickers.
      </Sub>
      <Card t={t}>
        <div style={{ fontSize: 12, fontWeight: 600, color: t.text, marginBottom: 10, fontFamily: t.fontUI }}>
          Filters
        </div>
        <Table t={t}
          headers={['Filter', 'Options']}
          rows={[
            ['Tab', 'ALL · INDIA · CRYPTO · MACRO · EARNINGS'],
            ['Timeframe', '1H · 4H · 24H · 7D'],
            ['Impact', 'ALL · HIGH · MEDIUM · LOW'],
          ]}
        />
      </Card>
      <Card t={t}>
        <div style={{ fontSize: 12, fontWeight: 600, color: t.text, marginBottom: 10, fontFamily: t.fontUI }}>
          Impact badges
        </div>
        <Table t={t}
          headers={['Badge', 'Meaning']}
          rows={[
            [<Pill key="h" label="HIGH" color={t.bear} t={t} />, 'Market-moving event — likely to cause significant price action'],
            [<Pill key="m" label="MEDIUM" color={t.amber} t={t} />, 'Sector or stock-level impact'],
            [<Pill key="l" label="LOW" color={t.textMuted} t={t} />, 'Background noise — context only, unlikely to move prices'],
          ]}
        />
      </Card>
    </>
  )
}

function Feeds({ t }) {
  return (
    <>
      <SectionHeading t={t}>Market Feeds</SectionHeading>
      <Sub t={t}>
        TradeX pulls live data from multiple sources. Understanding feed health helps you know
        when the data is fresh vs. delayed.
      </Sub>
      <Card t={t}>
        <div style={{ fontSize: 12, fontWeight: 600, color: t.text, marginBottom: 10, fontFamily: t.fontUI }}>
          Data sources
        </div>
        <Table t={t}
          headers={['Feed', 'Source', 'Symbols', 'Update rate']}
          rows={[
            ['India indices', 'yfinance', 'NIFTY50, BANKNIFTY, INDIAVIX, SENSEX, USDINR, DXY', '60s market hours · 5 min off-hours'],
            ['India LTP', 'Groww API', 'Your full watchlist', '1s during market hours (requires API key)'],
            ['Crypto perps', 'Delta Exchange India REST', 'BTCUSD, ETHUSD, SOLUSDT, BNBUSD, AVAXUSD, XRPUSD', '15 min (snapshot)'],
            ['News', 'NSE RSS · internal sentiment agent', 'All Indian equities', 'Runs with India pipeline (09:30 IST)'],
          ]}
        />
      </Card>
      <Card t={t} accent={t.amber}>
        <div style={{ fontSize: 12, fontWeight: 600, color: t.amber, marginBottom: 8, fontFamily: t.fontUI }}>
          Feed status meanings
        </div>
        <Table t={t}
          headers={['Status', 'Meaning']}
          rows={[
            ['OK (green)', 'Data received within the last 2.5 minutes'],
            ['STALE (yellow)', 'Data is 2.5–60 min old — normal during off-hours and weekends'],
            ['OFFLINE (red)', 'No data for over 60 minutes — check backend is running'],
          ]}
        />
      </Card>
    </>
  )
}

function Settings({ t }) {
  return (
    <>
      <SectionHeading t={t}>Settings & Brokers</SectionHeading>
      <Sub t={t}>
        Open Settings with F9 or <code style={{ color: t.cyan, fontFamily: t.font }}>/settings</code>.
        Your configuration is saved to the backend and synced across devices.
      </Sub>
      <Card t={t}>
        <div style={{ fontSize: 12, fontWeight: 600, color: t.text, marginBottom: 10, fontFamily: t.fontUI }}>
          India (Groww)
        </div>
        <Table t={t}
          headers={['Field', 'Where to get it', 'Required for']}
          rows={[
            ['API Key', 'Groww app → Profile → API', 'Live price data, order placement'],
            ['TOTP Secret', 'Groww → API access setup', 'Two-factor authentication for orders'],
            ['Capital (₹)', 'Your total portfolio size', 'Position sizing calculations'],
            ['Max Position %', 'Your risk preference (suggested: 5–10%)', 'Single-trade capital cap'],
          ]}
        />
      </Card>
      <Card t={t}>
        <div style={{ fontSize: 12, fontWeight: 600, color: t.text, marginBottom: 10, fontFamily: t.fontUI }}>
          Crypto (Delta Exchange India)
        </div>
        <Table t={t}
          headers={['Field', 'Where to get it', 'Required for']}
          rows={[
            ['API Key', 'Delta Exchange → Settings → API Keys', 'Order placement'],
            ['API Secret', 'Delta Exchange → Settings → API Keys', 'Order signing'],
            ['Paper Trading', 'Toggle in Settings', 'Simulate trades without real money'],
            ['Max Exposure %', 'Your risk preference (suggested: 20–30%)', 'Total crypto capital cap'],
          ]}
        />
      </Card>
      <Card t={t} accent={t.accent}>
        <div style={{ fontSize: 12, fontWeight: 600, color: t.accent, marginBottom: 8, fontFamily: t.fontUI }}>
          Telegram notifications
        </div>
        <StepList t={t} steps={[
          'Create a Telegram bot via @BotFather and copy the bot token.',
          'Add the bot to a private channel or group, then get the Chat ID.',
          'Enter the Chat ID in Settings → Notifications.',
          'Enable the alert types you want: Signals, Stop hits, News, Daily summary.',
        ]} />
      </Card>
    </>
  )
}

// ── Map section id → component ────────────────────────────────────
const SECTION_MAP = {
  'getting-started': GettingStarted,
  'command-palette': CommandPalette,
  'keyboard':        KeyboardShortcuts,
  'dashboard':       Dashboard,
  'signals':         Signals,
  'agents':          Agents,
  'screener':        Screener,
  'trades':          Trades,
  'risk':            Risk,
  'bots':            Bots,
  'alerts':          Alerts,
  'intel':           Intel,
  'feeds':           Feeds,
  'settings':        Settings,
}

// ── Main component ────────────────────────────────────────────────
export default function DocsPage() {
  const t = useTheme()
  const [active, setActive] = useState('getting-started')
  const contentRef = useRef(null)
  const sectionRefs = useRef({})

  // Register a ref for each section
  function getSectionRef(id) {
    if (!sectionRefs.current[id]) sectionRefs.current[id] = { current: null }
    return sectionRefs.current[id]
  }

  function scrollTo(id) {
    setActive(id)
    const el = sectionRefs.current[id]?.current
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }

  // Intersection observer — update active nav item while scrolling
  useEffect(() => {
    const container = contentRef.current
    if (!container) return

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            setActive(entry.target.dataset.section)
          }
        }
      },
      { root: container, threshold: 0.15 }
    )

    Object.values(sectionRefs.current).forEach(ref => {
      if (ref.current) observer.observe(ref.current)
    })

    return () => observer.disconnect()
  }, [])

  const ActiveSection = SECTION_MAP[active] || GettingStarted

  return (
    <div style={{
      display: 'flex', height: '100%', overflow: 'hidden',
      background: t.bg, fontFamily: t.fontUI,
    }}>

      {/* ── Left nav ──────────────────────────────────────────── */}
      <div style={{
        width: 220, flexShrink: 0,
        borderRight: `1px solid ${t.border}`,
        background: t.bgPanel,
        display: 'flex', flexDirection: 'column',
        overflow: 'hidden',
      }}>
        {/* Header */}
        <div style={{
          padding: '14px 16px 10px',
          borderBottom: `1px solid ${t.border}`,
        }}>
          <div style={{ fontSize: 9, color: t.accent, fontFamily: t.font, fontWeight: 600, letterSpacing: '0.08em', marginBottom: 4 }}>
            TRADEX DOCS
          </div>
          <div style={{ fontSize: 13, fontWeight: 700, color: t.text }}>
            Platform Guide
          </div>
        </div>

        {/* Nav items */}
        <div style={{ overflowY: 'auto', flex: 1, padding: '8px 0' }}>
          {SECTIONS.map(s => {
            const isActive = active === s.id
            return (
              <button
                key={s.id}
                onClick={() => scrollTo(s.id)}
                style={{
                  display: 'flex', alignItems: 'center', gap: 9,
                  width: '100%', padding: '7px 16px',
                  background: isActive ? t.accentBg : 'none',
                  border: 'none',
                  borderLeft: `2px solid ${isActive ? t.accent : 'transparent'}`,
                  cursor: 'pointer', textAlign: 'left',
                  transition: 'background 0.1s',
                }}
                onMouseEnter={e => { if (!isActive) e.currentTarget.style.background = t.bgCard }}
                onMouseLeave={e => { if (!isActive) e.currentTarget.style.background = 'none' }}
              >
                <span style={{ fontSize: 11, color: isActive ? t.accent : t.textDim, width: 14, textAlign: 'center', flexShrink: 0 }}>
                  {s.icon}
                </span>
                <span style={{ fontSize: 12, color: isActive ? t.accent : t.textMuted, fontFamily: t.fontUI, fontWeight: isActive ? 600 : 400 }}>
                  {s.label}
                </span>
              </button>
            )
          })}
        </div>

        {/* Footer */}
        <div style={{ padding: '12px 16px', borderTop: `1px solid ${t.border}` }}>
          <div style={{ fontSize: 10, color: t.textDim, fontFamily: t.fontUI }}>
            TradeX v3 · Platform docs
          </div>
        </div>
      </div>

      {/* ── Content area ──────────────────────────────────────── */}
      <div ref={contentRef} style={{ flex: 1, overflowY: 'auto', padding: '32px 40px', maxWidth: 820 }}>
        {SECTIONS.map(s => {
          const Comp = SECTION_MAP[s.id]
          return (
            <div
              key={s.id}
              ref={el => { if (!sectionRefs.current[s.id]) sectionRefs.current[s.id] = {}; sectionRefs.current[s.id].current = el }}
              data-section={s.id}
              style={{ marginBottom: 56 }}
            >
              {/* Section anchor badge */}
              <div style={{
                display: 'flex', alignItems: 'center', gap: 8, marginBottom: 16,
                paddingBottom: 10, borderBottom: `1px solid ${t.border}`,
              }}>
                <span style={{ fontSize: 14, color: t.accent }}>{s.icon}</span>
                <span style={{ fontSize: 9, color: t.accent, fontFamily: t.font, fontWeight: 600, letterSpacing: '0.08em' }}>
                  {s.label.toUpperCase()}
                </span>
              </div>
              <Comp t={t} />
            </div>
          )
        })}

        {/* Bottom padding */}
        <div style={{ height: 80 }} />
      </div>
    </div>
  )
}
