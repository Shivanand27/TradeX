// src/components/news/IntelFeed.jsx
import { useState } from 'react'
import { useDataStore } from '../../store'
import { useTheme } from '../../store'

const TABS = [
  { k: 'ALL',      label: 'ALL',      n: 47 },
  { k: 'X',        label: 'X/TWITTER',n: 8  },
  { k: 'INDIA',    label: 'INDIA',    n: 14 },
  { k: 'CRYPTO',   label: 'CRYPTO',   n: 11 },
  { k: 'GLOBAL',   label: 'GLOBAL',   n: 9  },
  { k: 'REGULATOR',label: 'RBI/SEBI', n: 5  },
]
const TIMEFRAMES = ['1H', '6H', '24H', '48H', '7D']
const FILTERS    = ['ALL', 'HIGH IMPACT', 'BREAKING', 'TRUMP', 'RBI', 'WHALE ALERT']

function srcStyle(src, t) {
  const isModern = t.name === 'modern'
  const map = {
    X:    { bg: isModern ? 'rgba(0,200,255,0.1)'  : 'rgba(0,212,255,.12)', color: t.cyan },
    RBI:  { bg: isModern ? 'rgba(0,255,148,0.08)' : 'rgba(0,230,118,.08)', color: t.bull },
    SEBI: { bg: isModern ? 'rgba(0,255,148,0.08)' : 'rgba(0,230,118,.08)', color: t.bull },
    ET:   { bg: isModern ? 'rgba(255,183,0,0.08)' : 'rgba(255,140,0,.10)', color: t.amber },
    MC:   { bg: isModern ? 'rgba(255,183,0,0.08)' : 'rgba(255,140,0,.10)', color: t.amber },
    BS:   { bg: isModern ? 'rgba(255,183,0,0.08)' : 'rgba(255,140,0,.10)', color: t.amber },
    WH:   { bg: isModern ? 'rgba(180,0,255,0.12)' : 'rgba(224,64,251,.10)', color: t.purple },
    CP:   { bg: isModern ? 'rgba(120,0,200,0.10)' : 'rgba(157,78,221,.10)', color: t.purple },
    GLOB: { bg: isModern ? 'rgba(0,150,200,0.08)' : 'rgba(0,212,255,.08)', color: '#009abf' },
    GL:   { bg: isModern ? 'rgba(0,150,200,0.08)' : 'rgba(0,212,255,.08)', color: '#009abf' },
  }
  return map[src] || map.GLOB
}

function NewsItem({ item, t }) {
  const st = srcStyle(item.src, t)
  const isModern = t.name === 'modern'
  const impactColor = item.impact === 'HIGH' ? t.bear : item.impact === 'MEDIUM' ? t.amber : t.textDim
  const impactBg    = item.impact === 'HIGH' ? t.bearBg : item.impact === 'MEDIUM' ? 'rgba(255,183,0,0.1)' : `${t.bgGrid}`
  const isBreaking  = item.tags?.includes('BREAKING')
  const isCrit      = item.impact === 'HIGH'

  return (
    <div
      style={{
        padding: '7px 10px',
        borderBottom: `1px solid ${isModern ? 'rgba(0,200,255,0.08)' : 'rgba(31,40,48,.7)'}`,
        display: 'grid', gridTemplateColumns: '26px 1fr', gap: 8, alignItems: 'start',
        borderLeft: isCrit
          ? `2px solid ${t.bear}`
          : isBreaking
          ? `2px solid ${t.accent}`
          : '2px solid transparent',
        cursor: 'pointer', transition: 'background .15s',
      }}
      onMouseEnter={e => e.currentTarget.style.background = t.bgRow}
      onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
    >
      <div style={{
        width: 22, height: 22, borderRadius: t.radius,
        background: st.bg, color: st.color,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        fontSize: 7, fontWeight: 700, marginTop: 1, flexShrink: 0, letterSpacing: .2,
        fontFamily: t.font,
        boxShadow: isModern ? `0 0 8px ${st.color}40` : 'none',
        border: isModern ? `1px solid ${st.color}30` : 'none',
      }}>
        {item.src}
      </div>
      <div>
        <div style={{ fontSize: 10, color: t.text, lineHeight: 1.35, fontFamily: t.fontSans }}>
          {isBreaking && (
            <span style={{
              color: t.accent, fontWeight: 700, marginRight: 4, fontSize: 9,
              fontFamily: t.font,
              textShadow: isModern ? t.glowAccent : 'none',
            }}>
              BREAKING
            </span>
          )}
          <span style={{ fontWeight: isCrit ? 600 : 400 }}>{item.headline}</span>
        </div>
        {item.quote && (
          <div style={{
            fontSize: 9, color: t.textMuted, fontStyle: 'italic', marginTop: 3, lineHeight: 1.4,
            borderLeft: `2px solid ${t.accent}50`, paddingLeft: 6, fontFamily: t.fontSans,
          }}>
            "{item.quote}"
          </div>
        )}
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 3, flexWrap: 'wrap' }}>
          <span style={{ fontSize: 8, color: t.textMuted, fontFamily: t.font }}>{item.handle || item.source}</span>
          <span style={{ fontSize: 8, color: t.textDim,  fontFamily: t.font }}>{item.time}</span>
          <span style={{
            fontSize: 8, padding: '1px 5px', borderRadius: t.radius,
            background: impactBg, color: impactColor,
            border: `1px solid ${impactColor}30`,
            fontFamily: t.font,
          }}>
            {item.impact}
          </span>
          {item.sources && (
            <span style={{ fontSize: 8, color: t.cyan, cursor: 'pointer', fontFamily: t.font }}>
              View {item.sources} sources ↓
            </span>
          )}
          {item.tags?.filter(tag => tag !== 'BREAKING').map(tag => (
            <span key={tag} style={{
              fontSize: 8, padding: '1px 5px',
              border: `1px solid ${t.border}`,
              borderRadius: t.radius, color: t.textDim, fontFamily: t.font,
            }}>
              {tag}
            </span>
          ))}
        </div>
      </div>
    </div>
  )
}

export default function IntelFeed() {
  const [activeTab, setTab]    = useState('ALL')
  const [activeTF,  setTF]     = useState('24H')
  const [filter,    setFilter] = useState('ALL')
  const newsFeed = useDataStore((s) => s.newsFeed)
  const t = useTheme()
  const isModern = t.name === 'modern'

  const items = (newsFeed.length ? newsFeed : MOCK_NEWS).filter(n => {
    if (activeTab !== 'ALL' && n.category !== activeTab) return false
    if (filter === 'HIGH IMPACT' && n.impact !== 'HIGH') return false
    if (filter === 'BREAKING' && !n.tags?.includes('BREAKING')) return false
    if (filter === 'TRUMP' && !n.handle?.includes('Trump')) return false
    if (filter === 'RBI' && n.src !== 'RBI') return false
    if (filter === 'WHALE ALERT' && n.src !== 'WH') return false
    return true
  })

  return (
    <div style={{
      background: t.bgPanel,
      display: 'flex', flexDirection: 'column', overflow: 'hidden',
      backdropFilter: isModern ? t.panelGlass : 'none',
    }}>
      <div style={{
        display: 'flex', alignItems: 'center',
        background: t.headerGrad,
        borderBottom: `1px solid ${t.border}`,
        height: 22, flexShrink: 0,
      }}>
        <span style={{
          padding: '0 10px', color: t.accent, fontSize: 10, fontWeight: 500,
          letterSpacing: .4, borderRight: `1px solid ${t.border}`,
          height: '100%', display: 'flex', alignItems: 'center',
          fontFamily: t.font, textShadow: isModern ? t.glowAccent : 'none',
        }}>
          INTEL FEED {'<GO>'}
        </span>
        <span style={{ padding: '0 8px', color: t.textDim, fontSize: 9, fontFamily: t.font }}>
          LIVE · X · NEWS · RSS
        </span>
        <div style={{ marginLeft: 'auto', padding: '0 8px' }}>
          <span style={{
            fontSize: 9, color: t.bull, fontFamily: t.font,
            textShadow: isModern ? t.glowBull : 'none',
          }}>
            ● {items.length} ITEMS
          </span>
        </div>
      </div>

      <div style={{ display: 'flex', borderBottom: `1px solid ${t.border}`, flexShrink: 0, height: 22, overflow: 'hidden' }}>
        {TABS.map(tab => (
          <div key={tab.k} onClick={() => setTab(tab.k)} style={{
            padding: '0 8px', height: '100%', display: 'flex', alignItems: 'center', gap: 4,
            fontSize: 9, color: activeTab === tab.k ? t.accent : t.textDim,
            cursor: 'pointer', borderRight: `1px solid ${t.border}`, letterSpacing: .3,
            borderBottom: activeTab === tab.k ? `1px solid ${t.accent}` : 'none',
            whiteSpace: 'nowrap', fontFamily: t.font,
            textShadow: activeTab === tab.k && isModern ? t.glowAccent : 'none',
          }}>
            {tab.label}
            <span style={{
              background: t.bgActive,
              color: t.textMuted, padding: '0 3px', borderRadius: t.radius, fontSize: 8,
              fontFamily: t.font,
            }}>
              {tab.n}
            </span>
          </div>
        ))}
      </div>

      <div style={{ display: 'flex', alignItems: 'center', borderBottom: `1px solid ${t.border}`, height: 22, padding: '0 6px', gap: 4, flexShrink: 0, overflow: 'hidden' }}>
        {FILTERS.map(f => (
          <div key={f} onClick={() => setFilter(f)} style={{
            padding: '1px 7px', borderRadius: t.radius, fontSize: 8, cursor: 'pointer', whiteSpace: 'nowrap',
            border: filter === f ? 'none' : `1px solid ${t.border}`,
            background: filter === f
              ? (isModern ? t.accentGrad : t.accent)
              : 'transparent',
            color: filter === f ? t.textInverse : t.textDim,
            fontWeight: filter === f ? 700 : 400,
            fontFamily: t.font,
            boxShadow: filter === f && isModern ? t.glowAccent : 'none',
          }}>
            {f}
          </div>
        ))}
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 4 }}>
          {TIMEFRAMES.map(tf => (
            <div key={tf} onClick={() => setTF(tf)} style={{
              padding: '1px 5px', borderRadius: t.radius, fontSize: 8, cursor: 'pointer',
              color: activeTF === tf ? t.cyan : t.textDim,
              borderBottom: activeTF === tf ? `1px solid ${t.cyan}` : 'none',
              fontFamily: t.font,
              textShadow: activeTF === tf && isModern ? `0 0 6px ${t.cyan}` : 'none',
            }}>
              {tf}
            </div>
          ))}
        </div>
      </div>

      <div style={{ flex: 1, overflowY: 'auto' }}>
        {items.map((item, i) => <NewsItem key={i} item={item} t={t} />)}
      </div>
    </div>
  )
}

const MOCK_NEWS = [
  { src: 'X',    category: 'X',         headline: 'Trump signs executive order establishing US Strategic Bitcoin Reserve — Treasury directed to accumulate BTC', quote: 'The United States will be the crypto capital of the planet.', handle: '@realDonaldTrump', time: '6 mins ago', impact: 'HIGH', tags: ['BREAKING', 'US POLICY'], sources: 23 },
  { src: 'RBI',  category: 'REGULATOR', headline: 'RBI MPC holds repo rate at 6.25% — GDP forecast upgraded to 6.8% for FY26, inflation at 4.2%', source: 'RBI.org.in', time: '9 mins ago', impact: 'HIGH', tags: ['INDIA MACRO'] },
  { src: 'X',    category: 'CRYPTO',    headline: 'MicroStrategy buys 12,000 BTC — total treasury now 470,000 BTC worth $41.5B', quote: 'Bitcoin is the only asset worth holding at scale.', handle: '@saylor', time: '14 mins ago', impact: 'HIGH', tags: ['CRYPTO'], sources: 23 },
  { src: 'ET',   category: 'INDIA',     headline: 'FII net buyers ₹3,420 Cr today — DII add ₹2,100 Cr — highest institutional buying in 3 months', source: 'Economic Times', time: '18 mins ago', impact: 'HIGH', tags: ['INDIA BULLISH'] },
  { src: 'WH',   category: 'CRYPTO',    headline: 'Whale Alert: 8,500 BTC moved to cold storage — 3rd largest whale transfer of 2025', source: '@whale_alert', time: '22 mins ago', impact: 'MEDIUM', tags: ['SUPPLY LOCK'] },
  { src: 'BS',   category: 'INDIA',     headline: 'India PMI Manufacturing 57.4 — 14-month high on export demand. Services PMI 59.1', source: 'Business Standard', time: '31 mins ago', impact: 'MEDIUM', tags: [] },
  { src: 'SEBI', category: 'REGULATOR', headline: 'SEBI proposes new F&O position limits for retail — OTM weekly options to be restricted further from May 2025', source: '@SEBI_India', time: '44 mins ago', impact: 'HIGH', tags: ['F&O RISK'] },
  { src: 'GL',   category: 'CRYPTO',    headline: 'Glassnode: BTC exchange netflow -12,400 BTC in 24h — coins leaving exchanges, supply shock building', source: 'Glassnode', time: '52 mins ago', impact: 'MEDIUM', tags: ['BULLISH SIGNAL'] },
  { src: 'MC',   category: 'INDIA',     headline: 'Reliance Q3 results preview: Analysts expect 8% YoY revenue on O2C recovery + Jio subscriber growth', source: 'Moneycontrol', time: '1h 4m ago', impact: 'MEDIUM', tags: ['RELIANCE'] },
  { src: 'GLOB', category: 'GLOBAL',    headline: 'US Fed holds rates steady — dot plot signals 2 cuts in 2026 H2. Dollar weakens, gold rallies', source: 'Global Macro', time: '1h 22m ago', impact: 'HIGH', tags: ['GLOBAL'], sources: 47 },
  { src: 'CP',   category: 'CRYPTO',    headline: 'Spot Bitcoin ETF total inflows hit $480M today — 7th consecutive positive flow day. BlackRock leads $312M', source: 'CryptoPanic', time: '1h 38m ago', impact: 'HIGH', tags: ['ETF FLOW'] },
  { src: 'X',    category: 'X',         headline: 'Iran ceasefire deal reached — oil prices slide 3%, defence stocks fall, market sentiment improves', handle: '@StateDept', time: '1h 51m ago', impact: 'MEDIUM', tags: ['GLOBAL', 'MILITARY'], sources: 47 },
]
