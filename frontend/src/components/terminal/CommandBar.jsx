// src/components/terminal/CommandBar.jsx
// Modern top bar: command input | status chips | theme toggle | user menu

import { useMemo, useState, useRef, useEffect } from 'react'
import toast from 'react-hot-toast'
import { useQuery } from '@tanstack/react-query'
import { logout as logoutApi, getConnectivity } from '../../lib/api'
import { supabase } from '../../lib/supabase'
import { useDataStore, useTerminalStore, useTheme } from '../../store'
import AlertsPanel from './AlertsPanel'
import NotificationCentre from './NotificationCentre'

const SLASH_COMMANDS = {
  '/home':     () => useTerminalStore.getState().setActiveView('terminal'),
  '/signals':  () => useTerminalStore.getState().setActiveView('signals'),
  '/orders':   () => useTerminalStore.getState().setActiveView('orders'),
  '/pos':      () => useTerminalStore.getState().setActiveView('positions'),
  '/risk':     () => useTerminalStore.getState().setActiveView('risk'),
  '/news':     () => useTerminalStore.getState().setActiveView('news'),
  '/bots':     () => useTerminalStore.getState().setActiveView('bots'),
  '/users':    () => useTerminalStore.getState().setActiveView('users'),
  '/settings': () => useTerminalStore.getState().setActiveView('settings'),
  '/docs':     () => useTerminalStore.getState().setActiveView('docs'),
  '/logout':   async () => {
    try { await logoutApi() } catch {}
    await supabase.auth.signOut()
  },
}
const VERBS = ['SIGNAL', 'NEWS', 'CHART', 'RISK', 'HELP']

function StatusDot({ color }) {
  return (
    <span className="pulse" style={{
      display: 'inline-block', width: 6, height: 6,
      borderRadius: '50%', background: color, flexShrink: 0,
    }} />
  )
}

function Chip({ children, color, bg, onClick, title }) {
  return (
    <div onClick={onClick} title={title} style={{
      display: 'flex', alignItems: 'center', gap: 5,
      padding: '4px 10px', borderRadius: 20,
      background: bg, border: `1px solid ${color}28`,
      cursor: onClick ? 'pointer' : 'default',
      fontSize: 10, fontWeight: 500, color, whiteSpace: 'nowrap', userSelect: 'none',
    }}>
      {children}
    </div>
  )
}

// Maps a connectivity status string to a theme color
function connColor(status, t) {
  if (status === 'ok' || status === 'paper') return t.bull
  if (status === 'stale' || status === 'unconfigured') return t.amber
  return t.bear  // error | offline | unknown
}

// Single connectivity chip that opens a detail popup on click
function ConnChip({ label, status, detail, t }) {
  const [open, setOpen] = useState(false)
  const ref = useRef(null)
  const color = connColor(status, t)

  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <div
        onClick={() => setOpen(o => !o)}
        title={`${label}: ${status}`}
        style={{
          display: 'flex', alignItems: 'center', gap: 5,
          padding: '4px 10px', borderRadius: 20,
          background: `${color}10`, border: `1px solid ${color}28`,
          cursor: 'pointer', fontSize: 10, fontWeight: 500, color,
          whiteSpace: 'nowrap', userSelect: 'none',
        }}
      >
        <span style={{
          display: 'inline-block', width: 6, height: 6,
          borderRadius: '50%', background: color, flexShrink: 0,
        }} />
        {label}
      </div>

      {open && (
        <>
          <div onClick={() => setOpen(false)} style={{ position: 'fixed', inset: 0, zIndex: 98 }} />
          <div className="fade-in" style={{
            position: 'absolute', right: 0, top: 42, width: 220,
            background: t.bgCard, border: `1px solid ${t.border}`,
            borderRadius: t.radiusLg, boxShadow: t.shadowLg,
            zIndex: 99, overflow: 'hidden', padding: 12,
          }}>
            <div style={{
              fontSize: 9, fontWeight: 700, color: t.accent,
              fontFamily: t.fontUI, letterSpacing: 0.6, marginBottom: 10,
            }}>{label} STATUS</div>
            {detail.map(row => {
              const c = connColor(row.status, t)
              return (
                <div key={row.key} style={{
                  display: 'flex', justifyContent: 'space-between',
                  alignItems: 'center', marginBottom: 8,
                }}>
                  <div>
                    <div style={{ fontSize: 10, fontWeight: 600, color: t.text, fontFamily: t.fontUI }}>
                      {row.label}
                    </div>
                    {row.sub && (
                      <div style={{ fontSize: 8, color: t.textDim, fontFamily: t.fontUI, marginTop: 1 }}>
                        {row.sub}
                      </div>
                    )}
                  </div>
                  <span style={{
                    fontSize: 8, fontWeight: 700, padding: '2px 7px', borderRadius: 4,
                    background: `${c}18`, color: c, border: `1px solid ${c}30`,
                    fontFamily: t.fontUI, letterSpacing: 0.4, textTransform: 'uppercase',
                  }}>{row.status}</span>
                </div>
              )
            })}
          </div>
        </>
      )}
    </div>
  )
}

function ThemeToggle({ t }) {
  const theme       = useTerminalStore(s => s.theme)
  const toggleTheme = useTerminalStore(s => s.toggleTheme)
  const isModern    = theme === 'modern'
  return (
    <button
      onClick={toggleTheme}
      title={isModern ? 'Switch to Bloomberg classic' : 'Switch to Modern'}
      style={{
        background: 'rgba(255,255,255,0.05)', border: `1px solid ${t.border}`,
        borderRadius: t.radius, color: t.textMuted,
        fontSize: 10, padding: '5px 10px', cursor: 'pointer',
        fontFamily: t.fontUI, display: 'flex', alignItems: 'center', gap: 5,
        transition: 'all 0.15s',
      }}
      onMouseEnter={e => { e.currentTarget.style.borderColor = t.borderHover; e.currentTarget.style.color = t.text }}
      onMouseLeave={e => { e.currentTarget.style.borderColor = t.border;      e.currentTarget.style.color = t.textMuted }}
    >
      {isModern ? '◑' : '◐'} {isModern ? 'Modern' : 'Classic'}
    </button>
  )
}

function UserMenu({ user, t }) {
  const [open, setOpen] = useState(false)
  const setActiveView = useTerminalStore(s => s.setActiveView)

  async function handleLogout() {
    setOpen(false)
    try { await logoutApi() } catch {}
    await supabase.auth.signOut()
  }

  function navigate(view) {
    setActiveView(view)
    setOpen(false)
  }

  const initials = (user?.email || 'U').split('@')[0].slice(0, 2).toUpperCase()

  const menuItemStyle = {
    width: '100%', padding: '8px 12px', background: 'none',
    border: 'none', borderRadius: t.radius, color: t.text,
    fontSize: 12, fontFamily: t.fontUI, cursor: 'pointer',
    textAlign: 'left', display: 'flex', alignItems: 'center', gap: 8,
  }

  return (
    <div style={{ position: 'relative' }}>
      <div
        onClick={() => setOpen(o => !o)}
        title={user?.email}
        style={{
          width: 34, height: 34, borderRadius: '50%',
          background: t.accentGrad, display: 'flex',
          alignItems: 'center', justifyContent: 'center',
          cursor: 'pointer', fontSize: 12, fontWeight: 700,
          color: '#fff', fontFamily: t.fontUI, flexShrink: 0,
          border: `2px solid ${t.border}`, transition: 'border-color 0.15s',
        }}
        onMouseEnter={e => e.currentTarget.style.borderColor = t.accent}
        onMouseLeave={e => e.currentTarget.style.borderColor = t.border}
      >
        {initials}
      </div>
      {open && (
        <>
          <div onClick={() => setOpen(false)} style={{ position: 'fixed', inset: 0, zIndex: 98 }} />
          <div className="fade-in" style={{
            position: 'absolute', right: 0, top: 42, width: 200,
            background: t.bgCard, border: `1px solid ${t.border}`,
            borderRadius: t.radiusLg, boxShadow: t.shadowLg, zIndex: 99,
            overflow: 'hidden', padding: 6,
          }}>
            {/* User info */}
            <div style={{ padding: '8px 12px 10px', borderBottom: `1px solid ${t.border}`, marginBottom: 4 }}>
              <div style={{ fontSize: 11, fontWeight: 600, color: t.text, fontFamily: t.fontUI }}>
                {user?.email?.split('@')[0]}
              </div>
              <div style={{ fontSize: 10, color: t.textDim, fontFamily: t.fontUI, marginTop: 1 }}>
                {user?.email}
              </div>
            </div>

            {/* Docs link */}
            <button
              onClick={() => navigate('docs')}
              style={menuItemStyle}
              onMouseEnter={e => e.currentTarget.style.background = t.accentBg}
              onMouseLeave={e => e.currentTarget.style.background = 'none'}
            >
              <span style={{ fontSize: 14, lineHeight: 1 }}>◈</span>
              Documentation
            </button>

            {/* Settings link */}
            <button
              onClick={() => navigate('settings')}
              style={menuItemStyle}
              onMouseEnter={e => e.currentTarget.style.background = t.bgPanel}
              onMouseLeave={e => e.currentTarget.style.background = 'none'}
            >
              <span style={{ fontSize: 14, lineHeight: 1 }}>⚙</span>
              Settings
            </button>

            <div style={{ borderTop: `1px solid ${t.border}`, margin: '4px 0' }} />

            {/* Sign out */}
            <button
              onClick={handleLogout}
              style={{ ...menuItemStyle, color: t.bear }}
              onMouseEnter={e => e.currentTarget.style.background = t.bearBg}
              onMouseLeave={e => e.currentTarget.style.background = 'none'}
            >
              <span style={{ fontSize: 14, lineHeight: 1 }}>⏻</span>
              Sign out
            </button>
          </div>
        </>
      )}
    </div>
  )
}

export default function CommandBar({ clock }) {
  const [cmd, setCmd]         = useState('')
  const [focused, setFocused] = useState(false)
  const t = useTheme()

  const { isAdmin, user, paperMode, killActive, setActiveSignal, setPaperMode } = useTerminalStore()
  const wsState   = useDataStore(s => s.wsState)
  const signals   = useDataStore(s => s.signals)
  const goSignals = signals.filter(s => s.verdict === 'GO')

  const suggestions = useMemo(() => {
    const upper = cmd.trim().toUpperCase()
    if (!upper || upper.startsWith('/')) return []
    const parts = upper.split(/\s+/)
    if (parts.length === 1) {
      return signals.filter(s => s.symbol?.toUpperCase().startsWith(parts[0])).slice(0, 5)
        .map(s => ({ symbol: s.symbol, verb: 'SIGNAL', signal: s }))
    }
    if (parts.length === 2) {
      return VERBS.filter(v => v.startsWith(parts[1])).map(v => ({ symbol: parts[0], verb: v }))
    }
    return []
  }, [cmd, signals])

  async function executeCommand(raw) {
    const text = raw.trim()
    if (!text) return
    const slash = SLASH_COMMANDS[text.toLowerCase()]
    if (slash) { await slash(); setCmd(''); return }
    const [symbolRaw, verbRaw = 'SIGNAL'] = text.toUpperCase().split(/\s+/)
    if (verbRaw === 'HELP') {
      toast('/home /signals /orders /pos /risk /news /bots /settings /docs /logout', {
        duration: 6000,
        style: { background: t.bgCard, border: `1px solid ${t.border}`, color: t.text, fontFamily: t.fontUI },
      })
      setCmd(''); return
    }
    const match = signals.find(s =>
      s.symbol === symbolRaw || s.symbol === symbolRaw + '.NS' || s.symbol?.startsWith(symbolRaw)
    )
    if (!match) { toast.error(`Symbol not found: ${symbolRaw}`); return }
    setActiveSignal(match); setCmd('')
  }

  function onKey(e) {
    if (e.key === 'Enter')  { e.preventDefault(); executeCommand(cmd) }
    if (e.key === 'Escape') setCmd('')
  }

  const wsColor = wsState === 'open' ? t.bull : wsState === 'connecting' ? t.amber : t.bear
  const wsLabel = wsState === 'open' ? 'LIVE'  : wsState === 'connecting' ? 'SYNC'  : 'OFFLINE'

  // Connectivity health — 30 s poll, never blocks render
  const { data: conn } = useQuery({
    queryKey: ['connectivity'],
    queryFn:  getConnectivity,
    refetchInterval: 30_000,
    staleTime:       20_000,
    retry: false,
  })

  // Sync paper mode from backend whenever connectivity is fetched
  useEffect(() => {
    if (conn && typeof conn.paper_mode === 'boolean') {
      setPaperMode(conn.paper_mode)
    }
  }, [conn])

  // Derive composite broker status: worst of groww + delta
  const brokerWorst = useMemo(() => {
    if (!conn) return null
    const rank = s => s === 'error' ? 3 : s === 'stale' ? 2 : s === 'unconfigured' ? 1 : 0
    const { groww, delta } = conn.broker || {}
    return rank(groww) >= rank(delta) ? groww : delta
  }, [conn])

  // Derive composite feed status: worst of india + crypto
  const feedWorst = useMemo(() => {
    if (!conn) return null
    const rank = s => s === 'offline' ? 3 : s === 'stale' ? 2 : 0
    const { india, crypto } = conn.feed || {}
    return rank(india) >= rank(crypto) ? india : crypto
  }, [conn])

  const brokerDetail = conn ? [
    {
      key: 'groww', label: 'Groww (India)',
      status: conn.broker?.groww || 'unknown',
      sub: conn.paper_mode ? 'Paper trading mode' : null,
    },
    {
      key: 'delta', label: 'Delta Exchange (Crypto)',
      status: conn.broker?.delta || 'unknown',
      sub: conn.paper_mode ? 'Paper trading mode' : null,
    },
  ] : []

  const feedDetail = conn ? [
    {
      key: 'india', label: 'India Market Feed',
      status: conn.feed?.india || 'unknown',
      sub: conn.feed?.india_age_s != null
        ? `Last update ${conn.feed.india_age_s}s ago`
        : null,
    },
    {
      key: 'crypto', label: 'Crypto Feed',
      status: conn.feed?.crypto || 'unknown',
      sub: conn.feed?.crypto_age_s != null
        ? `Last update ${conn.feed.crypto_age_s}s ago`
        : null,
    },
  ] : []

  return (
    <div style={{
      display: 'flex', alignItems: 'center',
      height: 52, padding: '0 16px', gap: 12,
      background: t.bgPanel, borderBottom: `1px solid ${t.border}`,
      flexShrink: 0,
    }}>

      {/* Command / search input */}
      <div style={{
        flex: 1, maxWidth: 420, position: 'relative',
        display: 'flex', alignItems: 'center', gap: 8,
        background: t.bgInput, border: `1px solid ${focused ? t.accent : t.border}`,
        borderRadius: t.radius, padding: '0 12px', height: 36,
        transition: 'border-color 0.15s, box-shadow 0.15s',
        boxShadow: focused ? `0 0 0 3px ${t.accentBg}` : 'none',
      }}>
        <svg width="13" height="13" viewBox="0 0 13 13" fill="none" style={{ flexShrink: 0 }}>
          <circle cx="5.5" cy="5.5" r="4" stroke={t.textDim} strokeWidth="1.3"/>
          <path d="M9 9L11.5 11.5" stroke={t.textDim} strokeWidth="1.3" strokeLinecap="round"/>
        </svg>
        <input
          value={cmd}
          onChange={e => setCmd(e.target.value)}
          onKeyDown={onKey}
          onFocus={() => setFocused(true)}
          onBlur={() => setTimeout(() => setFocused(false), 120)}
          placeholder="Search symbol or /command…"
          spellCheck={false} autoComplete="off"
          style={{
            background: 'transparent', border: 'none', outline: 'none',
            color: t.text, fontFamily: t.fontUI, fontSize: 12,
            width: '100%', caretColor: t.accent,
          }}
        />
        {/* Dropdown */}
        {focused && suggestions.length > 0 && (
          <div style={{
            position: 'absolute', top: '110%', left: 0, right: 0,
            background: t.bgCard, border: `1px solid ${t.border}`,
            borderRadius: t.radius, boxShadow: t.shadowMd, zIndex: 200, overflow: 'hidden',
          }}>
            {suggestions.map((sug, i) => (
              <div
                key={i}
                onMouseDown={() => { if (sug.signal) setActiveSignal(sug.signal); setCmd('') }}
                style={{
                  padding: '8px 14px', fontSize: 11, fontFamily: t.fontUI,
                  cursor: 'pointer', display: 'flex', gap: 8, alignItems: 'center',
                  borderBottom: i < suggestions.length - 1 ? `1px solid ${t.border}` : 'none',
                }}
                onMouseEnter={e => e.currentTarget.style.background = t.bgActive}
                onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
              >
                <span style={{ fontWeight: 600, color: t.cyan }}>{sug.symbol}</span>
                <span style={{ color: t.textDim }}>·</span>
                <span style={{ color: t.textMuted }}>{sug.verb}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Right side */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginLeft: 'auto' }}>
        {killActive && (
          <Chip color={t.bear} bg={t.bearBg}><StatusDot color={t.bear} /> KILL ACTIVE</Chip>
        )}
        <Chip color={goSignals.length > 0 ? t.bull : t.textMuted} bg={goSignals.length > 0 ? t.bullBg : 'rgba(255,255,255,0.04)'}>
          <StatusDot color={goSignals.length > 0 ? t.bull : t.textDim} /> {goSignals.length} GO
        </Chip>
        <Chip color={paperMode ? t.amber : t.bull} bg={paperMode ? 'rgba(245,158,11,0.10)' : t.bullBg}>
          {paperMode ? '◆ PAPER' : '● LIVE'}
        </Chip>
        <Chip color={wsColor} bg={`${wsColor}10`}>
          <StatusDot color={wsColor} /> {wsLabel}
        </Chip>
        {brokerWorst && (
          <ConnChip
            label="BROKER"
            status={brokerWorst}
            detail={brokerDetail}
            t={t}
          />
        )}
        {feedWorst && (
          <ConnChip
            label="FEED"
            status={feedWorst}
            detail={feedDetail}
            t={t}
          />
        )}
        <span style={{ fontSize: 11, color: t.textMuted, fontFamily: t.font, whiteSpace: 'nowrap', minWidth: 90, textAlign: 'right' }}>
          {clock}
        </span>
        {isAdmin && <Chip color={t.accent} bg={t.accentBg}>ADMIN</Chip>}
        <NotificationCentre t={t} />
        <AlertsPanel t={t} />
        <ThemeToggle t={t} />
        <UserMenu user={user} t={t} />
      </div>
    </div>
  )
}
