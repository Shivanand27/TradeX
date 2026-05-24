// src/components/chart/PriceChart.jsx
// Slide-in chart drawer using lightweight-charts v5.
// Candlesticks + EMA 9 (amber) + EMA 21 (accent). Period selector top-right.

import { useEffect, useRef, useState } from 'react'
import { createChart, CandlestickSeries, LineSeries } from 'lightweight-charts'
import { useQuery } from '@tanstack/react-query'
import { getChartData } from '../../lib/api'

const PERIODS = [
  { label: '5D',  value: '5d',  interval: '15m' },
  { label: '1M',  value: '1mo', interval: '1h'  },
  { label: '3M',  value: '3mo', interval: '1d'  },
  { label: '6M',  value: '6mo', interval: '1d'  },
  { label: '1Y',  value: '1y',  interval: '1wk' },
]

function computeEMA(candles, period) {
  if (candles.length < period) return []
  const k = 2 / (period + 1)
  const result = []
  let ema = candles[0].close
  for (let i = 0; i < candles.length; i++) {
    ema = i === 0 ? candles[0].close : candles[i].close * k + ema * (1 - k)
    if (i >= period - 1) result.push({ time: candles[i].time, value: parseFloat(ema.toFixed(4)) })
  }
  return result
}

export default function PriceChart({ symbol, onClose, t }) {
  const containerRef = useRef(null)
  const chartRefs    = useRef(null)   // { chart, candle, ema9, ema21 }
  const [period, setPeriod] = useState(PERIODS[2])   // 3M default

  const { data, isLoading, isError } = useQuery({
    queryKey: ['chart', symbol, period.value, period.interval],
    queryFn:  () => getChartData(symbol, period.value, period.interval),
    staleTime: 60_000,
    retry: 1,
  })

  // Create chart and series once the container is mounted
  useEffect(() => {
    if (!containerRef.current) return
    const chart = createChart(containerRef.current, {
      autoSize: true,
      height:   360,
      layout: {
        background: { color: 'transparent' },
        textColor:  t.textMuted,
        fontFamily: t.fontUI,
        fontSize:   11,
      },
      grid: {
        vertLines: { color: `${t.border}50` },
        horzLines: { color: `${t.border}50` },
      },
      crosshair: { mode: 1 },
      rightPriceScale: { borderColor: t.border },
      timeScale: { borderColor: t.border, timeVisible: true, secondsVisible: false },
      handleScroll: true,
      handleScale:  true,
    })

    const candle = chart.addSeries(CandlestickSeries, {
      upColor:          t.bull,
      downColor:        t.bear,
      borderUpColor:    t.bull,
      borderDownColor:  t.bear,
      wickUpColor:      t.bull,
      wickDownColor:    t.bear,
    })

    const ema9 = chart.addSeries(LineSeries, {
      color: t.amber, lineWidth: 1,
      priceLineVisible: false, lastValueVisible: false,
      crosshairMarkerVisible: false,
    })

    const ema21 = chart.addSeries(LineSeries, {
      color: t.accent, lineWidth: 1.5,
      priceLineVisible: false, lastValueVisible: false,
      crosshairMarkerVisible: false,
    })

    chartRefs.current = { chart, candle, ema9, ema21 }

    return () => {
      chart.remove()
      chartRefs.current = null
    }
  }, [])   // mount/unmount only — colors from initial `t` snapshot

  // Update data whenever fetch result changes
  useEffect(() => {
    if (!data?.candles?.length || !chartRefs.current) return
    const { chart, candle, ema9, ema21 } = chartRefs.current

    const candles = data.candles.map(c => ({
      time:  Math.floor(c.t / 1000),
      open:  c.o, high: c.h, low: c.l, close: c.c,
    }))

    candle.setData(candles)
    ema9.setData(computeEMA(candles, 9))
    ema21.setData(computeEMA(candles, 21))
    chart.timeScale().fitContent()
  }, [data])

  // Close on Escape
  useEffect(() => {
    const handler = (e) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [onClose])

  const meta = data?.meta || {}
  const isCrypto = /USD|BTC|ETH|SOL|BNB|XRP/i.test(symbol || '')
  const currency = isCrypto ? '$' : '₹'
  const lastCandle = data?.candles?.at(-1)
  const prevCandle = data?.candles?.at(-2)
  const chgPct = lastCandle && prevCandle
    ? (((lastCandle.c - prevCandle.c) / prevCandle.c) * 100).toFixed(2)
    : null

  return (
    <>
      {/* Backdrop */}
      <div
        onClick={onClose}
        style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', zIndex: 300 }}
      />

      {/* Drawer */}
      <div className="fade-in" style={{
        position: 'fixed', right: 0, top: 0, bottom: 0, width: 820,
        background: t.bgPanel, borderLeft: `1px solid ${t.border}`,
        zIndex: 301, display: 'flex', flexDirection: 'column',
        boxShadow: '-8px 0 48px rgba(0,0,0,0.45)',
      }}>
        {/* Header */}
        <div style={{
          display: 'flex', alignItems: 'center', gap: 12,
          padding: '13px 20px', borderBottom: `1px solid ${t.border}`, flexShrink: 0,
        }}>
          <span style={{ fontSize: 16, fontWeight: 700, color: t.cyan, fontFamily: t.fontUI }}>{symbol}</span>
          {lastCandle && (
            <>
              <span style={{ fontSize: 14, fontWeight: 700, color: t.text, fontFamily: t.fontUI }}>
                {currency}{Number(lastCandle.c).toLocaleString('en-IN', { maximumFractionDigits: 2 })}
              </span>
              {chgPct !== null && (
                <span style={{ fontSize: 11, fontWeight: 600, fontFamily: t.fontUI, color: parseFloat(chgPct) >= 0 ? t.bull : t.bear }}>
                  {parseFloat(chgPct) >= 0 ? '+' : ''}{chgPct}%
                </span>
              )}
            </>
          )}
          {meta['52w_high'] > 0 && (
            <span style={{ fontSize: 9, color: t.textDim, fontFamily: t.fontUI }}>
              52W H: {currency}{Number(meta['52w_high']).toLocaleString('en-IN')}
              {' · '}
              L: {currency}{Number(meta['52w_low']).toLocaleString('en-IN')}
            </span>
          )}
          <div style={{ marginLeft: 'auto', display: 'flex', gap: 6, alignItems: 'center' }}>
            {PERIODS.map(p => (
              <button
                key={p.value}
                onClick={() => setPeriod(p)}
                style={{
                  padding: '4px 10px', fontSize: 10,
                  fontWeight: p.value === period.value ? 700 : 400,
                  fontFamily: t.fontUI, cursor: 'pointer', borderRadius: t.radius,
                  border: `1px solid ${p.value === period.value ? t.accent : t.border}`,
                  background: p.value === period.value ? `${t.accent}18` : 'transparent',
                  color: p.value === period.value ? t.accent : t.textMuted,
                  transition: 'all 0.12s',
                }}
              >{p.label}</button>
            ))}
            <button
              onClick={onClose}
              title="Close (Esc)"
              style={{
                width: 28, height: 28, borderRadius: '50%', marginLeft: 6,
                background: 'transparent', border: `1px solid ${t.border}`,
                cursor: 'pointer', color: t.textMuted, fontSize: 13,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                transition: 'all 0.12s',
              }}
              onMouseEnter={e => { e.currentTarget.style.borderColor = t.bear; e.currentTarget.style.color = t.bear }}
              onMouseLeave={e => { e.currentTarget.style.borderColor = t.border; e.currentTarget.style.color = t.textMuted }}
            >✕</button>
          </div>
        </div>

        {/* EMA legend */}
        <div style={{
          display: 'flex', gap: 16, padding: '7px 20px',
          borderBottom: `1px solid ${t.border}30`, flexShrink: 0,
        }}>
          <span style={{ fontSize: 9, fontFamily: t.fontUI, color: t.amber, display: 'flex', alignItems: 'center', gap: 5 }}>
            <span style={{ display: 'inline-block', width: 16, height: 2, background: t.amber, borderRadius: 1 }} />
            EMA 9
          </span>
          <span style={{ fontSize: 9, fontFamily: t.fontUI, color: t.accent, display: 'flex', alignItems: 'center', gap: 5 }}>
            <span style={{ display: 'inline-block', width: 16, height: 2, background: t.accent, borderRadius: 1 }} />
            EMA 21
          </span>
        </div>

        {/* Chart area */}
        <div style={{ flex: 1, padding: '12px 20px 20px', overflow: 'hidden', display: 'flex', flexDirection: 'column', gap: 10 }}>
          {isLoading && (
            <div style={{
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              height: 360, color: t.textDim, fontFamily: t.fontUI, fontSize: 11,
            }}>
              Loading chart data…
            </div>
          )}
          {isError && !isLoading && (
            <div style={{
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              height: 360, color: t.bear, fontFamily: t.fontUI, fontSize: 11,
            }}>
              Failed to load chart data for {symbol}
            </div>
          )}
          <div ref={containerRef} style={{ width: '100%', flex: 1 }} />
        </div>
      </div>
    </>
  )
}
