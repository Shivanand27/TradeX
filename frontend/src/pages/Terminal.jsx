// src/pages/Terminal.jsx
// Shell: left sidebar nav + top bar + animated ticker + content area.
// F1–F9 keyboard shortcuts active via useHotkeys.

import { lazy, Suspense, useEffect } from 'react'
import { useQuery } from '@tanstack/react-query'
import { getNewsFeeds, getOrders, getPositions, getRiskSummary, getSignals } from '../lib/api'
import { useDataStore, useTerminalStore, useTheme } from '../store'
import { useHotkeys, useISTClock, useWebSocket } from '../hooks'

import Sidebar        from '../components/terminal/Sidebar'
import CommandBar     from '../components/terminal/CommandBar'
import TickerStrip    from '../components/terminal/TickerStrip'
import RiskPanel      from '../components/risk/RiskPanel'
import IntelFeed      from '../components/news/IntelFeed'
import PositionsOrdersPage from '../components/trading/PositionsOrdersPage'
import OrderTicket    from '../components/trading/OrderTicket'
import SignalPopup    from '../components/signals/SignalPopup'
import ErrorBoundary  from '../components/common/ErrorBoundary'
import { LoadingSkeleton } from '../components/common/LoadingSkeleton'
import HomeDashboard  from '../components/home/HomeDashboard'
import SignalsPage    from './SignalsPage'
import ScreenerPage   from './ScreenerPage'
import JournalPage    from './JournalPage'
import BotsPage       from './BotsPage'
import DocsPage       from './DocsPage'

const SettingsPage = lazy(() => import('../components/settings/SettingsPage'))
const UsersPage    = lazy(() => import('../components/users/UsersPage'))

export default function Terminal() {
  const wsState = useWebSocket()
  const clock   = useISTClock()
  useHotkeys()
  const t = useTheme()

  const { setSignals, setRisk, setNewsFeed, setWsState, setOrders, setPositions } = useDataStore()
  const activeView = useTerminalStore(s => s.activeView)
  const isAdmin    = useTerminalStore(s => s.isAdmin)

  useEffect(() => { setWsState(wsState) }, [wsState, setWsState])

  // ── Data polling (REST fallback — real-time data arrives via WebSocket) ──
  // Tickers, risk: pushed by WS every 1s — no REST polling needed.
  // Signals/news: low-frequency updates, poll every 60s.
  // Orders/positions: not WS-pushed, poll every 15s (broker round-trip).
  const { data: signalsData   } = useQuery({ queryKey: ['signals'],   queryFn: () => getSignals(),                refetchInterval: 60_000  })
  const { data: riskData      } = useQuery({ queryKey: ['risk'],      queryFn: getRiskSummary,                    refetchInterval: 60_000  })
  const { data: newsData      } = useQuery({ queryKey: ['news'],      queryFn: () => getNewsFeeds({ limit: 60 }), refetchInterval: 30_000  })
  const { data: ordersData    } = useQuery({ queryKey: ['orders'],    queryFn: getOrders,                         refetchInterval: 15_000  })
  const { data: positionsData } = useQuery({ queryKey: ['positions'], queryFn: getPositions,                      refetchInterval: 15_000  })

  useEffect(() => { if (signalsData?.signals)     setSignals(signalsData.signals)       }, [signalsData, setSignals])
  useEffect(() => { if (riskData)                 setRisk(riskData)                     }, [riskData, setRisk])
  useEffect(() => { if (newsData?.items)          setNewsFeed(newsData.items)           }, [newsData, setNewsFeed])
  useEffect(() => { if (ordersData?.orders)       setOrders(ordersData.orders)          }, [ordersData, setOrders])
  useEffect(() => { if (positionsData?.positions) setPositions(positionsData.positions) }, [positionsData, setPositions])

  return (
    <div style={{ display: 'flex', height: '100vh', background: t.bg, overflow: 'hidden' }}>

      {/* ── Sidebar navigation ── */}
      <Sidebar />

      {/* ── Main content column ── */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', minWidth: 0 }}>

        <CommandBar clock={clock} />
        <TickerStrip />

        {/* Global overlays */}
        <OrderTicket />
        <SignalPopup />

        {/* Views */}
        {activeView === 'terminal' && (
          <ErrorBoundary scope="HOME"><HomeDashboard /></ErrorBoundary>
        )}
        {activeView === 'signals' && (
          <ErrorBoundary scope="SIGNALS"><SignalsPage /></ErrorBoundary>
        )}
        {activeView === 'screener' && (
          <ErrorBoundary scope="SCREENER"><ScreenerPage /></ErrorBoundary>
        )}
        {activeView === 'trades' && (
          <ErrorBoundary scope="TRADES"><PositionsOrdersPage /></ErrorBoundary>
        )}
        {activeView === 'risk' && (
          <ErrorBoundary scope="RISK"><RiskPanel /></ErrorBoundary>
        )}
        {activeView === 'news' && (
          <ErrorBoundary scope="INTEL"><IntelFeed /></ErrorBoundary>
        )}
        {activeView === 'bots' && (
          <ErrorBoundary scope="BOTS"><BotsPage /></ErrorBoundary>
        )}
        {activeView === 'journal' && (
          <ErrorBoundary scope="JOURNAL"><JournalPage /></ErrorBoundary>
        )}
        {activeView === 'users' && isAdmin && (
          <ErrorBoundary scope="USERS">
            <Suspense fallback={<LoadingSkeleton rows={6} label="LOADING USERS" />}>
              <UsersPage />
            </Suspense>
          </ErrorBoundary>
        )}
        {activeView === 'settings' && (
          <ErrorBoundary scope="SETTINGS">
            <Suspense fallback={<LoadingSkeleton rows={6} label="LOADING SETTINGS" />}>
              <SettingsPage />
            </Suspense>
          </ErrorBoundary>
        )}
        {activeView === 'docs' && (
          <ErrorBoundary scope="DOCS"><DocsPage /></ErrorBoundary>
        )}

      </div>
    </div>
  )
}
