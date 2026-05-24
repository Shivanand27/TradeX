// src/App.jsx
// ────────────────────────────────────────────────────────
// Root app: auth gate + router.
// Adds proper loading UI and a per-route error boundary so one
// broken panel doesn't tank the whole terminal.

import { useEffect, useState } from 'react'
import { Navigate, Route, Routes } from 'react-router-dom'
import ErrorBoundary from './components/common/ErrorBoundary'
import { supabase } from './lib/supabase'
import { getUserConfig } from './lib/api'
import Login from './pages/Login'
import Terminal from './pages/Terminal'
import { useTerminalStore } from './store'

function AuthGuard({ children }) {
  const user = useTerminalStore((s) => s.user)
  return user ? children : <Navigate to="/login" replace />
}

async function loadUserRecord(accessToken) {
  const apiBase = import.meta.env.VITE_API_URL || ''
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 8000)
  try {
    const res = await fetch(`${apiBase}/api/auth/me`, {
      headers: { Authorization: `Bearer ${accessToken}` },
      signal: controller.signal,
    })
    if (!res.ok) throw new Error(`auth/me ${res.status}`)
    return res.json()
  } finally {
    clearTimeout(timer)
  }
}

const _DEV_MODE = import.meta.env.VITE_DEV_MODE === 'true'
const _DEV_USER  = { id: '00000000-0000-0000-0000-000000000001', email: 'dev@localhost' }

export default function App() {
  const { setUser, clearUser, setWatchlistSidebarSymbols } = useTerminalStore()
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (_DEV_MODE) {
      setUser(_DEV_USER, true)
      setLoading(false)
      return
    }

    let mounted = true

    async function bootstrap(session) {
      if (!session?.user) {
        clearUser()
        return
      }
      try {
        const rec = await loadUserRecord(session.access_token)
        if (mounted && rec?.status === 'active') {
          setUser(session.user, rec.is_admin)
          // Restore watchlist from user config (best-effort, non-blocking)
          getUserConfig().then(cfg => {
            if (mounted && cfg?.watchlist) setWatchlistSidebarSymbols(cfg.watchlist)
          }).catch(() => {})
        } else if (mounted) {
          await supabase.auth.signOut()
          clearUser()
        }
      } catch {
        if (mounted) clearUser()
      }
    }

    supabase.auth.getSession().then(async ({ data: { session } }) => {
      await bootstrap(session)
      if (mounted) setLoading(false)
    }).catch(() => {
      if (mounted) { clearUser(); setLoading(false) }
    })

    const { data: { subscription } } = supabase.auth.onAuthStateChange(
      async (event, session) => {
        if (event === 'SIGNED_OUT' || !session) {
          clearUser()
        } else if (event === 'SIGNED_IN' || event === 'TOKEN_REFRESHED') {
          await bootstrap(session)
        }
      }
    )

    return () => {
      mounted = false
      subscription?.unsubscribe()
    }
  }, [setUser, clearUser, setWatchlistSidebarSymbols])

  if (loading) {
    return (
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        height: '100vh', background: '#060809',
        fontFamily: '"IBM Plex Mono", monospace',
      }}>
        <div style={{
          color: '#ff8c00', fontSize: 12, letterSpacing: 1.2,
          animation: 'pulse 1.4s ease-in-out infinite',
        }}>
          TRADEX TERMINAL · INITIALIZING
        </div>
        <style>{`
          @keyframes pulse { 0%,100% { opacity: 0.4 } 50% { opacity: 1 } }
        `}</style>
      </div>
    )
  }

  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route path="/*" element={
        <AuthGuard>
          <ErrorBoundary scope="TERMINAL">
            <Terminal />
          </ErrorBoundary>
        </AuthGuard>
      } />
    </Routes>
  )
}
