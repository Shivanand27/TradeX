import { useState, useEffect } from 'react'
import { getUserConfig, saveUserConfig } from '../../lib/api'
import toast from 'react-hot-toast'
import { useTheme, useTerminalStore } from '../../store'

// ── Themed sub-components ─────────────────────────────────────
function Panel({ title, badge, badgeColor, children, t }) {
  return (
    <div style={{
      background: t.bgPanel,
      border: t.panelBorder,
      borderRadius: t.radiusLg,
      overflow: 'hidden',
      boxShadow: t.shadowCard,
    }}>
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        background: t.headerGrad, borderBottom: t.panelBorder,
        padding: '0 12px', height: 30,
      }}>
        <span style={{
          fontSize: 10, fontWeight: 600, color: t.accent,
          letterSpacing: 0.5, textTransform: 'uppercase', fontFamily: t.font,
          textShadow: t.name === 'modern' ? t.glowAccent : 'none',
        }}>{title}</span>
        {badge && (
          <span style={{
            fontSize: 9, padding: '2px 7px', borderRadius: t.radiusSm,
            background: `${badgeColor}18`, color: badgeColor,
            border: `1px solid ${badgeColor}40`, fontFamily: t.font,
          }}>{badge}</span>
        )}
      </div>
      {children}
    </div>
  )
}

function Row({ label, children, t }) {
  return (
    <div style={{
      display: 'grid', gridTemplateColumns: '150px 1fr',
      alignItems: 'center', padding: '8px 12px',
      borderBottom: t.panelBorder, gap: 10,
    }}>
      <span style={{ fontSize: 10, color: t.textMuted, fontFamily: t.font }}>{label}</span>
      {children}
    </div>
  )
}

function Inp({ value, onChange, type = 'text', placeholder, t }) {
  return (
    <input
      type={type} value={value}
      onChange={e => onChange(e.target.value)}
      placeholder={placeholder}
      style={{
        background: t.bgInput, border: t.panelBorder,
        color: t.text, fontSize: 11, padding: '5px 8px',
        fontFamily: t.font, width: '100%', outline: 'none',
        borderRadius: t.radiusSm, boxSizing: 'border-box',
      }}
      onFocus={e => { e.target.style.borderColor = t.accent }}
      onBlur={e => { e.target.style.borderColor = '' }}
    />
  )
}

function Toggle({ on, onChange, label, t }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      <div
        onClick={() => onChange(!on)}
        style={{
          width: 36, height: 18, borderRadius: 9,
          background: on ? t.bull : t.bgGrid,
          position: 'relative', cursor: 'pointer',
          border: `1px solid ${on ? t.bull : t.border}`,
          transition: 'background .2s, border-color .2s', flexShrink: 0,
        }}
      >
        <div style={{
          width: 12, height: 12, borderRadius: '50%', background: '#fff',
          position: 'absolute', top: 2, left: on ? 20 : 2, transition: 'left .2s',
        }} />
      </div>
      <span style={{ fontSize: 10, color: t.textMuted, fontFamily: t.font }}>{label}</span>
    </div>
  )
}

function SaveBtn({ onClick, disabled, label, t }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      style={{
        background: t.accent, color: t.textInverse,
        border: 'none', padding: '6px 16px',
        fontSize: 11, fontWeight: 700, cursor: disabled ? 'not-allowed' : 'pointer',
        fontFamily: t.font, borderRadius: t.radiusSm,
        opacity: disabled ? 0.6 : 1, transition: 'opacity .15s',
      }}
    >{label}</button>
  )
}

// ── Main page ─────────────────────────────────────────────────
export default function SettingsPage() {
  const t        = useTheme()
  const theme    = useTerminalStore(s => s.theme)
  const setTheme = useTerminalStore(s => s.setTheme)

  const [cfg, setCfg] = useState({
    groww_api_key: '', groww_totp_secret: '', groww_capital: 200000,
    groww_max_pct: 10, groww_bot: false,
    delta_api_key: '', delta_api_secret: '', delta_paper: false,
    delta_bot: false, delta_max_pct: 30,
    twitter_handles: 'realDonaldTrump,elonmusk,SEBI_India,PMOIndia,saylor,whale_alert',
    telegram_chat_id: '', alert_signals: true, alert_stops: true,
    alert_news: true, daily_summary: true,
  })
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    getUserConfig().then(d => d && setCfg(c => ({ ...c, ...d }))).catch(() => {})
  }, [])

  async function save(section) {
    setSaving(true)
    try {
      await saveUserConfig(cfg)
      toast.success(`${section} saved`)
    } catch {
      toast.error('Save failed — check connection')
    }
    setSaving(false)
  }

  const upd = k => v => setCfg(c => ({ ...c, [k]: v }))

  const inputBg = { background: t.bgInput, border: `1px solid ${t.border}`, color: t.text,
    fontSize: 11, padding: '5px 8px', fontFamily: t.font, width: '100%',
    outline: 'none', borderRadius: t.radiusSm, boxSizing: 'border-box' }

  return (
    <div style={{ flex: 1, overflowY: 'auto', padding: 20, background: t.bg }}>

      {/* Header */}
      <div style={{ marginBottom: 16 }}>
        <div style={{
          fontSize: 13, fontWeight: 700, color: t.accent,
          letterSpacing: 0.5, fontFamily: t.font,
          textShadow: t.name === 'modern' ? t.glowAccent : 'none',
        }}>SETTINGS</div>
        <div style={{ fontSize: 10, color: t.textDim, marginTop: 3, fontFamily: t.font }}>
          Broker keys encrypted with AES-256 before storage.
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>

        {/* ── Groww ── */}
        <Panel t={t} title="Groww — India Stocks & F&O"
          badge={cfg.groww_api_key && !cfg.groww_api_key.startsWith('•') ? 'CONNECTED' : cfg.groww_api_key ? 'SET' : 'NOT SET'}
          badgeColor={cfg.groww_api_key ? t.bull : t.bear}>
          <Row t={t} label="API Key">
            <Inp t={t} type="password" value={cfg.groww_api_key} onChange={upd('groww_api_key')} placeholder="gw_live_..." />
          </Row>
          <Row t={t} label="TOTP Secret">
            <Inp t={t} type="password" value={cfg.groww_totp_secret} onChange={upd('groww_totp_secret')} placeholder="Base32 TOTP secret" />
          </Row>
          <Row t={t} label="Capital (₹)">
            <Inp t={t} type="number" value={cfg.groww_capital} onChange={upd('groww_capital')} />
          </Row>
          <Row t={t} label="Max position %">
            <Inp t={t} type="number" value={cfg.groww_max_pct} onChange={upd('groww_max_pct')} />
          </Row>
          <Row t={t} label="Bot trading">
            <Toggle t={t} on={cfg.groww_bot} onChange={upd('groww_bot')}
              label={cfg.groww_bot ? 'Enabled — auto execution' : 'Disabled — signals only'} />
          </Row>
          <div style={{ padding: '10px 12px' }}>
            <SaveBtn t={t} onClick={() => save('Groww')} disabled={saving} label="SAVE GROWW CONFIG" />
          </div>
        </Panel>

        {/* ── Delta Exchange ── */}
        <Panel t={t} title="Delta Exchange India — Crypto"
          badge={cfg.delta_paper ? 'TESTNET' : 'LIVE'}
          badgeColor={cfg.delta_paper ? t.amber : t.bull}>
          <Row t={t} label="API Key">
            <Inp t={t} type="password" value={cfg.delta_api_key} onChange={upd('delta_api_key')} placeholder="delta_..." />
          </Row>
          <Row t={t} label="API Secret">
            <Inp t={t} type="password" value={cfg.delta_api_secret} onChange={upd('delta_api_secret')} placeholder="API secret" />
          </Row>
          <Row t={t} label="Mode">
            <Toggle t={t} on={!cfg.delta_paper} onChange={v => upd('delta_paper')(!v)}
              label={cfg.delta_paper ? 'Testnet mode' : '⚡ Live trading (real orders)'} />
          </Row>
          <Row t={t} label="Bot trading">
            <Toggle t={t} on={cfg.delta_bot} onChange={upd('delta_bot')}
              label={cfg.delta_bot ? 'Enabled' : 'Disabled'} />
          </Row>
          <Row t={t} label="Max crypto %">
            <Inp t={t} type="number" value={cfg.delta_max_pct} onChange={upd('delta_max_pct')} />
          </Row>
          <div style={{ padding: '10px 12px' }}>
            <SaveBtn t={t} onClick={() => save('Delta')} disabled={saving} label="SAVE DELTA CONFIG" />
          </div>
        </Panel>

        {/* ── Twitter / X Signals ── */}
        <Panel t={t} title="Twitter / X Signal Feed">
          <Row t={t} label="Impact handles">
            <Inp t={t} value={cfg.twitter_handles} onChange={upd('twitter_handles')} placeholder="handle1,handle2,..." />
          </Row>
          <div style={{ padding: '6px 12px 10px' }}>
            <div style={{ fontSize: 9, color: t.textDim, fontFamily: t.font, marginBottom: 8 }}>
              Comma-separated handles. News agent monitors these for high-impact events.
            </div>
            <SaveBtn t={t} onClick={() => save('Twitter feed')} disabled={saving} label="SAVE FEED CONFIG" />
          </div>
        </Panel>

        {/* ── Notifications ── */}
        <Panel t={t} title="Telegram Notifications">
          <Row t={t} label="Chat ID">
            <Inp t={t} value={cfg.telegram_chat_id} onChange={upd('telegram_chat_id')} placeholder="Your Telegram chat ID" />
          </Row>
          <Row t={t} label="Signal alerts">
            <Toggle t={t} on={cfg.alert_signals} onChange={upd('alert_signals')} label="High conviction GO signals" />
          </Row>
          <Row t={t} label="Stop loss alerts">
            <Toggle t={t} on={cfg.alert_stops} onChange={upd('alert_stops')} label="Immediate push on stop hit" />
          </Row>
          <Row t={t} label="High impact news">
            <Toggle t={t} on={cfg.alert_news} onChange={upd('alert_news')} label="Trump · RBI · SEBI events" />
          </Row>
          <Row t={t} label="Daily summary">
            <Toggle t={t} on={cfg.daily_summary} onChange={upd('daily_summary')} label="8:00 PM IST digest" />
          </Row>
          <div style={{ padding: '10px 12px' }}>
            <SaveBtn t={t} onClick={() => save('Notifications')} disabled={saving} label="SAVE NOTIFICATIONS" />
          </div>
        </Panel>

        {/* ── UI Theme ── */}
        <Panel t={t} title="UI Theme" badge="LOCAL" badgeColor={t.cyan}>
          <Row t={t} label="Theme">
            <div style={{ display: 'flex', gap: 8 }}>
              {[
                { key: 'modern',    label: 'Modern',    accent: '#3B82F6' },
                { key: 'bloomberg', label: 'Bloomberg', accent: '#ff8c00' },
              ].map(opt => (
                <button
                  key={opt.key}
                  onClick={() => setTheme(opt.key)}
                  style={{
                    flex: 1, padding: '6px 0', fontSize: 10, fontFamily: t.font,
                    cursor: 'pointer', borderRadius: t.radiusSm,
                    border: `1px solid ${theme === opt.key ? opt.accent : t.border}`,
                    background: theme === opt.key ? `${opt.accent}18` : t.bgInput,
                    color: theme === opt.key ? opt.accent : t.textMuted,
                    fontWeight: theme === opt.key ? 700 : 400,
                    transition: 'all .15s',
                  }}
                >{opt.label}</button>
              ))}
            </div>
          </Row>
          <div style={{ padding: '6px 12px 10px' }}>
            <div style={{ fontSize: 9, color: t.textDim, fontFamily: t.font }}>
              Theme preference is stored locally in your browser.
            </div>
          </div>
        </Panel>

      </div>
    </div>
  )
}
