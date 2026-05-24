// src/pages/BotsPage.jsx
// Trading Bot management — create, configure, enable/disable auto-trading bots.
// Bots for India Stocks and Crypto, driven by: Signal Pipeline / RF[DW] / Screener / Confluence.

import { useState, useMemo, useCallback, useEffect } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import toast from 'react-hot-toast'
import {
  getBots, createBot, updateBot, toggleBot, deleteBot, getBotExecutions, fmtIST,
  runIndiaPipeline, getIndiaPipelineStatus, getBotWebhookInfo, regenerateBotToken,
} from '../lib/api'
import { useTheme, useDataStore } from '../store'
import AgentLivePage from '../components/agents/AgentLivePage'

// ─── Constants ────────────────────────────────────────────────────

const SIGNAL_SOURCES = {
  india:  [
    { id: 'signal_pipeline',   label: 'Signal Pipeline',    desc: 'GO/WATCH verdicts from multi-factor LLM analysis', icon: '🧠' },
    { id: 'screener',          label: 'Screener Breakout',  desc: 'Triggered when stocks match screener categories',   icon: '📈' },
    { id: 'tv_webhook',        label: 'TradingView Alert',  desc: 'Your Pine Script strategy fires an alert → bot executes', icon: '📡' },
    { id: 'chartink',          label: 'Chartink Scan',      desc: 'Your Chartink scan fires → bot enters the matched stocks', icon: '🔍' },
    { id: 'custom_conditions', label: 'Custom Conditions',  desc: 'Define indicator rules (RSI, ADX, EMA…) — no code needed', icon: '⚙️' },
  ],
  crypto: [
    { id: 'signal_pipeline',   label: 'Signal Pipeline',    desc: 'GO/WATCH verdicts from multi-factor LLM analysis', icon: '🧠' },
    { id: 'ema_cross',         label: 'EMA Cross 9/15',     desc: '9/15 EMA crossover on 15m bars · ATR stops · regime filter', icon: '📊' },
    { id: 'rf_dw',             label: 'RF[DW] Reversal',    desc: 'ATR-based adaptive filter signal flips (3-min bars)', icon: '⚡' },
    { id: 'screener',          label: 'Screener Breakout',  desc: 'Triggered when crypto matches screener categories', icon: '📈' },
    { id: 'conf_simple',       label: 'Confluence (Simple)', desc: 'RSI+EMA+MACD+Volume STRONG BUY/SELL signals',    icon: '🔀' },
    { id: 'tv_webhook',        label: 'TradingView Alert',  desc: 'Your Pine Script strategy fires an alert → bot executes', icon: '📡' },
    { id: 'custom_conditions', label: 'Custom Conditions',  desc: 'Define indicator rules (RSI, ADX, EMA…) — no code needed', icon: '⚙️' },
  ],
}

// ── India daily technical screener categories ──────────────────────
const INDIA_SCREENER_CATS = [
  { id: 'bullish_breakout',          label: 'Bullish Breakout',       type: 'bull' },
  { id: 'oversold_bounce',           label: 'Oversold Bounce',        type: 'bull' },
  { id: 'golden_cross',              label: 'Golden Cross',           type: 'bull' },
  { id: 'gap_up',                    label: 'Gap Up',                 type: 'bull' },
  { id: 'near_support',              label: 'Near Support',           type: 'bull' },
  { id: 'weekly_high_breakout',      label: 'Weekly High Breakout',   type: 'bull' },
  { id: 'bearish_breakdown',         label: 'Bearish Breakdown',      type: 'bear' },
  { id: 'overbought_reversal',       label: 'Overbought Reversal',    type: 'bear' },
  { id: 'death_cross',               label: 'Death Cross',            type: 'bear' },
  { id: 'gap_down',                  label: 'Gap Down',               type: 'bear' },
  { id: 'weekly_low_breakdown',      label: 'Weekly Low Breakdown',   type: 'bear' },
  { id: 'volume_surge',              label: 'Volume Surge',           type: 'neutral' },
  { id: 'consolidation',             label: 'Consolidation',          type: 'neutral' },
]

// ── India intraday screener categories (5-min / 15-min) ────────────
const INDIA_INTRADAY_CATS = [
  { id: 'volume_spike_5m',   label: 'Volume Spike (5m)',    type: 'bull' },
  { id: 'rsi_crossover_15m', label: 'RSI Crossover (15m)', type: 'bull' },
  { id: 'intraday_momentum', label: 'Intraday Momentum',   type: 'bull' },
  { id: 'pivot_r1_breakout', label: 'Pivot R1 Breakout',   type: 'bull' },
  { id: 'near_vwap',         label: 'Near VWAP',           type: 'neutral' },
  { id: 'near_day_high',     label: 'Near Day High',       type: 'neutral' },
  { id: 'intraday_reversal', label: 'Intraday Reversal',   type: 'bear' },
  { id: 'near_day_low',      label: 'Near Day Low',        type: 'bear' },
]

// ── Crypto screener categories (no gap/pivot/intraday) ─────────────
const CRYPTO_SCREENER_CATS = [
  { id: 'bullish_breakout',    label: 'Bullish Breakout',    type: 'bull' },
  { id: 'oversold_bounce',     label: 'Oversold Bounce',     type: 'bull' },
  { id: 'golden_cross',        label: 'Golden Cross',        type: 'bull' },
  { id: 'volume_surge',        label: 'Volume Surge',        type: 'bull' },
  { id: 'bearish_breakdown',   label: 'Bearish Breakdown',   type: 'bear' },
  { id: 'overbought_reversal', label: 'Overbought Reversal', type: 'bear' },
  { id: 'death_cross',         label: 'Death Cross',         type: 'bear' },
  { id: 'consolidation',       label: 'Consolidation',       type: 'neutral' },
]

const CRYPTO_SYMBOLS  = ['BTCUSD', 'ETHUSD', 'SOLUSD', 'BNBUSD', 'XRPUSD', 'AVAXUSD']
const INDIA_SYMBOLS   = [
  'RELIANCE', 'TCS', 'HDFCBANK', 'INFY', 'ICICIBANK', 'AXISBANK',
  'BHARTIARTL', 'SBIN', 'WIPRO', 'LT', 'BAJFINANCE', 'HCLTECH',
  'KOTAKBANK', 'ASIANPAINT', 'ONGC', 'NTPC', 'SUNPHARMA', 'TATAMOTORS',
]

const DEFAULT_FORM = {
  name: '',
  market: 'india',
  signal_source: 'signal_pipeline',
  enabled: false,
  min_conviction: 'HIGH',
  min_score: 6.5,
  verdicts: ['GO'],
  screener_categories: ['bullish_breakout'],
  symbols: [],
  capital_pct: 1.0,
  capital_inr: 100000,
  max_position_inr: 50000,
  order_type: 'MARKET',
  product: 'CNC',
  // Crypto futures only
  leverage: 5,
  margin_mode: 'isolated',
  // Risk
  max_daily_trades: 5,
  max_open_positions: 3,
  max_daily_loss_inr: 5000,
  cooldown_minutes: 5,
  use_signal_targets: true,
  custom_target_pct: 5.0,
  custom_sl_pct: 2.0,
  trailing_stop: false,
  // EMA Cross 9/15 hyperparameters
  atr_sl_mult: 1.5,
  atr_tp_mult: 3.0,
  // TradingView Webhook
  tv_webhook_token: '',
  tv_indicator_name: 'Custom Strategy',
  // Chartink
  chartink_token: '',
  chartink_scan_name: '',
  // Custom Conditions
  custom_conditions: [],
  custom_conditions_logic: 'AND',
  custom_conditions_side: 'BUY',
}

// ─── Helpers ──────────────────────────────────────────────────────

function fmtTs(ts) {
  return fmtIST(ts, 'datetime')
}

function stateColor(s, t) {
  if (s === 'IN_POSITION') return t.bull
  if (s === 'PAUSED')      return t.textDim
  if (s === 'ERROR')       return t.bear
  return t.textMuted
}

function stateLabel(s) {
  if (s === 'IN_POSITION') return 'IN POSITION'
  if (s === 'PAUSED')      return 'PAUSED'
  if (s === 'ERROR')       return 'ERROR'
  return 'IDLE'
}

function sourceBadge(src, t) {
  const map = {
    signal_pipeline:   { label: 'Signal Pipeline', color: t.accent },
    ema_cross:         { label: 'EMA 9/15',        color: t.bull   },
    rf_dw:             { label: 'RF[DW]',          color: t.purple },
    screener:          { label: 'Screener',         color: t.cyan   },
    conf_simple:       { label: 'Confluence',       color: t.amber  },
    tv_webhook:        { label: 'TV Alert',         color: '#00bfff' },
    chartink:          { label: 'Chartink',         color: '#ff9800' },
    custom_conditions: { label: 'Custom Rules',     color: '#9c27b0' },
    reversal:          { label: 'FLIP',             color: t.bear   },
  }
  return map[src] || { label: src, color: t.textMuted }
}

// ─── Bot Card ─────────────────────────────────────────────────────

function BotCard({ bot, onEdit, onDelete, onToggle, t }) {
  const [confirmDelete, setConfirmDelete] = useState(false)
  const src = sourceBadge(bot.signal_source, t)
  const sc  = stateColor(bot.state, t)
  const stats = bot.stats || {}

  return (
    <div style={{
      background: t.bgCard, border: `1px solid ${bot.enabled ? `${t.accent}40` : t.border}`,
      borderTop: `3px solid ${bot.enabled ? t.accent : t.border}`,
      borderRadius: t.radiusLg, padding: '16px 18px',
      boxShadow: bot.enabled ? `0 4px 20px ${t.accent}12` : t.shadowCard,
      display: 'flex', flexDirection: 'column', gap: 12,
      transition: 'border-color 0.2s, box-shadow 0.2s',
    }}>
      {/* Header row */}
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
        {/* Market icon */}
        <div style={{
          width: 38, height: 38, borderRadius: 10, flexShrink: 0,
          background: `${bot.market === 'crypto' ? t.purple : t.accent}18`,
          border: `1px solid ${bot.market === 'crypto' ? t.purple : t.accent}30`,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          fontSize: 18,
        }}>
          {bot.market === 'crypto' ? '₿' : '📊'}
        </div>

        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 7, flexWrap: 'wrap' }}>
            <span style={{ fontSize: 14, fontWeight: 700, color: t.text, fontFamily: t.fontUI }}>{bot.name}</span>
            <span style={{
              fontSize: 8, fontWeight: 700, fontFamily: t.fontUI, letterSpacing: 0.5,
              padding: '2px 7px', borderRadius: 10,
              background: `${bot.market === 'crypto' ? t.purple : t.accent}18`,
              color: bot.market === 'crypto' ? t.purple : t.accent,
              border: `1px solid ${bot.market === 'crypto' ? t.purple : t.accent}40`,
              textTransform: 'uppercase',
            }}>
              {bot.market === 'crypto' ? 'CRYPTO' : 'INDIA'}
            </span>
            <span style={{
              fontSize: 8, fontWeight: 600, fontFamily: t.fontUI,
              padding: '2px 7px', borderRadius: 10,
              background: `${src.color}15`, color: src.color, border: `1px solid ${src.color}30`,
            }}>
              {src.label}
            </span>
          </div>
          <div style={{ fontSize: 9, color: t.textDim, fontFamily: t.fontUI, marginTop: 3 }}>
            {stateLabel(bot.state)}
            <span style={{ color: sc, fontWeight: 600, marginLeft: 4 }}>●</span>
            {bot.last_execution && (
              <span style={{ marginLeft: 6 }}>Last: {fmtTs(bot.last_execution_ts)}</span>
            )}
          </div>
        </div>

        {/* Enable toggle */}
        <button
          onClick={() => onToggle(bot.id, !bot.enabled)}
          title={bot.enabled ? 'Click to disable' : 'Click to enable'}
          style={{
            width: 42, height: 24, borderRadius: 12, flexShrink: 0, cursor: 'pointer',
            background: bot.enabled ? t.bull : `${t.border}80`,
            border: 'none', position: 'relative', transition: 'background 0.2s',
          }}
        >
          <div style={{
            position: 'absolute', top: 3, left: bot.enabled ? 21 : 3,
            width: 18, height: 18, borderRadius: '50%',
            background: '#fff', transition: 'left 0.2s',
            boxShadow: '0 1px 4px rgba(0,0,0,0.3)',
          }} />
        </button>
      </div>

      {/* Stats row */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 8 }}>
        {[
          { label: 'Today', value: stats.trades_today ?? 0, color: t.text },
          { label: 'Total',  value: stats.total_trades ?? 0, color: t.textMuted },
          { label: 'P&L',    value: stats.pnl_today != null ? `₹${Number(stats.pnl_today).toFixed(0)}` : '—', color: (stats.pnl_today || 0) >= 0 ? t.bull : t.bear },
          { label: 'Wins',   value: stats.wins ?? 0, color: t.bull },
        ].map(({ label, value, color }) => (
          <div key={label} style={{ background: t.bgActive, borderRadius: t.radius, padding: '6px 8px', textAlign: 'center' }}>
            <div style={{ fontSize: 8, color: t.textDim, fontFamily: t.fontUI, letterSpacing: 0.4, textTransform: 'uppercase' }}>{label}</div>
            <div style={{ fontSize: 14, fontWeight: 700, color, fontFamily: t.fontUI, marginTop: 2 }}>{value}</div>
          </div>
        ))}
      </div>

      {/* Auto-disabled banner */}
      {bot.disabled_reason && (
        <div style={{
          padding: '7px 10px', borderRadius: t.radius,
          background: `${t.bear}12`, border: `1px solid ${t.bear}40`,
          display: 'flex', alignItems: 'flex-start', gap: 7,
        }}>
          <span style={{ color: t.bear, fontSize: 13, flexShrink: 0 }}>⊘</span>
          <div>
            <div style={{ fontSize: 9, fontWeight: 700, fontFamily: t.fontUI, color: t.bear, letterSpacing: 0.4, textTransform: 'uppercase' }}>Auto-Disabled</div>
            <div style={{ fontSize: 9, color: t.textMuted, fontFamily: t.fontUI, marginTop: 2, lineHeight: 1.5 }}>{bot.disabled_reason}</div>
          </div>
        </div>
      )}

      {/* Last broker error badge (when not disabled) */}
      {bot.last_error && !bot.disabled_reason && (
        <div style={{
          padding: '5px 10px', borderRadius: t.radius,
          background: `${t.amber}10`, border: `1px solid ${t.amber}35`,
          display: 'flex', alignItems: 'center', gap: 6,
        }}>
          <span style={{ color: t.amber, fontSize: 11 }}>⚠</span>
          <div style={{ flex: 1, minWidth: 0 }}>
            <span style={{ fontSize: 8, fontWeight: 700, fontFamily: t.fontUI, color: t.amber, letterSpacing: 0.4, textTransform: 'uppercase' }}>
              Broker Error ({bot.error_count ?? 1}×)&nbsp;·&nbsp;
            </span>
            <span style={{ fontSize: 8, color: t.textMuted, fontFamily: t.fontUI }}>{bot.last_error}</span>
          </div>
        </div>
      )}

      {/* Config summary */}
      <div style={{ fontSize: 9, color: t.textMuted, fontFamily: t.fontUI, lineHeight: 1.8, padding: '8px 10px', background: t.bgActive, borderRadius: t.radius, border: `1px solid ${t.border}` }}>
        {bot.signal_source === 'signal_pipeline' && (
          <><span style={{ color: t.textDim, fontWeight: 600 }}>Verdicts:</span> {(bot.verdicts || []).join('/')}
          {' · '}<span style={{ color: t.textDim, fontWeight: 600 }}>Conviction:</span> {bot.min_conviction}
          {' · '}<span style={{ color: t.textDim, fontWeight: 600 }}>Score ≥</span> {bot.min_score}<br/></>
        )}
        <span style={{ color: t.textDim, fontWeight: 600 }}>Capital:</span> {bot.capital_pct}% of ₹{(bot.capital_inr / 1000).toFixed(0)}K
        {bot.market === 'crypto' && bot.leverage > 1 && (
          <>{' · '}<span style={{ color: t.amber, fontWeight: 700 }}>{bot.leverage}× leverage</span>
          {' · '}<span style={{ color: t.textDim, fontWeight: 600 }}>{bot.margin_mode || 'isolated'}</span></>
        )}
        {' · '}
        <span style={{ color: t.textDim, fontWeight: 600 }}>Max daily:</span> {bot.max_daily_trades} trades
        {' · '}
        <span style={{ color: t.textDim, fontWeight: 600 }}>Cooldown:</span> {bot.cooldown_minutes}m
        {bot.signal_source === 'screener' && bot.screener_categories?.length > 0 && (
          <><br/><span style={{ color: t.textDim, fontWeight: 600 }}>Categories:</span> {bot.screener_categories.slice(0, 4).join(', ')}{bot.screener_categories.length > 4 ? ` +${bot.screener_categories.length - 4} more` : ''}</>
        )}
        {(bot.signal_source === 'rf_dw' || bot.signal_source === 'conf_simple' || bot.signal_source === 'ema_cross' || (bot.signal_source === 'signal_pipeline' && bot.market === 'crypto')) && (
          <><br/><span style={{ color: t.textDim, fontWeight: 600 }}>Symbols:</span> {bot.symbols?.length ? bot.symbols.map(s => s.replace('USD','')).join(', ') : 'All crypto'}</>
        )}
        {bot.signal_source === 'ema_cross' && (
          <><br/><span style={{ color: t.textDim, fontWeight: 600 }}>ATR SL/TP:</span> {bot.atr_sl_mult ?? 1.5}× / {bot.atr_tp_mult ?? 3.0}×</>
        )}
        {bot.signal_source === 'signal_pipeline' && bot.market === 'india' && bot.symbols?.length > 0 && (
          <><br/><span style={{ color: t.textDim, fontWeight: 600 }}>Restricted to:</span> {bot.symbols.join(', ')}</>
        )}
        {bot.signal_source === 'tv_webhook' && (
          <><br/><span style={{ color: t.textDim, fontWeight: 600 }}>Strategy:</span> {bot.tv_indicator_name || 'Custom Strategy'}
          {' · '}<span style={{ color: t.textDim, fontWeight: 600 }}>Token:</span> {bot.tv_webhook_token ? `…${bot.tv_webhook_token.slice(-6)}` : 'Not set'}</>
        )}
        {bot.signal_source === 'chartink' && (
          <><br/><span style={{ color: t.textDim, fontWeight: 600 }}>Scan:</span> {bot.chartink_scan_name || 'Any scan'}
          {' · '}<span style={{ color: t.textDim, fontWeight: 600 }}>Token:</span> {bot.chartink_token ? `…${bot.chartink_token.slice(-6)}` : 'Not set'}</>
        )}
        {bot.signal_source === 'custom_conditions' && (
          <><br/><span style={{ color: t.textDim, fontWeight: 600 }}>Rules:</span> {(bot.custom_conditions || []).length} condition{(bot.custom_conditions || []).length !== 1 ? 's' : ''}
          {' · '}<span style={{ color: t.textDim, fontWeight: 600 }}>Logic:</span> {bot.custom_conditions_logic || 'AND'}
          {' · '}<span style={{ color: t.textDim, fontWeight: 600 }}>Side:</span> {bot.custom_conditions_side || 'BUY'}</>
        )}
      </div>

      {/* Actions */}
      <div style={{ display: 'flex', gap: 8 }}>
        <button
          onClick={() => onEdit(bot)}
          style={{
            flex: 1, padding: '7px 0', fontSize: 11, fontWeight: 600, fontFamily: t.fontUI,
            cursor: 'pointer', borderRadius: t.radius,
            border: `1px solid ${t.border}`, background: 'transparent', color: t.textMuted,
            transition: 'all 0.12s',
          }}
          onMouseEnter={e => { e.currentTarget.style.borderColor = t.accent; e.currentTarget.style.color = t.accent }}
          onMouseLeave={e => { e.currentTarget.style.borderColor = t.border; e.currentTarget.style.color = t.textMuted }}
        >
          Configure
        </button>

        {confirmDelete ? (
          <>
            <button
              onClick={() => { onDelete(bot.id); setConfirmDelete(false) }}
              style={{ padding: '7px 14px', fontSize: 11, fontWeight: 700, fontFamily: t.fontUI, cursor: 'pointer', borderRadius: t.radius, border: 'none', background: t.bear, color: '#fff' }}
            >Confirm</button>
            <button
              onClick={() => setConfirmDelete(false)}
              style={{ padding: '7px 10px', fontSize: 11, fontFamily: t.fontUI, cursor: 'pointer', borderRadius: t.radius, border: `1px solid ${t.border}`, background: 'transparent', color: t.textMuted }}
            >Cancel</button>
          </>
        ) : (
          <button
            onClick={() => setConfirmDelete(true)}
            style={{ padding: '7px 12px', fontSize: 11, fontFamily: t.fontUI, cursor: 'pointer', borderRadius: t.radius, border: `1px solid ${t.bear}40`, background: 'transparent', color: t.bear, transition: 'all 0.12s' }}
            onMouseEnter={e => { e.currentTarget.style.background = `${t.bear}12` }}
            onMouseLeave={e => { e.currentTarget.style.background = 'transparent' }}
          >✕</button>
        )}
      </div>
    </div>
  )
}

// ─── Execution History Row ─────────────────────────────────────────

function ExecRow({ exec, t }) {
  const src       = sourceBadge(exec.signal_source, t)
  const isReversal = exec.status === 'REVERSAL_CLOSE'
  const sideColor  = isReversal ? t.bear
                   : exec.side === 'BUY' ? t.bull : t.bear
  const sideLabel  = isReversal ? `↺ ${exec.side}` : exec.side

  return (
    <div style={{
      display: 'grid', gridTemplateColumns: '90px 80px 60px 50px 80px 80px 70px 1fr',
      gap: 4, padding: '7px 14px', borderBottom: `1px solid ${t.border}`,
      alignItems: 'center',
      background: isReversal ? `${t.bear}08` : 'transparent',
      borderLeft: isReversal ? `2px solid ${t.bear}60` : '2px solid transparent',
    }}>
      <span style={{ fontSize: 9, color: t.textDim, fontFamily: t.fontUI }}>{fmtTs(exec.ts)}</span>
      <span style={{ fontSize: 11, fontWeight: 700, color: t.text, fontFamily: t.fontUI }}>{exec.symbol}</span>
      <span style={{ fontSize: 10, fontWeight: 700, color: sideColor, fontFamily: t.fontUI }}>{sideLabel}</span>
      <span style={{ fontSize: 10, color: t.textMuted, fontFamily: t.fontUI }}>{exec.qty}</span>
      <span style={{ fontSize: 10, color: t.text, fontFamily: t.fontUI }}>₹{Number(exec.price || 0).toLocaleString('en-IN', { maximumFractionDigits: 2 })}</span>
      <span style={{ fontSize: 9, color: src.color, fontFamily: t.fontUI, background: `${src.color}15`, padding: '2px 6px', borderRadius: 8 }}>{src.label}</span>
      <span style={{ fontSize: 9, fontWeight: 600, color: exec.conviction === 'HIGH' ? t.bull : exec.conviction === 'MEDIUM' ? t.amber : t.textDim, fontFamily: t.fontUI }}>{exec.conviction || '—'}</span>
      <span style={{ fontSize: 10, color: t.textMuted, fontFamily: t.fontUI, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{exec.bot_name}</span>
    </div>
  )
}

// ─── TradingView Webhook Panel ─────────────────────────────────────

function TVWebhookPanel({ form, upd, bot, t, inputStyle, labelStyle, sectionGap, isEdit }) {
  const [webhookInfo, setWebhookInfo] = useState(null)
  const [loading, setLoading] = useState(false)
  const [copied, setCopied] = useState('')

  const fetchInfo = async () => {
    if (!bot?.id) return
    setLoading(true)
    try {
      const info = await getBotWebhookInfo(bot.id)
      setWebhookInfo(info)
    } catch {
      toast.error('Save the bot first to generate a webhook URL')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    if (isEdit && bot?.signal_source === 'tv_webhook' && bot?.tv_webhook_token) {
      fetchInfo()
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const copy = (text, key) => {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(key)
      setTimeout(() => setCopied(''), 2000)
    })
  }

  return (
    <>
      <div style={{ padding: '10px 12px', marginBottom: 14, background: '#00bfff18', border: '1px solid #00bfff40', borderRadius: 6, fontSize: 9, color: '#00bfff', fontFamily: t.fontUI }}>
        📡 <strong>TradingView Alert:</strong> Connect any Pine Script strategy. When your strategy fires an alert, this bot places the corresponding BUY or SELL order automatically.
      </div>

      <div style={sectionGap}>
        <label style={labelStyle}>Strategy / Indicator Name</label>
        <input
          value={form.tv_indicator_name || ''}
          onChange={e => upd('tv_indicator_name', e.target.value)}
          placeholder="e.g. EMA Cross Strategy"
          style={inputStyle}
        />
        <div style={{ fontSize: 9, color: t.textDim, fontFamily: t.fontUI, marginTop: 4 }}>
          For your reference — does not affect execution.
        </div>
      </div>

      {isEdit && webhookInfo ? (
        <>
          <div style={{ ...sectionGap, padding: '12px 14px', background: t.bgActive, border: `1px solid ${t.border}`, borderRadius: 6 }}>
            <div style={{ fontSize: 9, fontWeight: 700, color: t.textMuted, fontFamily: t.fontUI, letterSpacing: 0.5, textTransform: 'uppercase', marginBottom: 8 }}>Webhook URL</div>
            <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
              <code style={{ flex: 1, fontSize: 9, color: '#00bfff', background: '#00bfff10', padding: '6px 8px', borderRadius: 4, wordBreak: 'break-all', fontFamily: 'monospace' }}>
                {webhookInfo.webhook_url}
              </code>
              <button
                onClick={() => copy(webhookInfo.webhook_url, 'url')}
                style={{ padding: '6px 10px', fontSize: 9, fontFamily: t.fontUI, cursor: 'pointer', borderRadius: 4, border: '1px solid #00bfff40', background: copied === 'url' ? '#00bfff20' : 'transparent', color: '#00bfff', whiteSpace: 'nowrap' }}
              >
                {copied === 'url' ? '✓ Copied' : 'Copy'}
              </button>
            </div>
          </div>

          <div style={{ ...sectionGap, padding: '12px 14px', background: t.bgActive, border: `1px solid ${t.border}`, borderRadius: 6 }}>
            <div style={{ fontSize: 9, fontWeight: 700, color: t.textMuted, fontFamily: t.fontUI, letterSpacing: 0.5, textTransform: 'uppercase', marginBottom: 8 }}>Alert Message (paste into TradingView)</div>
            <div style={{ display: 'flex', gap: 6, alignItems: 'flex-start' }}>
              <code style={{ flex: 1, fontSize: 9, color: t.text, background: t.bgCard, padding: '6px 8px', borderRadius: 4, wordBreak: 'break-all', fontFamily: 'monospace', lineHeight: 1.5 }}>
                {webhookInfo.alert_message}
              </code>
              <button
                onClick={() => copy(webhookInfo.alert_message, 'msg')}
                style={{ padding: '6px 10px', fontSize: 9, fontFamily: t.fontUI, cursor: 'pointer', borderRadius: 4, border: `1px solid ${t.border}`, background: copied === 'msg' ? `${t.accent}20` : 'transparent', color: t.textMuted, whiteSpace: 'nowrap' }}
              >
                {copied === 'msg' ? '✓ Copied' : 'Copy'}
              </button>
            </div>
          </div>

          <div style={{ padding: '10px 14px', background: t.bgActive, border: `1px solid ${t.border}`, borderRadius: 6, fontSize: 9, color: t.textDim, fontFamily: t.fontUI, lineHeight: 1.8 }}>
            <strong style={{ color: t.text }}>Setup in TradingView:</strong><br/>
            1. Open your chart · open your Strategy or Indicator<br/>
            2. Click the alert bell (⏰) → Create Alert<br/>
            3. Set <em>Condition</em> to your strategy's signal<br/>
            4. Under <em>Notifications</em> → enable <strong>Webhook URL</strong><br/>
            5. Paste the webhook URL above<br/>
            6. In <em>Message</em>, paste the alert message above<br/>
            7. Click <strong>Create</strong>
          </div>

          <div style={{ marginTop: 10 }}>
            <button
              onClick={async () => {
                if (!confirm('Regenerate token? The old webhook URL will stop working immediately.')) return
                try {
                  await regenerateBotToken(bot.id)
                  fetchInfo()
                  toast.success('Token regenerated — update your TradingView alert')
                } catch {
                  toast.error('Failed to regenerate token')
                }
              }}
              style={{ padding: '6px 12px', fontSize: 9, fontFamily: t.fontUI, cursor: 'pointer', borderRadius: 4, border: `1px solid ${t.bear}40`, background: 'transparent', color: t.bear }}
            >
              Regenerate Token
            </button>
          </div>
        </>
      ) : isEdit ? (
        <div style={{ padding: '10px', textAlign: 'center', color: t.textDim, fontSize: 9, fontFamily: t.fontUI }}>
          <button onClick={fetchInfo} disabled={loading} style={{ padding: '7px 16px', fontSize: 10, fontFamily: t.fontUI, cursor: 'pointer', borderRadius: 4, border: `1px solid #00bfff40`, background: '#00bfff10', color: '#00bfff' }}>
            {loading ? 'Loading…' : 'Show Webhook URL'}
          </button>
        </div>
      ) : (
        <div style={{ padding: '10px 14px', background: `${t.amber}10`, border: `1px solid ${t.amber}35`, borderRadius: 6, fontSize: 9, color: t.amber, fontFamily: t.fontUI }}>
          Save the bot first → your unique webhook URL will be generated automatically.
        </div>
      )}
    </>
  )
}

// ─── Chartink Panel ────────────────────────────────────────────────

function ChartinkPanel({ form, upd, bot, t, inputStyle, labelStyle, sectionGap, isEdit }) {
  const [webhookInfo, setWebhookInfo] = useState(null)
  const [loading, setLoading] = useState(false)
  const [copied, setCopied] = useState('')

  const fetchInfo = async () => {
    if (!bot?.id) return
    setLoading(true)
    try {
      const info = await getBotWebhookInfo(bot.id)
      setWebhookInfo(info)
    } catch {
      toast.error('Save the bot first to generate a webhook URL')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    if (isEdit && bot?.signal_source === 'chartink' && bot?.chartink_token) {
      fetchInfo()
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const copy = (text, key) => {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(key)
      setTimeout(() => setCopied(''), 2000)
    })
  }

  return (
    <>
      <div style={{ padding: '10px 12px', marginBottom: 14, background: '#ff980018', border: '1px solid #ff980040', borderRadius: 6, fontSize: 9, color: '#ff9800', fontFamily: t.fontUI }}>
        🔍 <strong>Chartink Scan:</strong> Whenever your Chartink scan triggers, this bot automatically buys the matched stocks. Configure the webhook URL in Chartink → Alerts.
      </div>

      <div style={sectionGap}>
        <label style={labelStyle}>Scan Label (optional)</label>
        <input
          value={form.chartink_scan_name || ''}
          onChange={e => upd('chartink_scan_name', e.target.value)}
          placeholder="e.g. RSI Breakout Scan"
          style={inputStyle}
        />
        <div style={{ fontSize: 9, color: t.textDim, fontFamily: t.fontUI, marginTop: 4 }}>
          For your reference only.
        </div>
      </div>

      {isEdit && webhookInfo ? (
        <>
          <div style={{ ...sectionGap, padding: '12px 14px', background: t.bgActive, border: `1px solid ${t.border}`, borderRadius: 6 }}>
            <div style={{ fontSize: 9, fontWeight: 700, color: t.textMuted, fontFamily: t.fontUI, letterSpacing: 0.5, textTransform: 'uppercase', marginBottom: 8 }}>Chartink Webhook URL</div>
            <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
              <code style={{ flex: 1, fontSize: 9, color: '#ff9800', background: '#ff980010', padding: '6px 8px', borderRadius: 4, wordBreak: 'break-all', fontFamily: 'monospace' }}>
                {webhookInfo.webhook_url}
              </code>
              <button
                onClick={() => copy(webhookInfo.webhook_url, 'url')}
                style={{ padding: '6px 10px', fontSize: 9, fontFamily: t.fontUI, cursor: 'pointer', borderRadius: 4, border: '1px solid #ff980040', background: copied === 'url' ? '#ff980020' : 'transparent', color: '#ff9800', whiteSpace: 'nowrap' }}
              >
                {copied === 'url' ? '✓ Copied' : 'Copy'}
              </button>
            </div>
          </div>

          <div style={{ padding: '10px 14px', background: t.bgActive, border: `1px solid ${t.border}`, borderRadius: 6, fontSize: 9, color: t.textDim, fontFamily: t.fontUI, lineHeight: 1.8 }}>
            <strong style={{ color: t.text }}>Setup in Chartink:</strong><br/>
            1. Open your scan → click <strong>Alerts</strong><br/>
            2. Under <em>Alert Type</em> → select <strong>Webhook</strong><br/>
            3. Paste the URL above into the Webhook field<br/>
            4. Method: <strong>POST</strong><br/>
            5. Save and enable the alert<br/>
            6. Chartink sends matched stocks each time the scan runs
          </div>

          <div style={{ marginTop: 10 }}>
            <button
              onClick={async () => {
                if (!confirm('Regenerate token? The old webhook URL will stop working immediately.')) return
                try {
                  await regenerateBotToken(bot.id)
                  fetchInfo()
                  toast.success('Token regenerated — update your Chartink webhook')
                } catch {
                  toast.error('Failed to regenerate token')
                }
              }}
              style={{ padding: '6px 12px', fontSize: 9, fontFamily: t.fontUI, cursor: 'pointer', borderRadius: 4, border: `1px solid ${t.bear}40`, background: 'transparent', color: t.bear }}
            >
              Regenerate Token
            </button>
          </div>
        </>
      ) : isEdit ? (
        <div style={{ padding: '10px', textAlign: 'center' }}>
          <button onClick={fetchInfo} disabled={loading} style={{ padding: '7px 16px', fontSize: 10, fontFamily: t.fontUI, cursor: 'pointer', borderRadius: 4, border: '1px solid #ff980040', background: '#ff980010', color: '#ff9800' }}>
            {loading ? 'Loading…' : 'Show Webhook URL'}
          </button>
        </div>
      ) : (
        <div style={{ padding: '10px 14px', background: `${t.amber}10`, border: `1px solid ${t.amber}35`, borderRadius: 6, fontSize: 9, color: t.amber, fontFamily: t.fontUI }}>
          Save the bot first → your unique Chartink webhook URL will be generated.
        </div>
      )}
    </>
  )
}

// ─── Custom Conditions Panel ───────────────────────────────────────

const CONDITION_INDICATORS = [
  { id: 'rsi',               label: 'RSI (14)',             hint: 'Relative Strength Index, 0–100' },
  { id: 'adx',               label: 'ADX (14)',             hint: 'Average Directional Index, 0–100' },
  { id: 'volume_ratio',      label: 'Volume Ratio',         hint: 'Current volume ÷ average volume' },
  { id: 'technical_score',   label: 'Technical Score',      hint: 'Composite score 0–10' },
  { id: 'atr',               label: 'ATR (14)',             hint: 'Average True Range' },
  { id: 'ema20',             label: 'EMA 20',               hint: 'Exponential Moving Average (20)' },
  { id: 'ema50',             label: 'EMA 50',               hint: 'Exponential Moving Average (50)' },
  { id: 'ema200',            label: 'EMA 200',              hint: 'Exponential Moving Average (200)' },
  { id: 'price_vs_ema50_pct',  label: 'Price vs EMA50 %',  hint: '% above/below EMA(50), negative = below' },
  { id: 'price_vs_ema200_pct', label: 'Price vs EMA200 %', hint: '% above/below EMA(200)' },
]

const CONDITION_OPS = [
  { id: 'gt',  label: '>' },
  { id: 'gte', label: '≥' },
  { id: 'lt',  label: '<' },
  { id: 'lte', label: '≤' },
  { id: 'eq',  label: '=' },
]

function CustomConditionsPanel({ form, upd, t, inputStyle, labelStyle, sectionGap, isCrypto, isIndia }) {
  const conditions = form.custom_conditions || []
  const symbols = form.symbols || []
  const allSymbols = isCrypto
    ? ['BTCUSD', 'ETHUSD', 'SOLUSD', 'BNBUSD', 'XRPUSD', 'AVAXUSD']
    : ['RELIANCE', 'TCS', 'HDFCBANK', 'INFY', 'ICICIBANK', 'AXISBANK', 'BHARTIARTL', 'SBIN', 'WIPRO', 'LT']

  const addCondition = () => {
    upd('custom_conditions', [...conditions, { indicator: 'rsi', op: 'gt', value: 50 }])
  }

  const removeCondition = (i) => {
    upd('custom_conditions', conditions.filter((_, idx) => idx !== i))
  }

  const updateCondition = (i, key, val) => {
    const next = conditions.map((c, idx) => idx === i ? { ...c, [key]: val } : c)
    upd('custom_conditions', next)
  }

  return (
    <>
      <div style={{ padding: '10px 12px', marginBottom: 14, background: '#9c27b018', border: '1px solid #9c27b040', borderRadius: 6, fontSize: 9, color: '#9c27b0', fontFamily: t.fontUI }}>
        ⚙️ <strong>Custom Conditions:</strong> Define indicator rules — bot enters when ALL (or ANY) conditions are met for a symbol in your watchlist.
      </div>

      {/* Symbol picker */}
      <div style={sectionGap}>
        <label style={labelStyle}>Symbols to Monitor <span style={{ color: t.textDim, fontWeight: 400 }}>(required)</span></label>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
          {allSymbols.map(sym => {
            const active = symbols.includes(sym)
            return (
              <button key={sym} type="button" onClick={() => {
                upd('symbols', active ? symbols.filter(s => s !== sym) : [...symbols, sym])
              }} style={{
                padding: '5px 11px', cursor: 'pointer', borderRadius: 20,
                border: `1px solid ${active ? '#9c27b0' : t.border}`,
                background: active ? '#9c27b018' : 'transparent',
                color: active ? '#9c27b0' : t.textDim,
                fontSize: 10, fontWeight: active ? 600 : 400, fontFamily: t.fontUI,
              }}>
                {isCrypto ? sym.replace('USD', '') : sym}
              </button>
            )
          })}
        </div>
        {symbols.length === 0 && (
          <div style={{ fontSize: 9, color: t.bear, fontFamily: t.fontUI, marginTop: 5 }}>
            Select at least one symbol to monitor.
          </div>
        )}
      </div>

      {/* Logic + Side */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, ...sectionGap }}>
        <div>
          <label style={labelStyle}>Condition Logic</label>
          <div style={{ display: 'flex', gap: 6 }}>
            {['AND', 'OR'].map(logic => (
              <button key={logic} type="button" onClick={() => upd('custom_conditions_logic', logic)} style={{
                flex: 1, padding: '8px 0', fontSize: 11, fontWeight: 600, fontFamily: t.fontUI,
                cursor: 'pointer', borderRadius: 4,
                border: `1px solid ${form.custom_conditions_logic === logic ? '#9c27b0' : t.border}`,
                background: form.custom_conditions_logic === logic ? '#9c27b018' : 'transparent',
                color: form.custom_conditions_logic === logic ? '#9c27b0' : t.textDim,
              }}>
                {logic}
              </button>
            ))}
          </div>
          <div style={{ fontSize: 9, color: t.textDim, fontFamily: t.fontUI, marginTop: 4 }}>
            {form.custom_conditions_logic === 'AND' ? 'ALL rules must be true' : 'ANY one rule is enough'}
          </div>
        </div>
        <div>
          <label style={labelStyle}>Trade Side</label>
          <div style={{ display: 'flex', gap: 6 }}>
            {['BUY', 'SELL'].map(side => (
              <button key={side} type="button" onClick={() => upd('custom_conditions_side', side)} style={{
                flex: 1, padding: '8px 0', fontSize: 11, fontWeight: 600, fontFamily: t.fontUI,
                cursor: 'pointer', borderRadius: 4,
                border: `1px solid ${form.custom_conditions_side === side ? (side === 'BUY' ? t.bull : t.bear) : t.border}`,
                background: form.custom_conditions_side === side ? `${side === 'BUY' ? t.bull : t.bear}18` : 'transparent',
                color: form.custom_conditions_side === side ? (side === 'BUY' ? t.bull : t.bear) : t.textDim,
              }}>
                {side}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Condition rows */}
      <div style={sectionGap}>
        <label style={labelStyle}>Rules</label>
        {conditions.length === 0 && (
          <div style={{ padding: '10px', textAlign: 'center', color: t.textDim, fontSize: 9, fontFamily: t.fontUI, border: `1px dashed ${t.border}`, borderRadius: 6 }}>
            No conditions yet — add at least one rule below.
          </div>
        )}
        {conditions.map((cond, i) => (
          <div key={i} style={{ display: 'flex', gap: 6, alignItems: 'center', marginBottom: 6 }}>
            {i > 0 && (
              <div style={{ width: 30, fontSize: 8, fontWeight: 700, color: '#9c27b0', fontFamily: t.fontUI, textAlign: 'center', flexShrink: 0 }}>
                {form.custom_conditions_logic}
              </div>
            )}
            {i === 0 && <div style={{ width: 30, flexShrink: 0 }} />}
            <select
              value={cond.indicator}
              onChange={e => updateCondition(i, 'indicator', e.target.value)}
              style={{ ...inputStyle, flex: 2, padding: '6px 8px' }}
            >
              {CONDITION_INDICATORS.map(ind => (
                <option key={ind.id} value={ind.id}>{ind.label}</option>
              ))}
            </select>
            <select
              value={cond.op}
              onChange={e => updateCondition(i, 'op', e.target.value)}
              style={{ ...inputStyle, width: 48, padding: '6px 6px', flexShrink: 0 }}
            >
              {CONDITION_OPS.map(op => (
                <option key={op.id} value={op.id}>{op.label}</option>
              ))}
            </select>
            <input
              type="number" step="any"
              value={cond.value}
              onChange={e => updateCondition(i, 'value', parseFloat(e.target.value) || 0)}
              style={{ ...inputStyle, width: 70, flexShrink: 0 }}
            />
            <button
              onClick={() => removeCondition(i)}
              style={{ padding: '6px 8px', fontSize: 12, cursor: 'pointer', borderRadius: 4, border: `1px solid ${t.bear}40`, background: 'transparent', color: t.bear, flexShrink: 0 }}
            >
              ✕
            </button>
          </div>
        ))}
        <button
          type="button" onClick={addCondition}
          style={{ marginTop: 6, padding: '7px 14px', fontSize: 10, fontWeight: 600, fontFamily: t.fontUI, cursor: 'pointer', borderRadius: 4, border: '1px solid #9c27b040', background: '#9c27b010', color: '#9c27b0' }}
        >
          + Add Rule
        </button>
      </div>

      {conditions.length > 0 && (
        <div style={{ padding: '8px 12px', background: t.bgActive, border: `1px solid ${t.border}`, borderRadius: 6, fontSize: 9, color: t.textDim, fontFamily: t.fontUI, lineHeight: 1.8 }}>
          <strong style={{ color: t.text }}>Preview:</strong> {
            conditions.map((c, i) => {
              const ind = CONDITION_INDICATORS.find(x => x.id === c.indicator)?.label || c.indicator
              const op  = CONDITION_OPS.find(x => x.id === c.op)?.label || c.op
              return `${i > 0 ? ` ${form.custom_conditions_logic} ` : ''}${ind} ${op} ${c.value}`
            }).join('')
          } → {form.custom_conditions_side}
        </div>
      )}
    </>
  )
}

// ─── Bot Config Modal ──────────────────────────────────────────────

function BotModal({ bot, onClose, onSave, t }) {
  const isEdit = !!bot?.id
  const [step, setStep] = useState(0)
  const [form, setForm] = useState(() => {
    if (isEdit) {
      const { id, created_at, state: _s, stats, last_execution, last_signal_id, last_execution_ts, ...rest } = bot
      return { ...DEFAULT_FORM, ...rest }
    }
    return { ...DEFAULT_FORM }
  })

  const upd = useCallback((key, val) => setForm(f => ({ ...f, [key]: val })), [])

  const sources = SIGNAL_SOURCES[form.market] || SIGNAL_SOURCES.india
  // Reset signal_source + product when market changes
  useEffect(() => {
    const valid = sources.map(s => s.id)
    if (!valid.includes(form.signal_source)) {
      upd('signal_source', valid[0])
    }
    if (form.market === 'crypto') {
      upd('product', 'PERPETUAL')
    } else {
      upd('product', 'CNC')
      upd('leverage', 1)  // leverage not applicable for India equity
    }
  }, [form.market]) // eslint-disable-line react-hooks/exhaustive-deps

  const inputStyle = {
    width: '100%', boxSizing: 'border-box',
    background: t.bgInput || t.bgActive, border: `1px solid ${t.border}`,
    color: t.text, fontFamily: t.fontUI, fontSize: 12,
    padding: '8px 10px', borderRadius: t.radius, outline: 'none',
  }
  const labelStyle = {
    fontSize: 9, fontWeight: 600, color: t.textMuted, fontFamily: t.fontUI,
    letterSpacing: 0.5, textTransform: 'uppercase', display: 'block', marginBottom: 4,
  }
  const focusBorder  = e => { e.target.style.borderColor = t.accent }
  const blurBorder   = e => { e.target.style.borderColor = t.border }
  const sectionGap   = { marginBottom: 16 }

  const STEPS = ['Basics', 'Filters', 'Position', 'Exit Rules']

  // ── Step 0: Basics ────────────────────────────────────────────
  const renderBasics = () => (
    <>
      <div style={sectionGap}>
        <label style={labelStyle}>Bot Name</label>
        <input
          value={form.name} onChange={e => upd('name', e.target.value)}
          placeholder="e.g. India GO Bot"
          style={inputStyle} onFocus={focusBorder} onBlur={blurBorder}
        />
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: form.signal_source === 'signal_pipeline' ? '1fr 1fr' : '1fr', gap: 12, ...sectionGap }}>
        <div>
          <label style={labelStyle}>Market</label>
          <div style={{ display: 'flex', gap: 6 }}>
            {['india', 'crypto'].map(m => (
              <button key={m} type="button" onClick={() => upd('market', m)} style={{
                flex: 1, padding: '9px 0', fontSize: 11, fontWeight: 600, fontFamily: t.fontUI,
                cursor: 'pointer', borderRadius: t.radius,
                border: `1px solid ${form.market === m ? t.accent : t.border}`,
                background: form.market === m ? t.accentBg : 'transparent',
                color: form.market === m ? t.accent : t.textDim,
              }}>
                {m === 'india' ? '🇮🇳 India' : '₿ Crypto'}
              </button>
            ))}
          </div>
        </div>
        {form.signal_source === 'signal_pipeline' && (
          <div>
            <label style={labelStyle}>Verdicts to trade</label>
            <div style={{ display: 'flex', gap: 5 }}>
              {['GO', 'WATCH'].map(v => {
                const active = form.verdicts.includes(v)
                return (
                  <button key={v} type="button" onClick={() => {
                    upd('verdicts', active
                      ? form.verdicts.filter(x => x !== v)
                      : [...form.verdicts, v])
                  }} style={{
                    flex: 1, padding: '9px 0', fontSize: 11, fontWeight: 600, fontFamily: t.fontUI,
                    cursor: 'pointer', borderRadius: t.radius,
                    border: `1px solid ${active ? (v === 'GO' ? t.bull : t.amber) : t.border}`,
                    background: active ? `${v === 'GO' ? t.bull : t.amber}18` : 'transparent',
                    color: active ? (v === 'GO' ? t.bull : t.amber) : t.textDim,
                  }}>{v}</button>
                )
              })}
            </div>
            <div style={{ fontSize: 9, color: t.textDim, fontFamily: t.fontUI, marginTop: 4 }}>
              GO = high-confidence entry · WATCH = speculative
            </div>
          </div>
        )}
      </div>

      <div style={sectionGap}>
        <label style={labelStyle}>Signal Source</label>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {sources.map(src => (
            <button key={src.id} type="button" onClick={() => upd('signal_source', src.id)} style={{
              padding: '10px 14px', cursor: 'pointer', borderRadius: t.radius, textAlign: 'left',
              border: `1px solid ${form.signal_source === src.id ? t.accent : t.border}`,
              background: form.signal_source === src.id ? t.accentBg : 'transparent',
              display: 'flex', alignItems: 'center', gap: 10,
            }}>
              <span style={{ fontSize: 18 }}>{src.icon}</span>
              <div>
                <div style={{ fontSize: 12, fontWeight: 600, color: form.signal_source === src.id ? t.accent : t.text, fontFamily: t.fontUI }}>{src.label}</div>
                <div style={{ fontSize: 9, color: t.textDim, fontFamily: t.fontUI, marginTop: 1 }}>{src.desc}</div>
              </div>
              {form.signal_source === src.id && (
                <span style={{ marginLeft: 'auto', color: t.accent, fontSize: 14 }}>✓</span>
              )}
            </button>
          ))}
        </div>
      </div>
    </>
  )

  // ── Step 1: Filters ───────────────────────────────────────────
  const renderFilters = () => {
    const isIndia  = form.market === 'india'
    const isCrypto = form.market === 'crypto'
    const src      = form.signal_source

    // ── Reusable: category toggle grid ──────────────────────────
    const CatGrid = ({ cats, label, note }) => (
      <div style={sectionGap}>
        <label style={labelStyle}>{label}</label>
        {note && <div style={{ fontSize: 9, color: t.textDim, fontFamily: t.fontUI, marginBottom: 7 }}>{note}</div>}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 5 }}>
          {cats.map(cat => {
            const active = (form.screener_categories || []).includes(cat.id)
            const col    = cat.type === 'bull' ? t.bull : cat.type === 'bear' ? t.bear : t.amber
            return (
              <button key={cat.id} type="button" onClick={() => {
                const prev = form.screener_categories || []
                upd('screener_categories', active ? prev.filter(c => c !== cat.id) : [...prev, cat.id])
              }} style={{
                padding: '7px 10px', cursor: 'pointer', borderRadius: t.radius, textAlign: 'left',
                border: `1px solid ${active ? col : t.border}`,
                background: active ? `${col}12` : 'transparent',
                color: active ? col : t.textDim,
                fontSize: 10, fontFamily: t.fontUI,
                display: 'flex', alignItems: 'center', gap: 6,
              }}>
                <span style={{ fontSize: 9 }}>{cat.type === 'bull' ? '▲' : cat.type === 'bear' ? '▼' : '◆'}</span>
                {cat.label}
              </button>
            )
          })}
        </div>
      </div>
    )

    // ── Reusable: symbol chip selector ──────────────────────────
    const SymbolPicker = ({ symbols, color, emptyLabel }) => (
      <div style={sectionGap}>
        <label style={labelStyle}>Symbols to Watch <span style={{ color: t.textDim, fontWeight: 400 }}>(leave empty for all)</span></label>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
          {symbols.map(sym => {
            const active = (form.symbols || []).includes(sym)
            return (
              <button key={sym} type="button" onClick={() => {
                const prev = form.symbols || []
                upd('symbols', active ? prev.filter(s => s !== sym) : [...prev, sym])
              }} style={{
                padding: '5px 11px', cursor: 'pointer', borderRadius: 20,
                border: `1px solid ${active ? color : t.border}`,
                background: active ? `${color}18` : 'transparent',
                color: active ? color : t.textDim,
                fontSize: 10, fontWeight: active ? 600 : 400, fontFamily: t.fontUI,
              }}>
                {isCrypto ? sym.replace('USD', '') : sym}
              </button>
            )
          })}
        </div>
        <div style={{ fontSize: 9, color: t.textDim, fontFamily: t.fontUI, marginTop: 5 }}>
          {(form.symbols || []).length === 0
            ? emptyLabel
            : `Monitoring: ${form.symbols.join(', ')}`}
        </div>
      </div>
    )

    // ── Signal Pipeline ──────────────────────────────────────────
    if (src === 'signal_pipeline') return (
      <>
        <div style={{ padding: '8px 12px', marginBottom: 14, borderRadius: t.radius,
          background: `${isIndia ? t.accent : t.purple}10`,
          border: `1px solid ${isIndia ? t.accent : t.purple}30`,
          fontSize: 9, color: isIndia ? t.accent : t.purple, fontFamily: t.fontUI,
        }}>
          {isIndia
            ? '🇮🇳 Trades NSE stocks from your India watchlist when the multi-factor LLM analysis issues a GO or WATCH verdict.'
            : '₿ Trades selected crypto pairs when the multi-factor LLM analysis issues a GO or WATCH verdict.'}
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, ...sectionGap }}>
          <div>
            <label style={labelStyle}>Minimum Conviction</label>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
              {[['HIGH', t.bull, 'Best signals only'], ['MEDIUM', t.amber, 'Good + best'], ['LOW', t.textMuted, 'All signals']].map(([c, col, hint]) => (
                <button key={c} type="button" onClick={() => upd('min_conviction', c)} style={{
                  padding: '8px 12px', cursor: 'pointer', borderRadius: t.radius, textAlign: 'left',
                  border: `1px solid ${form.min_conviction === c ? col : t.border}`,
                  background: form.min_conviction === c ? `${col}15` : 'transparent',
                  color: form.min_conviction === c ? col : t.textDim,
                  fontSize: 11, fontWeight: 600, fontFamily: t.fontUI,
                  display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                }}>
                  {c}
                  <span style={{ fontSize: 9, opacity: 0.7 }}>{hint}</span>
                </button>
              ))}
            </div>
          </div>
          <div>
            <label style={labelStyle}>Minimum Overall Score (0–10)</label>
            <input type="number" min="0" max="10" step="0.5"
              value={form.min_score} onChange={e => upd('min_score', parseFloat(e.target.value) || 0)}
              style={inputStyle} onFocus={focusBorder} onBlur={blurBorder}
            />
            <div style={{ fontSize: 9, color: t.textDim, fontFamily: t.fontUI, marginTop: 5 }}>
              Signals below this score are skipped. Recommended: 6.5+
            </div>
          </div>
        </div>

        {isCrypto && (
          <SymbolPicker
            symbols={CRYPTO_SYMBOLS} color={t.purple}
            emptyLabel="All crypto pairs in the pipeline will be monitored."
          />
        )}
        {isIndia && (
          <SymbolPicker
            symbols={INDIA_SYMBOLS} color={t.accent}
            emptyLabel="All stocks in your India watchlist will be monitored."
          />
        )}
      </>
    )

    // ── Screener — India ─────────────────────────────────────────
    if (src === 'screener' && isIndia) return (
      <>
        <div style={{ padding: '8px 12px', marginBottom: 14, borderRadius: t.radius,
          background: `${t.cyan}10`, border: `1px solid ${t.cyan}30`,
          fontSize: 9, color: t.cyan, fontFamily: t.fontUI,
        }}>
          🇮🇳 Bot enters a trade whenever a watchlisted India stock newly appears in the selected screener category. Daily categories scan twice a day; intraday categories scan every 15 min during market hours.
        </div>

        <CatGrid
          cats={INDIA_SCREENER_CATS}
          label="Daily Technical Categories"
          note="Based on EOD data — scans at 9:30 AM & 1:30 PM IST"
        />
        <CatGrid
          cats={INDIA_INTRADAY_CATS}
          label="Intraday Categories (5m / 15m)"
          note="Based on live 5-min & 15-min bars — scans every 15 min during market hours"
        />
      </>
    )

    // ── Screener — Crypto ────────────────────────────────────────
    if (src === 'screener' && isCrypto) return (
      <>
        <div style={{ padding: '8px 12px', marginBottom: 14, borderRadius: t.radius,
          background: `${t.purple}10`, border: `1px solid ${t.purple}30`,
          fontSize: 9, color: t.purple, fontFamily: t.fontUI,
        }}>
          ₿ Bot enters a trade when a selected crypto pair matches the chosen technical screener category. Note: intraday (5m/15m) categories are not available for crypto — use Confluence or RF[DW] for high-frequency crypto signals.
        </div>

        <CatGrid
          cats={CRYPTO_SCREENER_CATS}
          label="Crypto Technical Categories"
          note="RSI/EMA/volume-based daily technical signals for crypto pairs"
        />
        <SymbolPicker
          symbols={CRYPTO_SYMBOLS} color={t.purple}
          emptyLabel="All crypto pairs will be monitored for the selected categories."
        />
      </>
    )

    // ── RF[DW] — Crypto only ─────────────────────────────────────
    if (src === 'rf_dw') return (
      <>
        <div style={{ padding: '10px 12px', marginBottom: 14, background: `${t.purple}10`, border: `1px solid ${t.purple}30`, borderRadius: t.radius, fontSize: 9, color: t.purple, fontFamily: t.fontUI }}>
          ⚡ <strong>RF[DW] Reversal:</strong> Fires on ATR-based adaptive filter direction flips on 3-min bars. High-frequency strategy — set an appropriate cooldown (≥ 3 min) to avoid over-trading. Direction (BUY/SELL) is determined automatically by the signal flip.
        </div>
        <SymbolPicker
          symbols={CRYPTO_SYMBOLS} color={t.purple}
          emptyLabel="All available crypto pairs will be monitored for RF[DW] flips."
        />
      </>
    )

    // ── Confluence — Crypto only ─────────────────────────────────
    if (src === 'conf_simple') return (
      <>
        <div style={{ padding: '10px 12px', marginBottom: 14, background: `${t.amber}10`, border: `1px solid ${t.amber}30`, borderRadius: t.radius, fontSize: 9, color: t.amber, fontFamily: t.fontUI }}>
          🔀 <strong>Confluence (Simple):</strong> Fires only on STRONG BUY or STRONG SELL signals where RSI, EMA, MACD, and Volume all align. Lower frequency than RF[DW] but higher precision. Direction (BUY/SELL) is set by the confluence signal.
        </div>
        <SymbolPicker
          symbols={CRYPTO_SYMBOLS} color={t.amber}
          emptyLabel="All available crypto pairs will be monitored for confluence signals."
        />
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, ...sectionGap }}>
          <div>
            <label style={labelStyle}>Minimum Conviction</label>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
              {[['HIGH', t.bull, 'Best confluence only'], ['MEDIUM', t.amber, 'Good + best']].map(([c, col, hint]) => (
                <button key={c} type="button" onClick={() => upd('min_conviction', c)} style={{
                  padding: '8px 12px', cursor: 'pointer', borderRadius: t.radius, textAlign: 'left',
                  border: `1px solid ${form.min_conviction === c ? col : t.border}`,
                  background: form.min_conviction === c ? `${col}15` : 'transparent',
                  color: form.min_conviction === c ? col : t.textDim,
                  fontSize: 11, fontWeight: 600, fontFamily: t.fontUI,
                  display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                }}>
                  {c}
                  <span style={{ fontSize: 9, opacity: 0.7 }}>{hint}</span>
                </button>
              ))}
            </div>
          </div>
          <div>
            <label style={labelStyle}>Minimum Score (0–10)</label>
            <input type="number" min="0" max="10" step="0.5"
              value={form.min_score} onChange={e => upd('min_score', parseFloat(e.target.value) || 0)}
              style={inputStyle} onFocus={focusBorder} onBlur={blurBorder}
            />
            <div style={{ fontSize: 9, color: t.textDim, fontFamily: t.fontUI, marginTop: 5 }}>
              Recommended: 7.0+ for precision entries
            </div>
          </div>
        </div>
      </>
    )

    // ── EMA Cross 9/15 — Crypto only ─────────────────────────────
    if (src === 'ema_cross') return (
      <>
        <div style={{ padding: '10px 12px', marginBottom: 14, background: `${t.bull}10`, border: `1px solid ${t.bull}30`, borderRadius: t.radius, fontSize: 9, color: t.bull, fontFamily: t.fontUI }}>
          📊 <strong>EMA Cross 9/15:</strong> Fires when EMA(9) crosses EMA(15) on 15-min bars, confirmed by 5-min trend alignment and volume surge ≥ 1.2× average. Stop-loss and take-profit are set automatically using ATR(14). Signal is suppressed in ranging markets (ADX &lt; 20).
        </div>

        <SymbolPicker
          symbols={CRYPTO_SYMBOLS} color={t.bull}
          emptyLabel="All crypto pairs will be monitored for EMA crossover signals."
        />

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, ...sectionGap }}>
          <div>
            <label style={labelStyle}>ATR Stop Multiplier (1.0 – 2.5)</label>
            <input type="number" min="1.0" max="2.5" step="0.1"
              value={form.atr_sl_mult ?? 1.5}
              onChange={e => upd('atr_sl_mult', parseFloat(e.target.value) || 1.5)}
              style={inputStyle} onFocus={focusBorder} onBlur={blurBorder}
            />
            <div style={{ fontSize: 9, color: t.textDim, fontFamily: t.fontUI, marginTop: 5 }}>
              Stop = Entry ± ATR × this value. Lower = tighter stop.
            </div>
          </div>
          <div>
            <label style={labelStyle}>ATR Target Multiplier (2.0 – 5.0)</label>
            <input type="number" min="2.0" max="5.0" step="0.25"
              value={form.atr_tp_mult ?? 3.0}
              onChange={e => upd('atr_tp_mult', parseFloat(e.target.value) || 3.0)}
              style={inputStyle} onFocus={focusBorder} onBlur={blurBorder}
            />
            <div style={{ fontSize: 9, color: t.textDim, fontFamily: t.fontUI, marginTop: 5 }}>
              Target = Entry ± ATR × this value. R:R = TP ÷ SL multipliers.
            </div>
          </div>
        </div>

        <div style={{ padding: '8px 12px', borderRadius: t.radius, background: t.bgActive, border: `1px solid ${t.border}`, fontSize: 9, color: t.textDim, fontFamily: t.fontUI }}>
          <strong style={{ color: t.text }}>Strategy details:</strong> 15-min signal TF · 5-min entry confirmation · 1-hour ADX regime filter · ATR(14) dynamic SL/TP · Trailing stop activates at +1 ATR profit · Scans every 15 minutes.
        </div>
      </>
    )

    // ── TradingView Webhook ──────────────────────────────────────
    if (src === 'tv_webhook') return (
      <TVWebhookPanel form={form} upd={upd} bot={bot} t={t} inputStyle={inputStyle} labelStyle={labelStyle} sectionGap={sectionGap} isEdit={isEdit} />
    )

    // ── Chartink User Webhook ────────────────────────────────────
    if (src === 'chartink') return (
      <ChartinkPanel form={form} upd={upd} bot={bot} t={t} inputStyle={inputStyle} labelStyle={labelStyle} sectionGap={sectionGap} isEdit={isEdit} />
    )

    // ── Custom Conditions ────────────────────────────────────────
    if (src === 'custom_conditions') return (
      <CustomConditionsPanel form={form} upd={upd} t={t} inputStyle={inputStyle} labelStyle={labelStyle} sectionGap={sectionGap} isCrypto={isCrypto} isIndia={isIndia} />
    )

    return null
  }

  // ── Step 2: Position & Risk ────────────────────────────────────
  const renderPosition = () => (
    <>
      <div style={{ padding: '10px 12px', background: `${t.accent}10`, border: `1px solid ${t.accent}30`, borderRadius: t.radius, marginBottom: 14, fontSize: 9, color: t.accent, fontFamily: t.fontUI }}>
        Position size = <strong>Capital × Capital%</strong>, capped at Max Position. Qty = Position ÷ Entry Price.
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 14 }}>
        <div>
          <label style={labelStyle}>Base Capital (₹)</label>
          <input type="number" min="1000" step="1000" value={form.capital_inr} onChange={e => upd('capital_inr', parseFloat(e.target.value) || 0)} style={inputStyle} onFocus={focusBorder} onBlur={blurBorder} />
        </div>
        <div>
          <label style={labelStyle}>Capital per Trade (%)</label>
          <input type="number" min="0.1" max="100" step="0.1" value={form.capital_pct} onChange={e => upd('capital_pct', parseFloat(e.target.value) || 0)} style={inputStyle} onFocus={focusBorder} onBlur={blurBorder} />
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 14 }}>
        <div>
          <label style={labelStyle}>Max Position Value (₹)</label>
          <input type="number" min="1000" step="1000" value={form.max_position_inr} onChange={e => upd('max_position_inr', parseFloat(e.target.value) || 0)} style={inputStyle} onFocus={focusBorder} onBlur={blurBorder} />
        </div>
        <div>
          <label style={labelStyle}>Order Type</label>
          <div style={{ display: 'flex', gap: 6 }}>
            {['MARKET', 'LIMIT'].map(ot => (
              <button key={ot} type="button" onClick={() => upd('order_type', ot)} style={{
                flex: 1, padding: '8px 0', fontSize: 11, fontWeight: 600, fontFamily: t.fontUI,
                cursor: 'pointer', borderRadius: t.radius,
                border: `1px solid ${form.order_type === ot ? t.accent : t.border}`,
                background: form.order_type === ot ? t.accentBg : 'transparent',
                color: form.order_type === ot ? t.accent : t.textDim,
              }}>{ot}</button>
            ))}
          </div>
        </div>
      </div>

      {/* Product type */}
      <div style={{ ...sectionGap }}>
        <label style={labelStyle}>Contract Type</label>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          {(form.market === 'crypto'
            ? [
                { id: 'PERPETUAL',  hint: 'Perpetual futures — no expiry, funding rate applies' },
                { id: 'QUARTERLY',  hint: 'Quarterly futures — expires at contract date' },
              ]
            : [
                { id: 'CNC',  hint: 'Delivery — hold positions for days or weeks' },
                { id: 'MIS',  hint: 'Intraday — auto square-off before market close' },
              ]
          ).map(({ id, hint }) => (
            <button key={id} type="button" onClick={() => upd('product', id)} style={{
              padding: '8px 12px', cursor: 'pointer', borderRadius: t.radius, textAlign: 'left',
              border: `1px solid ${form.product === id ? t.accent : t.border}`,
              background: form.product === id ? t.accentBg : 'transparent',
              color: form.product === id ? t.accent : t.textDim,
              fontSize: 11, fontWeight: 600, fontFamily: t.fontUI,
              display: 'flex', justifyContent: 'space-between', alignItems: 'center',
            }}>
              {id}
              <span style={{ fontSize: 9, opacity: 0.7, textAlign: 'right', maxWidth: 200 }}>{hint}</span>
            </button>
          ))}
        </div>
      </div>

      {/* Leverage + Margin Mode — crypto futures only */}
      {form.market === 'crypto' && (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, ...sectionGap }}>
          <div>
            <label style={labelStyle}>Leverage</label>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5, marginBottom: 7 }}>
              {[1, 2, 3, 5, 10, 20, 25].map(lv => (
                <button key={lv} type="button" onClick={() => upd('leverage', lv)} style={{
                  padding: '5px 10px', cursor: 'pointer', borderRadius: t.radiusSm,
                  border: `1px solid ${form.leverage === lv ? t.amber : t.border}`,
                  background: form.leverage === lv ? `${t.amber}18` : 'transparent',
                  color: form.leverage === lv ? t.amber : t.textDim,
                  fontSize: 11, fontWeight: form.leverage === lv ? 700 : 400, fontFamily: t.fontUI,
                }}>
                  {lv}×
                </button>
              ))}
            </div>
            <input type="number" min="1" max="100" step="1" placeholder="Custom (1–100)"
              value={[1,2,3,5,10,20,25].includes(form.leverage) ? '' : form.leverage}
              onChange={e => { const v = parseInt(e.target.value); if (v >= 1 && v <= 100) upd('leverage', v) }}
              style={{ ...inputStyle, fontSize: 11 }} onFocus={focusBorder} onBlur={blurBorder}
            />
            <div style={{ fontSize: 9, color: t.textDim, fontFamily: t.fontUI, marginTop: 5 }}>
              Effective position = Capital% × Leverage. Higher leverage = higher liquidation risk.
            </div>
          </div>
          <div>
            <label style={labelStyle}>Margin Mode</label>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {[
                { id: 'isolated', label: 'Isolated',  hint: 'Only deposited margin is at risk per position' },
                { id: 'cross',    label: 'Cross',     hint: 'Full account balance backs all positions — higher liquidation risk' },
              ].map(({ id, label, hint }) => (
                <button key={id} type="button" onClick={() => upd('margin_mode', id)} style={{
                  padding: '9px 12px', cursor: 'pointer', borderRadius: t.radius, textAlign: 'left',
                  border: `1px solid ${form.margin_mode === id ? (id === 'isolated' ? t.bull : t.bear) : t.border}`,
                  background: form.margin_mode === id ? `${id === 'isolated' ? t.bull : t.bear}12` : 'transparent',
                  color: form.margin_mode === id ? (id === 'isolated' ? t.bull : t.bear) : t.textDim,
                  display: 'flex', flexDirection: 'column', gap: 2,
                }}>
                  <span style={{ fontSize: 11, fontWeight: 600, fontFamily: t.fontUI }}>{label}</span>
                  <span style={{ fontSize: 9, opacity: 0.75, fontFamily: t.fontUI }}>{hint}</span>
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Trades + Positions limits */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 14 }}>
        <div>
          <label style={labelStyle}>Max Trades / Day</label>
          <input type="number" min="1" max="50" value={form.max_daily_trades} onChange={e => upd('max_daily_trades', parseInt(e.target.value) || 1)} style={inputStyle} onFocus={focusBorder} onBlur={blurBorder} />
        </div>
        <div>
          <label style={labelStyle}>Max Open Positions</label>
          <input type="number" min="1" max="20" value={form.max_open_positions} onChange={e => upd('max_open_positions', parseInt(e.target.value) || 1)} style={inputStyle} onFocus={focusBorder} onBlur={blurBorder} />
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
        <div>
          <label style={labelStyle}>Max Daily Loss (₹)</label>
          <input type="number" min="0" step="500" value={form.max_daily_loss_inr} onChange={e => upd('max_daily_loss_inr', parseFloat(e.target.value) || 0)} style={inputStyle} onFocus={focusBorder} onBlur={blurBorder} />
        </div>
        <div>
          <label style={labelStyle}>Cooldown Between Trades (min)</label>
          <input type="number" min="0" max="1440" value={form.cooldown_minutes} onChange={e => upd('cooldown_minutes', parseInt(e.target.value) || 0)} style={inputStyle} onFocus={focusBorder} onBlur={blurBorder} />
        </div>
      </div>
    </>
  )

  // ── Step 3: Exit Rules ─────────────────────────────────────────
  const renderExit = () => (
    <>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 16 }}>
        <button type="button" onClick={() => upd('use_signal_targets', true)} style={{
          padding: '12px 14px', cursor: 'pointer', borderRadius: t.radius, textAlign: 'left',
          border: `1px solid ${form.use_signal_targets ? t.accent : t.border}`,
          background: form.use_signal_targets ? t.accentBg : 'transparent',
        }}>
          <div style={{ fontSize: 12, fontWeight: 600, color: form.use_signal_targets ? t.accent : t.text, fontFamily: t.fontUI }}>
            {form.use_signal_targets ? '✓ ' : ''}Use Signal Targets (Recommended)
          </div>
          <div style={{ fontSize: 9, color: t.textDim, fontFamily: t.fontUI, marginTop: 3 }}>
            Use T1/T2 and Stop Loss levels from the signal. For RF[DW]/Confluence bots, exit on reverse signal.
          </div>
        </button>
        <button type="button" onClick={() => upd('use_signal_targets', false)} style={{
          padding: '12px 14px', cursor: 'pointer', borderRadius: t.radius, textAlign: 'left',
          border: `1px solid ${!form.use_signal_targets ? t.accent : t.border}`,
          background: !form.use_signal_targets ? t.accentBg : 'transparent',
        }}>
          <div style={{ fontSize: 12, fontWeight: 600, color: !form.use_signal_targets ? t.accent : t.text, fontFamily: t.fontUI }}>
            {!form.use_signal_targets ? '✓ ' : ''}Custom Target / Stop Loss
          </div>
          <div style={{ fontSize: 9, color: t.textDim, fontFamily: t.fontUI, marginTop: 3 }}>
            Define fixed percentage targets and stop loss applied to all trades from this bot.
          </div>
        </button>
      </div>

      {!form.use_signal_targets && (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 14 }}>
          <div>
            <label style={labelStyle}>Target (%)</label>
            <input type="number" min="0.1" max="100" step="0.1" value={form.custom_target_pct} onChange={e => upd('custom_target_pct', parseFloat(e.target.value) || 0)} style={inputStyle} onFocus={focusBorder} onBlur={blurBorder} />
          </div>
          <div>
            <label style={labelStyle}>Stop Loss (%)</label>
            <input type="number" min="0.1" max="50" step="0.1" value={form.custom_sl_pct} onChange={e => upd('custom_sl_pct', parseFloat(e.target.value) || 0)} style={inputStyle} onFocus={focusBorder} onBlur={blurBorder} />
          </div>
        </div>
      )}

      <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 12px', background: t.bgActive, borderRadius: t.radius, border: `1px solid ${t.border}` }}>
        <button type="button" onClick={() => upd('trailing_stop', !form.trailing_stop)} style={{
          width: 36, height: 20, borderRadius: 10, cursor: 'pointer', border: 'none',
          background: form.trailing_stop ? t.bull : `${t.border}80`, position: 'relative', transition: 'background 0.2s',
        }}>
          <div style={{ position: 'absolute', top: 2, left: form.trailing_stop ? 18 : 2, width: 16, height: 16, borderRadius: '50%', background: '#fff', transition: 'left 0.2s' }} />
        </button>
        <div>
          <div style={{ fontSize: 11, fontWeight: 600, color: t.text, fontFamily: t.fontUI }}>Trailing Stop</div>
          <div style={{ fontSize: 9, color: t.textDim, fontFamily: t.fontUI }}>Locks in profits as price moves in your favour (uses signal ATR)</div>
        </div>
      </div>

      {/* Summary preview */}
      {form.name && (
        <div style={{ marginTop: 16, padding: '12px 14px', background: `${t.accent}08`, border: `1px solid ${t.accent}30`, borderRadius: t.radius }}>
          <div style={{ fontSize: 10, fontWeight: 700, color: t.accent, fontFamily: t.fontUI, marginBottom: 6 }}>Bot Summary</div>
          <div style={{ fontSize: 9, color: t.textMuted, fontFamily: t.fontUI, lineHeight: 1.8 }}>
            <strong style={{ color: t.text }}>{form.name}</strong>
            {' · '}<span style={{ color: form.market === 'crypto' ? t.purple : t.accent }}>{form.market === 'india' ? '🇮🇳 India' : '₿ Crypto'}</span>
            {' · '}{sourceBadge(form.signal_source, t).label}
            {form.signal_source === 'signal_pipeline' && (
              <><br/>Trades on <strong style={{ color: t.text }}>{form.verdicts.join('/')} </strong> signals · conviction <strong style={{ color: t.text }}>{form.min_conviction}+</strong> · score ≥ <strong style={{ color: t.text }}>{form.min_score}</strong></>
            )}
            {form.signal_source === 'screener' && (form.screener_categories || []).length > 0 && (
              <><br/>Watches categories: <strong style={{ color: t.text }}>{form.screener_categories.slice(0, 3).join(', ')}{form.screener_categories.length > 3 ? ` +${form.screener_categories.length - 3} more` : ''}</strong></>
            )}
            {(form.signal_source === 'rf_dw' || form.signal_source === 'conf_simple') && (
              <><br/>Symbols: <strong style={{ color: t.text }}>{(form.symbols || []).length ? form.symbols.map(s => s.replace('USD','')).join(', ') : 'All crypto'}</strong></>
            )}
            <br/>Position: <strong style={{ color: t.text }}>{form.capital_pct}%</strong> of ₹{(form.capital_inr / 1000).toFixed(0)}K (max ₹{(form.max_position_inr / 1000).toFixed(0)}K) · {form.order_type} · {form.product}
            <br/>Limits: <strong style={{ color: t.text }}>{form.max_daily_trades}</strong> trades/day · <strong style={{ color: t.text }}>{form.cooldown_minutes}min</strong> cooldown · max loss ₹{form.max_daily_loss_inr.toLocaleString()}
            <br/>Exit: {form.use_signal_targets ? 'Signal targets (T1/SL)' : `Target ${form.custom_target_pct}% / SL ${form.custom_sl_pct}%`}{form.trailing_stop ? ' + Trailing stop' : ''}
          </div>
        </div>
      )}
    </>
  )

  const steps = [renderBasics, renderFilters, renderPosition, renderExit]

  const needsVerdicts = form.signal_source === 'signal_pipeline'

  const canNext = () => {
    if (step === 0) return (
      form.name.trim().length > 0 &&
      (!needsVerdicts || form.verdicts.length > 0)
    )
    if (step === 1) {
      if (form.signal_source === 'screener') return (form.screener_categories || []).length > 0
      return true
    }
    return true
  }

  return (
    <>
      <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.65)', backdropFilter: 'blur(4px)', zIndex: 900 }} />
      <div className="fade-in" style={{
        position: 'fixed', top: '50%', left: '50%', transform: 'translate(-50%,-50%)',
        zIndex: 901, width: 560, maxHeight: '92vh',
        background: t.bgCard, border: `1px solid ${t.border}`,
        borderTop: `3px solid ${t.accent}`,
        borderRadius: t.radiusLg, boxShadow: t.shadowLg,
        display: 'flex', flexDirection: 'column', overflow: 'hidden',
      }}>
        {/* Header */}
        <div style={{ padding: '14px 18px', borderBottom: `1px solid ${t.border}`, display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexShrink: 0 }}>
          <div>
            <div style={{ fontSize: 14, fontWeight: 700, color: t.text, fontFamily: t.fontUI }}>
              🤖 {isEdit ? 'Configure Bot' : 'New Trading Bot'}
            </div>
            <div style={{ fontSize: 9, color: t.textDim, fontFamily: t.fontUI, marginTop: 2 }}>Step {step + 1} of {STEPS.length} — {STEPS[step]}</div>
          </div>
          <button onClick={onClose} style={{ background: 'none', border: 'none', color: t.textMuted, fontSize: 20, cursor: 'pointer', lineHeight: 1 }}>×</button>
        </div>

        {/* Step indicator */}
        <div style={{ display: 'flex', padding: '10px 18px', gap: 6, borderBottom: `1px solid ${t.border}`, flexShrink: 0 }}>
          {STEPS.map((label, i) => (
            <button key={i} type="button" onClick={() => { if (i < step || canNext()) setStep(i) }} style={{
              flex: 1, padding: '6px 0', fontSize: 9, fontWeight: 600, fontFamily: t.fontUI,
              cursor: 'pointer', borderRadius: t.radius, border: 'none',
              background: i === step ? t.accent : i < step ? `${t.accent}30` : t.bgActive,
              color: i === step ? '#fff' : i < step ? t.accent : t.textDim,
            }}>{label}</button>
          ))}
        </div>

        {/* Content */}
        <div style={{ flex: 1, overflowY: 'auto', padding: '18px 18px' }}>
          {steps[step]()}
        </div>

        {/* Footer */}
        <div style={{ padding: '12px 18px', borderTop: `1px solid ${t.border}`, display: 'flex', gap: 10, flexShrink: 0 }}>
          {step > 0 && (
            <button type="button" onClick={() => setStep(s => s - 1)} style={{
              padding: '10px 20px', fontSize: 12, fontWeight: 600, fontFamily: t.fontUI,
              cursor: 'pointer', borderRadius: t.radius, border: `1px solid ${t.border}`, background: 'transparent', color: t.textMuted,
            }}>← Back</button>
          )}
          <button type="button" style={{ flex: 1 }} />
          {step < STEPS.length - 1 ? (
            <button type="button" onClick={() => canNext() && setStep(s => s + 1)} disabled={!canNext()} style={{
              padding: '10px 24px', fontSize: 12, fontWeight: 700, fontFamily: t.fontUI,
              cursor: canNext() ? 'pointer' : 'not-allowed',
              borderRadius: t.radius, border: 'none',
              background: canNext() ? t.accent : `${t.accent}40`,
              color: '#fff', opacity: canNext() ? 1 : 0.6,
            }}>Next →</button>
          ) : (
            <button type="button" onClick={() => {
              if (!form.name.trim()) return toast.error('Bot name is required')
              if (needsVerdicts && !form.verdicts.length) return toast.error('Select at least one verdict (GO or WATCH)')
              onSave(form)
            }} style={{
              padding: '10px 24px', fontSize: 12, fontWeight: 700, fontFamily: t.fontUI,
              cursor: 'pointer', borderRadius: t.radius, border: 'none',
              background: t.bull, color: '#fff', boxShadow: `0 4px 14px ${t.bull}40`,
            }}>
              {isEdit ? '✓ Save Changes' : '✓ Create Bot'}
            </button>
          )}
        </div>
      </div>
    </>
  )
}

// ─── Main Page ─────────────────────────────────────────────────────

export default function BotsPage() {
  const t  = useTheme()
  const qc = useQueryClient()

  const [tab,         setTab]         = useState('bots')     // bots | agents
  const [marketFilter, setMarketFilter] = useState('all')    // all | india | crypto
  const [editingBot,  setEditingBot]  = useState(null)       // null | 'new' | bot object
  const [showExecs,   setShowExecs]   = useState(false)

  // ── Agent pipeline trigger ───────────────────────────────────
  const { data: pipelineData, refetch: refetchPipeline } = useQuery({
    queryKey: ['indiaPipelineStatus'],
    queryFn: getIndiaPipelineStatus,
    refetchInterval: (data) => data?.status === 'running' ? 4_000 : 60_000,
  })
  const pipelineRunning = pipelineData?.status === 'running'
  const { mutate: triggerPipeline, isPending: triggeringPipeline } = useMutation({
    mutationFn: runIndiaPipeline,
    onSuccess: () => { toast.success('India pipeline started'); setTimeout(() => refetchPipeline(), 1000) },
    onError: () => toast.error('Failed to trigger pipeline'),
  })

  // ── Data fetching ────────────────────────────────────────────
  const { data: botsData, isLoading } = useQuery({
    queryKey: ['bots'],
    queryFn:  getBots,
    staleTime: 30_000,
    refetchInterval: 30_000,
  })
  const bots = botsData?.bots || []
  const migrationSql = botsData?.migration_needed || null

  const { data: execsData } = useQuery({
    queryKey: ['botExecutions'],
    queryFn:  getBotExecutions,
    staleTime: 10_000,
    refetchInterval: 30_000,
    enabled: showExecs,
  })
  const executions = execsData?.executions || []

  // Refresh bots + executions immediately when a WS bot_execution or
  // position_reversal event fires (bumps botExecTick in the store).
  const botExecTick = useDataStore((s) => s.botExecTick)
  useEffect(() => {
    if (botExecTick === 0) return
    qc.invalidateQueries({ queryKey: ['bots'] })
    qc.invalidateQueries({ queryKey: ['botExecutions'] })
  }, [botExecTick, qc])

  // ── Mutations ────────────────────────────────────────────────
  const createMut = useMutation({
    mutationFn: createBot,
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['bots'] }); toast.success('Bot created'); setEditingBot(null) },
    onError:   (e) => toast.error(e?.response?.data?.detail || 'Failed to create bot'),
  })

  const updateMut = useMutation({
    mutationFn: ({ id, data }) => updateBot(id, data),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['bots'] }); toast.success('Bot updated'); setEditingBot(null) },
    onError:   (e) => toast.error(e?.response?.data?.detail || 'Failed to update bot'),
  })

  const toggleMut = useMutation({
    mutationFn: ({ id, enabled }) => toggleBot(id, enabled),
    onSuccess: (updated) => {
      qc.setQueryData(['bots'], old => ({
        ...old,
        bots: (old?.bots || []).map(b => b.id === updated.id ? updated : b),
      }))
      toast.success(updated.enabled ? 'Bot enabled' : 'Bot paused')
    },
    onError: (e) => toast.error(e?.response?.data?.detail || 'Toggle failed'),
  })

  const deleteMut = useMutation({
    mutationFn: deleteBot,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['bots'] })
      toast.success('Bot deleted')
    },
    onError: (e) => toast.error(e?.response?.data?.detail || 'Delete failed'),
  })

  const handleSave = useCallback((form) => {
    if (editingBot?.id) {
      updateMut.mutate({ id: editingBot.id, data: form })
    } else {
      createMut.mutate(form)
    }
  }, [editingBot, createMut, updateMut])

  // ── Filtered bots ────────────────────────────────────────────
  const filtered = useMemo(() => {
    if (marketFilter === 'all') return bots
    return bots.filter(b => b.market === marketFilter)
  }, [bots, marketFilter])

  const activeBots  = bots.filter(b => b.enabled).length
  const tradesToday = bots.reduce((s, b) => s + (b.stats?.trades_today || 0), 0)
  const pnlToday    = bots.reduce((s, b) => s + (b.stats?.pnl_today || 0), 0)

  // ── Tab pill style ───────────────────────────────────────────
  const tabBtn = (id, label) => (
    <button key={id} onClick={() => setTab(id)} style={{
      padding: '8px 20px', fontSize: 11, fontWeight: tab === id ? 700 : 400, fontFamily: t.fontUI,
      cursor: 'pointer', borderRadius: t.radius, border: 'none',
      background: tab === id ? t.accent : 'transparent',
      color: tab === id ? '#fff' : t.textMuted,
      transition: 'all 0.15s',
    }}>{label}</button>
  )

  // ── Render ───────────────────────────────────────────────────
  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0, overflow: 'hidden', background: t.bg }}>

      {/* Modals */}
      {editingBot !== null && (
        <BotModal
          bot={editingBot === 'new' ? null : editingBot}
          onClose={() => setEditingBot(null)}
          onSave={handleSave}
          t={t}
        />
      )}

      {/* Page header */}
      <div style={{ padding: '12px 20px', borderBottom: `1px solid ${t.border}`, flexShrink: 0, background: t.bgPanel || t.bgCard }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <div style={{ width: 36, height: 36, borderRadius: 10, background: `${t.accent}18`, border: `1px solid ${t.accent}30`, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 18 }}>🤖</div>
            <div>
              <div style={{ fontSize: 16, fontWeight: 800, color: t.text, fontFamily: t.fontUI, letterSpacing: -0.3 }}>Trading Bots</div>
              <div style={{ fontSize: 9, color: t.textDim, fontFamily: t.fontUI, marginTop: 1 }}>Auto-execution · Signal-driven · Risk-gated</div>
            </div>
          </div>

          <div style={{ display: 'flex', gap: 8 }}>
            <button
              onClick={() => setShowExecs(s => !s)}
              style={{
                padding: '8px 14px', fontSize: 11, fontWeight: 600, fontFamily: t.fontUI, cursor: 'pointer',
                borderRadius: t.radius, border: `1px solid ${showExecs ? t.amber : t.border}`,
                background: showExecs ? `${t.amber}15` : 'transparent', color: showExecs ? t.amber : t.textMuted,
              }}
            >Executions</button>
            {tab === 'agents' && (
              <button
                onClick={() => triggerPipeline()}
                disabled={triggeringPipeline || pipelineRunning}
                style={{
                  padding: '8px 16px', fontSize: 11, fontWeight: 700, fontFamily: t.fontUI,
                  cursor: (triggeringPipeline || pipelineRunning) ? 'not-allowed' : 'pointer',
                  borderRadius: t.radius, border: `1px solid ${pipelineRunning ? '#F59E0B55' : '#10B98155'}`,
                  background: pipelineRunning ? 'rgba(245,158,11,0.1)' : 'rgba(16,185,129,0.1)',
                  color: pipelineRunning ? '#F59E0B' : '#10B981',
                  opacity: (triggeringPipeline || pipelineRunning) ? 0.7 : 1,
                }}
              >
                {pipelineRunning ? '⏳ Running…' : triggeringPipeline ? '⏳ Starting…' : '▶ Run Pipeline'}
              </button>
            )}
            {tab === 'bots' && (
              <button
                onClick={() => setEditingBot('new')}
                style={{
                  padding: '8px 18px', fontSize: 11, fontWeight: 700, fontFamily: t.fontUI, cursor: 'pointer',
                  borderRadius: t.radius, border: 'none', background: t.accent, color: '#fff',
                  boxShadow: `0 4px 14px ${t.accent}40`,
                }}
              >+ New Bot</button>
            )}
          </div>
        </div>

        {/* Tab + summary row */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div style={{ display: 'flex', gap: 4, background: t.bgActive, padding: 3, borderRadius: t.radius }}>
            {tabBtn('bots',   '🤖 Bots')}
            {tabBtn('agents', '🧠 Agent Monitor')}
          </div>

          {tab === 'bots' && (
            <div style={{ display: 'flex', gap: 16, alignItems: 'center' }}>
              {[
                { label: 'Active', value: activeBots,  color: activeBots > 0 ? t.bull : t.textMuted },
                { label: 'Trades Today', value: tradesToday, color: t.text },
                { label: 'P&L Today',  value: pnlToday >= 0 ? `+₹${pnlToday.toFixed(0)}` : `-₹${Math.abs(pnlToday).toFixed(0)}`, color: pnlToday >= 0 ? t.bull : t.bear },
              ].map(({ label, value, color }) => (
                <div key={label} style={{ textAlign: 'right' }}>
                  <div style={{ fontSize: 9, color: t.textDim, fontFamily: t.fontUI }}>{label}</div>
                  <div style={{ fontSize: 14, fontWeight: 700, color, fontFamily: t.fontUI }}>{value}</div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Executions panel */}
      {showExecs && tab === 'bots' && (
        <div style={{ flexShrink: 0, borderBottom: `1px solid ${t.border}`, maxHeight: 220, overflowY: 'auto', background: t.bgCard }}>
          <div style={{ padding: '8px 14px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', borderBottom: `1px solid ${t.border}`, position: 'sticky', top: 0, background: t.bgCard, zIndex: 1 }}>
            <span style={{ fontSize: 11, fontWeight: 700, color: t.text, fontFamily: t.fontUI }}>Recent Executions</span>
            <span style={{ fontSize: 9, color: t.textDim, fontFamily: t.fontUI }}>{executions.length} records</span>
          </div>
          {executions.length === 0 ? (
            <div style={{ padding: '24px 14px', textAlign: 'center', fontSize: 11, color: t.textMuted, fontFamily: t.fontUI }}>No executions yet — enable a bot to start auto-trading.</div>
          ) : (
            <>
              {/* Header */}
              <div style={{ display: 'grid', gridTemplateColumns: '90px 80px 50px 50px 80px 80px 70px 1fr', gap: 4, padding: '5px 14px', borderBottom: `1px solid ${t.border}` }}>
                {['Time', 'Symbol', 'Side', 'Qty', 'Price', 'Source', 'Conviction', 'Bot'].map(h => (
                  <span key={h} style={{ fontSize: 8, fontWeight: 600, color: t.textDim, fontFamily: t.fontUI, letterSpacing: 0.4, textTransform: 'uppercase' }}>{h}</span>
                ))}
              </div>
              {executions.map(ex => <ExecRow key={ex.id} exec={ex} t={t} />)}
            </>
          )}
        </div>
      )}

      {/* Content */}
      {tab === 'agents' ? (
        <div style={{ flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
          <AgentLivePage />
        </div>
      ) : (
        <div style={{ flex: 1, overflowY: 'auto', padding: 20 }}>
          {/* Market filter pills */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 18 }}>
            {[['all', 'All Bots'], ['india', '🇮🇳 India'], ['crypto', '₿ Crypto']].map(([id, label]) => (
              <button key={id} onClick={() => setMarketFilter(id)} style={{
                padding: '5px 14px', fontSize: 11, fontWeight: marketFilter === id ? 600 : 400, fontFamily: t.fontUI,
                cursor: 'pointer', borderRadius: 20,
                border: `1px solid ${marketFilter === id ? t.accent : t.border}`,
                background: marketFilter === id ? t.accentBg : 'transparent',
                color: marketFilter === id ? t.accent : t.textMuted,
              }}>{label}</button>
            ))}
            <span style={{ marginLeft: 'auto', fontSize: 9, color: t.textDim, fontFamily: t.fontUI }}>
              {filtered.length} bot{filtered.length !== 1 ? 's' : ''}
            </span>
          </div>

          {/* Migration warning banner */}
          {migrationSql && (
            <div style={{
              padding: '12px 16px', borderRadius: t.radius, marginBottom: 12,
              background: `${t.bear}12`, border: `1px solid ${t.bear}40`,
              display: 'flex', alignItems: 'flex-start', gap: 10,
            }}>
              <span style={{ fontSize: 18, flexShrink: 0 }}>⚠️</span>
              <div>
                <div style={{ fontSize: 11, fontWeight: 700, color: t.bear, fontFamily: t.fontUI, marginBottom: 4 }}>
                  Database migration needed — bots won't survive server restarts
                </div>
                <div style={{ fontSize: 9, color: t.textMuted, fontFamily: t.fontUI, marginBottom: 6 }}>
                  Run this SQL in your Supabase → SQL Editor to permanently fix bot persistence:
                </div>
                <code style={{
                  display: 'block', padding: '6px 10px', background: t.bgActive,
                  borderRadius: t.radius, fontSize: 9, color: t.cyan,
                  fontFamily: 'monospace', userSelect: 'all',
                }}>
                  {migrationSql}
                </code>
              </div>
            </div>
          )}

          {/* Loading */}
          {isLoading && (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))', gap: 14 }}>
              {[1, 2].map(i => (
                <div key={i} style={{ height: 220, background: t.bgCard, border: `1px solid ${t.border}`, borderRadius: t.radiusLg, animation: 'pulse 1.5s ease-in-out infinite' }} />
              ))}
            </div>
          )}

          {/* Empty state */}
          {!isLoading && bots.length === 0 && (
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: '80px 20px', gap: 14 }}>
              <div style={{ fontSize: 48 }}>🤖</div>
              <div style={{ fontSize: 18, fontWeight: 700, color: t.text, fontFamily: t.fontUI }}>No bots configured</div>
              <div style={{ fontSize: 12, color: t.textMuted, fontFamily: t.fontUI, textAlign: 'center', maxWidth: 400 }}>
                Create a trading bot to auto-execute trades based on your signal pipeline, RF[DW], screener, or confluence signals.
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, width: '100%', maxWidth: 480, marginTop: 10 }}>
                {[
                  { emoji: '🧠', title: 'India GO Bot', desc: 'Auto-trade HIGH conviction GO signals from Signal Pipeline', market: 'india', source: 'signal_pipeline' },
                  { emoji: '⚡', title: 'BTC RF[DW] Bot', desc: 'Trade BTC on ATR-based RF[DW] reversal signals', market: 'crypto', source: 'rf_dw' },
                  { emoji: '📈', title: 'Screener Bot', desc: 'Enter when stocks match Bullish Breakout screener', market: 'india', source: 'screener' },
                  { emoji: '🔀', title: 'Confluence Bot', desc: 'Crypto STRONG BUY/SELL confluence signals', market: 'crypto', source: 'conf_simple' },
                ].map(preset => (
                  <button key={preset.title} onClick={() => setEditingBot('new')} style={{
                    padding: '14px', cursor: 'pointer', borderRadius: t.radiusLg, textAlign: 'left',
                    border: `1px solid ${t.border}`, background: t.bgCard,
                    transition: 'border-color 0.15s',
                  }}
                  onMouseEnter={e => e.currentTarget.style.borderColor = t.accent}
                  onMouseLeave={e => e.currentTarget.style.borderColor = t.border}
                  >
                    <div style={{ fontSize: 20, marginBottom: 6 }}>{preset.emoji}</div>
                    <div style={{ fontSize: 11, fontWeight: 700, color: t.text, fontFamily: t.fontUI }}>{preset.title}</div>
                    <div style={{ fontSize: 9, color: t.textDim, fontFamily: t.fontUI, marginTop: 3 }}>{preset.desc}</div>
                  </button>
                ))}
              </div>
              <button
                onClick={() => setEditingBot('new')}
                style={{
                  marginTop: 8, padding: '10px 28px', fontSize: 12, fontWeight: 700, fontFamily: t.fontUI,
                  cursor: 'pointer', borderRadius: t.radiusLg, border: 'none',
                  background: t.accent, color: '#fff', boxShadow: `0 4px 14px ${t.accent}40`,
                }}
              >+ Create First Bot</button>
            </div>
          )}

          {/* Bot grid */}
          {!isLoading && filtered.length > 0 && (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))', gap: 14 }}>
              {filtered.map(bot => (
                <BotCard
                  key={bot.id}
                  bot={bot}
                  t={t}
                  onEdit={setEditingBot}
                  onDelete={(id) => deleteMut.mutate(id)}
                  onToggle={(id, enabled) => toggleMut.mutate({ id, enabled })}
                />
              ))}
            </div>
          )}

          {/* No filtered results but bots exist */}
          {!isLoading && bots.length > 0 && filtered.length === 0 && (
            <div style={{ padding: '60px 20px', textAlign: 'center', fontSize: 11, color: t.textMuted, fontFamily: t.fontUI }}>
              No {marketFilter} bots. <button onClick={() => setEditingBot('new')} style={{ color: t.accent, background: 'none', border: 'none', cursor: 'pointer', fontSize: 11, fontFamily: t.fontUI }}>+ Create one</button>
            </div>
          )}
        </div>
      )}

      <style>{`@keyframes pulse { 0%,100%{opacity:1} 50%{opacity:0.5} }`}</style>
    </div>
  )
}
