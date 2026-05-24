// src/store/index.js
// ────────────────────────────────────────────────────────
// Zustand stores.
//
// `useTerminalStore` — UI state (active panel, filters, auth user, orderTicket)
// `useDataStore`     — server-synced data (tickers, signals, news, risk, orders, positions, agents)

import { create } from 'zustand'
import { themes } from '../theme'
import { saveUserConfig } from '../lib/api'

// Debounced watchlist persist — fires 1 s after the last mutation
let _watchlistSaveTimer = null
function _scheduleWatchlistSave(symbols) {
  clearTimeout(_watchlistSaveTimer)
  _watchlistSaveTimer = setTimeout(() => {
    saveUserConfig({ watchlist: symbols }).catch(() => {})
  }, 1000)
}

export function useTheme() {
  const theme = useTerminalStore((s) => s.theme)
  return themes[theme] || themes.bloomberg
}

export const useTerminalStore = create((set, get) => ({
  // Navigation
  activeView: 'terminal',
  setActiveView: (view) => set({ activeView: view }),

  // Home sub-tab: 'OVERVIEW' | 'STOCKS' | 'CRYPTO' | 'COMMODITIES'
  homeTab: 'OVERVIEW',
  setHomeTab: (tab) => set({ homeTab: tab }),

  // Command bar
  command: '',
  setCommand: (cmd) => set({ command: cmd }),

  // Active signal in detail panel / popup
  activeSignal: null,
  setActiveSignal: (sig) => set({ activeSignal: sig }),

  // Signal popup open
  signalPopupOpen: false,
  setSignalPopupOpen: (v) => set({ signalPopupOpen: v }),
  openSignalPopup: (sig) => set({ activeSignal: sig, signalPopupOpen: true }),
  closeSignalPopup: () => set({ signalPopupOpen: false }),

  // Market depth symbol (driven by watchlist selection)
  depthSymbol: null,
  setDepthSymbol: (sym) => set({ depthSymbol: sym }),

  // Filters / tabs
  newsFilter: { tab: 'ALL', timeframe: '24H', impact: 'ALL' },
  setNewsFilter: (f) => set({ newsFilter: { ...get().newsFilter, ...f } }),
  watchTab: 'india',
  setWatchTab: (t) => set({ watchTab: t }),

  // TV-style watchlist sidebar state
  watchlistSidebarOpen: true,
  toggleWatchlistSidebar: () => set((s) => ({ watchlistSidebarOpen: !s.watchlistSidebarOpen })),
  watchlistSidebarSymbols: {
    india:      ['RELIANCE', 'TCS', 'HDFCBANK', 'INFY', 'ICICIBANK', 'AXISBANK'],
    crypto:     ['BTCUSD', 'ETHUSD', 'SOLUSD', 'BNBUSD', 'XRPUSD'],
    fo:         ['NIFTY-FUT', 'BANKNIFTY-FUT'],
    commodities:['GOLD', 'SILVER', 'CRUDEOIL'],
  },
  setWatchlistSidebarSymbols: (symbols) => set({ watchlistSidebarSymbols: symbols }),
  addWatchlistSymbol: (group, sym) => set((s) => {
    const prev = s.watchlistSidebarSymbols[group] || []
    if (prev.includes(sym)) return s
    const next = { ...s.watchlistSidebarSymbols, [group]: [...prev, sym] }
    _scheduleWatchlistSave(next)
    return { watchlistSidebarSymbols: next }
  }),
  removeWatchlistSymbol: (group, sym) => set((s) => {
    const next = {
      ...s.watchlistSidebarSymbols,
      [group]: (s.watchlistSidebarSymbols[group] || []).filter(x => x !== sym),
    }
    _scheduleWatchlistSave(next)
    return { watchlistSidebarSymbols: next }
  }),

  // Order ticket overlay
  orderTicketOpen: false,
  orderTicketSymbol: null,
  orderTicketSide: 'BUY',
  openOrderTicket: (sym, side = 'BUY') => set({ orderTicketOpen: true, orderTicketSymbol: sym, orderTicketSide: side }),
  closeOrderTicket: () => set({ orderTicketOpen: false, orderTicketSymbol: null }),

  // Positions + Orders merged view tab
  tradesTab: 'POSITIONS',
  setTradesTab: (tab) => set({ tradesTab: tab }),

  // Orders filter
  ordersFilter: 'OPEN',
  setOrdersFilter: (f) => set({ ordersFilter: f }),

  // Risk
  killActive: false,
  setKillActive: (v) => set({ killActive: v }),
  killConfirmOpen: false,
  setKillConfirmOpen: (v) => set({ killConfirmOpen: v }),
  // Granular kill switches: crypto-only, shorts-only, longs-only, new-entries-only
  granularKills: { crypto: false, shorts: false, longs: false },
  setGranularKill: (scope, active) => set((s) => ({ granularKills: { ...s.granularKills, [scope]: active } })),

  // Platform state
  paperMode: false,
  setPaperMode: (v) => set({ paperMode: v }),

  // Sidebar nav
  sidebarCollapsed: false,
  toggleSidebar: () => set((s) => ({ sidebarCollapsed: !s.sidebarCollapsed })),

  // Theme
  theme: 'modern',
  setTheme: (t) => set({ theme: t }),
  toggleTheme: () => set((s) => ({ theme: s.theme === 'bloomberg' ? 'modern' : 'bloomberg' })),

  // Auth
  user: null,
  isAdmin: false,
  setUser: (user, isAdmin) => set({ user, isAdmin }),
  clearUser: () => set({ user: null, isAdmin: false }),

  // Signal filter on signals page
  signalFilter: { market: 'ALL', source: 'ALL', conviction: 'ALL' },
  setSignalFilter: (f) => set((s) => ({ signalFilter: { ...s.signalFilter, ...f } })),
}))

export const useDataStore = create((set) => ({
  // Tickers (real-time) — keyed by symbol
  tickers: {},
  updateTicker: (sym, data) => set((s) => ({
    tickers: { ...s.tickers, [sym]: { ...data, _flashAt: Date.now() } },
  })),

  // Watchlists
  indiaWatchlist: [],
  setIndiaWatchlist: (d) => set({ indiaWatchlist: d }),
  cryptoWatchlist: [],
  setCryptoWatchlist: (d) => set({ cryptoWatchlist: d }),

  // Signals
  signals: [],
  setSignals: (d) => set({ signals: d }),

  // News feed
  newsFeed: [],
  setNewsFeed: (d) => set({ newsFeed: d }),
  prependNews: (items) => set((s) => {
    if (!items?.length) return s
    const seen = new Set(s.newsFeed.slice(0, 50).map(n => n.headline))
    const fresh = items.filter(i => i.headline && !seen.has(i.headline))
    return { newsFeed: [...fresh, ...s.newsFeed].slice(0, 200) }
  }),

  // Risk
  risk: {},
  setRisk: (d) => set({ risk: d || {} }),

  // Orders
  orders: [],
  setOrders: (d) => set({ orders: Array.isArray(d) ? d : [] }),
  addOrder: (o) => set((s) => ({ orders: [o, ...s.orders].slice(0, 500) })),
  updateOrder: (id, patch) => set((s) => ({
    orders: s.orders.map(o => o.id === id ? { ...o, ...patch, _updatedAt: Date.now() } : o),
  })),

  // Positions
  positions: [],
  setPositions: (d) => set({ positions: Array.isArray(d) ? d : [] }),
  updatePosition: (sym, patch) => set((s) => ({
    positions: s.positions.map(p => p.symbol === sym ? { ...p, ...patch, _updatedAt: Date.now() } : p),
  })),

  // Market Depth — keyed by symbol
  depth: {},
  updateDepth: (sym, data) => set((s) => ({ depth: { ...s.depth, [sym]: data } })),

  // RF [DW] 5m signals — keyed by symbol
  rfDwSignals: {},
  setRfDwSignals: (d) => set({ rfDwSignals: d || {} }),
  updateRfDwSignal: (sym, data) => set((s) => ({
    rfDwSignals: { ...s.rfDwSignals, [sym]: { ...data, _flashAt: Date.now() } },
  })),

  // Confirmation Signals [Simple] — keyed by symbol
  confSimpleSignals: {},
  setConfSimpleSignals: (d) => set({ confSimpleSignals: d || {} }),
  updateConfSimpleSignal: (sym, data) => set((s) => ({
    confSimpleSignals: { ...s.confSimpleSignals, [sym]: { ...data, _flashAt: Date.now() } },
  })),

  // P&L Summary
  pnlSummary: { day_pnl: 0, day_pnl_pct: 0, open_count: 0, pending_orders: 0 },
  setPnlSummary: (d) => set({ pnlSummary: d || {} }),

  // WebSocket connection status
  wsState: 'connecting',
  setWsState: (s) => set({ wsState: s }),

  // ── Agent monitoring ──────────────────────────────────────────────
  agentLogs: [],          // ring buffer of log entries from /ws/agent-logs
  agentStatus: null,      // latest from /agents/status
  addAgentLog: (entry) => set((s) => ({
    agentLogs: [...s.agentLogs.slice(-499), entry],
  })),
  prependAgentLogs: (entries) => set((s) => ({
    agentLogs: [...(entries || []), ...s.agentLogs].slice(0, 500),
  })),
  setAgentStatus: (d) => set({ agentStatus: d || null }),

  // ── Market sentiment (full object from backend) ───────────────────
  marketSentiment: null,
  setMarketSentiment: (d) => set({ marketSentiment: d || null }),

  // ── Price Alerts ──────────────────────────────────────────────────
  priceAlerts: [],
  setPriceAlerts: (alerts) => set({ priceAlerts: Array.isArray(alerts) ? alerts : [] }),
  addPriceAlert: (alert) => set((s) => ({
    priceAlerts: [alert, ...s.priceAlerts].slice(0, 100),
  })),
  removePriceAlert: (id) => set((s) => ({
    priceAlerts: s.priceAlerts.filter(a => a.id !== id),
  })),
  triggerPriceAlert: (id) => set((s) => ({
    priceAlerts: s.priceAlerts.map(a => a.id === id ? { ...a, triggered: true, triggered_at: new Date().toISOString() } : a),
  })),

  // ── Signal performance tracking ───────────────────────────────────
  signalPerformance: {},   // keyed by source: { win_rate, avg_rr, total, wins }
  setSignalPerformance: (d) => set({ signalPerformance: d || {} }),

  // ── Screener freshness — set by WS screener_updated message ──────
  screenerLastScan: null,
  setScreenerLastScan: (ts) => set({ screenerLastScan: ts }),

  // ── Bot execution tick — incremented on bot_execution / position_reversal WS ──
  botExecTick: 0,
  bumpBotExecTick: () => set((s) => ({ botExecTick: s.botExecTick + 1 })),

  // ── Notification Centre — persisted to localStorage (last 50) ─────
  notifications: (() => {
    try { return JSON.parse(localStorage.getItem('tradex_notifs_v1') || '[]') } catch { return [] }
  })(),
  addNotification: (n) => set((s) => {
    const entry = { ...n, id: Date.now(), ts: new Date().toISOString(), read: false }
    const next = [entry, ...s.notifications].slice(0, 50)
    try { localStorage.setItem('tradex_notifs_v1', JSON.stringify(next)) } catch {}
    return { notifications: next }
  }),
  markAllRead: () => set((s) => {
    const next = s.notifications.map(n => ({ ...n, read: true }))
    try { localStorage.setItem('tradex_notifs_v1', JSON.stringify(next)) } catch {}
    return { notifications: next }
  }),
  clearNotifications: () => {
    try { localStorage.removeItem('tradex_notifs_v1') } catch {}
    set({ notifications: [] })
  },
}))
