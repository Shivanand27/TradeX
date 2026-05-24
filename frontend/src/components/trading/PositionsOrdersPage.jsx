// src/components/trading/PositionsOrdersPage.jsx
// Split view: Orders (top 5, always visible) + Positions (below, fills rest).

import { useTheme } from '../../store'
import OrderBlotter  from './OrderBlotter'
import PositionsPanel from './PositionsPanel'

export default function PositionsOrdersPage() {
  const t = useTheme()

  return (
    <div style={{
      flex: 1, display: 'flex', flexDirection: 'column',
      overflow: 'hidden', minWidth: 0,
    }}>
      {/* Orders — fixed height, top 5 rows */}
      <div style={{
        height: 224, flexShrink: 0,
        borderBottom: `2px solid ${t.border}`,
        display: 'flex', flexDirection: 'column',
        overflow: 'hidden',
      }}>
        <OrderBlotter maxRows={5} />
      </div>

      {/* Positions — fills remaining space */}
      <div style={{
        flex: 1, overflow: 'hidden',
        display: 'flex', flexDirection: 'column',
      }}>
        <PositionsPanel />
      </div>
    </div>
  )
}
