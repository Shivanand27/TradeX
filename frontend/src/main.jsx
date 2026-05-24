// src/main.jsx
// ────────────────────────────────────────────────────────
// Bootstrap: React root + providers + top-level ErrorBoundary.

import React from 'react'
import ReactDOM from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { Toaster } from 'react-hot-toast'
import App from './App'
import ErrorBoundary from './components/common/ErrorBoundary'
import './index.css'

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 60_000,        // 1 min default — individual queries override as needed
      refetchInterval: false,   // no global polling; each query opts in explicitly
      refetchOnWindowFocus: false,
      retry: (failureCount, error) => {
        const status = error?.response?.status
        if (status === 401 || status === 403) return false
        return failureCount < 2
      },
    },
  },
})

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <ErrorBoundary scope="APP">
      <QueryClientProvider client={queryClient}>
        <BrowserRouter>
          <App />
          <Toaster
            position="bottom-right"
            toastOptions={{
              duration: 4500,
              style: {
                background: '#0f1317',
                color: '#c8d8e8',
                border: '1px solid #1f2830',
                fontFamily: '"IBM Plex Mono", monospace',
                fontSize: '11px',
                padding: '8px 12px',
              },
              success: { iconTheme: { primary: '#00e676', secondary: '#000' } },
              error:   { iconTheme: { primary: '#ff3b4e', secondary: '#fff' } },
            }}
          />
        </BrowserRouter>
      </QueryClientProvider>
    </ErrorBoundary>
  </React.StrictMode>
)
