// src/lib/api.js
// ────────────────────────────────────────────────────────
// Axios client with JWT injection and smart error handling.
//
// Improvements vs v2:
//   • Single instance (v2 was in the same file as the supabase client)
//   • Request interceptor reads the CURRENT session every call
//   • Response interceptor:
//       - 401 triggers a clean sign-out (token expired / revoked)
//       - 5xx shows a toast once per minute per endpoint
//       - Network errors surface a friendly message, not "Network Error"
//   • 15s timeout (v2 was 10s — too tight for scan triggers)
//   • Emits a request-id so backend logs can be correlated

import axios from 'axios'
import toast from 'react-hot-toast'
import { supabase } from './supabase'

export { supabase }

// Dedupe toasts within this window to avoid spamming on reconnect storms
const _toastCooldown = new Map()
function toastOnce(key, message, opts = {}) {
  const last = _toastCooldown.get(key) || 0
  if (Date.now() - last < 60_000) return
  _toastCooldown.set(key, Date.now())
  toast.error(message, opts)
}

function newRequestId() {
  return Math.random().toString(36).slice(2, 14)
}

const api = axios.create({
  baseURL: import.meta.env.VITE_API_URL || '/api',
  timeout: 15_000,
})

const _DEV_MODE = import.meta.env.VITE_DEV_MODE === 'true'

// ── Request: attach JWT + request ID ────────────────────────
api.interceptors.request.use(async (config) => {
  if (_DEV_MODE) {
    config.headers.Authorization = 'Bearer dev-admin-token'
  } else {
    try {
      const { data: { session } } = await supabase.auth.getSession()
      if (session?.access_token) {
        config.headers.Authorization = `Bearer ${session.access_token}`
      }
    } catch {
      // If session fetch fails we still try the request; backend will 401
    }
  }
  config.headers['X-Request-ID'] = newRequestId()
  return config
})

// ── Response: smart error routing ───────────────────────────
api.interceptors.response.use(
  (r) => r,
  async (err) => {
    const status = err.response?.status
    const url = err.config?.url || 'unknown'

    if (status === 401) {
      // Token expired or revoked — clean sign-out
      toastOnce('auth-401', 'Session expired. Please sign in again.')
      await supabase.auth.signOut()
    } else if (status === 403) {
      toastOnce(`403-${url}`, 'Access denied')
    } else if (status === 429) {
      const retry = err.response?.headers?.['retry-after'] || '60'
      toastOnce(`429-${url}`, `Rate limited. Retry in ${retry}s.`)
    } else if (status >= 500) {
      toastOnce(`5xx-${url}`, 'Server error — the team has been notified.')
    } else if (err.code === 'ECONNABORTED') {
      toastOnce(`timeout-${url}`, 'Request timed out.')
    } else if (!err.response) {
      toastOnce(`offline-${url}`, 'Cannot reach server.')
    }
    return Promise.reject(err)
  }
)

export default api

// ── IST time formatter ───────────────────────────────────────
// Single source of truth for all timestamp display in the UI.
// All timestamps from the backend are UTC ISO strings; this converts them to IST.
const _IST = { timeZone: 'Asia/Kolkata' }

export function fmtIST(input, fmt = 'time') {
  if (!input) return '—'
  const d = input instanceof Date ? input : new Date(input)
  if (isNaN(d)) return '—'
  switch (fmt) {
    case 'time':     // "13:45 IST"
      return d.toLocaleTimeString('en-IN', { ..._IST, hour: '2-digit', minute: '2-digit', hour12: false }) + ' IST'
    case 'datetime': // "27 Apr · 13:45 IST"
      return d.toLocaleDateString('en-IN', { ..._IST, day: 'numeric', month: 'short' }) +
             ' · ' + d.toLocaleTimeString('en-IN', { ..._IST, hour: '2-digit', minute: '2-digit', hour12: false }) + ' IST'
    case 'date':     // "27 Apr 2026"
      return d.toLocaleDateString('en-IN', { ..._IST, day: 'numeric', month: 'short', year: 'numeric' })
    case 'full':     // "27 Apr 2026, 13:45 IST"
      return d.toLocaleString('en-IN', { ..._IST, day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }) + ' IST'
    default:
      return d.toLocaleString('en-IN', _IST)
  }
}

// ── Convenience exports ─────────────────────────────────────
export const getMarketData   = () => api.get('/market/india').then(r => r.data)
export const getPrices       = (symbols, market = 'india') => api.get('/market/prices', { params: { symbols: symbols.join(','), market } }).then(r => r.data)
export const getCryptoData   = () => api.get('/market/crypto').then(r => r.data)
export const getSignals      = (market) => api.get('/signals', { params: { market } }).then(r => r.data)
export const getSignalDetail = (id) => api.get(`/signals/${id}`).then(r => r.data)
export const getNewsFeeds    = (params) => api.get('/news', { params }).then(r => r.data)
export const getRiskSummary  = () => api.get('/risk').then(r => r.data)
export const getWatchList    = (market) => api.get(`/watchlist/${market}`).then(r => r.data)
export const getUsers        = () => api.get('/admin/users').then(r => r.data)
export const createUser      = (data) => api.post('/admin/users', data).then(r => r.data)
export const updateUser      = (id, data) => api.put(`/admin/users/${id}`, data).then(r => r.data)
export const deleteUser      = (id) => api.delete(`/admin/users/${id}`).then(r => r.data)
export const saveUserConfig  = (data) => api.put('/user/config', data).then(r => r.data)
export const getUserConfig   = () => api.get('/user/config').then(r => r.data)
export const getChartData    = (symbol, period = '3mo', interval = '1d') => api.get(`/chart/${symbol}`, { params: { period, interval } }).then(r => r.data)
export const softKill        = (reason) => api.post('/risk/soft-kill', null, { params: { reason } }).then(r => r.data)
export const resetKill       = () => api.post('/risk/reset').then(r => r.data)
export const granularKill    = (scope, reason) => api.post('/risk/granular-kill', { scope, reason }).then(r => r.data)
export const resetGranularKill = (scope) => api.delete(`/risk/granular-kill/${scope}`).then(r => r.data)
export const runScan         = () => api.post('/scan/run').then(r => r.data)
export const logout          = () => api.post('/auth/logout').then(r => r.data).catch(() => ({}))

// ── Orders ──────────────────────────────────────────────────
export const getOrders       = (params) => api.get('/orders', { params }).then(r => r.data)
export const placeOrder      = (data)   => api.post('/orders', data).then(r => r.data)
export const cancelOrder     = (id, market = 'india') => api.delete(`/orders/${id}`, { params: { market } }).then(r => r.data)
export const modifyOrder     = (id, data) => api.put(`/orders/${id}`, data).then(r => r.data)

// ── Positions ────────────────────────────────────────────────
export const getPositions    = ()                  => api.get('/positions').then(r => r.data)
export const closePosition   = (sym, qty, opts = {}) => api.post(`/positions/${sym}/close`, { qty, order_type: opts.type, price: opts.price }, { params: { market: opts.market || 'india' } }).then(r => r.data)

// ── Market Depth ─────────────────────────────────────────────
export const getMarketDepth     = (sym) => api.get(`/market/depth/${sym}`).then(r => r.data)

// ── Market Sentiment ─────────────────────────────────────────
export const getMarketSentiment = ()    => api.get('/market/sentiment').then(r => r.data)

// ── RF [DW] signals ─────────────────────────────────────────
export const getRfDwSignals        = () => api.get('/rf_dw/signals').then(r => r.data)

// ── Confirmation Signals [Simple] ────────────────────────────
export const getConfSimpleSignals  = () => api.get('/conf_simple/signals').then(r => r.data)

// ── Stock Screener ────────────────────────────────────────────
export const getScreenerResults    = (market = 'all') => api.get(`/screener/results?market=${market}`).then(r => r.data)
export const refreshScreener       = (market = 'all') => api.post(`/screener/refresh?market=${market}`).then(r => r.data)
export const refreshRfDw           = ()               => api.post('/rf_dw/refresh').then(r => r.data)
export const refreshConfSimple     = ()               => api.post('/conf_simple/refresh').then(r => r.data)

// ── Price Alerts ─────────────────────────────────────────────
export const getAlerts    = ()        => api.get('/alerts').then(r => r.data)
export const createAlert  = (data)    => api.post('/alerts', data).then(r => r.data)
export const deleteAlert  = (id)      => api.delete(`/alerts/${id}`).then(r => r.data)

// ── Signal Performance ────────────────────────────────────────
export const getSignalPerformance = () => api.get('/signals/performance').then(r => r.data)

// ── Agents ───────────────────────────────────────────────────
export const getAgentsStatus         = ()    => api.get('/agents/status').then(r => r.data)
export const runIndiaPipeline        = ()    => api.post('/agents/india/pipeline/run').then(r => r.data)
export const getIndiaPipelineStatus  = ()    => api.get('/agents/india/pipeline/status').then(r => r.data)

// ── Trading Bots ──────────────────────────────────────────────
export const getBots            = ()         => api.get('/bots').then(r => r.data)
export const createBot          = (data)     => api.post('/bots', data).then(r => r.data)
export const updateBot          = (id, data) => api.put(`/bots/${id}`, data).then(r => r.data)
export const toggleBot          = (id, enabled) => api.post(`/bots/${id}/toggle`, { enabled }).then(r => r.data)

// ── Phase 1: Block & Bulk Deals ───────────────────────────────
export const getDeals           = (params = {}) => api.get('/market/deals', { params }).then(r => r.data)
export const getDealsWatchlist  = (days = 5)    => api.get('/market/deals/watchlist', { params: { days } }).then(r => r.data)
export const triggerDealsRefresh = ()           => api.post('/market/deals/refresh').then(r => r.data)

// ── Phase 2: Corporate Events ─────────────────────────────────
export const getEvents          = (params = {}) => api.get('/market/events', { params }).then(r => r.data)
export const getEventsToday     = ()            => api.get('/market/events/today').then(r => r.data)
export const getEventsForSymbol = (symbol, days = 30) => api.get(`/market/events/${symbol}`, { params: { days } }).then(r => r.data)
export const triggerEventsRefresh = ()          => api.post('/market/events/refresh').then(r => r.data)

// ── Phase 3: Chartink ─────────────────────────────────────────
export const getChartinkSignals = ()        => api.get('/chartink/signals').then(r => r.data)
export const getChartinkScans   = ()        => api.get('/admin/chartink-scans').then(r => r.data)
export const createChartinkScan = (data)    => api.post('/admin/chartink-scans', data).then(r => r.data)
export const deleteChartinkScan = (name)    => api.delete(`/admin/chartink-scans/${name}`).then(r => r.data)

// ── Phase 4: Insider Trades ───────────────────────────────────
export const getInsiderTrades    = (params = {}) => api.get('/market/insider-trades', { params }).then(r => r.data)
export const getInsiderClusters  = (days = 14)   => api.get('/market/insider-trades/clusters', { params: { days } }).then(r => r.data)
export const triggerInsiderRefresh = ()          => api.post('/market/insider-trades/refresh').then(r => r.data)

// ── Phase 5: Intraday Screener ────────────────────────────────
export const getIntradayScreener  = ()  => api.get('/screener/intraday').then(r => r.data)
export const triggerIntradayRefresh = () => api.post('/screener/intraday/refresh').then(r => r.data)
export const deleteBot             = (id)     => api.delete(`/bots/${id}`).then(r => r.data)
export const getBotExecutions      = ()       => api.get('/bots/executions').then(r => r.data)
export const getBotWebhookInfo     = (id)     => api.get(`/bots/${id}/webhook-info`).then(r => r.data)
export const regenerateBotToken    = (id)     => api.post(`/bots/${id}/regenerate-token`).then(r => r.data)
export const getConnectivity       = ()       => api.get('/health/connectivity').then(r => r.data)
export const apiFetch              = api
