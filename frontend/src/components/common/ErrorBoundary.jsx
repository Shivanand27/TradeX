// src/components/common/ErrorBoundary.jsx
// ────────────────────────────────────────────────────────
// Top-level error boundary. Any render error in a child tree
// surfaces a terminal-styled fallback instead of a blank screen.
//
// Usage: wrap <App /> in main.jsx, and optionally wrap individual
// panels so one broken panel doesn't take down the whole terminal.

import { Component } from 'react'

export default class ErrorBoundary extends Component {
  constructor(props) {
    super(props)
    this.state = { error: null, info: null }
  }

  static getDerivedStateFromError(error) {
    return { error }
  }

  componentDidCatch(error, info) {
    this.setState({ info })
    // eslint-disable-next-line no-console
    console.error('[ErrorBoundary]', error, info)
    // Optional: ship to a reporter like Sentry here
  }

  handleReload = () => {
    // Clear the error so the tree remounts; full reload as a fallback
    this.setState({ error: null, info: null })
    if (this.props.onReset) {
      this.props.onReset()
    } else {
      window.location.reload()
    }
  }

  render() {
    if (!this.state.error) return this.props.children

    const scope = this.props.scope || 'TERMINAL'

    return (
      <div style={{
        background: '#060809',
        color: '#c8d8e8',
        fontFamily: '"IBM Plex Mono", monospace',
        padding: 24,
        height: '100%',
        minHeight: 240,
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'center',
        alignItems: 'center',
        borderLeft: '3px solid #ff3b4e',
      }}>
        <div style={{
          width: '100%', maxWidth: 560,
          background: '#0a0d10',
          border: '1px solid #1f2830',
          padding: 20,
        }}>
          <div style={{
            fontSize: 10, color: '#ff3b4e', letterSpacing: 0.6, marginBottom: 6,
          }}>
            ▲ {scope} FAULT
          </div>
          <div style={{ fontSize: 13, fontWeight: 600, color: '#ff8c00', marginBottom: 12 }}>
            A panel crashed while rendering
          </div>
          <div style={{
            fontSize: 10, color: '#6a8099', lineHeight: 1.5,
            background: '#14191f', padding: '8px 10px', border: '1px solid #1f2830',
            marginBottom: 14, overflow: 'auto', maxHeight: 160,
          }}>
            <strong style={{ color: '#c8d8e8' }}>
              {this.state.error?.name}:
            </strong>{' '}
            {this.state.error?.message || 'Unknown error'}
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button onClick={this.handleReload} style={{
              background: '#ff8c00', color: '#000', border: 'none',
              padding: '6px 14px', fontSize: 11, fontWeight: 700,
              fontFamily: '"IBM Plex Mono", monospace', cursor: 'pointer',
            }}>
              RELOAD
            </button>
            <div style={{ fontSize: 9, color: '#334455', alignSelf: 'center' }}>
              If this keeps happening, contact support with request-id from network tab.
            </div>
          </div>
        </div>
      </div>
    )
  }
}
