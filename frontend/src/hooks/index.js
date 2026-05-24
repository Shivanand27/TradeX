// src/hooks/index.js
// ────────────────────────────────────────────────────────
// Hooks: useWebSocket, useISTClock, useHotkeys, useConnectionState

import { useCallback, useEffect, useRef, useState } from 'react'
import toast from 'react-hot-toast'
import { useDataStore, useTerminalStore } from '../store'
import { supabase } from '../lib/supabase'

// ─── useWebSocket (authenticated, auto-reconnect) ────────────
// Improvements vs v2:
//   • Sends JWT as ?token=... (matches v3 backend which requires auth)
//   • Exponential backoff with jitter (v2 reconnected every 3s — DDoS-adjacent)
//   • Heartbeat: tears down the connection if no message in 30s
//   • Exposes connection state so the UI can show LIVE / CONNECTING / OFFLINE
//   • Handles auth token refresh cleanly — WS reconnects with the new token
export function useWebSocket() {
  const ws = useRef(null)
  const reconnectTimer = useRef(null)
  const heartbeatTimer = useRef(null)
  const lastMessageAt = useRef(Date.now())
  const attempt = useRef(0)
  const mounted = useRef(true)

  const [state, setState] = useState('connecting')  // connecting | open | closed

  const { updateTicker, prependNews, setNewsFeed, setRisk, setSignals, updateRfDwSignal, updateConfSimpleSignal, triggerPriceAlert, setScreenerLastScan, bumpBotExecTick, addNotification } = useDataStore()

  const clearTimers = () => {
    clearTimeout(reconnectTimer.current)
    clearInterval(heartbeatTimer.current)
  }

  const connect = useCallback(async () => {
    if (!mounted.current) return
    clearTimers()
    setState('connecting')

    // Grab a fresh token every connect attempt
    let token = ''
    try {
      const { data: { session } } = await supabase.auth.getSession()
      token = session?.access_token || ''
    } catch {
      // continue — backend will reject and we'll retry
    }
    if (!token) {
      setState('closed')
      // Wait for auth before trying again
      reconnectTimer.current = setTimeout(connect, 2000)
      return
    }

    const proto = window.location.protocol === 'https:' ? 'wss' : 'ws'
    const host = import.meta.env.VITE_WS_HOST || window.location.host
    const url = `${proto}://${host}/ws/live?token=${encodeURIComponent(token)}`

    try {
      ws.current = new WebSocket(url)
    } catch (err) {
      setState('closed')
      scheduleReconnect()
      return
    }

    ws.current.onopen = () => {
      attempt.current = 0
      setState('open')
      lastMessageAt.current = Date.now()
      // Heartbeat: if no server message in 30s, reconnect
      heartbeatTimer.current = setInterval(() => {
        if (Date.now() - lastMessageAt.current > 30_000) {
          ws.current?.close()
        }
      }, 10_000)
    }

    ws.current.onmessage = (evt) => {
      lastMessageAt.current = Date.now()
      let msg
      try { msg = JSON.parse(evt.data) } catch { return }

      switch (msg.type) {
        case 'snapshot':
          if (msg.signals) setSignals(msg.signals)
          if (msg.risk) setRisk(msg.risk)
          if (msg.news?.length) setNewsFeed(msg.news)
          break
        case 'ticker':
          updateTicker(msg.symbol, msg.data)
          break
        case 'news':
          prependNews(msg.items || (msg.item ? [msg.item] : []))
          break
        case 'risk':
          setRisk(msg.data)
          break
        case 'rf_signal':
          if (msg.symbol && msg.data) updateRfDwSignal(msg.symbol, msg.data)
          break
        case 'conf_simple_signal':
          if (msg.symbol && msg.data) updateConfSimpleSignal(msg.symbol, msg.data)
          break
        case 'price_alert_triggered':
          if (msg.alert_id) {
            triggerPriceAlert(msg.alert_id)
            addNotification({ type: 'price', title: `Alert: ${msg.symbol}`, body: `Hit target ₹${msg.target_price}` })
            toast(`🔔 Alert: ${msg.symbol} hit ${msg.target_price}`, {
              duration: 8000,
              style: { background: '#1a1a2e', border: '1px solid #F59E0B', color: '#F59E0B', fontFamily: 'var(--font-ui, sans-serif)' },
            })
          }
          break
        case 'screener_updated':
          // Backend completed a scheduled scan — signal the screener page to refetch
          setScreenerLastScan(msg.last_scan || new Date().toISOString())
          break
        case 'bot_execution':
          bumpBotExecTick()
          addNotification({
            type: 'bot',
            title: `Bot: ${msg.side} ${msg.qty}× ${msg.symbol}`,
            body: `@ ${Number(msg.price || 0).toLocaleString('en-IN', { maximumFractionDigits: 2 })} · ${msg.bot_name || ''}`,
          })
          toast(
            `Bot: ${msg.side} ${msg.qty}× ${msg.symbol} @ ${Number(msg.price || 0).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`,
            {
              duration: 6000,
              style: {
                background: '#1a1a2e',
                border: `1px solid ${msg.side === 'BUY' ? '#22c55e' : '#ef4444'}`,
                color: msg.side === 'BUY' ? '#22c55e' : '#ef4444',
                fontFamily: 'var(--font-ui, monospace)',
                fontSize: '12px',
              },
            }
          )
          break
        case 'position_reversal':
          bumpBotExecTick()
          addNotification({
            type: 'flip',
            title: `Flip: ${msg.symbol}`,
            body: `Closed ${msg.closed_side} → entering ${msg.new_side}`,
          })
          toast(
            `↺ FLIP: closed ${msg.closed_side} ${msg.symbol} — entering ${msg.new_side}`,
            {
              duration: 8000,
              style: {
                background: '#1a1a2e',
                border: '1px solid #ef4444',
                color: '#ef4444',
                fontFamily: 'var(--font-ui, monospace)',
                fontSize: '12px',
              },
            }
          )
          break
        case 'bot_auto_disabled':
          bumpBotExecTick()
          addNotification({
            type: 'alert',
            title: `Bot auto-disabled: ${msg.bot_name}`,
            body: msg.reason,
          })
          toast.error(
            `Bot "${msg.bot_name}" auto-disabled: ${msg.reason}`,
            { duration: 12000, style: { fontFamily: 'var(--font-ui, monospace)', fontSize: '12px' } }
          )
          break
        default:
          break
      }
    }

    ws.current.onclose = (evt) => {
      setState('closed')
      clearInterval(heartbeatTimer.current)
      // Policy violations (1008) mean auth was rejected — try again after refresh
      if (evt.code === 1008) {
        reconnectTimer.current = setTimeout(connect, 5000)
      } else {
        scheduleReconnect()
      }
    }

    ws.current.onerror = () => {
      // onclose will run next and handle reconnect
    }
  }, [updateTicker, prependNews, setRisk, setSignals, updateRfDwSignal, updateConfSimpleSignal, triggerPriceAlert, setScreenerLastScan, bumpBotExecTick, addNotification])

  const scheduleReconnect = () => {
    if (!mounted.current) return
    attempt.current = Math.min(attempt.current + 1, 6)
    // Exponential backoff: 1s, 2s, 4s, 8s, 16s, 30s (cap), with ±20% jitter
    const base = Math.min(1000 * 2 ** (attempt.current - 1), 30_000)
    const jitter = base * (0.8 + Math.random() * 0.4)
    reconnectTimer.current = setTimeout(connect, jitter)
  }

  useEffect(() => {
    mounted.current = true
    connect()
    // Reconnect on auth state change (login / refresh / logout)
    const { data: { subscription } } = supabase.auth.onAuthStateChange(() => {
      if (mounted.current) {
        ws.current?.close()
      }
    })
    return () => {
      mounted.current = false
      clearTimers()
      subscription?.unsubscribe()
      ws.current?.close()
    }
  }, [connect])

  return state
}

// ─── useISTClock ─────────────────────────────────────────────
export function useISTClock() {
  const [time, setTime] = useState('')
  useEffect(() => {
    const fmt = new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Asia/Kolkata',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
    })
    const update = () => setTime(`${fmt.format(new Date())} IST`)
    update()
    const id = setInterval(update, 1000)
    return () => clearInterval(id)
  }, [])
  return time
}

// ─── useHotkeys ──────────────────────────────────────────────
// F1-F9: view switches.  Ctrl+O: order ticket.
// Ignores presses when focus is in an input.
export function useHotkeys() {
  const setActiveView  = useTerminalStore((s) => s.setActiveView)
  const isAdmin        = useTerminalStore((s) => s.isAdmin)
  const openOrderTicket = useTerminalStore((s) => s.openOrderTicket)
  const activeSignal   = useTerminalStore((s) => s.activeSignal)

  useEffect(() => {
    function handler(e) {
      const tag = e.target?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || e.target?.isContentEditable) return

      // Ctrl+O — open order ticket pre-filled with active symbol
      if ((e.ctrlKey || e.metaKey) && e.key === 'o') {
        e.preventDefault()
        openOrderTicket(activeSignal?.symbol || null, 'BUY')
        return
      }

      const view = FKEY_MAP[e.key]
      if (!view) return
      if (e.key === 'F8' && !isAdmin) return  // F8 = USERS (admin only)
      e.preventDefault()
      setActiveView(view)
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [setActiveView, isAdmin, openOrderTicket, activeSignal])
}

// F1=HOME, F2=SIGNALS, F3=SCREENER, F4=TRADES, F5=RISK, F6=INTEL, F7=AGENTS, F8=USERS(admin), F9=SETTINGS
const FKEY_MAP = {
  F1: 'terminal',
  F2: 'signals',
  F3: 'screener',
  F4: 'trades',
  F5: 'risk',
  F6: 'news',
  F7: 'bots',
  F8: 'users',
  F9: 'settings',
}
