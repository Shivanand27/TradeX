// src/components/common/LoadingSkeleton.jsx
// ────────────────────────────────────────────────────────
// Terminal-styled loading skeleton. Use while React Query fetches.

export function LoadingSkeleton({ rows = 5, label = 'LOADING' }) {
  return (
    <div style={{
      flex: 1, padding: 12,
      fontFamily: '"IBM Plex Mono", monospace',
    }}>
      <div style={{
        fontSize: 9, color: '#ff8c00', letterSpacing: 0.5,
        marginBottom: 10, display: 'flex', alignItems: 'center', gap: 6,
      }}>
        <span style={{
          width: 6, height: 6, borderRadius: '50%', background: '#ff8c00',
          animation: 'pulse 1.2s ease-in-out infinite',
        }} />
        {label}
      </div>
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} style={{
          height: 14,
          background: `linear-gradient(90deg, #0f1317 0%, #1f2830 50%, #0f1317 100%)`,
          backgroundSize: '200% 100%',
          animation: 'shimmer 1.4s ease-in-out infinite',
          marginBottom: 6,
          width: `${90 - i * 8}%`,
          borderRadius: 2,
        }} />
      ))}
      <style>{`
        @keyframes shimmer {
          0%   { background-position: 200% 0; }
          100% { background-position: -200% 0; }
        }
        @keyframes pulse {
          0%, 100% { opacity: 0.4; }
          50%      { opacity: 1; }
        }
      `}</style>
    </div>
  )
}

// src/components/common/EmptyState.jsx
// Unified empty-state component for "no data" panels.
export function EmptyState({ label = 'NO DATA', hint, icon = '—' }) {
  return (
    <div style={{
      flex: 1, display: 'flex', flexDirection: 'column',
      alignItems: 'center', justifyContent: 'center',
      fontFamily: '"IBM Plex Mono", monospace',
      padding: 20, color: '#334455',
    }}>
      <div style={{ fontSize: 20, color: '#1f2830', marginBottom: 8 }}>
        {icon}
      </div>
      <div style={{ fontSize: 10, letterSpacing: 0.5, color: '#6a8099' }}>
        {label}
      </div>
      {hint && (
        <div style={{ fontSize: 9, color: '#334455', marginTop: 4, textAlign: 'center', maxWidth: 280 }}>
          {hint}
        </div>
      )}
    </div>
  )
}

// src/components/common/ConnectionStatus.jsx
// Shows a pill that tells the user their connection state.
export function ConnectionStatus({ wsState, apiError }) {
  let color = '#6a8099'
  let label = 'UNKNOWN'
  if (wsState === 'open' && !apiError) { color = '#00e676'; label = 'LIVE' }
  else if (wsState === 'connecting') { color = '#f5a523'; label = 'CONNECTING' }
  else if (wsState === 'closed' || apiError) { color = '#ff3b4e'; label = 'OFFLINE' }

  return (
    <div style={{
      display: 'inline-flex', alignItems: 'center', gap: 4,
      fontSize: 9, color, letterSpacing: 0.3,
    }}>
      <span style={{
        width: 6, height: 6, borderRadius: '50%',
        background: color,
        animation: wsState === 'connecting' ? 'blink 0.9s infinite' : 'none',
      }} />
      {label}
      <style>{`@keyframes blink { 50% { opacity: 0.3; } }`}</style>
    </div>
  )
}

// Default export for single-file consumers
export default LoadingSkeleton
