// src/components/terminal/Sidebar.jsx
// Vertical navigation sidebar — replaces the F-key function bar.
// Collapsed: 56px icon strip. Expanded: 200px with labels.
// F1-F9 keyboard shortcuts still work via useHotkeys.

import { useTerminalStore, useTheme } from '../../store'

const NAV_ITEMS = [
  { view: 'terminal', label: 'Dashboard', icon: NavHome,      fkey: 'F1' },
  { view: 'signals',  label: 'Signals',   icon: NavSignals,   fkey: 'F2' },
  { view: 'screener', label: 'Screener',  icon: NavScreener,  fkey: 'F3' },
  { view: 'trades',   label: 'Trades',    icon: NavTrades,    fkey: 'F4' },
  { view: 'risk',     label: 'Risk',      icon: NavRisk,      fkey: 'F5' },
  { view: 'news',     label: 'Intel',     icon: NavNews,      fkey: 'F6' },
  { view: 'bots',     label: 'Agents',    icon: NavBots,      fkey: 'F7' },
  { view: 'journal',  label: 'Journal',   icon: NavJournal,   fkey: null },
  { view: 'users',    label: 'Users',     icon: NavUsers,     fkey: 'F8', admin: true },
  { view: 'settings', label: 'Settings',  icon: NavSettings,  fkey: 'F9' },
]

// ── SVG icon components ───────────────────────────────────────────
function NavHome({ color, size = 16 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none">
      <path d="M2 7L8 2L14 7V14H10V10H6V14H2V7Z" stroke={color} strokeWidth="1.25" strokeLinejoin="round" fill="none"/>
    </svg>
  )
}
function NavSignals({ color, size = 16 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none">
      <path d="M8 13V8M5 13V10M11 13V6M2 13V12M14 13V4" stroke={color} strokeWidth="1.5" strokeLinecap="round"/>
    </svg>
  )
}
function NavScreener({ color, size = 16 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none">
      <rect x="1" y="2" width="14" height="12" rx="2" stroke={color} strokeWidth="1.25" fill="none"/>
      <path d="M4 10L6 7L8 9L10 5L12 8" stroke={color} strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round"/>
      <line x1="1" y1="6" x2="15" y2="6" stroke={color} strokeWidth=".75" opacity=".4"/>
    </svg>
  )
}
function NavOrders({ color, size = 16 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none">
      <rect x="2" y="3" width="12" height="2" rx="1" fill={color} opacity=".8"/>
      <rect x="2" y="7" width="9" height="2" rx="1" fill={color} opacity=".6"/>
      <rect x="2" y="11" width="6" height="2" rx="1" fill={color} opacity=".4"/>
    </svg>
  )
}
function NavTrades({ color, size = 16 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none">
      <rect x="1" y="3" width="8" height="1.5" rx=".75" fill={color} opacity=".9"/>
      <rect x="1" y="6.25" width="6" height="1.5" rx=".75" fill={color} opacity=".7"/>
      <rect x="1" y="9.5" width="4" height="1.5" rx=".75" fill={color} opacity=".5"/>
      <circle cx="12" cy="9" r="3" stroke={color} strokeWidth="1.25" fill="none" opacity=".9"/>
      <circle cx="12" cy="9" r="1.25" fill={color} opacity=".6"/>
    </svg>
  )
}
function NavPositions({ color, size = 16 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none">
      <circle cx="8" cy="8" r="5.5" stroke={color} strokeWidth="1.25" fill="none"/>
      <circle cx="8" cy="8" r="2.5" fill={color} opacity=".5"/>
    </svg>
  )
}
function NavRisk({ color, size = 16 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none">
      <path d="M8 2L14 13H2L8 2Z" stroke={color} strokeWidth="1.25" strokeLinejoin="round" fill="none"/>
      <line x1="8" y1="6" x2="8" y2="9.5" stroke={color} strokeWidth="1.25" strokeLinecap="round"/>
      <circle cx="8" cy="11" r=".75" fill={color}/>
    </svg>
  )
}
function NavNews({ color, size = 16 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none">
      <rect x="2" y="2" width="12" height="12" rx="2" stroke={color} strokeWidth="1.25" fill="none"/>
      <path d="M5 6H11M5 8H9M5 10H8" stroke={color} strokeWidth="1" strokeLinecap="round"/>
    </svg>
  )
}
function NavBots({ color, size = 16 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none">
      <rect x="3" y="5" width="10" height="8" rx="2" stroke={color} strokeWidth="1.25" fill="none"/>
      <circle cx="6" cy="9" r="1" fill={color}/>
      <circle cx="10" cy="9" r="1" fill={color}/>
      <path d="M8 3V5" stroke={color} strokeWidth="1.25" strokeLinecap="round"/>
      <circle cx="8" cy="2.5" r=".75" fill={color}/>
    </svg>
  )
}
function NavUsers({ color, size = 16 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none">
      <circle cx="6" cy="5.5" r="2.5" stroke={color} strokeWidth="1.25" fill="none"/>
      <path d="M1 13.5C1 11 3.5 9 6 9s5 2 5 4.5" stroke={color} strokeWidth="1.25" strokeLinecap="round" fill="none"/>
      <circle cx="12" cy="5" r="2" stroke={color} strokeWidth="1" fill="none" opacity=".6"/>
      <path d="M14.5 12.5c0-1.9-1.1-3-2.5-3" stroke={color} strokeWidth="1" strokeLinecap="round" opacity=".6"/>
    </svg>
  )
}
function NavJournal({ color, size = 16 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none">
      <rect x="3" y="1" width="10" height="14" rx="1.5" stroke={color} strokeWidth="1.25" fill="none"/>
      <path d="M5.5 5H10.5M5.5 7.5H10.5M5.5 10H8.5" stroke={color} strokeWidth="1" strokeLinecap="round"/>
      <path d="M3 3H2.5a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1H3" stroke={color} strokeWidth="1" strokeLinecap="round" opacity=".5"/>
    </svg>
  )
}
function NavSettings({ color, size = 16 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none">
      <circle cx="8" cy="8" r="2.25" stroke={color} strokeWidth="1.25" fill="none"/>
      <path d="M8 2v1.5M8 12.5V14M14 8h-1.5M3.5 8H2M12.2 3.8l-1.05 1.05M4.85 11.15l-1.05 1.05M12.2 12.2l-1.05-1.05M4.85 4.85L3.8 3.8" stroke={color} strokeWidth="1.25" strokeLinecap="round"/>
    </svg>
  )
}
function ChevronLeft({ color, size = 14 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 14 14" fill="none">
      <path d="M9 3L5 7L9 11" stroke={color} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
    </svg>
  )
}
function ChevronRight({ color, size = 14 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 14 14" fill="none">
      <path d="M5 3L9 7L5 11" stroke={color} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
    </svg>
  )
}

// ── Nav item ─────────────────────────────────────────────────────
function NavItem({ item, isActive, collapsed, onClick, t }) {
  const Icon    = item.icon
  const color   = isActive ? t.accent : t.textDim
  const bgColor = isActive ? t.accentBg : 'transparent'

  return (
    <div
      onClick={onClick}
      title={collapsed ? (item.fkey ? `${item.label}  (${item.fkey})` : item.label) : undefined}
      style={{
        display:     'flex',
        alignItems:  'center',
        gap:         10,
        padding:     collapsed ? '10px 0' : '9px 14px',
        justifyContent: collapsed ? 'center' : 'flex-start',
        cursor:      'pointer',
        borderRadius: t.radius,
        margin:      '1px 8px',
        background:  bgColor,
        borderLeft:  isActive && !collapsed ? `2px solid ${t.accent}` : '2px solid transparent',
        transition:  'all 0.15s ease',
        position:    'relative',
      }}
      onMouseEnter={e => {
        if (!isActive) e.currentTarget.style.background = `rgba(255,255,255,0.04)`
      }}
      onMouseLeave={e => {
        if (!isActive) e.currentTarget.style.background = 'transparent'
      }}
    >
      <Icon color={color} size={16} />
      {!collapsed && (
        <>
          <span style={{
            fontSize:      12,
            fontFamily:    t.fontUI,
            fontWeight:    isActive ? 600 : 400,
            color,
            letterSpacing: 0.1,
            flex: 1,
          }}>
            {item.label}
          </span>
        </>
      )}
      {isActive && collapsed && (
        <div style={{
          position:     'absolute',
          left:         0,
          top:          '50%',
          transform:    'translateY(-50%)',
          width:        2,
          height:       18,
          background:   t.accent,
          borderRadius: '0 2px 2px 0',
        }} />
      )}
    </div>
  )
}

// ── Main sidebar ──────────────────────────────────────────────────
export default function Sidebar() {
  const t             = useTheme()
  const activeView    = useTerminalStore(s => s.activeView)
  const setActiveView = useTerminalStore(s => s.setActiveView)
  const isAdmin       = useTerminalStore(s => s.isAdmin)
  const collapsed     = useTerminalStore(s => s.sidebarCollapsed)
  const toggle        = useTerminalStore(s => s.toggleSidebar)

  const W = collapsed ? 56 : 200

  return (
    <div style={{
      width:      W,
      minWidth:   W,
      height:     '100vh',
      background: t.bgSidebar,
      borderRight:`1px solid ${t.border}`,
      display:    'flex',
      flexDirection: 'column',
      transition: 'width 0.2s ease, min-width 0.2s ease',
      overflow:   'hidden',
      flexShrink: 0,
      zIndex:     50,
    }}>

      {/* ── Brand ── */}
      <div style={{
        height:         56,
        display:        'flex',
        alignItems:     'center',
        justifyContent: collapsed ? 'center' : 'flex-start',
        padding:        collapsed ? 0 : '0 16px',
        borderBottom:   `1px solid ${t.border}`,
        flexShrink:     0,
        gap:            10,
      }}>
        {/* Logo mark */}
        <div style={{
          width:          32,
          height:         32,
          borderRadius:   8,
          background:     'linear-gradient(135deg, #0EA5E9 0%, #818CF8 50%, #A855F7 100%)',
          display:        'flex',
          alignItems:     'center',
          justifyContent: 'center',
          flexShrink:     0,
          boxShadow:      '0 4px 16px rgba(14,165,233,.45), 0 0 0 1px rgba(255,255,255,.1)',
          position:       'relative',
          overflow:       'hidden',
        }}>
          <div style={{
            position: 'absolute', inset: 0,
            background: 'linear-gradient(135deg, rgba(255,255,255,.2) 0%, transparent 50%)',
          }}/>
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none">
            <polyline points="3,17 8,10 12,13 17,6" stroke="white" strokeWidth="2.4"
                      strokeLinecap="round" strokeLinejoin="round"
                      filter="drop-shadow(0 0 4px rgba(255,255,255,.6))"/>
            <polyline points="17,6 21,6 21,10" stroke="white" strokeWidth="2.4"
                      strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
        </div>
        {!collapsed && (
          <div>
            <div style={{ color: t.text, fontWeight: 700, fontSize: 13, fontFamily: t.fontUI, letterSpacing: -0.3 }}>
              TradeX
            </div>
            <div style={{ color: t.textDim, fontSize: 9, fontFamily: t.font, letterSpacing: 0.5 }}>
              TERMINAL
            </div>
          </div>
        )}
      </div>

      {/* ── Nav items ── */}
      <div style={{ flex: 1, overflowY: 'auto', overflowX: 'hidden', paddingTop: 8 }}>
        {NAV_ITEMS.filter(f => !f.admin || isAdmin).map(item => (
          <NavItem
            key={item.view}
            item={item}
            isActive={activeView === item.view}
            collapsed={collapsed}
            onClick={() => setActiveView(item.view)}
            t={t}
          />
        ))}
      </div>

      {/* ── Collapse toggle ── */}
      <div style={{ borderTop: `1px solid ${t.border}`, padding: '8px', flexShrink: 0 }}>
        <div
          onClick={toggle}
          title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          style={{
            display:        'flex',
            alignItems:     'center',
            justifyContent: 'center',
            gap:            6,
            padding:        '8px',
            borderRadius:   t.radius,
            cursor:         'pointer',
            color:          t.textDim,
            transition:     'all 0.15s',
          }}
          onMouseEnter={e => e.currentTarget.style.background = `rgba(255,255,255,0.05)`}
          onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
        >
          {collapsed
            ? <ChevronRight color={t.textDim} size={14} />
            : (
              <>
                <ChevronLeft color={t.textDim} size={14} />
                <span style={{ fontSize: 10, fontFamily: t.fontUI, color: t.textDim }}>Collapse</span>
              </>
            )
          }
        </div>
      </div>
    </div>
  )
}
