// src/pages/JournalPage.jsx
// Trade Journal — log every trade with setup context, outcome, and emotional notes.
// Entries stored in localStorage. Stats computed from all entries.
// Add Entry form: Symbol · Side · Date · Setup · Entry/Exit/SL/Target · Outcome · Notes

import { useState, useMemo, useCallback, useEffect } from 'react'
import * as XLSX from 'xlsx'
import { jsPDF } from 'jspdf'
import autoTable from 'jspdf-autotable'
import { useTheme } from '../store'
import { fmtIST } from '../lib/api'
import SetupAnalytics from '../components/journal/SetupAnalytics'

const SETUP_TYPES = ['Breakout', 'Pullback', 'Reversal', 'Scalp', 'Gap Play', 'Earnings', 'News Play', 'Range Break', 'Other']
const EMOTIONS    = ['Disciplined', 'FOMO Entry', 'Revenge Trade', 'Hesitant Exit', 'Oversize', 'Rushed', 'Fearful']
const OUTCOMES    = ['WIN', 'LOSS', 'BREAKEVEN']

const LS_KEY = 'tradex_journal_v1'

function loadEntries() {
  try { return JSON.parse(localStorage.getItem(LS_KEY) || '[]') } catch { return [] }
}
function saveEntries(entries) {
  try { localStorage.setItem(LS_KEY, JSON.stringify(entries)) } catch {}
}

function fmt(n, dec = 2) {
  if (n == null || isNaN(n)) return '—'
  return Number(n).toFixed(dec)
}

function StatsBar({ entries, t }) {
  const wins  = entries.filter(e => e.outcome === 'WIN').length
  const total = entries.length
  const winRate = total > 0 ? ((wins / total) * 100).toFixed(1) : '—'

  const rrs = entries.filter(e => e.rr_achieved && parseFloat(e.rr_achieved) > 0).map(e => parseFloat(e.rr_achieved))
  const avgRR = rrs.length > 0 ? (rrs.reduce((a, b) => a + b, 0) / rrs.length).toFixed(2) : '—'

  const grossWin  = entries.filter(e => e.outcome === 'WIN').reduce((s, e) => s + (parseFloat(e.pnl) || 0), 0)
  const grossLoss = entries.filter(e => e.outcome === 'LOSS').reduce((s, e) => s + Math.abs(parseFloat(e.pnl) || 0), 0)
  const pf = grossLoss > 0 ? (grossWin / grossLoss).toFixed(2) : grossWin > 0 ? '∞' : '—'

  const stats = [
    { label: 'Total Trades', value: total, color: t.text },
    { label: 'Win Rate',     value: total > 0 ? `${winRate}%` : '—', color: parseFloat(winRate) >= 50 ? t.bull : t.bear },
    { label: 'Avg R:R',      value: avgRR === '—' ? '—' : `1:${avgRR}`, color: parseFloat(avgRR) >= 2 ? t.bull : t.amber },
    { label: 'Profit Factor',value: pf,   color: parseFloat(pf) >= 1.5 ? t.bull : t.bear },
    { label: 'Wins',         value: wins, color: t.bull },
    { label: 'Losses',       value: entries.filter(e => e.outcome === 'LOSS').length, color: t.bear },
  ]

  return (
    <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', padding: '12px 20px', borderBottom: `1px solid ${t.border}`, flexShrink: 0 }}>
      {stats.map(({ label, value, color }) => (
        <div key={label} style={{ padding: '8px 14px', background: t.bgCard, border: `1px solid ${t.border}`, borderRadius: t.radiusLg, minWidth: 90 }}>
          <div style={{ fontSize: 9, color: t.textMuted, fontFamily: t.fontUI, fontWeight: 600, letterSpacing: 0.5, textTransform: 'uppercase', marginBottom: 4 }}>{label}</div>
          <div style={{ fontSize: 16, fontWeight: 700, color, fontFamily: t.fontUI }}>{value}</div>
        </div>
      ))}
    </div>
  )
}

function EntryCard({ entry, onDelete, t }) {
  const outcomeColor = entry.outcome === 'WIN' ? t.bull : entry.outcome === 'LOSS' ? t.bear : t.textMuted
  const sideColor    = entry.side === 'BUY' ? t.bull : t.bear
  const [expanded, setExpanded] = useState(false)

  return (
    <div
      style={{
        background: t.bgCard, border: `1px solid ${t.border}`,
        borderLeft: `3px solid ${outcomeColor}`,
        borderRadius: t.radiusLg, padding: '12px 16px', marginBottom: 8,
        cursor: 'pointer', transition: 'border-color 0.15s',
      }}
      onClick={() => setExpanded(e => !e)}
      onMouseEnter={e => { e.currentTarget.style.borderColor = outcomeColor }}
      onMouseLeave={e => { e.currentTarget.style.borderColor = t.border }}
    >
      {/* Header row */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        {/* Outcome badge */}
        <span style={{
          fontSize: 9, fontWeight: 700, fontFamily: t.fontUI,
          color: outcomeColor, background: `${outcomeColor}18`,
          border: `1px solid ${outcomeColor}40`,
          borderRadius: 4, padding: '2px 7px', letterSpacing: 0.5,
        }}>{entry.outcome}</span>

        {/* Symbol + side */}
        <span style={{ fontSize: 13, fontWeight: 700, color: t.text, fontFamily: t.fontUI }}>{entry.symbol}</span>
        <span style={{ fontSize: 10, fontWeight: 600, color: sideColor, fontFamily: t.fontUI }}>{entry.side}</span>

        {/* Setup type */}
        <span style={{ fontSize: 10, color: t.accent, fontFamily: t.fontUI, background: t.accentBg, padding: '1px 7px', borderRadius: 10 }}>{entry.setup}</span>

        {/* R:R */}
        {entry.rr_achieved && (
          <span style={{ fontSize: 10, color: t.textMuted, fontFamily: t.fontUI }}>R:R <span style={{ color: parseFloat(entry.rr_achieved) >= 2 ? t.bull : t.amber, fontWeight: 600 }}>1:{fmt(entry.rr_achieved, 2)}</span></span>
        )}

        {/* P&L */}
        {entry.pnl && (
          <span style={{ fontSize: 11, fontWeight: 700, color: parseFloat(entry.pnl) >= 0 ? t.bull : t.bear, fontFamily: t.fontUI, marginLeft: 'auto' }}>
            {parseFloat(entry.pnl) >= 0 ? '+' : ''}₹{fmt(entry.pnl, 0)}
          </span>
        )}

        {/* Date */}
        <span style={{ fontSize: 9, color: t.textDim, fontFamily: t.fontUI }}>{entry.trade_date}</span>

        {/* Emotional state */}
        {entry.emotion && entry.emotion !== 'Disciplined' && (
          <span style={{ fontSize: 9, color: t.amber, fontFamily: t.fontUI }}>⚠ {entry.emotion}</span>
        )}

        {/* Expand indicator */}
        <span style={{ fontSize: 10, color: t.textDim, marginLeft: 4 }}>{expanded ? '▲' : '▼'}</span>
      </div>

      {/* Expanded detail */}
      {expanded && (
        <div style={{ marginTop: 12, paddingTop: 12, borderTop: `1px solid ${t.border}` }}>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(120px, 1fr))', gap: 8, marginBottom: 10 }}>
            {[
              ['Entry', entry.entry_price ? `₹${entry.entry_price}` : '—'],
              ['Exit',  entry.exit_price  ? `₹${entry.exit_price}`  : '—'],
              ['SL',    entry.stop_loss   ? `₹${entry.stop_loss}`   : '—'],
              ['Target',entry.target      ? `₹${entry.target}`      : '—'],
              ['Qty',   entry.qty || '—'],
            ].map(([label, val]) => (
              <div key={label} style={{ background: t.bgActive, borderRadius: t.radius, padding: '6px 10px' }}>
                <div style={{ fontSize: 9, color: t.textMuted, fontFamily: t.fontUI, letterSpacing: 0.5, textTransform: 'uppercase' }}>{label}</div>
                <div style={{ fontSize: 12, color: t.text, fontFamily: t.fontUI, fontWeight: 600 }}>{val}</div>
              </div>
            ))}
          </div>

          {entry.notes && (
            <div style={{ fontSize: 11, color: t.textMuted, fontFamily: t.fontUI, fontStyle: 'italic', marginBottom: 10 }}>
              "{entry.notes}"
            </div>
          )}

          <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
            <button
              onClick={e => { e.stopPropagation(); onDelete(entry.id) }}
              style={{ fontSize: 10, color: t.bear, fontFamily: t.fontUI, background: 'none', border: `1px solid ${t.bear}50`, borderRadius: t.radius, padding: '3px 10px', cursor: 'pointer' }}
            >Delete</button>
          </div>
        </div>
      )}
    </div>
  )
}

function AddEntryModal({ t, onSave, onClose }) {
  const [form, setForm] = useState({
    symbol: '', side: 'BUY', trade_date: new Date().toISOString().slice(0, 10),
    setup: 'Breakout', emotion: 'Disciplined', outcome: 'WIN',
    entry_price: '', exit_price: '', stop_loss: '', target: '', qty: '',
    pnl: '', rr_achieved: '', notes: '',
  })

  const upd = (key, val) => setForm(f => ({ ...f, [key]: val }))

  const computedRR = useMemo(() => {
    const ep = parseFloat(form.entry_price)
    const sl = parseFloat(form.stop_loss)
    const tgt = parseFloat(form.target)
    if (!ep || !sl || !tgt) return null
    const risk   = Math.abs(ep - sl)
    const reward = Math.abs(ep - tgt)
    return risk > 0 ? (reward / risk).toFixed(2) : null
  }, [form.entry_price, form.stop_loss, form.target])

  const computedPnl = useMemo(() => {
    const ep = parseFloat(form.entry_price)
    const ex = parseFloat(form.exit_price)
    const q  = parseFloat(form.qty)
    if (!ep || !ex || !q) return null
    const pnl = (ex - ep) * q * (form.side === 'SELL' ? -1 : 1)
    return pnl.toFixed(0)
  }, [form.entry_price, form.exit_price, form.qty, form.side])

  const handleSave = useCallback(() => {
    if (!form.symbol.trim()) return
    const entry = {
      ...form,
      id:          `JRN${Date.now()}`,
      symbol:      form.symbol.toUpperCase().trim(),
      rr_achieved: form.rr_achieved || computedRR || '',
      pnl:         form.pnl || computedPnl || '',
    }
    onSave(entry)
    onClose()
  }, [form, computedRR, computedPnl, onSave, onClose])

  const inputStyle = {
    width: '100%', boxSizing: 'border-box',
    background: t.bgInput, border: `1px solid ${t.border}`,
    color: t.text, fontFamily: t.fontUI, fontSize: 12,
    padding: '7px 10px', borderRadius: t.radius, outline: 'none',
  }
  const labelStyle = { fontSize: 10, fontWeight: 600, color: t.textMuted, fontFamily: t.fontUI, letterSpacing: 0.5, textTransform: 'uppercase', display: 'block', marginBottom: 4 }
  const sectionStyle = { marginBottom: 14 }

  const focusBorder = (e) => { e.target.style.borderColor = t.accent; e.target.style.boxShadow = `0 0 0 2px ${t.accentBg}` }
  const blurBorder  = (e) => { e.target.style.borderColor = t.border; e.target.style.boxShadow = 'none' }

  return (
    <>
      <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.65)', backdropFilter: 'blur(4px)', zIndex: 900 }} />
      <div className="fade-in" style={{
        position: 'fixed', top: '50%', left: '50%', transform: 'translate(-50%,-50%)',
        zIndex: 901, width: 520, maxHeight: '90vh', overflowY: 'auto',
        background: t.bgCard, border: `1px solid ${t.border}`,
        borderTop: `3px solid ${t.accent}`,
        borderRadius: t.radiusLg, boxShadow: t.shadowLg, overflow: 'hidden',
      }}>
        {/* Header */}
        <div style={{ padding: '14px 18px', borderBottom: `1px solid ${t.border}`, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <span style={{ fontSize: 13, fontWeight: 700, color: t.text, fontFamily: t.fontUI }}>📝 Add Journal Entry</span>
          <button onClick={onClose} style={{ background: 'none', border: 'none', color: t.textMuted, fontSize: 18, cursor: 'pointer' }}>×</button>
        </div>

        <div style={{ padding: '16px 18px', overflowY: 'auto' }}>
          {/* Symbol + Side + Date */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 100px 130px', gap: 10, ...sectionStyle }}>
            <div>
              <label style={labelStyle}>Symbol</label>
              <input value={form.symbol} onChange={e => upd('symbol', e.target.value.toUpperCase())} placeholder="RELIANCE" style={inputStyle} onFocus={focusBorder} onBlur={blurBorder} />
            </div>
            <div>
              <label style={labelStyle}>Side</label>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 4 }}>
                {['BUY', 'SELL'].map(s => (
                  <button key={s} type="button" onClick={() => upd('side', s)} style={{
                    padding: '7px 0', fontSize: 10, fontWeight: 600, fontFamily: t.fontUI,
                    cursor: 'pointer', borderRadius: t.radius,
                    border: `1px solid ${form.side === s ? (s === 'BUY' ? t.bull : t.bear) : t.border}`,
                    background: form.side === s ? (s === 'BUY' ? t.bullBg : t.bearBg) : 'transparent',
                    color: form.side === s ? (s === 'BUY' ? t.bull : t.bear) : t.textDim,
                  }}>{s}</button>
                ))}
              </div>
            </div>
            <div>
              <label style={labelStyle}>Trade Date</label>
              <input type="date" value={form.trade_date} onChange={e => upd('trade_date', e.target.value)} style={inputStyle} onFocus={focusBorder} onBlur={blurBorder} />
            </div>
          </div>

          {/* Setup + Outcome + Emotion */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 10, ...sectionStyle }}>
            <div>
              <label style={labelStyle}>Setup Type</label>
              <select value={form.setup} onChange={e => upd('setup', e.target.value)} style={{ ...inputStyle, cursor: 'pointer' }} onFocus={focusBorder} onBlur={blurBorder}>
                {SETUP_TYPES.map(s => <option key={s}>{s}</option>)}
              </select>
            </div>
            <div>
              <label style={labelStyle}>Outcome</label>
              <div style={{ display: 'flex', gap: 4 }}>
                {OUTCOMES.map(o => (
                  <button key={o} type="button" onClick={() => upd('outcome', o)} style={{
                    flex: 1, padding: '7px 0', fontSize: 9, fontWeight: 600, fontFamily: t.fontUI,
                    cursor: 'pointer', borderRadius: t.radius,
                    border: `1px solid ${form.outcome === o ? (o === 'WIN' ? t.bull : o === 'LOSS' ? t.bear : t.textMuted) : t.border}`,
                    background: form.outcome === o ? `${o === 'WIN' ? t.bull : o === 'LOSS' ? t.bear : t.textMuted}18` : 'transparent',
                    color: form.outcome === o ? (o === 'WIN' ? t.bull : o === 'LOSS' ? t.bear : t.textMuted) : t.textDim,
                  }}>{o}</button>
                ))}
              </div>
            </div>
            <div>
              <label style={labelStyle}>Emotional State</label>
              <select value={form.emotion} onChange={e => upd('emotion', e.target.value)} style={{ ...inputStyle, cursor: 'pointer' }} onFocus={focusBorder} onBlur={blurBorder}>
                {EMOTIONS.map(e => <option key={e}>{e}</option>)}
              </select>
            </div>
          </div>

          {/* Prices */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr 1fr 1fr', gap: 8, ...sectionStyle }}>
            {[['entry_price', 'Entry'], ['exit_price', 'Exit'], ['stop_loss', 'Stop Loss'], ['target', 'Target'], ['qty', 'Qty']].map(([key, label]) => (
              <div key={key}>
                <label style={labelStyle}>{label}</label>
                <input type="number" value={form[key]} onChange={e => upd(key, e.target.value)} placeholder="0" step="0.01" style={inputStyle} onFocus={focusBorder} onBlur={blurBorder} />
              </div>
            ))}
          </div>

          {/* Auto-computed P&L + R:R */}
          {(computedPnl || computedRR) && (
            <div style={{ display: 'flex', gap: 10, marginBottom: 14, padding: '10px 12px', background: t.bgActive, border: `1px solid ${t.border}`, borderRadius: t.radius }}>
              {computedPnl && (
                <span style={{ fontSize: 11, fontFamily: t.fontUI, color: t.textMuted }}>
                  Auto P&L: <span style={{ color: parseFloat(computedPnl) >= 0 ? t.bull : t.bear, fontWeight: 700 }}>₹{computedPnl}</span>
                </span>
              )}
              {computedRR && (
                <span style={{ fontSize: 11, fontFamily: t.fontUI, color: t.textMuted }}>
                  Auto R:R: <span style={{ color: parseFloat(computedRR) >= 2 ? t.bull : t.amber, fontWeight: 700 }}>1:{computedRR}</span>
                </span>
              )}
            </div>
          )}

          {/* Manual P&L + R:R override */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, ...sectionStyle }}>
            <div>
              <label style={labelStyle}>P&L (₹) — override</label>
              <input type="number" value={form.pnl} onChange={e => upd('pnl', e.target.value)} placeholder={computedPnl || '0'} style={inputStyle} onFocus={focusBorder} onBlur={blurBorder} />
            </div>
            <div>
              <label style={labelStyle}>R:R Achieved — override</label>
              <input type="number" value={form.rr_achieved} onChange={e => upd('rr_achieved', e.target.value)} placeholder={computedRR || '0.00'} step="0.01" style={inputStyle} onFocus={focusBorder} onBlur={blurBorder} />
            </div>
          </div>

          {/* Notes */}
          <div style={sectionStyle}>
            <label style={labelStyle}>Notes (setup reason, what happened, what to improve)</label>
            <textarea
              value={form.notes}
              onChange={e => upd('notes', e.target.value)}
              placeholder="e.g. Strong breakout with volume confirmation at key resistance. Target hit cleanly..."
              rows={3}
              style={{ ...inputStyle, resize: 'vertical', lineHeight: 1.5 }}
              onFocus={focusBorder} onBlur={blurBorder}
            />
          </div>

          {/* Save */}
          <button
            type="button"
            onClick={handleSave}
            disabled={!form.symbol.trim()}
            style={{
              width: '100%', padding: '11px 0',
              fontSize: 12, fontWeight: 700, fontFamily: t.fontUI,
              cursor: form.symbol.trim() ? 'pointer' : 'not-allowed',
              borderRadius: t.radius, border: 'none',
              background: form.symbol.trim() ? t.accent : `${t.accent}40`,
              color: '#fff', opacity: form.symbol.trim() ? 1 : 0.6,
              boxShadow: form.symbol.trim() ? `0 4px 14px ${t.accent}40` : 'none',
              transition: 'all 0.15s',
            }}
          >SAVE ENTRY</button>
        </div>
      </div>
    </>
  )
}

// ─── Export helpers ────────────────────────────────────────────────

const EXPORT_COLS = [
  { key: 'trade_date',   header: 'Date' },
  { key: 'symbol',       header: 'Symbol' },
  { key: 'side',         header: 'Side' },
  { key: 'setup',        header: 'Setup' },
  { key: 'outcome',      header: 'Outcome' },
  { key: 'entry_price',  header: 'Entry Price' },
  { key: 'exit_price',   header: 'Exit Price' },
  { key: 'stop_loss',    header: 'Stop Loss' },
  { key: 'target',       header: 'Target' },
  { key: 'qty',          header: 'Qty' },
  { key: 'pnl',          header: 'P&L (₹)' },
  { key: 'rr_achieved',  header: 'R:R Achieved' },
  { key: 'emotion',      header: 'Emotional State' },
  { key: 'notes',        header: 'Notes' },
]

function toRows(entries) {
  return entries.map(e => EXPORT_COLS.reduce((row, col) => {
    row[col.header] = e[col.key] ?? ''
    return row
  }, {}))
}

function exportExcel(entries, filename = 'trade_journal') {
  const ws   = XLSX.utils.json_to_sheet(toRows(entries))
  const wb   = XLSX.utils.book_new()

  // Column widths
  ws['!cols'] = [10, 12, 6, 12, 10, 12, 12, 10, 10, 6, 10, 10, 16, 40].map(w => ({ wch: w }))

  // Header row styling — bold + background (xlsx-style requires commercial plugin; skip)
  XLSX.utils.book_append_sheet(wb, ws, 'Trade Journal')
  XLSX.writeFile(wb, `${filename}.xlsx`)
}

function exportPDF(entries, filename = 'trade_journal') {
  const doc = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4' })

  // Title block
  doc.setFontSize(16)
  doc.setFont('helvetica', 'bold')
  doc.setTextColor(59, 130, 246)        // accent blue
  doc.text('TradeX — Trade Journal', 14, 14)

  doc.setFontSize(8)
  doc.setFont('helvetica', 'normal')
  doc.setTextColor(120, 120, 140)
  doc.text(`Exported ${fmtIST(new Date(), 'full')}  ·  ${entries.length} entries`, 14, 20)

  // Stats summary line
  const wins     = entries.filter(e => e.outcome === 'WIN').length
  const total    = entries.length
  const winRate  = total > 0 ? ((wins / total) * 100).toFixed(1) : '0'
  const rrs      = entries.filter(e => e.rr_achieved && parseFloat(e.rr_achieved) > 0).map(e => parseFloat(e.rr_achieved))
  const avgRR    = rrs.length > 0 ? (rrs.reduce((a, b) => a + b, 0) / rrs.length).toFixed(2) : '—'
  const totalPnl = entries.reduce((s, e) => s + (parseFloat(e.pnl) || 0), 0)

  doc.setFontSize(8)
  doc.setTextColor(60, 60, 80)
  doc.text(`Win Rate: ${winRate}%   Avg R:R: 1:${avgRR}   Total P&L: ₹${totalPnl.toLocaleString('en-IN', { maximumFractionDigits: 0 })}`, 14, 26)

  // Table
  const head = [EXPORT_COLS.map(c => c.header)]
  const body = entries.map(e => EXPORT_COLS.map(c => {
    const v = e[c.key] ?? ''
    return String(v)
  }))

  autoTable(doc, {
    head,
    body,
    startY:       32,
    styles:       { fontSize: 7, cellPadding: 2, overflow: 'linebreak' },
    headStyles:   { fillColor: [59, 130, 246], textColor: 255, fontStyle: 'bold', fontSize: 7 },
    alternateRowStyles: { fillColor: [245, 246, 250] },
    columnStyles: {
      0:  { cellWidth: 18 },   // Date
      1:  { cellWidth: 16 },   // Symbol
      2:  { cellWidth: 10 },   // Side
      3:  { cellWidth: 18 },   // Setup
      4:  { cellWidth: 14 },   // Outcome
      5:  { cellWidth: 18 },   // Entry
      6:  { cellWidth: 18 },   // Exit
      7:  { cellWidth: 16 },   // SL
      8:  { cellWidth: 16 },   // Target
      9:  { cellWidth: 10 },   // Qty
      10: { cellWidth: 16 },   // P&L
      11: { cellWidth: 16 },   // R:R
      12: { cellWidth: 22 },   // Emotion
      13: { cellWidth: 'auto' }, // Notes
    },
    didParseCell: (data) => {
      if (data.section === 'body' && data.column.index === 4) {
        const v = data.cell.raw
        if (v === 'WIN')       { data.cell.styles.textColor = [16, 185, 129] }
        else if (v === 'LOSS') { data.cell.styles.textColor = [239, 68, 68] }
      }
      if (data.section === 'body' && data.column.index === 10) {
        const n = parseFloat(data.cell.raw)
        if (!isNaN(n)) {
          data.cell.styles.textColor = n >= 0 ? [16, 185, 129] : [239, 68, 68]
        }
      }
    },
    margin: { left: 14, right: 14 },
  })

  // Page numbers
  const pageCount = doc.getNumberOfPages()
  for (let i = 1; i <= pageCount; i++) {
    doc.setPage(i)
    doc.setFontSize(7)
    doc.setTextColor(150)
    doc.text(`Page ${i} / ${pageCount}`, doc.internal.pageSize.width - 20, doc.internal.pageSize.height - 6)
  }

  doc.save(`${filename}.pdf`)
}

// ─── Export buttons component ──────────────────────────────────────
function ExportButtons({ entries, filtered, t }) {
  const [open, setOpen] = useState(false)

  if (entries.length === 0) return null

  const btnBase = {
    padding: '7px 14px', fontSize: 11, fontWeight: 600, fontFamily: t.fontUI,
    cursor: 'pointer', borderRadius: t.radius, border: `1px solid ${t.border}`,
    background: 'transparent', color: t.textMuted,
    display: 'flex', alignItems: 'center', gap: 6,
    transition: 'all 0.12s', whiteSpace: 'nowrap',
  }

  return (
    <div style={{ position: 'relative' }}>
      <button
        onClick={() => setOpen(o => !o)}
        style={{
          ...btnBase,
          border: `1px solid ${open ? t.accent : t.border}`,
          color: open ? t.accent : t.textMuted,
          background: open ? t.accentBg : 'transparent',
        }}
        onMouseEnter={e => { if (!open) { e.currentTarget.style.borderColor = t.borderHover; e.currentTarget.style.color = t.text } }}
        onMouseLeave={e => { if (!open) { e.currentTarget.style.borderColor = t.border; e.currentTarget.style.color = t.textMuted } }}
      >
        ↓ Export {open ? '▲' : '▼'}
      </button>

      {open && (
        <>
          <div onClick={() => setOpen(false)} style={{ position: 'fixed', inset: 0, zIndex: 98 }} />
          <div className="fade-in" style={{
            position: 'absolute', right: 0, top: 38, width: 220,
            background: t.bgCard, border: `1px solid ${t.border}`,
            borderRadius: t.radiusLg, boxShadow: t.shadowLg, zIndex: 99,
            overflow: 'hidden', padding: 6,
          }}>
            {/* Scope info */}
            <div style={{ padding: '6px 10px 8px', fontSize: 9, color: t.textDim, fontFamily: t.fontUI, borderBottom: `1px solid ${t.border}`, marginBottom: 4 }}>
              All: {entries.length} entries · Filtered: {filtered.length}
            </div>

            {/* Export all */}
            <div style={{ fontSize: 9, fontWeight: 600, color: t.textMuted, fontFamily: t.fontUI, padding: '3px 10px 2px', letterSpacing: 0.4, textTransform: 'uppercase' }}>
              All Entries
            </div>
            {[
              { fmt: 'Excel', icon: '📊', ext: 'xlsx', fn: () => exportExcel(entries) },
              { fmt: 'PDF',   icon: '📄', ext: 'pdf',  fn: () => exportPDF(entries) },
            ].map(({ fmt, icon, fn }) => (
              <button key={fmt} onClick={() => { fn(); setOpen(false) }} style={{
                width: '100%', padding: '8px 10px', background: 'none', border: 'none',
                borderRadius: t.radius, color: t.text, fontSize: 12, fontFamily: t.fontUI,
                cursor: 'pointer', textAlign: 'left', display: 'flex', alignItems: 'center', gap: 8,
              }}
              onMouseEnter={e => e.currentTarget.style.background = t.bgActive}
              onMouseLeave={e => e.currentTarget.style.background = 'none'}
              >
                <span>{icon}</span>
                <span>Export {fmt}</span>
                <span style={{ marginLeft: 'auto', fontSize: 9, color: t.textDim }}>.{fmt === 'Excel' ? 'xlsx' : 'pdf'}</span>
              </button>
            ))}

            {/* Export filtered (only if different from all) */}
            {filtered.length !== entries.length && filtered.length > 0 && (
              <>
                <div style={{ height: 1, background: t.border, margin: '6px 0' }} />
                <div style={{ fontSize: 9, fontWeight: 600, color: t.textMuted, fontFamily: t.fontUI, padding: '3px 10px 2px', letterSpacing: 0.4, textTransform: 'uppercase' }}>
                  Current Filter ({filtered.length})
                </div>
                {[
                  { fmt: 'Excel', icon: '📊', fn: () => exportExcel(filtered, 'trade_journal_filtered') },
                  { fmt: 'PDF',   icon: '📄', fn: () => exportPDF(filtered,   'trade_journal_filtered') },
                ].map(({ fmt, icon, fn }) => (
                  <button key={`f-${fmt}`} onClick={() => { fn(); setOpen(false) }} style={{
                    width: '100%', padding: '8px 10px', background: 'none', border: 'none',
                    borderRadius: t.radius, color: t.text, fontSize: 12, fontFamily: t.fontUI,
                    cursor: 'pointer', textAlign: 'left', display: 'flex', alignItems: 'center', gap: 8,
                  }}
                  onMouseEnter={e => e.currentTarget.style.background = t.bgActive}
                  onMouseLeave={e => e.currentTarget.style.background = 'none'}
                  >
                    <span>{icon}</span>
                    <span>Export {fmt}</span>
                    <span style={{ marginLeft: 'auto', fontSize: 9, color: t.textDim }}>.{fmt === 'Excel' ? 'xlsx' : 'pdf'}</span>
                  </button>
                ))}
              </>
            )}
          </div>
        </>
      )}
    </div>
  )
}

export default function JournalPage() {
  const t = useTheme()
  const [entries, setEntries] = useState(loadEntries)
  const [showForm, setShowForm] = useState(false)
  const [activeTab, setActiveTab] = useState('journal')  // 'journal' | 'analytics'
  const [filter, setFilter] = useState('ALL')   // ALL | WIN | LOSS | BREAKEVEN
  const [setupFilter, setSetupFilter] = useState('ALL')
  const [search, setSearch] = useState('')

  useEffect(() => { saveEntries(entries) }, [entries])

  const handleSave = useCallback((entry) => {
    setEntries(prev => [entry, ...prev])
  }, [])

  const handleDelete = useCallback((id) => {
    setEntries(prev => prev.filter(e => e.id !== id))
  }, [])

  const filtered = useMemo(() => {
    return entries
      .filter(e => filter === 'ALL' || e.outcome === filter)
      .filter(e => setupFilter === 'ALL' || e.setup === setupFilter)
      .filter(e => !search || e.symbol?.toUpperCase().includes(search.toUpperCase()) || e.notes?.toLowerCase().includes(search.toLowerCase()))
  }, [entries, filter, setupFilter, search])

  const pillBtn = (val, label, active, onClick, activeColor) => (
    <button
      key={val}
      onClick={onClick}
      style={{
        padding: '4px 12px', fontSize: 11, fontWeight: active ? 600 : 400,
        fontFamily: t.fontUI, cursor: 'pointer', borderRadius: 20,
        border: `1px solid ${active ? (activeColor || t.accent) : t.border}`,
        background: active ? `${activeColor || t.accent}18` : 'transparent',
        color: active ? (activeColor || t.accent) : t.textMuted,
        transition: 'all 0.12s',
      }}
    >{label}</button>
  )

  const uniqueSetups = ['ALL', ...new Set(entries.map(e => e.setup).filter(Boolean))]

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden', background: t.bg }}>

      {/* Header */}
      <div style={{ padding: '16px 20px 12px', borderBottom: `1px solid ${t.border}`, flexShrink: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
          <div>
            <h1 style={{ margin: 0, fontSize: 18, fontWeight: 700, color: t.text, fontFamily: t.fontUI, letterSpacing: -0.3 }}>
              Trade Journal
            </h1>
            <p style={{ margin: '3px 0 0', fontSize: 11, color: t.textMuted, fontFamily: t.fontUI }}>
              {entries.length} entries recorded
            </p>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <ExportButtons entries={entries} filtered={filtered} t={t} />
            <button
              onClick={() => setShowForm(true)}
              style={{
                padding: '9px 18px', fontSize: 12, fontWeight: 700, fontFamily: t.fontUI,
                background: t.accent, border: 'none', borderRadius: t.radiusLg,
                color: '#fff', cursor: 'pointer',
                boxShadow: `0 4px 14px ${t.accent}40`,
                transition: 'all 0.15s',
              }}
              onMouseEnter={e => { e.currentTarget.style.filter = 'brightness(1.1)' }}
              onMouseLeave={e => { e.currentTarget.style.filter = 'none' }}
            >
              + Add Entry
            </button>
          </div>
        </div>

        {/* Tab bar */}
        <div style={{ display: 'flex', gap: 4, marginBottom: 10 }}>
          {[
            { id: 'journal',   label: 'Journal' },
            { id: 'analytics', label: 'Analytics' },
          ].map(tab => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              style={{
                padding: '5px 14px', fontSize: 11, fontWeight: activeTab === tab.id ? 700 : 400,
                fontFamily: t.fontUI, cursor: 'pointer', borderRadius: 20,
                border: `1px solid ${activeTab === tab.id ? t.accent : t.border}`,
                background: activeTab === tab.id ? `${t.accent}18` : 'transparent',
                color: activeTab === tab.id ? t.accent : t.textMuted,
                transition: 'all 0.12s',
              }}
            >{tab.label}</button>
          ))}
        </div>

        {/* Filters — journal tab only */}
        {activeTab === 'journal' && <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          {/* Outcome filter */}
          <div style={{ display: 'flex', gap: 5 }}>
            {pillBtn('ALL', 'All', filter === 'ALL', () => setFilter('ALL'))}
            {pillBtn('WIN', 'Wins', filter === 'WIN', () => setFilter('WIN'), t.bull)}
            {pillBtn('LOSS', 'Losses', filter === 'LOSS', () => setFilter('LOSS'), t.bear)}
            {pillBtn('BREAKEVEN', 'BE', filter === 'BREAKEVEN', () => setFilter('BREAKEVEN'), t.textMuted)}
          </div>

          <div style={{ width: 1, height: 20, background: t.border }} />

          {/* Setup filter */}
          <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
            {uniqueSetups.slice(0, 6).map(s => pillBtn(s, s, setupFilter === s, () => setSetupFilter(s)))}
          </div>

          {/* Search */}
          <div style={{ marginLeft: 'auto' }}>
            <input
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="Search symbol or notes…"
              style={{
                background: t.bgInput, border: `1px solid ${t.border}`,
                color: t.text, fontFamily: t.fontUI, fontSize: 11,
                padding: '6px 12px', borderRadius: t.radius, outline: 'none', width: 200,
              }}
              onFocus={e => { e.target.style.borderColor = t.accent }}
              onBlur={e => { e.target.style.borderColor = t.border }}
            />
          </div>
        </div>}
      </div>

      {activeTab === 'analytics' ? (
        <div style={{ flex: 1, overflowY: 'auto' }}>
          <SetupAnalytics entries={entries} t={t} />
        </div>
      ) : (
        <>
          {/* Stats */}
          <StatsBar entries={entries} t={t} />

          {/* Entry list */}
          <div style={{ flex: 1, overflowY: 'auto', padding: '16px 20px' }}>
            {filtered.length === 0 ? (
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '60%', gap: 12 }}>
                <div style={{ fontSize: 40 }}>📓</div>
                <div style={{ fontSize: 14, color: t.textMuted, fontFamily: t.fontUI }}>No journal entries yet</div>
                <div style={{ fontSize: 11, color: t.textDim, fontFamily: t.fontUI }}>Click "+ Add Entry" to log your first trade</div>
                <button
                  onClick={() => setShowForm(true)}
                  style={{
                    padding: '9px 20px', marginTop: 8, fontSize: 12, fontWeight: 600, fontFamily: t.fontUI,
                    background: t.accentBg, border: `1px solid ${t.accent}`,
                    color: t.accent, borderRadius: t.radiusLg, cursor: 'pointer',
                  }}
                >Add First Entry</button>
              </div>
            ) : (
              filtered.map(entry => (
                <EntryCard key={entry.id} entry={entry} onDelete={handleDelete} t={t} />
              ))
            )}
          </div>
        </>
      )}

      {/* Add entry modal */}
      {showForm && (
        <AddEntryModal t={t} onSave={handleSave} onClose={() => setShowForm(false)} />
      )}
    </div>
  )
}
