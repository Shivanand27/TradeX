// src/components/signals/RfDwPanel.jsx
// RF [DW] 5-minute crypto signal panel.
// Shows current direction + recent flips per symbol.
// Data comes from /signals/rf_dw (polled) + rf_signal WebSocket events.
import { useEffect } from 'react'
import { useQuery } from '@tanstack/react-query'
import { getRfDwSignals } from '../../lib/api'
import { useDataStore } from '../../store'
import { useTheme } from '../../store'

const SYMBOLS = ['BTCUSD', 'ETHUSD', 'SOLUSD', 'BNBUSD', 'AVAXUSD', 'XRPUSD']

function DirectionBadge({ direction, justFired, t }) {
  const isModern = t.name === 'modern'
  const isBuy    = direction === 1
  const color    = isBuy ? t.bull : t.bear
  const label    = isBuy ? '▲ BUY' : '▼ SELL'
  return (
    <span style={{
      fontSize: 9, padding: '2px 7px', borderRadius: t.radius,
      border: `1px solid ${color}60`,
      color,
      background: `${color}18`,
      fontFamily: t.font, fontWeight: 700, letterSpacing: 0.5,
      boxShadow: justFired && isModern ? `0 0 8px ${color}` : 'none',
      animation: justFired ? 'rfFlash 1.2s ease-out' : 'none',
    }}>
      {label}
    </span>
  )
}

function RecentFlips({ signals, t }) {
  if (!signals?.length) return null
  return (
    <div style={{ display: 'flex', gap: 3, flexWrap: 'wrap', marginTop: 3 }}>
      {signals.slice(0, 5).map((s, i) => {
        const isBuy = s.type === 'BUY'
        const color = isBuy ? t.bull : t.bear
        return (
          <span key={i} style={{
            fontSize: 7, padding: '1px 4px', borderRadius: 2,
            border: `1px solid ${color}40`, color, fontFamily: t.font,
            background: `${color}10`,
          }}>
            {s.type} ${s.price?.toLocaleString(undefined, { maximumFractionDigits: 2 })}
          </span>
        )
      })}
    </div>
  )
}

export default function RfDwPanel() {
  const t        = useTheme()
  const isModern = t.name === 'modern'

  const rfDwSignals    = useDataStore((s) => s.rfDwSignals)
  const setRfDwSignals = useDataStore((s) => s.setRfDwSignals)

  const { data, isLoading } = useQuery({
    queryKey: ['rf_dw'],
    queryFn:  getRfDwSignals,
    refetchInterval: 60_000,  // WebSocket keeps it fresh between polls
  })

  useEffect(() => {
    if (data?.signals) setRfDwSignals(data.signals)
  }, [data, setRfDwSignals])

  const buyCount  = SYMBOLS.filter(s => rfDwSignals[s]?.direction === 1).length
  const sellCount = SYMBOLS.filter(s => rfDwSignals[s]?.direction === -1).length

  return (
    <div style={{
      background: t.bgPanel,
      display: 'flex', flexDirection: 'column', overflow: 'hidden',
      backdropFilter: isModern ? t.panelGlass : 'none',
    }}>
      {/* Header */}
      <div style={{
        display: 'flex', alignItems: 'center',
        background: t.headerGrad, borderBottom: `1px solid ${t.border}`,
        height: 22, flexShrink: 0, padding: '0 10px', gap: 8,
      }}>
        <span style={{ color: t.accent, fontSize: 10, fontFamily: t.font, fontWeight: 600, letterSpacing: 0.4 }}>
          RF [DW] · 5M CRYPTO
        </span>
        <span style={{ fontSize: 8, color: t.textDim, fontFamily: t.font }}>by DW</span>
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
          <span style={{ fontSize: 8, color: t.bull, fontFamily: t.font }}>▲ {buyCount}</span>
          <span style={{ fontSize: 8, color: t.bear, fontFamily: t.font }}>▼ {sellCount}</span>
        </div>
      </div>

      {/* Signal rows */}
      <div style={{ flex: 1, overflowY: 'auto', padding: '4px 0' }}>
        {isLoading && Object.keys(rfDwSignals).length === 0 ? (
          <div style={{ padding: '20px 12px', color: t.textMuted, fontSize: 9, fontFamily: t.font, textAlign: 'center' }}>
            LOADING RF [DW] DATA…
          </div>
        ) : (
          SYMBOLS.map(sym => {
            const d = rfDwSignals[sym]
            if (!d) return (
              <div key={sym} style={{
                display: 'flex', alignItems: 'center', gap: 8,
                padding: '5px 12px', borderBottom: `1px solid ${t.border}20`,
              }}>
                <span style={{ color: t.textDim, fontSize: 9, fontFamily: t.font, width: 60 }}>{sym}</span>
                <span style={{ color: t.textMuted, fontSize: 8, fontFamily: t.font }}>NO DATA</span>
              </div>
            )

            const isBuy     = d.direction === 1
            const priceColor = isBuy ? t.bull : t.bear
            const dist      = d.rf_distance_pct ?? 0
            const distStr   = `${dist >= 0 ? '+' : ''}${dist.toFixed(2)}%`
            const justFired = d.just_fired && (Date.now() - (d._flashAt || 0) < 10_000)

            return (
              <div key={sym} style={{
                padding: '5px 12px',
                borderBottom: `1px solid ${t.border}20`,
                background: justFired
                  ? `${isBuy ? t.bull : t.bear}10`
                  : 'transparent',
                transition: 'background 1s ease',
              }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  {/* Symbol */}
                  <span style={{ color: t.accent, fontSize: 10, fontFamily: t.font, fontWeight: 600, width: 62 }}>
                    {sym.replace('USD', '')}
                  </span>

                  {/* Direction badge */}
                  <DirectionBadge direction={d.direction} justFired={justFired} t={t} />

                  {/* Price */}
                  <span style={{ color: t.text, fontSize: 9, fontFamily: t.font, marginLeft: 'auto' }}>
                    ${d.close?.toLocaleString(undefined, { maximumFractionDigits: 2 })}
                  </span>

                  {/* RF line */}
                  <span style={{ color: t.textDim, fontSize: 8, fontFamily: t.font }}>
                    RF {d.rf?.toLocaleString(undefined, { maximumFractionDigits: 2 })}
                  </span>

                  {/* Distance */}
                  <span style={{ color: priceColor, fontSize: 8, fontFamily: t.font, width: 44, textAlign: 'right' }}>
                    {distStr}
                  </span>
                </div>

                {/* Recent flip history */}
                <RecentFlips signals={d.recent_signals} t={t} />

                {/* New flip badge */}
                {justFired && (
                  <div style={{
                    marginTop: 2, fontSize: 7, fontFamily: t.font,
                    color: isBuy ? t.bull : t.bear,
                    textShadow: isModern ? `0 0 6px currentColor` : 'none',
                  }}>
                    ● NEW SIGNAL FIRED
                  </div>
                )}
              </div>
            )
          })
        )}
      </div>

      {/* Footer */}
      <div style={{
        padding: '3px 10px', borderTop: `1px solid ${t.border}`,
        display: 'flex', alignItems: 'center', gap: 6,
        background: t.headerGrad, flexShrink: 0,
      }}>
        <span style={{ fontSize: 7, color: t.textMuted, fontFamily: t.font }}>
          ATR(5) × 1.0 · 5m bars · auto-refreshes
        </span>
        <span style={{ fontSize: 7, color: t.textDim, fontFamily: t.font, marginLeft: 'auto' }}>
          TV webhook: /api/webhook/tradingview
        </span>
      </div>

      <style>{`
        @keyframes rfFlash {
          0%   { opacity: 1 }
          50%  { opacity: 0.4 }
          100% { opacity: 1 }
        }
      `}</style>
    </div>
  )
}
