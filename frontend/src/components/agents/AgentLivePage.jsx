// src/components/agents/AgentLivePage.jsx
// Agent Monitor — India Analysis Pipeline view + live decision feed.

import { useEffect, useRef, useState, useMemo, useCallback } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { getAgentsStatus, getIndiaPipelineStatus, runIndiaPipeline, refreshScreener, refreshRfDw, refreshConfSimple, fmtIST } from '../../lib/api'
import { useDataStore, useTheme } from '../../store'
import { supabase } from '../../lib/supabase'

const _DEV_MODE = import.meta.env.VITE_DEV_MODE === 'true'
const LS_LAST_LOGS_KEY = 'india_pipeline_last_run_logs'

const LEVEL_COLORS = {
  DEBUG:    '#64748B',
  INFO:     '#3B82F6',
  SUCCESS:  '#10B981',
  WARNING:  '#F59E0B',
  ERROR:    '#EF4444',
  CRITICAL: '#DC2626',
}

// Market scanners — run 24/7, detect real-time signals
const SCANNER_AGENTS = [
  {
    key:       'screener_agent',
    label:     'Stock Screener',
    color:     '#F97316',
    desc:      'Classifies all India stocks into technical categories · runs at 9:30 AM & 1:30 PM IST',
    interval:  '9:30 & 13:30 IST',
    schedKey:  'screener',
    triggerFn: refreshScreener,
  },
  {
    key:       'rf_dw_agent',
    label:     'RF [DW]',
    color:     '#8B5CF6',
    desc:      'Rate-of-Change [Donchian Width] momentum scanner for crypto — detects trend strength',
    interval:  '3m',
    schedKey:  'rf_dw',
    triggerFn: refreshRfDw,
  },
  {
    key:       'conf_simple_agent',
    label:     'Conf Signals',
    color:     '#A855F7',
    desc:      'Confirmation signals for crypto breakouts using multi-indicator consensus',
    interval:  '5m',
    schedKey:  'conf_simple',
    triggerFn: refreshConfSimple,
  },
]

// Core system agents — execution backbone
const SYSTEM_AGENTS = [
  {
    key:   'signal_pipeline',
    label: 'Signal Pipeline',
    color: '#3B82F6',
    desc:  'Combines chart pattern + fundamental scores to generate GO / WATCH verdicts',
    interval: '11:15 / 13:45 IST',
    schedKey: 'india_signal',
  },
  {
    key:   'risk_guardian',
    label: 'Risk Guardian',
    color: '#F59E0B',
    desc:  'Monitors open positions against stop-loss and max-loss limits; triggers soft-kill on breach',
    interval: 'Continuous',
    schedKey: null,
  },
]

// All agents (for log coloring and Decision Feed filter)
const ALL_AGENTS = [
  ...SCANNER_AGENTS,
  ...SYSTEM_AGENTS,
  { key: 'chart_pattern_agent',   label: 'Chart Pattern', color: '#10B981' },
  { key: 'fundamentals_agent',    label: 'Fundamentals',  color: '#06B6D4' },
  { key: 'india_sentiment_agent', label: 'Sentiment',     color: '#EC4899' },
  { key: 'india_pipeline',        label: 'India Pipeline',color: '#10B981' },
]

const TASKS = [
  { key: 'india_pipeline', label: 'India Analysis Pipeline', interval: '09:30 IST · on-demand', highlight: true },
  { key: 'screener',       label: 'Stock Screener',          interval: '9:30 & 13:30 IST'   },
  { key: 'rf_dw',          label: 'RF[DW] Scanner',          interval: '3m · 24/7'    },
  { key: 'conf_simple',    label: 'Conf Signals',            interval: '5m · 24/7'    },
  { key: 'crypto_chart',   label: 'Crypto Chart Scan',       interval: '30m · 24/7'   },
  { key: 'crypto_signal',  label: 'Crypto Signal Run',       interval: '2h · 24/7'    },
]

// ── Shared primitives ─────────────────────────────────────────────
function Card({ children, style = {} }) {
  const t = useTheme()
  return (
    <div style={{
      background: t.bgCard, border: `1px solid ${t.border}`,
      borderRadius: t.radiusLg, padding: '14px 16px',
      boxShadow: t.shadowCard, ...style,
    }}>
      {children}
    </div>
  )
}

function SectionLabel({ children, t, style = {} }) {
  return (
    <div style={{
      fontSize: 10, fontWeight: 600, letterSpacing: 0.8,
      color: t.textMuted, fontFamily: t.fontUI,
      textTransform: 'uppercase', marginBottom: 10,
      ...style,
    }}>
      {children}
    </div>
  )
}

function GroupHeader({ label, desc, t }) {
  return (
    <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, marginBottom: 10 }}>
      <span style={{
        fontSize: 10, fontWeight: 700, letterSpacing: 0.8,
        color: t.textMuted, fontFamily: t.fontUI, textTransform: 'uppercase',
      }}>{label}</span>
      <span style={{ fontSize: 10, color: t.textDim, fontFamily: t.fontUI }}>— {desc}</span>
    </div>
  )
}

// ── India Analysis Pipeline ───────────────────────────────────────

const PIPELINE_STAGES = [
  {
    key:   'chart_pattern',
    label: 'Chart Pattern',
    sub:   'Technical patterns + indicators for all watchlist stocks',
    color: '#10B981',
    icon:  '📊',
  },
  {
    key:   'fundamentals',
    label: 'Fundamentals',
    sub:   'Valuation · Growth · Quality · Momentum (runs if >7d stale)',
    color: '#06B6D4',
    icon:  '🏛',
  },
  {
    key:   'sentiment',
    label: 'Sentiment',
    sub:   'India news · VIX · NIFTY trend · FII/DII flows',
    color: '#EC4899',
    icon:  '📰',
  },
]

function stageStatusColor(status, t) {
  switch (status) {
    case 'complete': return '#10B981'
    case 'running':  return '#F59E0B'
    case 'error':    return '#EF4444'
    case 'skipped':  return '#64748B'
    default:         return t.textDim
  }
}

function stageIcon(status) {
  switch (status) {
    case 'complete': return '✓'
    case 'running':  return '⟳'
    case 'error':    return '✗'
    case 'skipped':  return '○'
    default:         return '·'
  }
}

function PipelineStageNode({ stage, stageData, isActive, t }) {
  const status  = stageData?.status || 'pending'
  const color   = isActive && status === 'running' ? '#F59E0B' : stageStatusColor(status, t)
  const isRun   = status === 'running'

  return (
    <div style={{
      flex: 1, background: t.bg,
      border: `1px solid ${color}${status === 'pending' ? '20' : '45'}`,
      borderTop: `3px solid ${color}`,
      borderRadius: t.radiusLg,
      padding: '12px 14px',
      boxShadow: isRun ? `0 0 12px ${color}30` : 'none',
      transition: 'box-shadow 0.3s',
      minWidth: 0,
    }}>
      {/* Stage header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginBottom: 8 }}>
        <span style={{ fontSize: 14 }}>{stage.icon}</span>
        <span style={{ fontSize: 11, fontWeight: 700, color, fontFamily: t.fontUI }}>{stage.label}</span>
        <span className={isRun ? 'pulse' : ''} style={{
          marginLeft: 'auto', fontSize: 12, color, fontWeight: 700, lineHeight: 1,
        }}>{stageIcon(status)}</span>
      </div>

      {/* Stage sub-label */}
      <div style={{
        fontSize: 9, color: t.textDim, fontFamily: t.fontUI,
        lineHeight: 1.5, marginBottom: 10,
      }}>{stage.sub}</div>

      {/* Stage stats */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
        {status === 'pending' && (
          <span style={{ fontSize: 10, color: t.textDim, fontFamily: t.fontUI }}>Waiting…</span>
        )}
        {status === 'running' && (
          <span style={{ fontSize: 10, color: '#F59E0B', fontFamily: t.fontUI }}>Running…</span>
        )}
        {status === 'complete' && (
          <>
            {stageData.symbols    != null && <StatRow label="Symbols"  val={stageData.symbols}    t={t} />}
            {stageData.news_items != null && <StatRow label="News"     val={`${stageData.news_items} items`} t={t} />}
            {stageData.duration_s != null && <StatRow label="Duration" val={`${stageData.duration_s}s`} t={t} color={t.textDim} />}
          </>
        )}
        {status === 'skipped' && (
          <span style={{ fontSize: 10, color: '#64748B', fontFamily: t.fontUI, fontStyle: 'italic' }}>
            {stageData.reason || 'Skipped'}
          </span>
        )}
        {status === 'error' && (
          <span style={{
            fontSize: 9, color: '#EF4444', fontFamily: t.fontUI,
            overflow: 'hidden', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical',
          }}>
            {stageData.error || 'Unknown error'}
          </span>
        )}
      </div>
    </div>
  )
}

function StatRow({ label, val, t, color }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
      <span style={{ fontSize: 9, color: t.textDim, fontFamily: t.fontUI }}>{label}</span>
      <span style={{ fontSize: 10, fontWeight: 600, color: color || t.text, fontFamily: t.font }}>{val}</span>
    </div>
  )
}

function PipelineConnector({ t, active }) {
  return (
    <div style={{
      display: 'flex', alignItems: 'center', flexShrink: 0,
      padding: '0 4px',
    }}>
      <div style={{
        width: 32, height: 2,
        background: active
          ? `linear-gradient(90deg, #10B98188, #F59E0B88)`
          : `${t.border}`,
        borderRadius: 1,
        position: 'relative',
      }} />
      <div style={{
        width: 0, height: 0,
        borderLeft: `6px solid ${active ? '#F59E0B88' : t.border}`,
        borderTop: '4px solid transparent',
        borderBottom: '4px solid transparent',
        flexShrink: 0,
      }} />
    </div>
  )
}

function IndiaPipelinePanel({ pipeline, onTrigger, triggering, lastRunLogs, t }) {
  const [logsOpen, setLogsOpen] = useState(false)
  const status    = pipeline?.status || 'idle'
  const isRunning = status === 'running'
  const stages    = pipeline?.stages || {}
  const currentStage = pipeline?.current_stage

  const statusColor = {
    idle:     t.textDim,
    running:  '#F59E0B',
    complete: '#10B981',
    error:    '#EF4444',
  }[status] || t.textDim

  const statusLabel = {
    idle:     'Idle',
    running:  `Running — ${currentStage?.replace('_', ' ') || '…'}`,
    complete: 'Complete',
    error:    'Completed with errors',
  }[status] || 'Idle'

  const fmtDT = (iso) => {
    if (!iso) return '—'
    try {
      return new Date(iso).toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', second: '2-digit' }) + ' IST'
    } catch { return iso }
  }

  return (
    <Card style={{ padding: 0, overflow: 'hidden' }}>
      {/* Panel header */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 10,
        padding: '11px 16px',
        borderBottom: `1px solid ${t.border}`,
        background: `${statusColor}08`,
      }}>
        {/* Title + schedule */}
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontSize: 12, fontWeight: 700, color: t.text, fontFamily: t.fontUI }}>
              India Analysis Pipeline
            </span>
            <span style={{
              fontSize: 9, color: t.textDim, fontFamily: t.fontUI,
              background: `rgba(255,255,255,0.05)`, borderRadius: 4, padding: '2px 7px',
            }}>
              Scheduled 09:30 IST
            </span>
          </div>
          <div style={{
            display: 'flex', alignItems: 'center', gap: 10, marginTop: 3,
          }}>
            <span className={isRunning ? 'pulse' : ''} style={{
              width: 6, height: 6, borderRadius: '50%',
              background: statusColor, display: 'inline-block', flexShrink: 0,
            }} />
            <span style={{ fontSize: 10, color: statusColor, fontFamily: t.fontUI }}>{statusLabel}</span>
            {pipeline?.started_at && (
              <span style={{ fontSize: 9, color: t.textDim, fontFamily: t.font }}>
                started {fmtDT(pipeline.started_at)}
              </span>
            )}
            {pipeline?.completed_at && !isRunning && (
              <span style={{ fontSize: 9, color: t.textDim, fontFamily: t.font }}>
                · done {fmtDT(pipeline.completed_at)}
              </span>
            )}
          </div>
        </div>

        {/* Trigger button */}
        <button
          onClick={onTrigger}
          disabled={triggering || isRunning}
          style={{
            marginLeft: 'auto',
            background: (triggering || isRunning) ? 'rgba(255,255,255,0.05)' : `#10B98120`,
            border: `1px solid ${(triggering || isRunning) ? t.border : '#10B98155'}`,
            color: (triggering || isRunning) ? t.textDim : '#10B981',
            fontSize: 10, fontWeight: 700, padding: '6px 14px',
            borderRadius: t.radius, cursor: (triggering || isRunning) ? 'not-allowed' : 'pointer',
            fontFamily: t.fontUI, letterSpacing: 0.3, flexShrink: 0,
            transition: 'all 0.2s',
          }}
        >
          {triggering ? '…' : isRunning ? '⟳ Running' : '▶ Run Pipeline'}
        </button>
      </div>

      {/* Pipeline nodes */}
      <div style={{ display: 'flex', alignItems: 'stretch', padding: '16px', gap: 4 }}>
        {PIPELINE_STAGES.map((stage, i) => (
          <>
            <PipelineStageNode
              key={stage.key}
              stage={stage}
              stageData={stages[stage.key]}
              isActive={currentStage === stage.key}
              t={t}
            />
            {i < PIPELINE_STAGES.length - 1 && (
              <PipelineConnector
                key={`conn-${i}`}
                t={t}
                active={isRunning && currentStage === PIPELINE_STAGES[i + 1]?.key}
              />
            )}
          </>
        ))}
      </div>

      {/* Last run logs toggle */}
      {lastRunLogs?.length > 0 && (
        <div style={{ borderTop: `1px solid ${t.border}` }}>
          <button
            onClick={() => setLogsOpen(o => !o)}
            style={{
              width: '100%', display: 'flex', alignItems: 'center', gap: 8,
              padding: '8px 16px', background: 'none', border: 'none',
              cursor: 'pointer', textAlign: 'left',
            }}
          >
            <span style={{ fontSize: 9, color: t.textDim, transform: logsOpen ? 'rotate(90deg)' : 'none', display: 'inline-block', transition: 'transform 0.15s' }}>▶</span>
            <span style={{ fontSize: 10, color: t.textMuted, fontFamily: t.fontUI }}>
              Last Run Logs
            </span>
            <span style={{
              fontSize: 9, color: t.textDim,
              background: 'rgba(255,255,255,0.05)', borderRadius: 10, padding: '1px 7px',
              fontFamily: t.font,
            }}>{lastRunLogs.length} entries</span>
          </button>
          {logsOpen && (
            <div style={{ borderTop: `1px solid ${t.border}20`, maxHeight: 260, overflowY: 'auto' }}>
              {lastRunLogs.map((entry, i) => (
                <LogRow key={i} entry={entry} t={t} compact />
              ))}
            </div>
          )}
        </div>
      )}
    </Card>
  )
}

// ── Budget bar ────────────────────────────────────────────────────
function BudgetBar({ cost, budget, t }) {
  const pct   = budget > 0 ? Math.min((cost / budget) * 100, 100) : 0
  const color = pct > 80 ? '#EF4444' : pct > 60 ? '#F59E0B' : '#10B981'
  return (
    <Card>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 8 }}>
        <span style={{ fontSize: 11, fontWeight: 600, color: t.textMuted, fontFamily: t.fontUI }}>LLM Daily Budget</span>
        <span style={{ fontSize: 13, fontWeight: 700, color, fontFamily: t.font }}>
          ₹{cost.toFixed(2)} <span style={{ fontSize: 10, color: t.textDim, fontWeight: 400 }}>/ ₹{budget.toFixed(0)}</span>
        </span>
      </div>
      <div style={{ height: 6, background: 'rgba(255,255,255,0.06)', borderRadius: 10, overflow: 'hidden' }}>
        <div style={{
          width: `${pct}%`, height: '100%', borderRadius: 10,
          background: `linear-gradient(90deg, ${color}cc, ${color})`,
          transition: 'width 0.6s ease',
          boxShadow: `0 0 8px ${color}60`,
        }} />
      </div>
      <div style={{ fontSize: 9, color: t.textDim, fontFamily: t.font, marginTop: 4, textAlign: 'right' }}>
        {pct.toFixed(1)}% used
      </div>
    </Card>
  )
}

// ── Metric card ───────────────────────────────────────────────────
function MetCard({ label, value, color, sub, t }) {
  return (
    <Card>
      <div style={{ fontSize: 10, color: t.textDim, fontFamily: t.fontUI, marginBottom: 6 }}>{label}</div>
      <div style={{ fontSize: 22, fontWeight: 700, color: color || t.text, fontFamily: t.font, lineHeight: 1 }}>{value ?? '—'}</div>
      {sub && <div style={{ fontSize: 10, color: t.textMuted, fontFamily: t.fontUI, marginTop: 4 }}>{sub}</div>}
    </Card>
  )
}

// ── Scheduler table ───────────────────────────────────────────────
function Scheduler({ lastScans, signals, t }) {
  return (
    <Card>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
        <SectionLabel t={t}>Scheduler</SectionLabel>
        <span style={{ fontSize: 10, color: t.textDim, fontFamily: t.font }}>
          {signals?.go ?? 0} GO · {signals?.watch ?? 0} WATCH
        </span>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
        {TASKS.map(task => {
          const lastRun = lastScans?.[task.key]
          const hi = task.highlight
          return (
            <div key={task.key} style={{
              display: 'grid', gridTemplateColumns: '1fr 110px 90px',
              padding: '5px 0', borderBottom: `1px solid ${t.border}`,
              alignItems: 'center',
              background: hi ? '#10B98108' : 'transparent',
              borderRadius: hi ? 4 : 0,
            }}>
              <span style={{
                fontSize: 11, color: hi ? '#10B981' : t.text,
                fontFamily: t.fontUI, fontWeight: hi ? 700 : 400,
              }}>{task.label}</span>
              <span style={{ fontSize: 10, color: t.textDim, fontFamily: t.font }}>{task.interval}</span>
              <span style={{ fontSize: 10, textAlign: 'right', fontFamily: t.font, color: lastRun ? '#10B981' : t.textDim }}>
                {lastRun || '—'}
              </span>
            </div>
          )
        })}
      </div>
    </Card>
  )
}

// ── RF[DW] state panel ────────────────────────────────────────────
function RfDwPanel({ rfDw, t }) {
  if (!rfDw || !Object.keys(rfDw).length) return null
  return (
    <Card>
      <SectionLabel t={t}>RF [DW] Current State</SectionLabel>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 6 }}>
        {Object.entries(rfDw).map(([sym, d]) => {
          const isBuy = d.signal === 'BUY'
          const color = isBuy ? '#10B981' : '#EF4444'
          return (
            <div key={sym} style={{
              padding: '8px 10px', borderRadius: t.radius,
              background: `${color}0A`, border: `1px solid ${color}25`,
            }}>
              <div style={{ fontSize: 10, color: t.textMuted, fontFamily: t.fontUI, marginBottom: 3 }}>
                {sym.replace('USD', '')}
              </div>
              <div style={{ fontSize: 13, fontWeight: 700, color, fontFamily: t.font }}>
                {d.signal || '—'}
              </div>
              <div style={{ fontSize: 9, color: t.textDim, fontFamily: t.font, marginTop: 2 }}>
                {d.ts ? fmtIST(d.ts) : '—'}
              </div>
            </div>
          )
        })}
      </div>
    </Card>
  )
}

// ── Agent status card (with purpose description) ─────────────────
function AgentCard({ agent, logs, lastScans, onTrigger, triggering, t }) {
  const myLogs  = useMemo(() => logs.filter(l => l.module === agent.key), [logs, agent.key])
  const recent  = useMemo(() => [...myLogs].slice(-3).reverse(), [myLogs])
  const lastLog = recent[0]
  const isActive = !!lastLog
  const lastRun  = agent.schedKey ? lastScans?.[agent.schedKey] : null

  return (
    <div style={{
      background: t.bgCard, borderRadius: t.radiusLg,
      border: `1px solid ${isActive ? agent.color + '35' : t.border}`,
      overflow: 'hidden', boxShadow: t.shadowCard,
    }}>
      {/* Color accent bar */}
      <div style={{ height: 3, background: isActive ? `linear-gradient(90deg, ${agent.color}, ${agent.color}44)` : t.border }} />
      <div style={{ padding: '11px 14px' }}>

        {/* Header: name + pulse + trigger button */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
            <span className={isActive ? 'pulse' : ''} style={{
              width: 7, height: 7, borderRadius: '50%', flexShrink: 0,
              background: isActive ? agent.color : t.textDim, display: 'inline-block',
            }} />
            <span style={{ fontSize: 11, fontWeight: 700, color: isActive ? agent.color : t.textMuted, fontFamily: t.fontUI }}>
              {agent.label}
            </span>
            {agent.interval && (
              <span style={{
                fontSize: 8, color: t.textDim, fontFamily: t.font,
                background: 'rgba(255,255,255,0.05)', borderRadius: 3, padding: '1px 5px',
              }}>{agent.interval}</span>
            )}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <span style={{ fontSize: 9, color: t.textDim, fontFamily: t.font }}>
              {lastLog?.ts || (lastRun ? lastRun : 'idle')}
            </span>
            {onTrigger && (
              <button
                onClick={onTrigger}
                disabled={triggering}
                style={{
                  background: triggering ? 'rgba(255,255,255,0.04)' : `${agent.color}18`,
                  border: `1px solid ${triggering ? t.border : agent.color + '55'}`,
                  color: triggering ? t.textDim : agent.color,
                  fontSize: 9, fontWeight: 700, padding: '3px 9px',
                  borderRadius: t.radius, cursor: triggering ? 'not-allowed' : 'pointer',
                  fontFamily: t.fontUI, flexShrink: 0, transition: 'all 0.2s',
                }}
              >
                {triggering ? '⟳' : '▶ Run'}
              </button>
            )}
          </div>
        </div>

        {/* Purpose description */}
        {agent.desc && (
          <div style={{
            fontSize: 9, color: t.textDim, fontFamily: t.fontUI,
            lineHeight: 1.5, marginBottom: 8,
            paddingLeft: 14,
          }}>{agent.desc}</div>
        )}

        {/* Recent log entries */}
        <div style={{ minHeight: 36 }}>
          {recent.length === 0 ? (
            <span style={{ fontSize: 10, color: t.textDim, fontFamily: t.fontUI, fontStyle: 'italic', paddingLeft: 14 }}>
              {lastRun ? `Last run: ${lastRun}` : 'No recent activity'}
            </span>
          ) : recent.map((log, i) => {
            const lc = LEVEL_COLORS[log.level] || t.textDim
            return (
              <div key={i} style={{ display: 'flex', gap: 6, marginBottom: 4, alignItems: 'flex-start' }}>
                <span style={{
                  fontSize: 8, fontWeight: 700, color: lc,
                  background: `${lc}15`, borderRadius: 3, padding: '1px 4px', flexShrink: 0,
                }}>{log.level.slice(0, 4)}</span>
                <span style={{
                  fontSize: 10, color: i === 0 ? t.text : t.textDim,
                  fontFamily: t.fontUI, lineHeight: 1.4,
                  overflow: 'hidden', display: '-webkit-box',
                  WebkitLineClamp: 2, WebkitBoxOrient: 'vertical',
                }}>{log.msg}</span>
              </div>
            )
          })}
        </div>

        <div style={{ marginTop: 6, fontSize: 9, color: t.textDim, fontFamily: t.font }}>
          {myLogs.length} event{myLogs.length !== 1 ? 's' : ''} this session
        </div>
      </div>
    </div>
  )
}

// ── Log row ───────────────────────────────────────────────────────
function LogRow({ entry, t, compact = false }) {
  const agent      = ALL_AGENTS.find(a => a.key === entry.module)
  const lc         = LEVEL_COLORS[entry.level] || t.textDim
  const hi         = ['SUCCESS', 'WARNING', 'ERROR', 'CRITICAL'].includes(entry.level)

  return (
    <div style={{
      display: 'flex', gap: 8, alignItems: 'flex-start',
      padding: compact ? '4px 12px' : '6px 14px',
      borderBottom: `1px solid ${t.border}08`,
      background: hi ? `${lc}06` : 'transparent',
      borderLeft: `2px solid ${hi ? lc : 'transparent'}`,
    }}>
      <span style={{
        fontSize: 9, fontWeight: 700, color: lc,
        background: `${lc}12`, borderRadius: 4, padding: '1px 5px', flexShrink: 0,
        fontFamily: t.font,
      }}>{entry.level}</span>
      <span style={{ flex: 1, fontSize: 10, color: hi ? t.text : t.textMuted, fontFamily: t.fontUI, lineHeight: 1.5 }}>
        {entry.msg}
      </span>
      <span style={{ fontSize: 9, color: t.textDim, fontFamily: t.font, flexShrink: 0, paddingTop: 1 }}>
        {entry.ts}
      </span>
    </div>
  )
}

// ── Group consecutive same-agent logs ─────────────────────────────
function groupLogs(logs) {
  const blocks = []
  for (const entry of logs) {
    const last = blocks[blocks.length - 1]
    if (last && last.agentKey === entry.module) {
      last.entries.push(entry)
      last.endTs = entry.ts
      if (['ERROR', 'CRITICAL'].includes(entry.level)) last.hasError = true
      if (entry.level === 'WARNING') last.hasWarning = true
      if (entry.level === 'SUCCESS') last.hasSuccess = true
    } else {
      blocks.push({
        id: `${entry.module}_${entry.ts}_${blocks.length}`,
        agentKey: entry.module,
        entries: [entry],
        startTs: entry.ts,
        endTs: entry.ts,
        hasError:   ['ERROR', 'CRITICAL'].includes(entry.level),
        hasWarning: entry.level === 'WARNING',
        hasSuccess: entry.level === 'SUCCESS',
      })
    }
  }
  return blocks
}

// ── Execution block ───────────────────────────────────────────────
function AgentBlock({ block, forceExpand, t }) {
  const [open, setOpen] = useState(false)
  const expanded = forceExpand || open

  const agent      = ALL_AGENTS.find(a => a.key === block.agentKey)
  const agentColor = agent?.color || t.textDim
  const agentLabel = agent?.label || block.agentKey
  const count      = block.entries.length
  const lastEntry  = block.entries[block.entries.length - 1]

  const statusColor = block.hasError ? LEVEL_COLORS.ERROR
    : block.hasWarning ? LEVEL_COLORS.WARNING
    : block.hasSuccess ? LEVEL_COLORS.SUCCESS
    : agentColor

  const levelCounts = block.entries.reduce((acc, e) => {
    acc[e.level] = (acc[e.level] || 0) + 1
    return acc
  }, {})

  return (
    <div style={{
      border: `1px solid ${statusColor}28`,
      borderLeft: `3px solid ${statusColor}`,
      borderRadius: t.radiusLg,
      background: t.bgCard, overflow: 'hidden', marginBottom: 6,
      boxShadow: block.hasError ? `0 0 0 1px ${statusColor}18` : 'none',
    }}>
      <button
        onClick={() => setOpen(o => !o)}
        style={{
          width: '100%', display: 'flex', alignItems: 'center', gap: 10,
          padding: '8px 12px', background: 'none', border: 'none', cursor: 'pointer', textAlign: 'left',
        }}
      >
        <span style={{
          fontSize: 9, color: t.textDim, flexShrink: 0,
          transform: expanded ? 'rotate(90deg)' : 'none', transition: 'transform 0.15s',
          display: 'inline-block', lineHeight: 1,
        }}>▶</span>

        <span style={{
          fontSize: 9, fontWeight: 700, color: agentColor,
          background: `${agentColor}14`, border: `1px solid ${agentColor}30`,
          borderRadius: 4, padding: '2px 8px', flexShrink: 0, minWidth: 90, textAlign: 'center',
          fontFamily: t.fontUI,
        }}>{agentLabel}</span>

        <span style={{
          fontSize: 9, color: t.textDim, background: 'rgba(255,255,255,0.05)',
          borderRadius: 10, padding: '1px 7px', flexShrink: 0, fontFamily: t.font,
        }}>{count} log{count !== 1 ? 's' : ''}</span>

        <div style={{ display: 'flex', gap: 4, flexShrink: 0 }}>
          {Object.entries(levelCounts)
            .sort((a, b) => ['CRITICAL','ERROR','WARNING','SUCCESS','INFO','DEBUG'].indexOf(a[0]) - ['CRITICAL','ERROR','WARNING','SUCCESS','INFO','DEBUG'].indexOf(b[0]))
            .map(([lvl, n]) => {
              const lc = LEVEL_COLORS[lvl] || t.textDim
              return (
                <span key={lvl} style={{
                  fontSize: 8, fontWeight: 700, color: lc,
                  background: `${lc}14`, borderRadius: 3, padding: '1px 5px', fontFamily: t.font,
                }}>{lvl.slice(0, 4)} ×{n}</span>
              )
            })}
        </div>

        {!expanded && (
          <span style={{
            flex: 1, fontSize: 10, color: t.textMuted, fontFamily: t.fontUI,
            overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis',
          }}>{lastEntry.msg}</span>
        )}

        <span style={{ fontSize: 9, color: t.textDim, flexShrink: 0, fontFamily: t.font, marginLeft: 'auto' }}>
          {block.startTs === block.endTs ? block.startTs : `${block.startTs} → ${block.endTs}`}
        </span>
      </button>

      {expanded && (
        <div style={{ borderTop: `1px solid ${t.border}20` }}>
          {block.entries.map((entry, i) => <LogRow key={i} entry={entry} t={t} compact />)}
        </div>
      )}
    </div>
  )
}

// ── Screener Pipeline Panel ───────────────────────────────────────

const SCREENER_STAGES = [
  {
    key:   'data_fetch',
    label: 'Data Fetch',
    sub:   '~120 NSE + 6 crypto · OHLCV daily bars',
    color: '#F97316',
    icon:  '📡',
    detail: ['120 India symbols', '6 crypto pairs', 'Kite / Binance'],
  },
  {
    key:   'india_tech',
    label: 'India Technical',
    sub:   'RSI · EMA 50/200 · MACD · Bollinger · ATR · Vol MA',
    color: '#10B981',
    icon:  '📊',
    detail: ['Daily bars', 'RSI(14)', 'EMA cross', 'BB(20,2)'],
  },
  {
    key:   'india_intraday',
    label: 'India Intraday',
    sub:   '4H / 15m / 5m · VWAP · Pivot R1/S1',
    color: '#06B6D4',
    icon:  '⏱',
    detail: ['4H high/low', '5m bars', 'VWAP bands', 'Pivot R1/S1'],
  },
  {
    key:   'crypto_scan',
    label: 'Crypto Scan',
    sub:   '1h bars · BTC ETH SOL BNB XRP AVAX',
    color: '#8B5CF6',
    icon:  '₿',
    detail: ['1h bars', '6 pairs', 'Same indicators'],
  },
  {
    key:   'categorize',
    label: 'Categorize',
    sub:   '13 India + 8 crypto category buckets',
    color: '#3B82F6',
    icon:  '🏷',
    detail: ['Breakout/Bounce', 'Golden/Death X', 'Gap/Volume', 'Oversold/OB'],
  },
  {
    key:   'bot_dispatch',
    label: 'Bot Dispatch',
    sub:   'Push category matches to listening bots',
    color: '#F59E0B',
    icon:  '🚀',
    detail: ['WS broadcast', 'Supabase upsert', 'Bot filter match'],
  },
]

function ScreenerStageNode({ stage, t, isFirst, isLast }) {
  return (
    <div style={{
      flex: 1, minWidth: 0,
      background: t.bgCard,
      border: `1px solid ${stage.color}30`,
      borderTop: `3px solid ${stage.color}`,
      borderRadius: t.radiusLg,
      padding: '12px 13px',
      boxShadow: `0 2px 12px ${stage.color}12`,
      position: 'relative',
    }}>
      {/* Step number badge */}
      <div style={{
        position: 'absolute', top: -10, left: 12,
        background: stage.color, color: '#000',
        fontSize: 8, fontWeight: 800, fontFamily: t.font,
        padding: '1px 6px', borderRadius: 8,
      }}>
        {SCREENER_STAGES.indexOf(stage) + 1}
      </div>

      {/* Icon + label */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginBottom: 6, marginTop: 4 }}>
        <span style={{ fontSize: 15 }}>{stage.icon}</span>
        <span style={{ fontSize: 11, fontWeight: 700, color: stage.color, fontFamily: t.fontUI }}>
          {stage.label}
        </span>
      </div>

      {/* Sub-description */}
      <div style={{
        fontSize: 9, color: t.textDim, fontFamily: t.fontUI,
        lineHeight: 1.5, marginBottom: 8,
      }}>{stage.sub}</div>

      {/* Detail pills */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 3 }}>
        {stage.detail.map(d => (
          <span key={d} style={{
            fontSize: 8, padding: '1px 6px',
            background: `${stage.color}12`,
            border: `1px solid ${stage.color}25`,
            borderRadius: 4, color: stage.color,
            fontFamily: t.font,
          }}>{d}</span>
        ))}
      </div>
    </div>
  )
}

function ScreenerConnector({ t, fromColor, toColor }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', flexShrink: 0, padding: '0 2px', gap: 0, marginTop: 12 }}>
      <div style={{
        width: 24, height: 2,
        background: `linear-gradient(90deg, ${fromColor}80, ${toColor}80)`,
        borderRadius: 1,
      }} />
      <div style={{
        width: 0, height: 0,
        borderLeft: `5px solid ${toColor}80`,
        borderTop: '3px solid transparent',
        borderBottom: '3px solid transparent',
        flexShrink: 0,
      }} />
    </div>
  )
}

function ScreenerPipelinePanel({ onTrigger, triggering, lastScans, t }) {
  const lastRun = lastScans?.screener

  return (
    <Card style={{ padding: 0, overflow: 'visible' }}>
      {/* Panel header */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 10,
        padding: '11px 16px',
        borderBottom: `1px solid ${t.border}`,
        background: 'rgba(249,115,22,0.05)',
      }}>
        <span style={{ fontSize: 14 }}>📈</span>
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontSize: 12, fontWeight: 700, color: t.text, fontFamily: t.fontUI }}>
              Stock Screener Pipeline
            </span>
            <span style={{
              fontSize: 9, color: t.textDim, fontFamily: t.fontUI,
              background: 'rgba(255,255,255,0.05)', borderRadius: 4, padding: '2px 7px',
            }}>9:30 AM & 1:30 PM IST · Mon–Fri</span>
          </div>
          <div style={{ fontSize: 10, color: t.textDim, fontFamily: t.fontUI, marginTop: 2 }}>
            {lastRun ? `Last run: ${lastRun}` : '6-stage scan · 120 India stocks + 6 crypto pairs'}
          </div>
        </div>

        <button
          onClick={onTrigger}
          disabled={triggering}
          style={{
            marginLeft: 'auto',
            background: triggering ? 'rgba(255,255,255,0.05)' : 'rgba(249,115,22,0.15)',
            border: `1px solid ${triggering ? t.border : '#F9731655'}`,
            color: triggering ? t.textDim : '#F97316',
            fontSize: 10, fontWeight: 700, padding: '6px 14px',
            borderRadius: t.radius, cursor: triggering ? 'not-allowed' : 'pointer',
            fontFamily: t.fontUI, letterSpacing: 0.3, flexShrink: 0,
            transition: 'all 0.2s',
          }}
        >
          {triggering ? '⟳ Running…' : '▶ Run Screener'}
        </button>
      </div>

      {/* Pipeline flow */}
      <div style={{ padding: '20px 16px 16px', overflow: 'auto' }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 0, minWidth: 640 }}>
          {SCREENER_STAGES.map((stage, i) => (
            <div key={stage.key} style={{ display: 'flex', alignItems: 'center', flex: 1, minWidth: 0 }}>
              <ScreenerStageNode stage={stage} t={t} isFirst={i === 0} isLast={i === SCREENER_STAGES.length - 1} />
              {i < SCREENER_STAGES.length - 1 && (
                <ScreenerConnector
                  t={t}
                  fromColor={stage.color}
                  toColor={SCREENER_STAGES[i + 1].color}
                />
              )}
            </div>
          ))}
        </div>

        {/* Legend row */}
        <div style={{ display: 'flex', gap: 16, marginTop: 12, paddingTop: 10, borderTop: `1px solid ${t.border}` }}>
          {[
            { label: 'Input', color: '#F97316', desc: 'Raw OHLCV market data' },
            { label: 'Analysis', color: '#10B981', desc: 'Technical indicators computed' },
            { label: 'Output', color: '#F59E0B', desc: 'Signals dispatched to bots' },
          ].map(item => (
            <div key={item.label} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <div style={{ width: 8, height: 8, borderRadius: '50%', background: item.color, flexShrink: 0 }} />
              <span style={{ fontSize: 9, color: t.textDim, fontFamily: t.fontUI }}>
                <span style={{ color: item.color, fontWeight: 600 }}>{item.label}</span> — {item.desc}
              </span>
            </div>
          ))}
        </div>
      </div>
    </Card>
  )
}

// ── Page ──────────────────────────────────────────────────────────
export default function AgentLivePage() {
  const t             = useTheme()
  const qc            = useQueryClient()
  const logBottomRef  = useRef(null)
  const logScrollRef  = useRef(null)
  const prevPipelineStatus = useRef(null)

  const [autoScroll,  setAutoScroll]  = useState(true)
  const [filterLevel, setFilterLevel] = useState('ALL')
  const [filterAgent, setFilterAgent] = useState('ALL')
  const [wsStatus,    setWsStatus]    = useState('connecting')
  const [viewMode,    setViewMode]    = useState('grouped')
  const [expandAll,   setExpandAll]   = useState(false)
  const [lastRunLogs, setLastRunLogs] = useState(() => {
    try { return JSON.parse(localStorage.getItem(LS_LAST_LOGS_KEY) || '[]') } catch { return [] }
  })

  const agentLogs      = useDataStore(s => s.agentLogs)
  const agentStatus    = useDataStore(s => s.agentStatus)
  const addAgentLog    = useDataStore(s => s.addAgentLog)
  const prependLogs    = useDataStore(s => s.prependAgentLogs)
  const setAgentStatus = useDataStore(s => s.setAgentStatus)

  // ── Poll agents status (30s) ──────────────────────────────────
  const { data: statusData } = useQuery({
    queryKey: ['agentsStatus'], queryFn: getAgentsStatus, refetchInterval: 30_000,
  })
  useEffect(() => { if (statusData) setAgentStatus(statusData) }, [statusData, setAgentStatus])
  const status = agentStatus || statusData

  // ── Poll pipeline status — fast when running, slow otherwise ──
  const { data: pipelineData, refetch: refetchPipeline } = useQuery({
    queryKey: ['indiaPipelineStatus'],
    queryFn: getIndiaPipelineStatus,
    refetchInterval: (data) => data?.status === 'running' ? 4_000 : 30_000,
    initialData: status?.india_pipeline,
  })

  const pipeline = pipelineData || status?.india_pipeline || { status: 'idle' }

  // ── Persist last-run logs when pipeline transitions to complete ─
  useEffect(() => {
    const prev = prevPipelineStatus.current
    const curr = pipeline?.status
    if (prev === 'running' && (curr === 'complete' || curr === 'error')) {
      const pipelineLogs = agentLogs.filter(l => l.is_agent).slice(-200)
      localStorage.setItem(LS_LAST_LOGS_KEY, JSON.stringify(pipelineLogs))
      setLastRunLogs(pipelineLogs)
      // Refresh agents status to get updated last_scans
      qc.invalidateQueries({ queryKey: ['agentsStatus'] })
    }
    prevPipelineStatus.current = curr
  }, [pipeline?.status, agentLogs, qc])

  // ── Trigger mutations ─────────────────────────────────────────
  const { mutate: triggerPipeline, isPending: triggering } = useMutation({
    mutationFn: runIndiaPipeline,
    onSuccess: () => { setTimeout(() => refetchPipeline(), 800) },
  })

  const { mutate: triggerScreener, isPending: triggeringScreener } = useMutation({
    mutationFn: refreshScreener,
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['agentsStatus'] }) },
  })

  const { mutate: triggerRfDw, isPending: triggeringRfDw } = useMutation({
    mutationFn: refreshRfDw,
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['agentsStatus'] }) },
  })

  const { mutate: triggerConfSimple, isPending: triggeringConfSimple } = useMutation({
    mutationFn: refreshConfSimple,
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['agentsStatus'] }) },
  })

  const scannerTriggers = {
    screener_agent:    { fn: triggerScreener,   pending: triggeringScreener   },
    rf_dw_agent:       { fn: triggerRfDw,        pending: triggeringRfDw       },
    conf_simple_agent: { fn: triggerConfSimple,  pending: triggeringConfSimple },
  }

  // ── WebSocket: agent log stream ───────────────────────────────
  useEffect(() => {
    let ws = null; let closed = false
    async function connect() {
      const wsHost = import.meta.env.VITE_WS_HOST || window.location.host
      const proto  = window.location.protocol === 'https:' ? 'wss' : 'ws'
      let token    = 'dev-admin-token'
      if (!_DEV_MODE) {
        const { data: { session } } = await supabase.auth.getSession()
        token = session?.access_token || ''
      }
      ws = new WebSocket(`${proto}://${wsHost}/ws/agent-logs?token=${token}`)
      setWsStatus('connecting')
      ws.onopen  = () => setWsStatus('connected')
      ws.onclose = () => { setWsStatus('disconnected'); if (!closed) setTimeout(connect, 5000) }
      ws.onerror = () => setWsStatus('error')
      ws.onmessage = e => {
        try {
          const msg = JSON.parse(e.data)
          if (msg.type === 'history')             prependLogs(msg.logs || [])
          else if (msg.type === 'log' && msg.entry) addAgentLog(msg.entry)
        } catch {}
      }
    }
    connect()
    return () => { closed = true; ws?.close() }
  }, [addAgentLog, prependLogs])

  // ── Auto-scroll decision feed ─────────────────────────────────
  // Scroll the log container itself — never the outer page scroll area.
  useEffect(() => {
    if (autoScroll && logScrollRef.current) {
      logScrollRef.current.scrollTop = logScrollRef.current.scrollHeight
    }
  }, [agentLogs, autoScroll])

  const feedLogs = useMemo(() => agentLogs.filter(e => {
    if (!e.is_agent) return false
    if (filterLevel !== 'ALL' && e.level !== filterLevel) return false
    if (filterAgent !== 'ALL' && e.module !== filterAgent) return false
    return true
  }), [agentLogs, filterLevel, filterAgent])

  const groupedBlocks = useMemo(() => groupLogs(feedLogs), [feedLogs])

  const wsColor = { connected: '#10B981', connecting: '#F59E0B', disconnected: '#EF4444', error: '#EF4444' }[wsStatus] || t.textDim

  const btnStyle = (active) => ({
    background: active ? `${t.accent}18` : 'rgba(255,255,255,0.04)',
    border: `1px solid ${active ? t.accent + '55' : t.border}`,
    color: active ? t.accent : t.textMuted,
    fontSize: 10, padding: '5px 11px', cursor: 'pointer',
    borderRadius: t.radius, fontFamily: t.fontUI,
  })

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', background: t.bg }}>

      {/* Page header */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 12,
        padding: '12px 20px', borderBottom: `1px solid ${t.border}`,
        background: t.bgPanel, flexShrink: 0,
      }}>
        <div>
          <div style={{ fontSize: 15, fontWeight: 700, color: t.text, fontFamily: t.fontUI }}>Agent Monitor</div>
          <div style={{ fontSize: 11, color: t.textDim, fontFamily: t.fontUI, marginTop: 1 }}>
            India Analysis Pipeline · Live decision feed
          </div>
        </div>
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 8, alignItems: 'center' }}>
          <div style={{
            display: 'flex', alignItems: 'center', gap: 6,
            padding: '5px 12px', borderRadius: 20,
            background: `${wsColor}10`, border: `1px solid ${wsColor}28`,
            fontSize: 10, color: wsColor, fontFamily: t.fontUI,
          }}>
            <span className="pulse" style={{ width: 6, height: 6, borderRadius: '50%', background: wsColor, display: 'inline-block' }} />
            WS {wsStatus.toUpperCase()}
          </div>
          <button
            onClick={() => setAutoScroll(a => !a)}
            style={{
              background: autoScroll ? `#10B98118` : 'rgba(255,255,255,0.05)',
              border: `1px solid ${autoScroll ? '#10B98155' : t.border}`,
              color: autoScroll ? '#10B981' : t.textMuted,
              fontSize: 10, padding: '5px 12px', cursor: 'pointer',
              borderRadius: t.radius, fontFamily: t.fontUI,
            }}
          >{autoScroll ? '⏬ AUTO' : '⏸ PAUSED'}</button>
        </div>
      </div>

      {/* Scrollable content */}
      <div style={{ flex: 1, overflowY: 'auto' }}>
        <div style={{ padding: '16px 20px', display: 'flex', flexDirection: 'column', gap: 14 }}>

          {/* Budget bar */}
          {status?.llm && <BudgetBar cost={status.llm.cost_today_inr} budget={status.llm.budget_inr} t={t} />}

          {/* Status metric cards */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 10 }}>
            <MetCard label="Open Signals"  value={status?.signals?.total} color={t.accent} t={t} />
            <MetCard label="GO Signals"    value={status?.signals?.go}    color="#10B981"  t={t} />
            <MetCard label="Watch Signals" value={status?.signals?.watch} color="#F59E0B"  t={t} />
            <MetCard label="Agent Events"  value={feedLogs.length}        color="#8B5CF6"  t={t} />
          </div>

          {/* ── India Analysis Pipeline ── */}
          <IndiaPipelinePanel
            pipeline={pipeline}
            onTrigger={triggerPipeline}
            triggering={triggering}
            lastRunLogs={lastRunLogs}
            t={t}
          />

          {/* Scheduler + RF[DW] */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
            <Scheduler lastScans={status?.last_scans} signals={status?.signals} t={t} />
            {status?.rf_dw && <RfDwPanel rfDw={status.rf_dw} t={t} />}
          </div>

          {/* ── Stock Screener Pipeline ── */}
          <ScreenerPipelinePanel
            onTrigger={() => triggerScreener()}
            triggering={triggeringScreener}
            lastScans={status?.last_scans}
            t={t}
          />

          {/* Market Scanners — real-time signal detection */}
          <div>
            <GroupHeader label="Market Scanners" desc="Real-time signal detection, run 24/7" t={t} />
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 10 }}>
              {SCANNER_AGENTS.map(agent => {
                const trig = scannerTriggers[agent.key]
                return (
                  <AgentCard
                    key={agent.key}
                    agent={agent}
                    logs={agentLogs}
                    lastScans={status?.last_scans}
                    onTrigger={trig ? () => trig.fn() : undefined}
                    triggering={trig?.pending}
                    t={t}
                  />
                )
              })}
            </div>
          </div>

          {/* System Agents — execution backbone */}
          <div>
            <GroupHeader label="System Agents" desc="Signal generation and position risk management" t={t} />
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2,1fr)', gap: 10 }}>
              {SYSTEM_AGENTS.map(agent => (
                <AgentCard key={agent.key} agent={agent} logs={agentLogs} lastScans={status?.last_scans} t={t} />
              ))}
            </div>
          </div>

        </div>

        {/* Decision feed */}
        <div style={{ borderTop: `1px solid ${t.border}`, background: t.bgPanel }}>
          <div style={{
            display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap',
            padding: '10px 16px', borderBottom: `1px solid ${t.border}`,
          }}>
            <span style={{ fontSize: 12, fontWeight: 600, color: t.text, fontFamily: t.fontUI, marginRight: 4 }}>
              Decision Feed
            </span>

            <div style={{ display: 'flex', borderRadius: t.radius, overflow: 'hidden', border: `1px solid ${t.border}` }}>
              <button onClick={() => setViewMode('grouped')} style={{ ...btnStyle(viewMode === 'grouped'), borderRadius: 0, borderRight: `1px solid ${t.border}` }}>
                ⊞ Grouped
              </button>
              <button onClick={() => setViewMode('flat')} style={{ ...btnStyle(viewMode === 'flat'), borderRadius: 0 }}>
                ≡ Flat
              </button>
            </div>

            <select
              value={filterAgent} onChange={e => setFilterAgent(e.target.value)}
              style={{
                background: t.bgCard, border: `1px solid ${t.border}`, color: t.text,
                fontSize: 11, padding: '5px 10px', borderRadius: t.radius,
                fontFamily: t.fontUI, cursor: 'pointer', outline: 'none',
              }}
            >
              <option value="ALL">All Agents</option>
              {ALL_AGENTS.map(a => <option key={a.key} value={a.key}>{a.label}</option>)}
            </select>

            <select
              value={filterLevel} onChange={e => setFilterLevel(e.target.value)}
              style={{
                background: t.bgCard, border: `1px solid ${t.border}`, color: t.text,
                fontSize: 11, padding: '5px 10px', borderRadius: t.radius,
                fontFamily: t.fontUI, cursor: 'pointer', outline: 'none',
              }}
            >
              {['ALL', 'DEBUG', 'INFO', 'WARNING', 'ERROR'].map(l => <option key={l}>{l}</option>)}
            </select>

            {viewMode === 'grouped' && (
              <>
                <button onClick={() => setExpandAll(true)}  style={btnStyle(false)}>Expand All</button>
                <button onClick={() => setExpandAll(false)} style={btnStyle(false)}>Collapse All</button>
              </>
            )}

            <span style={{ marginLeft: 'auto', fontSize: 10, color: t.textDim, fontFamily: t.fontUI }}>
              {viewMode === 'grouped'
                ? `${groupedBlocks.length} block${groupedBlocks.length !== 1 ? 's' : ''} · ${feedLogs.length} events`
                : `${feedLogs.length} event${feedLogs.length !== 1 ? 's' : ''}`}
            </span>
          </div>

          <div
            ref={logScrollRef}
            onScroll={e => {
              const el = e.currentTarget
              setAutoScroll(el.scrollHeight - el.scrollTop - el.clientHeight < 40)
            }}
            style={{ overflowY: 'auto', maxHeight: 420 }}
          >
            {feedLogs.length === 0 ? (
              <div style={{ padding: '32px 20px', color: t.textDim, fontSize: 12, fontFamily: t.fontUI, textAlign: 'center' }}>
                {wsStatus === 'connected' ? 'Waiting for agent activity…' : `WebSocket ${wsStatus} — reconnecting…`}
              </div>
            ) : viewMode === 'grouped' ? (
              <div style={{ padding: '10px 14px' }}>
                {groupedBlocks.map(block => (
                  <AgentBlock key={block.id} block={block} forceExpand={expandAll} t={t} />
                ))}
              </div>
            ) : (
              feedLogs.map((entry, i) => <LogRow key={i} entry={entry} t={t} />)
            )}
            <div ref={logBottomRef} />
          </div>
        </div>
      </div>
    </div>
  )
}
