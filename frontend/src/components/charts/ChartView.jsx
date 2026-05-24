// src/components/charts/ChartView.jsx
// Institutional chart view with candlestick, volume, RSI, EMA 20/50, and VWAP overlays.

import { useState, useEffect, useCallback, useMemo } from 'react'
import {
  ComposedChart, Bar, Line, XAxis, YAxis, CartesianGrid,
  Tooltip, ResponsiveContainer, ReferenceLine,
} from 'recharts'
import { getChartData } from '../../lib/api'
import { useTheme, useTerminalStore } from '../../store'

const PERIODS   = ['1d', '5d', '1mo', '3mo', '6mo', '1y', '2y']
const INTERVALS = { '1d': '5m', '5d': '15m', '1mo': '1h', '3mo': '1d', '6mo': '1d', '1y': '1d', '2y': '1wk' }

const POPULAR = [
  'RELIANCE', 'TCS', 'HDFCBANK', 'INFY', 'ICICIBANK', 'NIFTY50', 'BANKNIFTY',
  'BTCUSD', 'ETHUSD', 'SOLUSD',
]

// ── Indicator calculations ──────────────────────────────────
function calcEMA(data, period) {
  const k = 2 / (period + 1)
  const result = []
  let prev = null
  for (const d of data) {
    if (prev === null) { prev = d.c; result.push(parseFloat(d.c.toFixed(2))); continue }
    prev = d.c * k + prev * (1 - k)
    result.push(parseFloat(prev.toFixed(2)))
  }
  return result
}

function calcVWAP(data) {
  let cumTPV = 0, cumVol = 0
  return data.map(d => {
    const tp = (d.h + d.l + d.c) / 3
    cumTPV += tp * (d.v || 1)
    cumVol += (d.v || 1)
    return parseFloat((cumTPV / cumVol).toFixed(2))
  })
}

function calcRSI(data, period = 14) {
  const result = new Array(period).fill(null)
  let avgGain = 0, avgLoss = 0

  for (let i = 1; i <= period; i++) {
    const diff = data[i].c - data[i - 1].c
    if (diff >= 0) avgGain += diff / period
    else avgLoss += Math.abs(diff) / period
  }

  result.push(avgLoss === 0 ? 100 : parseFloat((100 - 100 / (1 + avgGain / avgLoss)).toFixed(2)))

  for (let i = period + 1; i < data.length; i++) {
    const diff = data[i].c - data[i - 1].c
    const gain = diff >= 0 ? diff : 0
    const loss = diff < 0 ? Math.abs(diff) : 0
    avgGain = (avgGain * (period - 1) + gain) / period
    avgLoss = (avgLoss * (period - 1) + loss) / period
    result.push(avgLoss === 0 ? 100 : parseFloat((100 - 100 / (1 + avgGain / avgLoss)).toFixed(2)))
  }
  return result
}

function calcBB(data, period = 20, stdDev = 2) {
  const result = []
  for (let i = 0; i < data.length; i++) {
    if (i < period - 1) { result.push({ mid: null, upper: null, lower: null }); continue }
    const slice = data.slice(i - period + 1, i + 1).map(d => d.c)
    const mean = slice.reduce((a, b) => a + b, 0) / period
    const variance = slice.reduce((a, b) => a + (b - mean) ** 2, 0) / period
    const sd = Math.sqrt(variance)
    result.push({
      mid:   parseFloat(mean.toFixed(2)),
      upper: parseFloat((mean + stdDev * sd).toFixed(2)),
      lower: parseFloat((mean - stdDev * sd).toFixed(2)),
    })
  }
  return result
}

// ── Tooltip ─────────────────────────────────────────────────
function CandleTooltip({ active, payload, t, showRSI, indicators }) {
  if (!active || !payload?.length) return null
  const d = payload[0]?.payload
  if (!d) return null
  const isUp = d.c >= d.o
  return (
    <div style={{
      background: t.bgPanel, border: `1px solid ${t.border}`,
      padding: '8px 12px', fontFamily: t.font, fontSize: 10,
      borderRadius: t.radius, minWidth: 160,
      boxShadow: t.name === 'modern' ? t.glowAccent : '0 4px 16px rgba(0,0,0,0.4)',
    }}>
      <div style={{ color: t.textMuted, marginBottom: 4 }}>{d.date}</div>
      {[['O', d.o], ['H', d.h], ['L', d.l], ['C', d.c]].map(([k, v]) => (
        <div key={k} style={{ display: 'flex', gap: 12, justifyContent: 'space-between' }}>
          <span style={{ color: t.textDim }}>{k}</span>
          <span style={{ color: isUp ? t.bull : t.bear }}>{v?.toLocaleString()}</span>
        </div>
      ))}
      <div style={{ display: 'flex', gap: 12, justifyContent: 'space-between', marginTop: 2, borderTop: `1px solid ${t.border}`, paddingTop: 2 }}>
        <span style={{ color: t.textDim }}>VOL</span>
        <span style={{ color: t.textMuted }}>{d.v >= 1e6 ? `${(d.v / 1e6).toFixed(1)}M` : d.v >= 1e3 ? `${(d.v / 1e3).toFixed(0)}K` : d.v}</span>
      </div>
      {indicators.ema20 && d.ema20 && (
        <div style={{ display: 'flex', gap: 12, justifyContent: 'space-between', borderTop: `1px solid ${t.border}`, paddingTop: 2, marginTop: 2 }}>
          <span style={{ color: t.cyan }}>EMA20</span>
          <span style={{ color: t.cyan }}>{d.ema20?.toLocaleString()}</span>
        </div>
      )}
      {indicators.ema50 && d.ema50 && (
        <div style={{ display: 'flex', gap: 12, justifyContent: 'space-between' }}>
          <span style={{ color: t.amber }}>EMA50</span>
          <span style={{ color: t.amber }}>{d.ema50?.toLocaleString()}</span>
        </div>
      )}
      {indicators.vwap && d.vwap && (
        <div style={{ display: 'flex', gap: 12, justifyContent: 'space-between' }}>
          <span style={{ color: t.purple }}>VWAP</span>
          <span style={{ color: t.purple }}>{d.vwap?.toLocaleString()}</span>
        </div>
      )}
      {showRSI && d.rsi != null && (
        <div style={{ display: 'flex', gap: 12, justifyContent: 'space-between', borderTop: `1px solid ${t.border}`, paddingTop: 2, marginTop: 2 }}>
          <span style={{ color: t.textDim }}>RSI(14)</span>
          <span style={{ color: d.rsi > 70 ? t.bear : d.rsi < 30 ? t.bull : t.text }}>{d.rsi?.toFixed(1)}</span>
        </div>
      )}
    </div>
  )
}

// ── Indicator toggle button ──────────────────────────────────
function IndicatorBtn({ label, active, color, onClick, t, isModern }) {
  return (
    <button onClick={onClick} style={{
      padding: '2px 7px', fontSize: 8, cursor: 'pointer',
      background: active ? `${color}18` : 'transparent',
      border: `1px solid ${active ? color : t.border}`,
      color: active ? color : t.textDim,
      fontFamily: t.font, borderRadius: t.radius,
      boxShadow: active && isModern ? `0 0 6px ${color}40` : 'none',
      letterSpacing: 0.3,
    }}>{label}</button>
  )
}

export default function ChartView() {
  const t = useTheme()
  const isModern = t.name === 'modern'
  const activeSignal = useTerminalStore((s) => s.activeSignal)

  const [symbol,  setSymbol]  = useState(activeSignal?.symbol?.replace('.NS', '').replace('.BO', '') || 'RELIANCE')
  const [period,  setPeriod]  = useState('3mo')
  const [data,    setData]    = useState(null)
  const [loading, setLoading] = useState(false)
  const [error,   setError]   = useState(null)
  const [input,   setInput]   = useState('')

  // Indicator toggles
  const [indicators, setIndicators] = useState({ ema20: true, ema50: true, vwap: false, bb: false, rsi: true })
  const toggleInd = (key) => setIndicators(prev => ({ ...prev, [key]: !prev[key] }))

  const fetchChart = useCallback(async (sym, per) => {
    setLoading(true); setError(null)
    try {
      const res = await getChartData(sym, per, INTERVALS[per])
      setData(res)
    } catch (e) {
      setError(e.response?.data?.detail || 'Failed to load chart data')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { fetchChart(symbol, period) }, [symbol, period, fetchChart])

  useEffect(() => {
    if (activeSignal?.symbol) {
      setSymbol(activeSignal.symbol.replace('.NS', '').replace('.BO', ''))
    }
  }, [activeSignal])

  const candles = data?.candles || []

  // Augment candles with computed indicators
  const chartData = useMemo(() => {
    if (!candles.length) return []
    const ema20 = calcEMA(candles, 20)
    const ema50 = calcEMA(candles, 50)
    const vwap  = calcVWAP(candles)
    const rsi   = candles.length >= 15 ? calcRSI(candles) : candles.map(() => null)
    const bb    = calcBB(candles)

    return candles.map((c, i) => ({
      ...c,
      ema20:    ema20[i],
      ema50:    ema50[i],
      vwap:     vwap[i],
      rsi:      rsi[i],
      bbUpper:  bb[i]?.upper,
      bbMid:    bb[i]?.mid,
      bbLower:  bb[i]?.lower,
      body_range: [Math.min(c.o, c.c), Math.max(c.o, c.c)],
    }))
  }, [candles])

  const last   = candles[candles.length - 1]
  const prev   = candles[candles.length - 2]
  const chgPct = last && prev ? ((last.c - prev.c) / prev.c * 100).toFixed(2) : null
  const isUp   = last && prev ? last.c >= prev.c : true
  const lastRSI = chartData[chartData.length - 1]?.rsi

  const allPrices = candles.flatMap(c => [c.h, c.l])
  const minP = allPrices.length ? Math.min(...allPrices) * 0.998 : 0
  const maxP = allPrices.length ? Math.max(...allPrices) * 1.002 : 100

  const rsiColor = lastRSI > 70 ? t.bear : lastRSI < 30 ? t.bull : t.cyan

  return (
    <div style={{
      flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden',
      background: t.bg, backdropFilter: isModern ? t.panelGlass : 'none',
    }}>
      {/* ── Header ── */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 0,
        background: t.headerGrad, borderBottom: `1px solid ${t.border}`,
        height: 32, flexShrink: 0, padding: '0 8px',
      }}>
        <form onSubmit={e => { e.preventDefault(); if (input.trim()) { setSymbol(input.trim().toUpperCase()); setInput('') } }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginRight: 12 }}>
            <span style={{ color: t.accent, fontSize: 10, fontFamily: t.font, textShadow: isModern ? t.glowAccent : 'none' }}>SYM›</span>
            <input
              value={input}
              onChange={e => setInput(e.target.value)}
              placeholder={symbol}
              style={{ background: 'transparent', border: 'none', outline: 'none', color: t.accent, fontFamily: t.font, fontSize: 11, width: 90, caretColor: t.accent }}
            />
          </div>
        </form>

        <span style={{ color: t.accent, fontSize: 12, fontWeight: 700, fontFamily: t.font, marginRight: 8, textShadow: isModern ? t.glowAccent : 'none' }}>
          {data?.symbol || symbol}
        </span>
        {last && (
          <>
            <span style={{ color: t.text, fontSize: 12, fontFamily: t.font, marginRight: 6 }}>
              {data?.meta?.currency === 'INR' ? '₹' : '$'}{last.c.toLocaleString()}
            </span>
            <span style={{ color: isUp ? t.bull : t.bear, fontSize: 10, fontFamily: t.font, marginRight: 12, textShadow: isModern ? `0 0 6px currentColor` : 'none' }}>
              {chgPct ? `${isUp ? '+' : ''}${chgPct}%` : ''}
            </span>
          </>
        )}
        {data?.meta && (
          <span style={{ color: t.textDim, fontSize: 9, fontFamily: t.font, marginRight: 12 }}>
            52W: {data.meta['52w_low']?.toLocaleString()} – {data.meta['52w_high']?.toLocaleString()}
          </span>
        )}
        {indicators.rsi && lastRSI != null && (
          <span style={{ fontSize: 9, fontFamily: t.font, marginRight: 8 }}>
            <span style={{ color: t.textDim }}>RSI </span>
            <span style={{ color: rsiColor, fontWeight: 600, textShadow: isModern ? `0 0 6px ${rsiColor}` : 'none' }}>
              {lastRSI.toFixed(1)}
              {lastRSI > 70 ? ' OVERBOUGHT' : lastRSI < 30 ? ' OVERSOLD' : ''}
            </span>
          </span>
        )}

        {/* Period selector */}
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 2 }}>
          {PERIODS.map(p => (
            <button key={p} onClick={() => setPeriod(p)} style={{
              padding: '2px 7px', fontSize: 9, cursor: 'pointer',
              background: period === p ? (isModern ? t.accentBg : '#ff8c0020') : 'transparent',
              border: period === p ? `1px solid ${t.accent}` : `1px solid transparent`,
              color: period === p ? t.accent : t.textDim,
              fontFamily: t.font, borderRadius: t.radius,
              textShadow: period === p && isModern ? t.glowAccent : 'none',
            }}>{p.toUpperCase()}</button>
          ))}
        </div>
      </div>

      {/* ── Toolbar: symbol chips + indicator toggles ── */}
      <div style={{
        display: 'flex', gap: 4, padding: '4px 8px',
        borderBottom: `1px solid ${t.border}`, flexShrink: 0,
        alignItems: 'center', overflow: 'hidden',
      }}>
        <div style={{ display: 'flex', gap: 4, flex: 1, overflow: 'hidden' }}>
          {POPULAR.map(s => (
            <button key={s} onClick={() => setSymbol(s)} style={{
              padding: '2px 7px', fontSize: 8, cursor: 'pointer', whiteSpace: 'nowrap',
              background: symbol === s ? t.accentBg : 'transparent',
              border: `1px solid ${symbol === s ? t.accent : t.border}`,
              color: symbol === s ? t.accent : t.textDim,
              fontFamily: t.font, borderRadius: t.radius,
              boxShadow: symbol === s && isModern ? t.glowAccent : 'none',
            }}>{s}</button>
          ))}
        </div>

        {/* Indicator toggles */}
        <div style={{ display: 'flex', gap: 4, flexShrink: 0, marginLeft: 8, paddingLeft: 8, borderLeft: `1px solid ${t.border}` }}>
          <IndicatorBtn label="EMA 20" active={indicators.ema20} color={t.cyan}   onClick={() => toggleInd('ema20')} t={t} isModern={isModern} />
          <IndicatorBtn label="EMA 50" active={indicators.ema50} color={t.amber}  onClick={() => toggleInd('ema50')} t={t} isModern={isModern} />
          <IndicatorBtn label="VWAP"   active={indicators.vwap}  color={t.purple} onClick={() => toggleInd('vwap')}  t={t} isModern={isModern} />
          <IndicatorBtn label="BB(20)" active={indicators.bb}    color={t.text}   onClick={() => toggleInd('bb')}    t={t} isModern={isModern} />
          <IndicatorBtn label="RSI(14)"active={indicators.rsi}   color={rsiColor} onClick={() => toggleInd('rsi')}   t={t} isModern={isModern} />
        </div>
      </div>

      {/* ── Chart area ── */}
      <div style={{ flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column', padding: '4px 0' }}>
        {loading && (
          <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: t.textMuted, fontFamily: t.font, fontSize: 10 }}>
            LOADING…
          </div>
        )}
        {error && (
          <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: t.bear, fontFamily: t.font, fontSize: 10 }}>
            {error}
          </div>
        )}

        {!loading && !error && chartData.length > 0 && (
          <>
            {/* Main price chart (60%) */}
            <div style={{ flex: indicators.rsi ? 6 : 7 }}>
              <ResponsiveContainer width="100%" height="100%">
                <ComposedChart data={chartData} margin={{ top: 4, right: 8, bottom: 0, left: 4 }}>
                  <CartesianGrid strokeDasharray="2 4" stroke={t.border} vertical={false} />
                  <XAxis
                    dataKey="date"
                    tick={{ fill: t.textDim, fontSize: 8, fontFamily: t.font }}
                    tickLine={false} axisLine={{ stroke: t.border }}
                    interval={Math.floor(chartData.length / 8)}
                  />
                  <YAxis
                    domain={[minP, maxP]}
                    tick={{ fill: t.textMuted, fontSize: 8, fontFamily: t.font }}
                    tickLine={false} axisLine={false}
                    width={64} orientation="right"
                    tickFormatter={v => v >= 1000 ? `${(v / 1000).toFixed(1)}K` : v.toFixed(0)}
                  />
                  <Tooltip content={<CandleTooltip t={t} showRSI={indicators.rsi} indicators={indicators} />} />

                  {/* Bollinger Bands */}
                  {indicators.bb && (
                    <>
                      <Line dataKey="bbUpper" stroke={t.text} dot={false} strokeWidth={1} strokeDasharray="3 2" opacity={0.35} />
                      <Line dataKey="bbMid"   stroke={t.text} dot={false} strokeWidth={1} strokeDasharray="3 2" opacity={0.2} />
                      <Line dataKey="bbLower" stroke={t.text} dot={false} strokeWidth={1} strokeDasharray="3 2" opacity={0.35} />
                    </>
                  )}

                  {/* Candlestick */}
                  <Bar dataKey="body_range" fill="transparent" stroke="none"
                    shape={(props) => {
                      const { x, y, width, height, payload } = props
                      if (!payload || payload.c == null) return null
                      const isUp = payload.c >= payload.o
                      const color = isUp ? t.bull : t.bear
                      return (
                        <g>
                          <line x1={x + width / 2} y1={y - 18} x2={x + width / 2} y2={y + Math.abs(height) + 18}
                            stroke={color} strokeWidth={1} opacity={0.5} />
                          <rect x={x + 1} y={isUp ? y + height : y}
                            width={Math.max(width - 2, 1)} height={Math.max(Math.abs(height), 1)}
                            fill={color} fillOpacity={0.85} />
                        </g>
                      )
                    }}
                  />

                  {/* EMA 20 */}
                  {indicators.ema20 && (
                    <Line dataKey="ema20" stroke={t.cyan} dot={false} strokeWidth={1.5}
                      opacity={0.85} name="EMA 20" />
                  )}
                  {/* EMA 50 */}
                  {indicators.ema50 && (
                    <Line dataKey="ema50" stroke={t.amber} dot={false} strokeWidth={1.5}
                      opacity={0.85} name="EMA 50" />
                  )}
                  {/* VWAP */}
                  {indicators.vwap && (
                    <Line dataKey="vwap" stroke={t.purple} dot={false} strokeWidth={1.5}
                      strokeDasharray="4 2" opacity={0.8} name="VWAP" />
                  )}

                  {/* Close line (subtle) */}
                  <Line dataKey="c" stroke={t.cyan} dot={false} strokeWidth={0.5} opacity={0.2} />

                  {/* Overbought/oversold ref lines on RSI aren't drawn here — they're in the sub chart */}
                </ComposedChart>
              </ResponsiveContainer>
            </div>

            {/* Volume (15%) */}
            <div style={{ flex: 1.5, paddingTop: 2, borderTop: `1px solid ${t.border}` }}>
              <ResponsiveContainer width="100%" height="100%">
                <ComposedChart data={chartData} margin={{ top: 0, right: 8, bottom: 0, left: 4 }}>
                  <XAxis dataKey="date" hide />
                  <YAxis orientation="right" width={64} tick={{ fill: t.textDim, fontSize: 7, fontFamily: t.font }}
                    tickLine={false} axisLine={false}
                    tickFormatter={v => v >= 1e6 ? `${(v / 1e6).toFixed(0)}M` : v >= 1e3 ? `${(v / 1e3).toFixed(0)}K` : v} />
                  <Bar dataKey="v" fill={t.accent} opacity={0.25} radius={[1, 1, 0, 0]} />
                </ComposedChart>
              </ResponsiveContainer>
            </div>

            {/* RSI sub-panel (25%) */}
            {indicators.rsi && (
              <div style={{ flex: 2.5, paddingTop: 2, borderTop: `1px solid ${t.border}` }}>
                <ResponsiveContainer width="100%" height="100%">
                  <ComposedChart data={chartData} margin={{ top: 0, right: 8, bottom: 4, left: 4 }}>
                    <CartesianGrid strokeDasharray="2 4" stroke={t.border} vertical={false} />
                    <XAxis dataKey="date" hide />
                    <YAxis domain={[0, 100]} orientation="right" width={64}
                      tick={{ fill: t.textDim, fontSize: 7, fontFamily: t.font }}
                      tickLine={false} axisLine={false}
                      ticks={[30, 50, 70]}
                    />
                    {/* Overbought/oversold zones */}
                    <ReferenceLine y={70} stroke={t.bear} strokeDasharray="3 3" strokeWidth={1} opacity={0.5} />
                    <ReferenceLine y={30} stroke={t.bull} strokeDasharray="3 3" strokeWidth={1} opacity={0.5} />
                    <ReferenceLine y={50} stroke={t.border} strokeWidth={0.5} />

                    <Line dataKey="rsi" stroke={rsiColor} dot={false} strokeWidth={1.5}
                      name="RSI(14)" connectNulls={false} />
                  </ComposedChart>
                </ResponsiveContainer>
                <div style={{ position: 'relative', marginTop: -16, padding: '0 8px', display: 'flex', justifyContent: 'space-between', pointerEvents: 'none' }}>
                  <span style={{ fontSize: 7, color: t.textDim, fontFamily: t.font }}>RSI(14)</span>
                  <span style={{ fontSize: 7, color: t.bear, fontFamily: t.font, opacity: 0.6 }}>OB:70</span>
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  )
}
