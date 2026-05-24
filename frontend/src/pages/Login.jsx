// src/pages/Login.jsx — full landing page + login  (3D holographic theme)
import { useState, useRef, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { supabase, fmtIST } from '../lib/api'
import toast from 'react-hot-toast'

// ─── Design tokens ────────────────────────────────────────────────
const C = {
  bg:   '#02040A',
  bgP:  '#060C18',
  bgC:  '#0A1020',
  bgI:  '#050A14',
  bd:   'rgba(56,189,248,0.1)',
  bdH:  'rgba(56,189,248,0.28)',
  tx:   '#E2E8F0',
  mu:   '#4A6280',
  di:   '#1A2A3A',
  ac:   '#38BDF8',
  ind:  '#818CF8',
  bull: '#00D9A3',
  bear: '#FF3D5A',
  amb:  '#FBBF24',
  cy:   '#22D3EE',
  pu:   '#A855F7',
  gold: '#F59E0B',
  font: '"IBM Plex Mono","JetBrains Mono",monospace',
  ui:   '"Inter","IBM Plex Sans",system-ui,sans-serif',
  r: 12,
}

// ─── CSS ──────────────────────────────────────────────────────────
const CSS = `
  @keyframes ticker    { 0%{transform:translateX(0)}100%{transform:translateX(-50%)} }
  @keyframes blink     { 0%,100%{opacity:.4}50%{opacity:1} }
  @keyframes fadeUp    { from{opacity:0;transform:translateY(18px)}to{opacity:1;transform:translateY(0)} }
  @keyframes fadeIn    { from{opacity:0}to{opacity:1} }
  @keyframes glowPulse { 0%,100%{opacity:.22}50%{opacity:.55} }
  @keyframes orb0      { 0%,100%{transform:translate(0,0) scale(1)}40%{transform:translate(40px,-30px) scale(1.08)}70%{transform:translate(-25px,18px) scale(.93)} }
  @keyframes orb1      { 0%,100%{transform:translate(0,0) scale(1)}35%{transform:translate(-50px,25px) scale(1.1)}68%{transform:translate(30px,-40px) scale(.9)} }
  @keyframes orb2      { 0%,100%{transform:translate(0,0) scale(1)}50%{transform:translate(20px,35px) scale(1.06)} }
  @keyframes gridFlow  { from{background-position:0 0}to{background-position:0 64px} }
  @keyframes scanH     { 0%,100%{opacity:0;top:2%}45%{opacity:.5;top:50%}55%{opacity:.5;top:50%}98%{opacity:0;top:98%} }
  @keyframes shimmer   { 0%{background-position:-200% center}100%{background-position:200% center} }
  @keyframes spinSlow  { from{transform:rotate(0deg)}to{transform:rotate(360deg)} }
  @keyframes spin      { from{transform:rotate(0deg)}to{transform:rotate(360deg)} }
  @keyframes float3d   { 0%,100%{transform:translateY(0) rotateX(2deg)}50%{transform:translateY(-12px) rotateX(-2deg)} }
  @keyframes neonPulse { 0%,100%{box-shadow:0 0 10px rgba(56,189,248,.2),0 0 30px rgba(56,189,248,.06)}50%{box-shadow:0 0 20px rgba(56,189,248,.45),0 0 60px rgba(56,189,248,.14)} }
  .fu  { animation:fadeUp .6s ease both }
  .fu1 { animation:fadeUp .6s .12s ease both }
  .fu2 { animation:fadeUp .6s .24s ease both }
  .fu3 { animation:fadeUp .6s .38s ease both }
  .fi  { animation:fadeIn .8s ease both }
`

// ─── Professional SVG icon set ────────────────────────────────────
function Ic({ d, size = 14, stroke = 'currentColor', sw = 2, fill = 'none', extra }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill={fill} style={{ display:'block', flexShrink:0 }}>
      {d}
    </svg>
  )
}

const ICONS = {
  // market / data
  signal: (sz=14) => <svg width={sz} height={sz} viewBox="0 0 24 24" fill="none" style={{display:'block'}}><circle cx="12" cy="12" r="2" fill="currentColor"/><path d="M16.24 7.76a6 6 0 010 8.49m-8.48-.01a6 6 0 010-8.49m11.31-2.82a10 10 0 010 14.14m-14.14 0a10 10 0 010-14.14" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/></svg>,
  barChart: (sz=14) => <svg width={sz} height={sz} viewBox="0 0 24 24" fill="none" style={{display:'block'}}><line x1="4" y1="20" x2="4" y2="10" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round"/><line x1="9" y1="20" x2="9" y2="4" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round"/><line x1="14" y1="20" x2="14" y2="14" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round"/><line x1="19" y1="20" x2="19" y2="8" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round"/></svg>,
  candlestick: (sz=14) => <svg width={sz} height={sz} viewBox="0 0 24 24" fill="none" style={{display:'block'}}><rect x="3" y="7" width="5" height="10" rx="1" stroke="currentColor" strokeWidth="2"/><line x1="5.5" y1="3" x2="5.5" y2="7" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/><line x1="5.5" y1="17" x2="5.5" y2="21" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/><rect x="16" y="10" width="5" height="7" rx="1" stroke="currentColor" strokeWidth="2"/><line x1="18.5" y1="5" x2="18.5" y2="10" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/><line x1="18.5" y1="17" x2="18.5" y2="20" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/></svg>,
  trendUp: (sz=14) => <svg width={sz} height={sz} viewBox="0 0 24 24" fill="none" style={{display:'block'}}><polyline points="23 6 13.5 15.5 8.5 10.5 1 18" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/><polyline points="17 6 23 6 23 12" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/></svg>,
  trendDown: (sz=14) => <svg width={sz} height={sz} viewBox="0 0 24 24" fill="none" style={{display:'block'}}><polyline points="23 18 13.5 8.5 8.5 13.5 1 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/><polyline points="17 18 23 18 23 12" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/></svg>,
  activity: (sz=14) => <svg width={sz} height={sz} viewBox="0 0 24 24" fill="none" style={{display:'block'}}><polyline points="22 12 18 12 15 21 9 3 6 12 2 12" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/></svg>,
  gauge: (sz=14) => <svg width={sz} height={sz} viewBox="0 0 24 24" fill="none" style={{display:'block'}}><path d="M12 2a10 10 0 100 20 10 10 0 000-20z" stroke="currentColor" strokeWidth="2"/><path d="M12 6v1M6 12H5M19 12h-1M7.76 7.76l.71.71" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/><path d="M12 12l2.5-3.5" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/><circle cx="12" cy="12" r="1.5" fill="currentColor"/></svg>,
  pieChart: (sz=14) => <svg width={sz} height={sz} viewBox="0 0 24 24" fill="none" style={{display:'block'}}><path d="M21.21 15.89A10 10 0 118 2.83" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/><path d="M22 12A10 10 0 0012 2v10z" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/></svg>,
  // signals / AI
  target: (sz=14) => <svg width={sz} height={sz} viewBox="0 0 24 24" fill="none" style={{display:'block'}}><circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="2"/><circle cx="12" cy="12" r="6" stroke="currentColor" strokeWidth="2"/><circle cx="12" cy="12" r="2" stroke="currentColor" strokeWidth="2"/></svg>,
  cpu: (sz=14) => <svg width={sz} height={sz} viewBox="0 0 24 24" fill="none" style={{display:'block'}}><rect x="4" y="4" width="16" height="16" rx="2" stroke="currentColor" strokeWidth="2"/><rect x="8.5" y="8.5" width="7" height="7" stroke="currentColor" strokeWidth="1.8"/><line x1="9" y1="1" x2="9" y2="4" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/><line x1="15" y1="1" x2="15" y2="4" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/><line x1="9" y1="20" x2="9" y2="23" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/><line x1="15" y1="20" x2="15" y2="23" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/><line x1="20" y1="9" x2="23" y2="9" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/><line x1="20" y1="15" x2="23" y2="15" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/><line x1="1" y1="9" x2="4" y2="9" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/><line x1="1" y1="15" x2="4" y2="15" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/></svg>,
  network: (sz=14) => <svg width={sz} height={sz} viewBox="0 0 24 24" fill="none" style={{display:'block'}}><circle cx="12" cy="5" r="3" stroke="currentColor" strokeWidth="2"/><circle cx="5" cy="19" r="3" stroke="currentColor" strokeWidth="2"/><circle cx="19" cy="19" r="3" stroke="currentColor" strokeWidth="2"/><line x1="12" y1="8" x2="5" y2="16" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/><line x1="12" y1="8" x2="19" y2="16" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/></svg>,
  gitBranch: (sz=14) => <svg width={sz} height={sz} viewBox="0 0 24 24" fill="none" style={{display:'block'}}><line x1="6" y1="3" x2="6" y2="15" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/><circle cx="18" cy="6" r="3" stroke="currentColor" strokeWidth="2"/><circle cx="6" cy="18" r="3" stroke="currentColor" strokeWidth="2"/><path d="M18 9a9 9 0 01-9 9" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/></svg>,
  sliders: (sz=14) => <svg width={sz} height={sz} viewBox="0 0 24 24" fill="none" style={{display:'block'}}><line x1="4" y1="21" x2="4" y2="14" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/><line x1="4" y1="10" x2="4" y2="3" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/><line x1="12" y1="21" x2="12" y2="12" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/><line x1="12" y1="8" x2="12" y2="3" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/><line x1="20" y1="21" x2="20" y2="16" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/><line x1="20" y1="12" x2="20" y2="3" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/><line x1="1" y1="14" x2="7" y2="14" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/><line x1="9" y1="8" x2="15" y2="8" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/><line x1="17" y1="16" x2="23" y2="16" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/></svg>,
  layers: (sz=14) => <svg width={sz} height={sz} viewBox="0 0 24 24" fill="none" style={{display:'block'}}><polygon points="12 2 2 7 12 12 22 7 12 2" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/><polyline points="2 17 12 22 22 17" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/><polyline points="2 12 12 17 22 12" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/></svg>,
  refresh: (sz=14) => <svg width={sz} height={sz} viewBox="0 0 24 24" fill="none" style={{display:'block'}}><polyline points="23 4 23 10 17 10" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/><path d="M20.49 15a9 9 0 11-2.12-9.36L23 10" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/></svg>,
  // risk / protection
  shield: (sz=14) => <svg width={sz} height={sz} viewBox="0 0 24 24" fill="none" style={{display:'block'}}><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/><polyline points="9 12 11 14 15 10" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/></svg>,
  alertTriangle: (sz=14) => <svg width={sz} height={sz} viewBox="0 0 24 24" fill="none" style={{display:'block'}}><path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/><line x1="12" y1="9" x2="12" y2="13" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/><line x1="12" y1="17" x2="12.01" y2="17" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"/></svg>,
  link: (sz=14) => <svg width={sz} height={sz} viewBox="0 0 24 24" fill="none" style={{display:'block'}}><path d="M10 13a5 5 0 007.54.54l3-3a5 5 0 00-7.07-7.07l-1.72 1.71" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/><path d="M14 11a5 5 0 00-7.54-.54l-3 3a5 5 0 007.07 7.07l1.71-1.71" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/></svg>,
  zap: (sz=14) => <svg width={sz} height={sz} viewBox="0 0 24 24" fill="none" style={{display:'block'}}><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/></svg>,
  // news / data sources
  fileText: (sz=14) => <svg width={sz} height={sz} viewBox="0 0 24 24" fill="none" style={{display:'block'}}><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/><polyline points="14 2 14 8 20 8" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/><line x1="16" y1="13" x2="8" y2="13" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/><line x1="16" y1="17" x2="8" y2="17" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/></svg>,
  rss: (sz=14) => <svg width={sz} height={sz} viewBox="0 0 24 24" fill="none" style={{display:'block'}}><path d="M4 11a9 9 0 019 9" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/><path d="M4 4a16 16 0 0116 16" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/><circle cx="5" cy="19" r="1" fill="currentColor"/></svg>,
  bell: (sz=14) => <svg width={sz} height={sz} viewBox="0 0 24 24" fill="none" style={{display:'block'}}><path d="M18 8A6 6 0 006 8c0 7-3 9-3 9h18s-3-2-3-9" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/><path d="M13.73 21a2 2 0 01-3.46 0" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/></svg>,
  // institutional / market
  building: (sz=14) => <svg width={sz} height={sz} viewBox="0 0 24 24" fill="none" style={{display:'block'}}><line x1="3" y1="22" x2="21" y2="22" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/><line x1="6" y1="18" x2="6" y2="11" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/><line x1="10" y1="18" x2="10" y2="11" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/><line x1="14" y1="18" x2="14" y2="11" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/><line x1="18" y1="18" x2="18" y2="11" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/><polygon points="12 2 20 7 4 7 12 2" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/></svg>,
  grid: (sz=14) => <svg width={sz} height={sz} viewBox="0 0 24 24" fill="none" style={{display:'block'}}><rect x="3" y="3" width="7" height="7" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/><rect x="14" y="3" width="7" height="7" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/><rect x="14" y="14" width="7" height="7" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/><rect x="3" y="14" width="7" height="7" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/></svg>,
  flag: (sz=14) => <svg width={sz} height={sz} viewBox="0 0 24 24" fill="none" style={{display:'block'}}><path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/><line x1="4" y1="22" x2="4" y2="15" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/></svg>,
  // misc
  lock: (sz=14) => <svg width={sz} height={sz} viewBox="0 0 24 24" fill="none" style={{display:'block'}}><rect x="3" y="11" width="18" height="11" rx="2" stroke="currentColor" strokeWidth="2"/><path d="M7 11V7a5 5 0 0110 0v4" stroke="currentColor" strokeWidth="2"/></svg>,
  checkCircle: (sz=14) => <svg width={sz} height={sz} viewBox="0 0 24 24" fill="none" style={{display:'block'}}><path d="M22 11.08V12a10 10 0 11-5.93-9.14" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/><polyline points="22 4 12 14.01 9 11.01" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/></svg>,
  clock: (sz=14) => <svg width={sz} height={sz} viewBox="0 0 24 24" fill="none" style={{display:'block'}}><circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="2"/><polyline points="12 6 12 12 16 14" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/></svg>,
}

// ─── Ticker data ──────────────────────────────────────────────────
const TICKS = [
  {s:'NIFTY 50',   v:'24,765', c:'+0.82%', b:true },
  {s:'SENSEX',     v:'81,432', c:'+0.76%', b:true },
  {s:'BANK NIFTY', v:'52,140', c:'-0.14%', b:false},
  {s:'BTC/USD',    v:'$103,820',c:'+2.41%',b:true },
  {s:'ETH/USD',    v:'$3,260', c:'+1.87%', b:true },
  {s:'GOLD MCX',   v:'₹92,450',c:'+0.32%', b:true },
  {s:'CRUDE OIL',  v:'$82.40', c:'-0.58%', b:false},
  {s:'USD/INR',    v:'83.54',  c:'+0.09%', b:false},
  {s:'INDIA VIX',  v:'13.8',   c:'-5.2%',  b:true },
  {s:'MIDCAP 100', v:'56,820', c:'+1.04%', b:true },
]

// ─── 3D perspective grid ──────────────────────────────────────────
function BgGrid3D() {
  return (
    <div style={{
      position:'fixed', inset:0, pointerEvents:'none', zIndex:0, overflow:'hidden',
    }}>
      <div style={{ position:'absolute', width:700, height:700, borderRadius:'50%',
                    left:'5%', top:'-10%',
                    background:'radial-gradient(circle at 40% 40%, rgba(56,189,248,.14) 0%, rgba(99,102,241,.07) 40%, transparent 70%)',
                    filter:'blur(80px)', animation:'orb0 18s ease-in-out infinite' }}/>
      <div style={{ position:'absolute', width:600, height:600, borderRadius:'50%',
                    right:'-5%', top:'30%',
                    background:'radial-gradient(circle at 60% 40%, rgba(168,85,247,.12) 0%, rgba(56,189,248,.06) 50%, transparent 70%)',
                    filter:'blur(100px)', animation:'orb1 22s ease-in-out infinite' }}/>
      <div style={{ position:'absolute', width:400, height:400, borderRadius:'50%',
                    left:'40%', bottom:'5%',
                    background:'radial-gradient(circle at 50% 50%, rgba(0,217,163,.1) 0%, transparent 65%)',
                    filter:'blur(60px)', animation:'orb2 14s ease-in-out infinite' }}/>
      <div style={{
        position:'absolute', bottom:0, left:'-20%', right:'-20%', height:'55%',
        backgroundImage:`
          linear-gradient(rgba(56,189,248,0.07) 1px, transparent 1px),
          linear-gradient(90deg, rgba(56,189,248,0.07) 1px, transparent 1px)
        `,
        backgroundSize:'64px 64px',
        transform:'perspective(320px) rotateX(72deg)',
        transformOrigin:'bottom center',
        animation:'gridFlow 4s linear infinite',
        maskImage:'linear-gradient(to top, rgba(0,0,0,.9) 0%, transparent 100%)',
        WebkitMaskImage:'linear-gradient(to top, rgba(0,0,0,.9) 0%, transparent 100%)',
      }}/>
      <div style={{
        position:'absolute', left:0, right:0, height:1, zIndex:2,
        background:`linear-gradient(90deg, transparent 0%, ${C.ac}60 20%, ${C.cy}80 50%, ${C.ac}60 80%, transparent 100%)`,
        animation:'scanH 9s ease-in-out infinite',
      }}/>
      <div style={{
        position:'absolute', inset:0,
        background:'radial-gradient(ellipse 80% 60% at 50% 50%, transparent 40%, rgba(2,4,10,.9) 100%)',
      }}/>
    </div>
  )
}

// ─── Nav ──────────────────────────────────────────────────────────
function Nav() {
  return (
    <nav style={{
      position:'sticky', top:0, zIndex:10,
      display:'flex', alignItems:'center', justifyContent:'space-between',
      padding:'0 48px', height:58, flexShrink:0,
      borderBottom:`1px solid ${C.bd}`,
      background:'rgba(2,4,10,0.80)',
      backdropFilter:'blur(20px) saturate(180%)',
    }}>
      <div style={{ display:'flex', alignItems:'center', gap:11 }}>
        <div style={{
          width:36, height:36, borderRadius:10,
          background:'linear-gradient(135deg, #0EA5E9, #818CF8)',
          display:'flex', alignItems:'center', justifyContent:'center',
          boxShadow:`0 0 20px rgba(14,165,233,.4), 0 0 40px rgba(14,165,233,.15)`,
          animation:'neonPulse 3s ease-in-out infinite',
        }}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
            <polyline points="3,17 8,10 12,13 17,6" stroke="white" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"/>
            <polyline points="17,6 21,6 21,10" stroke="white" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
        </div>
        <div>
          <div style={{ fontSize:15, fontWeight:900, color:C.tx, fontFamily:C.ui,
                        letterSpacing:-.4,
                        background:'linear-gradient(135deg, #E2E8F0, #94A3B8)',
                        WebkitBackgroundClip:'text', WebkitTextFillColor:'transparent' }}>
            TradeX
          </div>
          <div style={{ fontSize:7, color:C.ac, fontFamily:C.font, letterSpacing:2.5, marginTop:-2, fontWeight:700 }}>
            TERMINAL
          </div>
        </div>
      </div>

      <div style={{ display:'flex', alignItems:'center', gap:14 }}>
        <div style={{ display:'flex', alignItems:'center', gap:6 }}>
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none">
            <circle cx="12" cy="12" r="10" stroke={C.mu} strokeWidth="2"/>
            <polyline points="12 6 12 12 16 14" stroke={C.mu} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
          <span style={{ fontSize:9, color:C.mu, fontFamily:C.font }}>
            {fmtIST(new Date(), 'date')}
          </span>
        </div>
      </div>
    </nav>
  )
}

// ─── Ticker ───────────────────────────────────────────────────────
function Ticker() {
  const all = [...TICKS,...TICKS]
  return (
    <div style={{
      overflow:'hidden', borderBottom:`1px solid ${C.bd}`,
      background:'rgba(2,4,10,0.75)', backdropFilter:'blur(12px)',
      flexShrink:0, position:'sticky', top:58, zIndex:9,
    }}>
      <div style={{ display:'flex', animation:'ticker 38s linear infinite', whiteSpace:'nowrap' }}>
        {all.map((it,i)=>(
          <div key={i} style={{
            display:'inline-flex', alignItems:'center', gap:8,
            padding:'7px 24px', borderRight:`1px solid ${C.bd}`, flexShrink:0,
          }}>
            <span style={{ fontSize:9, color:C.mu, fontFamily:C.ui, fontWeight:600, letterSpacing:.5 }}>{it.s}</span>
            <span style={{ fontSize:11, color:C.tx, fontFamily:C.font, fontWeight:700 }}>{it.v}</span>
            <span style={{
              fontSize:9, fontFamily:C.font, fontWeight:800,
              color:it.b?C.bull:C.bear,
              background:it.b?'rgba(0,217,163,.1)':'rgba(255,61,90,.1)',
              padding:'1px 6px', borderRadius:3,
              display:'flex', alignItems:'center', gap:3,
            }}>
              {it.b
                ? <svg width="7" height="7" viewBox="0 0 10 10"><polygon points="5,1 9,9 1,9" fill="currentColor"/></svg>
                : <svg width="7" height="7" viewBox="0 0 10 10"><polygon points="5,9 9,1 1,1" fill="currentColor"/></svg>
              }
              {it.c}
            </span>
          </div>
        ))}
      </div>
    </div>
  )
}

// ─── Sparkline ────────────────────────────────────────────────────
function Spark({ vals, bull }) {
  const W=100, H=28, min=Math.min(...vals), max=Math.max(...vals), rng=max-min||1
  const pts = vals.map((v,i)=>`${(i/(vals.length-1))*W},${H-((v-min)/rng)*H}`).join(' ')
  const col = bull ? C.bull : C.bear
  return (
    <svg width={W} height={H}>
      <defs>
        <linearGradient id={`sg${bull}`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={col} stopOpacity=".3"/>
          <stop offset="100%" stopColor={col} stopOpacity="0"/>
        </linearGradient>
      </defs>
      <polyline points={pts} fill="none" stroke={col} strokeWidth="1.8" strokeLinejoin="round"
                filter={`drop-shadow(0 0 3px ${col})`}/>
    </svg>
  )
}

// ─── 3D Login card ────────────────────────────────────────────────
function LoginCard() {
  const [email,    setEmail]    = useState('')
  const [password, setPassword] = useState('')
  const [loading,  setLoading]  = useState(false)
  const [focused,  setFocused]  = useState(null)
  const [tilt,     setTilt]     = useState({ x:0, y:0 })
  const [shine,    setShine]    = useState({ x:50, y:50 })
  const cardRef = useRef(null)
  const navigate = useNavigate()

  const handleMouseMove = useCallback((e) => {
    if (!cardRef.current) return
    const rect = cardRef.current.getBoundingClientRect()
    const x = ((e.clientY - rect.top)  / rect.height - 0.5) * -14
    const y = ((e.clientX - rect.left) / rect.width  - 0.5) *  14
    setTilt({ x, y })
    setShine({
      x: ((e.clientX - rect.left) / rect.width)  * 100,
      y: ((e.clientY - rect.top)  / rect.height) * 100,
    })
  }, [])

  const handleMouseLeave = useCallback(() => {
    setTilt({ x:0, y:0 })
    setShine({ x:50, y:50 })
  }, [])

  const isReset = tilt.x === 0 && tilt.y === 0

  async function submit(e) {
    e.preventDefault()
    setLoading(true)
    const { error } = await supabase.auth.signInWithPassword({ email, password })
    if (error) toast.error(error.message)
    else navigate('/')
    setLoading(false)
  }

  const inp = f => ({
    width:'100%', boxSizing:'border-box',
    background:focused===f ? 'rgba(56,189,248,.05)' : C.bgI,
    border:`1px solid ${focused===f ? C.ac : 'rgba(56,189,248,.14)'}`,
    boxShadow: focused===f ? `0 0 0 3px rgba(56,189,248,.12), 0 0 12px rgba(56,189,248,.08)` : 'none',
    color:C.tx, fontSize:13, padding:'12px 15px', outline:'none',
    fontFamily:C.ui, borderRadius:10,
    transition:'border-color .15s, box-shadow .15s, background .15s',
  })

  return (
    <div
      ref={cardRef}
      onMouseMove={handleMouseMove}
      onMouseLeave={handleMouseLeave}
      style={{
        transform:`perspective(1000px) rotateX(${tilt.x}deg) rotateY(${tilt.y}deg)`,
        transition: isReset
          ? 'transform 0.65s cubic-bezier(0.34,1.56,0.64,1)'
          : 'transform 0.08s linear',
        transformStyle:'preserve-3d',
        willChange:'transform',
        position:'relative',
      }}
    >
      {/* Outer glow ring */}
      <div style={{
        position:'absolute', inset:-1, borderRadius:18,
        background:`linear-gradient(135deg, rgba(56,189,248,.3) 0%, rgba(129,140,248,.2) 50%, rgba(168,85,247,.3) 100%)`,
        zIndex:0, filter:'blur(1px)',
      }}/>

      {/* Card body */}
      <div style={{
        position:'relative', zIndex:1,
        background:`linear-gradient(160deg, rgba(10,16,32,.98) 0%, rgba(5,10,20,.99) 100%)`,
        border:'1px solid rgba(56,189,248,.2)',
        borderRadius:16,
        boxShadow:`
          0 40px 100px rgba(0,0,0,.8),
          0 0 60px rgba(56,189,248,.06),
          inset 0 1px 0 rgba(255,255,255,.06)
        `,
        overflow:'hidden',
      }}>
        {/* Specular highlight */}
        <div style={{
          position:'absolute', inset:0, borderRadius:'inherit',
          background:`radial-gradient(ellipse 70% 60% at ${shine.x}% ${shine.y}%, rgba(56,189,248,.09) 0%, transparent 65%)`,
          pointerEvents:'none', zIndex:2, transition:'background .05s',
        }}/>

        {/* Top shimmer line */}
        <div style={{
          position:'absolute', top:0, left:0, right:0, height:1, zIndex:3,
          background:`linear-gradient(90deg, transparent 10%, rgba(56,189,248,.6) 30%, rgba(168,85,247,.6) 70%, transparent 90%)`,
          backgroundSize:'200% auto', animation:'shimmer 4s linear infinite',
        }}/>

        {/* Header */}
        <div style={{
          padding:'28px 28px 22px',
          borderBottom:`1px solid rgba(56,189,248,.12)`,
          background:'linear-gradient(180deg, rgba(56,189,248,.05) 0%, transparent 100%)',
          display:'flex', flexDirection:'column', alignItems:'center', gap:12,
          textAlign:'center', position:'relative', zIndex:4,
        }}>
          {/* Logo mark */}
          <div style={{
            width:58, height:58, borderRadius:15,
            background:'linear-gradient(135deg, #0EA5E9 0%, #818CF8 50%, #A855F7 100%)',
            display:'flex', alignItems:'center', justifyContent:'center',
            boxShadow:'0 8px 32px rgba(14,165,233,.5), 0 0 0 1px rgba(255,255,255,.1)',
            position:'relative', overflow:'hidden',
          }}>
            <div style={{
              position:'absolute', inset:0,
              background:'linear-gradient(135deg, rgba(255,255,255,.2) 0%, transparent 50%)',
            }}/>
            <svg width="26" height="26" viewBox="0 0 24 24" fill="none">
              <polyline points="3,17 8,10 12,13 17,6" stroke="white" strokeWidth="2.4"
                        strokeLinecap="round" strokeLinejoin="round"
                        filter="drop-shadow(0 0 4px rgba(255,255,255,.6))"/>
              <polyline points="17,6 21,6 21,10" stroke="white" strokeWidth="2.4"
                        strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
          </div>

          <div>
            <div style={{
              fontSize:20, fontWeight:900, fontFamily:C.ui, letterSpacing:-.5,
              background:'linear-gradient(135deg, #E2E8F0 0%, #94A3B8 100%)',
              WebkitBackgroundClip:'text', WebkitTextFillColor:'transparent',
            }}>TradeX Terminal</div>
            <div style={{ fontSize:10, color:C.mu, fontFamily:C.ui, marginTop:4 }}>
              Institutional-grade access only
            </div>
          </div>
        </div>

        {/* Form */}
        <form onSubmit={submit} style={{ padding:'24px 28px 22px', position:'relative', zIndex:4 }}>
          <div style={{ marginBottom:16 }}>
            <label style={{
              display:'flex', alignItems:'center', gap:6, marginBottom:7,
              fontSize:9, fontWeight:700, color:C.mu, fontFamily:C.ui,
              letterSpacing:.7, textTransform:'uppercase',
            }}>
              <span style={{ color:C.ac, display:'flex' }}>
                <svg width="10" height="10" viewBox="0 0 24 24" fill="none">
                  <path d="M20 4H4a2 2 0 00-2 2v12a2 2 0 002 2h16a2 2 0 002-2V6a2 2 0 00-2-2z" stroke="currentColor" strokeWidth="2"/>
                  <polyline points="22,6 12,13 2,6" stroke="currentColor" strokeWidth="2"/>
                </svg>
              </span>
              Email
            </label>
            <input type="email" value={email} onChange={e=>setEmail(e.target.value)}
              required placeholder="trader@firm.com" style={inp('email')}
              onFocus={()=>setFocused('email')} onBlur={()=>setFocused(null)}/>
          </div>

          <div style={{ marginBottom:22 }}>
            <label style={{
              display:'flex', alignItems:'center', gap:6, marginBottom:7,
              fontSize:9, fontWeight:700, color:C.mu, fontFamily:C.ui,
              letterSpacing:.7, textTransform:'uppercase',
            }}>
              <span style={{ color:C.ac, display:'flex' }}>
                <svg width="10" height="10" viewBox="0 0 24 24" fill="none">
                  <rect x="3" y="11" width="18" height="11" rx="2" stroke="currentColor" strokeWidth="2"/>
                  <path d="M7 11V7a5 5 0 0110 0v4" stroke="currentColor" strokeWidth="2"/>
                </svg>
              </span>
              Password
            </label>
            <input type="password" value={password} onChange={e=>setPassword(e.target.value)}
              required placeholder="••••••••" style={inp('password')}
              onFocus={()=>setFocused('password')} onBlur={()=>setFocused(null)}/>
          </div>

          <button type="submit" disabled={loading}
            style={{
              width:'100%', padding:'14px', fontSize:13, fontWeight:800,
              fontFamily:C.ui, letterSpacing:.4, cursor:loading?'not-allowed':'pointer',
              borderRadius:11, border:'none', position:'relative', overflow:'hidden',
              background: loading
                ? 'rgba(56,189,248,.25)'
                : 'linear-gradient(135deg, #0EA5E9 0%, #818CF8 50%, #A855F7 100%)',
              color:'#fff',
              boxShadow: loading ? 'none' : '0 4px 24px rgba(14,165,233,.45), 0 2px 8px rgba(14,165,233,.3)',
              transition:'all .2s',
            }}
            onMouseEnter={e=>{ if(!loading){ e.currentTarget.style.transform='translateY(-1px)'; e.currentTarget.style.boxShadow='0 8px 32px rgba(14,165,233,.6), 0 2px 8px rgba(14,165,233,.4)' }}}
            onMouseLeave={e=>{ e.currentTarget.style.transform='translateY(0)'; e.currentTarget.style.boxShadow='0 4px 24px rgba(14,165,233,.45), 0 2px 8px rgba(14,165,233,.3)' }}
          >
            {!loading && (
              <div style={{
                position:'absolute', inset:0,
                background:'linear-gradient(90deg, transparent 0%, rgba(255,255,255,.15) 50%, transparent 100%)',
                backgroundSize:'200% auto', animation:'shimmer 3s linear infinite',
              }}/>
            )}
            <span style={{ position:'relative', zIndex:1 }}>
              {loading
                ? <span style={{ display:'flex', alignItems:'center', justifyContent:'center', gap:8 }}>
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none"
                         style={{ animation:'spin .8s linear infinite', display:'inline-block' }}>
                      <path d="M21 12a9 9 0 11-9-9" stroke="white" strokeWidth="2.5" strokeLinecap="round"/>
                    </svg>
                    Authenticating…
                  </span>
                : 'Enter Terminal  →'
              }
            </span>
          </button>

          <div style={{
            marginTop:14, padding:'11px 14px', borderRadius:10,
            background:'rgba(56,189,248,.05)', border:`1px solid rgba(56,189,248,.12)`,
            display:'flex', alignItems:'flex-start', gap:8,
          }}>
            <span style={{ color:C.ac, display:'flex', marginTop:1, flexShrink:0 }}>
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none">
                <rect x="3" y="11" width="18" height="11" rx="2" stroke="currentColor" strokeWidth="2"/>
                <path d="M7 11V7a5 5 0 0110 0v4" stroke="currentColor" strokeWidth="2"/>
              </svg>
            </span>
            <div style={{ fontSize:10, color:C.mu, fontFamily:C.ui, lineHeight:1.6 }}>
              Access is by invitation only. Contact your administrator to request an account.
            </div>
          </div>
        </form>

        {/* Footer */}
        <div style={{
          padding:'11px 28px 15px',
          borderTop:`1px solid rgba(56,189,248,.08)`,
          display:'flex', justifyContent:'flex-end', alignItems:'center',
          position:'relative', zIndex:4,
        }}>
          <div style={{ display:'flex', gap:6 }}>
            {['Supabase Auth','TLS 1.3','SOC 2'].map(b=>(
              <div key={b} style={{
                padding:'2px 8px',
                background:'rgba(56,189,248,.05)', border:`1px solid ${C.bd}`,
                borderRadius:4, fontSize:7, color:C.mu, fontFamily:C.ui, fontWeight:600,
              }}>{b}</div>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}

// ─── Stat pill ────────────────────────────────────────────────────
function StatPill({ val, label, color, icon }) {
  return (
    <div style={{
      flex:1, minWidth:0,
      background:`linear-gradient(135deg, ${color}0E 0%, ${color}05 100%)`,
      border:`1px solid ${color}22`,
      borderRadius:12, padding:'14px 16px',
      position:'relative', overflow:'hidden',
      boxShadow:`0 4px 20px rgba(0,0,0,.4), inset 0 1px 0 rgba(255,255,255,.04)`,
      transition:'transform .2s, box-shadow .2s',
    }}
    onMouseEnter={e=>{ e.currentTarget.style.transform='translateY(-3px) scale(1.02)'; e.currentTarget.style.boxShadow=`0 12px 32px rgba(0,0,0,.5), 0 0 20px ${color}18` }}
    onMouseLeave={e=>{ e.currentTarget.style.transform=''; e.currentTarget.style.boxShadow=`0 4px 20px rgba(0,0,0,.4), inset 0 1px 0 rgba(255,255,255,.04)` }}
    >
      <div style={{ position:'absolute', top:0, left:0, right:0, height:1,
                    background:`linear-gradient(90deg, transparent, ${color}60, transparent)` }}/>
      <div style={{ fontSize:9, color, fontFamily:C.ui, fontWeight:700,
                    letterSpacing:.8, textTransform:'uppercase', marginBottom:5,
                    display:'flex', alignItems:'center', gap:5 }}>
        <span style={{ color, display:'flex' }}>{icon}</span>{label}
      </div>
      <div style={{
        fontSize:26, fontWeight:900, fontFamily:C.font, letterSpacing:-1,
        background:`linear-gradient(135deg, #E2E8F0, ${color})`,
        WebkitBackgroundClip:'text', WebkitTextFillColor:'transparent',
      }}>{val}</div>
    </div>
  )
}

// ─── Signal table ─────────────────────────────────────────────────
const SIG_ROWS = [
  {sym:'RELIANCE', badge:'NSE · LARGECAP', price:'₹2,934', chg:'+1.42%', b:true,
   vals:[2800,2820,2795,2860,2890,2910,2935], sig:'BUY', sc:C.bull},
  {sym:'BTCUSDT',  badge:'CRYPTO · PERP',  price:'$103,820',chg:'+2.41%',b:true,
   vals:[98000,99200,100500,101800,102200,103100,103820], sig:'STRONG BUY', sc:'#00E5B0'},
  {sym:'HDFCBANK', badge:'NSE · BANKING',  price:'₹1,748', chg:'-0.38%', b:false,
   vals:[1790,1780,1770,1765,1760,1752,1748], sig:'HOLD', sc:C.amb},
]
function SignalTable() {
  return (
    <div style={{
      background:C.bgC, border:`1px solid ${C.bd}`, borderRadius:12, overflow:'hidden',
      boxShadow:`0 16px 48px rgba(0,0,0,.5), 0 0 0 1px rgba(56,189,248,.05)`,
    }}>
      <div style={{
        display:'flex', alignItems:'center', justifyContent:'space-between',
        padding:'9px 16px',
        background:`linear-gradient(90deg, ${C.bgP} 0%, rgba(56,189,248,.04) 100%)`,
        borderBottom:`1px solid ${C.bd}`,
      }}>
        <div style={{ display:'flex', gap:5 }}>
          {[C.bear,C.amb,C.bull].map((c,i)=>(
            <div key={i} style={{ width:9, height:9, borderRadius:'50%', background:c,
                                  boxShadow:`0 0 6px ${c}` }}/>
          ))}
        </div>
        <span style={{ fontSize:9, color:C.mu, fontFamily:C.font, letterSpacing:.5 }}>TRADEX · SIGNAL INTELLIGENCE</span>
        <div style={{ display:'flex', alignItems:'center', gap:4 }}>
          <svg width="9" height="9" viewBox="0 0 24 24" fill="none">
            <circle cx="12" cy="12" r="10" stroke={C.bull} strokeWidth="2"/>
            <polyline points="12 6 12 12 16 14" stroke={C.bull} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
          <span style={{ fontSize:8, color:C.bull, fontFamily:C.font, fontWeight:700 }}>REAL-TIME</span>
        </div>
      </div>
      <div style={{
        display:'grid', gridTemplateColumns:'1.2fr 1fr .8fr 1fr .9fr',
        padding:'6px 16px', borderBottom:`1px solid ${C.bd}`,
        background:'rgba(255,255,255,.02)',
      }}>
        {['SYMBOL','PRICE','CHANGE','CHART','SIGNAL'].map(h=>(
          <span key={h} style={{ fontSize:8, color:C.di, fontFamily:C.ui, fontWeight:700, letterSpacing:.8 }}>{h}</span>
        ))}
      </div>
      {SIG_ROWS.map((row,i)=>(
        <div key={i} style={{
          display:'grid', gridTemplateColumns:'1.2fr 1fr .8fr 1fr .9fr',
          padding:'11px 16px', alignItems:'center',
          borderBottom:i<SIG_ROWS.length-1?`1px solid ${C.bd}`:'none',
          background:i%2===0?'transparent':'rgba(255,255,255,.012)',
          transition:'background .15s',
        }}
        onMouseEnter={e=>e.currentTarget.style.background='rgba(56,189,248,.04)'}
        onMouseLeave={e=>e.currentTarget.style.background=i%2===0?'transparent':'rgba(255,255,255,.012)'}
        >
          <div>
            <div style={{ fontSize:12, fontWeight:700, color:C.tx, fontFamily:C.font }}>{row.sym}</div>
            <div style={{ fontSize:8, color:C.di, fontFamily:C.ui, marginTop:1 }}>{row.badge}</div>
          </div>
          <div style={{ fontSize:12, fontWeight:700, color:C.tx, fontFamily:C.font }}>{row.price}</div>
          <span style={{
            display:'inline-flex', alignItems:'center', gap:4,
            background:row.b?'rgba(0,217,163,.1)':'rgba(255,61,90,.1)',
            border:`1px solid ${row.b?C.bull:C.bear}25`, borderRadius:4,
            padding:'2px 7px', width:'fit-content',
          }}>
            {row.b
              ? <svg width="7" height="7" viewBox="0 0 10 10"><polygon points="5,1 9,9 1,9" fill={C.bull}/></svg>
              : <svg width="7" height="7" viewBox="0 0 10 10"><polygon points="5,9 9,1 1,1" fill={C.bear}/></svg>
            }
            <span style={{ fontSize:9, fontWeight:700, color:row.b?C.bull:C.bear, fontFamily:C.font }}>
              {row.chg}
            </span>
          </span>
          <Spark vals={row.vals} bull={row.b}/>
          <span style={{
            display:'inline-flex', alignItems:'center', gap:4,
            background:`${row.sc}12`, border:`1px solid ${row.sc}30`,
            borderRadius:5, padding:'3px 8px', width:'fit-content',
            boxShadow:`0 0 8px ${row.sc}12`,
          }}>
            <div style={{ width:4, height:4, borderRadius:'50%', background:row.sc, boxShadow:`0 0 5px ${row.sc}` }}/>
            <span style={{ fontSize:8, fontWeight:800, color:row.sc, fontFamily:C.font }}>{row.sig}</span>
          </span>
        </div>
      ))}
      <div style={{
        display:'flex', gap:18, padding:'7px 16px',
        background:`linear-gradient(90deg, ${C.bgP}, rgba(56,189,248,.03))`,
        borderTop:`1px solid ${C.bd}`,
      }}>
        {[
          {t:'AGENTS: 6/6 ACTIVE', c:C.di},
          {t:'RISK: LOW',          c:C.bull},
          {t:'SIGNALS TODAY: 24',  c:C.di},
        ].map(({t,c},i)=>(
          <span key={i} style={{ fontSize:8, color:c, fontFamily:C.font }}>{t}</span>
        ))}
      </div>
    </div>
  )
}

// ─── Section wrapper ──────────────────────────────────────────────
function Section({ children, alt, accent }) {
  return (
    <section style={{
      position:'relative', zIndex:1, padding:'96px 64px',
      background: alt ? 'rgba(6,12,24,0.5)' : 'transparent',
      borderTop:`1px solid ${C.bd}`,
    }}>
      {accent && (
        <div style={{ position:'absolute', inset:0, pointerEvents:'none', overflow:'hidden' }}>
          <div style={{
            position:'absolute', width:500, height:500, borderRadius:'50%',
            background:`radial-gradient(circle, ${accent}0A 0%, transparent 70%)`,
            left:'-8%', top:'5%', filter:'blur(40px)',
            animation:'glowPulse 5s ease-in-out infinite',
          }}/>
        </div>
      )}
      {children}
    </section>
  )
}

// ─── Section header ───────────────────────────────────────────────
function SecHdr({ num, label, title, color, center }) {
  return (
    <div style={{ marginBottom:48, textAlign:center?'center':'left' }}>
      <div style={{ display:'inline-flex', alignItems:'center', gap:10, marginBottom:16 }}>
        <span style={{ fontSize:10, fontWeight:700, color, fontFamily:C.font, letterSpacing:1, opacity:.5 }}>{num}</span>
        <div style={{ width:28, height:1, background:`${color}50` }}/>
        <span style={{
          fontSize:9, color, fontFamily:C.ui, fontWeight:700, letterSpacing:.8,
          textTransform:'uppercase',
          background:`${color}0E`, border:`1px solid ${color}22`,
          borderRadius:20, padding:'3px 11px',
          boxShadow:`0 0 10px ${color}15`,
        }}>{label}</span>
      </div>
      <h2 style={{ fontSize:'clamp(22px,2.4vw,34px)', fontWeight:900, color:C.tx,
                   fontFamily:C.ui, letterSpacing:-.8, lineHeight:1.2, margin:0 }}>
        {title}
      </h2>
    </div>
  )
}

// ─── Feature chip ─────────────────────────────────────────────────
function Chip({ icon, text, color }) {
  return (
    <div
      style={{
        display:'flex', alignItems:'center', gap:10, padding:'11px 14px',
        background:C.bgC, border:`1px solid ${C.bd}`, borderRadius:10,
        transition:'border-color .2s, transform .2s, box-shadow .2s',
        cursor:'default',
      }}
      onMouseEnter={e=>{ e.currentTarget.style.borderColor=`${color}40`; e.currentTarget.style.transform='translateY(-2px)'; e.currentTarget.style.boxShadow=`0 8px 24px rgba(0,0,0,.4), 0 0 12px ${color}12` }}
      onMouseLeave={e=>{ e.currentTarget.style.borderColor=C.bd; e.currentTarget.style.transform=''; e.currentTarget.style.boxShadow='none' }}
    >
      <div style={{
        width:32, height:32, borderRadius:8, flexShrink:0,
        background:`${color}12`, border:`1px solid ${color}22`,
        display:'flex', alignItems:'center', justifyContent:'center',
        boxShadow:`0 0 10px ${color}15`, color,
      }}>{icon}</div>
      <span style={{ fontSize:12, color:C.tx, fontFamily:C.ui, fontWeight:500 }}>{text}</span>
    </div>
  )
}

// ─── News feed mock ───────────────────────────────────────────────
const NEWS = [
  {t:'09:42',imp:'HIGH',  b:true,  h:'FII net buy ₹4,320 Cr — banking stocks surge at open'},
  {t:'10:15',imp:'HIGH',  b:true,  h:'Infosys Q4 PAT beats estimates by 8% — strong deal wins'},
  {t:'11:03',imp:'HIGH',  b:true,  h:'India VIX drops 6.2% — options writers cover shorts aggressively'},
  {t:'11:47',imp:'MEDIUM',b:false, h:'Crude oil dips on demand concern — OMC stocks rally'},
  {t:'12:30',imp:'MEDIUM',b:false, h:'RBI holds repo rate at 6.5% — rate-sensitive sectors flat'},
  {t:'13:10',imp:'LOW',   b:true,  h:'Nifty 50 breaks 24,800 resistance — breadth positive'},
  {t:'14:05',imp:'HIGH',  b:true,  h:'Adani Ports wins ₹2,800 Cr port infra order — stock jumps 4%'},
]
const IC = { HIGH:'#FF3D5A', MEDIUM:'#FBBF24', LOW:'#4A6280' }
function NewsMock() {
  return (
    <div style={{
      background:C.bgC, border:`1px solid ${C.bd}`, borderRadius:12, overflow:'hidden',
      boxShadow:`0 16px 48px rgba(0,0,0,.5), 0 0 0 1px rgba(34,211,238,.05)`,
    }}>
      <div style={{
        display:'flex', alignItems:'center', justifyContent:'space-between',
        padding:'10px 16px',
        background:`linear-gradient(90deg, ${C.bgP}, rgba(34,211,238,.04))`,
        borderBottom:`1px solid ${C.bd}`,
      }}>
        <div style={{ display:'flex', alignItems:'center', gap:8 }}>
          <span style={{ fontSize:10, fontWeight:700, color:C.cy, fontFamily:C.ui }}>MARKET INTELLIGENCE FEED</span>
          <span style={{ fontSize:8, color:C.di, fontFamily:C.ui }}>· 6 sources · AI classified</span>
        </div>
        <div style={{ display:'flex', alignItems:'center', gap:4, color:C.bull }}>
          {ICONS.activity(9)}
          <span style={{ fontSize:8, color:C.bull, fontFamily:C.font, fontWeight:700 }}>STREAMING</span>
        </div>
      </div>
      {NEWS.map((n,i)=>(
        <div key={i} style={{
          display:'flex', gap:10, padding:'10px 16px', alignItems:'flex-start',
          borderBottom:i<NEWS.length-1?`1px solid ${C.bd}`:'none',
          background:i%2===0?'transparent':'rgba(255,255,255,.012)',
          transition:'background .12s',
        }}
        onMouseEnter={e=>e.currentTarget.style.background='rgba(34,211,238,.03)'}
        onMouseLeave={e=>e.currentTarget.style.background=i%2===0?'transparent':'rgba(255,255,255,.012)'}
        >
          <span style={{ fontSize:8, color:C.di, fontFamily:C.font, flexShrink:0, paddingTop:2 }}>{n.t}</span>
          <span style={{
            fontSize:7, fontWeight:700, color:IC[n.imp],
            background:`${IC[n.imp]}12`, border:`1px solid ${IC[n.imp]}25`,
            borderRadius:3, padding:'2px 5px', flexShrink:0,
          }}>{n.imp}</span>
          <span style={{
            fontSize:11, color:n.b?C.tx:C.mu, fontFamily:C.ui, lineHeight:1.55,
            borderLeft:`2px solid ${n.b?C.bull:C.bear}35`, paddingLeft:8,
          }}>{n.h}</span>
        </div>
      ))}
    </div>
  )
}

// ─── Agent pipeline ───────────────────────────────────────────────
const AGENTS = [
  {name:'Market Data Agent',   icon:ICONS.barChart(16),   desc:'Fetches NSE/BSE/crypto prices every 5 min',    color:C.ac,  status:'ACTIVE', cycle:'5m'},
  {name:'Sentiment Agent',     icon:ICONS.rss(16),        desc:'LLM-classifies headlines per symbol',           color:C.cy,  status:'ACTIVE', cycle:'10m'},
  {name:'Chart Pattern Agent', icon:ICONS.candlestick(16),desc:'Detects 20+ candle patterns across watchlist',  color:C.pu,  status:'ACTIVE', cycle:'15m'},
  {name:'Fundamentals Agent',  icon:ICONS.fileText(16),   desc:'P/E, ROE, growth ratios — daily refresh',       color:C.amb, status:'ACTIVE', cycle:'Daily'},
  {name:'RF/DW Signal Engine', icon:ICONS.network(16),    desc:'ML model merges all signals → BUY/SELL/HOLD',  color:C.bull,status:'ACTIVE', cycle:'5m'},
  {name:'Risk Guardian',       icon:ICONS.shield(16),     desc:'Monitors positions, fires alerts & kill-switch',color:C.bear,status:'ACTIVE', cycle:'Real-time'},
]
function AgentPipeline() {
  return (
    <div style={{ display:'flex', flexDirection:'column', gap:8 }}>
      {AGENTS.map((ag,i)=>(
        <div key={i} style={{
          display:'flex', alignItems:'center', gap:12, padding:'12px 16px',
          background:C.bgC, border:`1px solid ${C.bd}`, borderRadius:10,
          position:'relative', overflow:'hidden',
          transition:'border-color .2s, transform .2s',
        }}
        onMouseEnter={e=>{ e.currentTarget.style.borderColor=`${ag.color}35`; e.currentTarget.style.transform='translateX(3px)' }}
        onMouseLeave={e=>{ e.currentTarget.style.borderColor=C.bd; e.currentTarget.style.transform='' }}
        >
          <div style={{ position:'absolute', left:0, top:0, bottom:0, width:3,
                        background:ag.color, borderRadius:'3px 0 0 3px',
                        boxShadow:`4px 0 12px ${ag.color}30` }}/>
          <div style={{
            width:36, height:36, borderRadius:9, background:`${ag.color}12`,
            border:`1px solid ${ag.color}25`, display:'flex', alignItems:'center',
            justifyContent:'center', flexShrink:0, color:ag.color,
          }}>{ag.icon}</div>
          <div style={{ flex:1, minWidth:0 }}>
            <div style={{ fontSize:12, fontWeight:700, color:C.tx, fontFamily:C.ui }}>{ag.name}</div>
            <div style={{ fontSize:10, color:C.mu, fontFamily:C.ui, marginTop:2 }}>{ag.desc}</div>
          </div>
          <div style={{ display:'flex', flexDirection:'column', alignItems:'flex-end', gap:4, flexShrink:0 }}>
            <span style={{
              fontSize:8, fontWeight:700, color:ag.color,
              background:`${ag.color}12`, border:`1px solid ${ag.color}25`,
              borderRadius:3, padding:'2px 8px', fontFamily:C.font,
              boxShadow:`0 0 8px ${ag.color}20`,
            }}>{ag.status}</span>
            <span style={{ fontSize:8, color:C.di, fontFamily:C.font }}>every {ag.cycle}</span>
          </div>
          {i < AGENTS.length-1 && (
            <div style={{ position:'absolute', bottom:-6, left:29, fontSize:9, color:C.di, zIndex:1 }}>▼</div>
          )}
        </div>
      ))}
    </div>
  )
}

// ─── Sector heatmap ───────────────────────────────────────────────
const SECTS = [
  {s:'BANK', C:C.bull,v:+1.24},{s:'IT',    C:C.bear,v:-0.43},
  {s:'AUTO', C:C.bull,v:+2.10},{s:'PHARM', C:C.bull,v:+0.67},
  {s:'FMCG', C:C.bear,v:-0.18},{s:'METAL', C:C.bull,v:+3.31},
  {s:'ENGY', C:C.bull,v:+0.92},{s:'RLTY',  C:C.bear,v:-1.05},
]
function SectorHeat() {
  const mx = Math.max(...SECTS.map(s=>Math.abs(s.v)))
  return (
    <div>
      <div style={{ display:'grid', gridTemplateColumns:'repeat(4,1fr)', gap:7 }}>
        {SECTS.map(({s,C:c,v})=>{
          const pct=Math.abs(v)/mx
          const bg=v>=0?`rgba(0,217,163,${.07+pct*.18})`:`rgba(255,61,90,${.07+pct*.18})`
          return (
            <div key={s} style={{
              background:bg, border:`1px solid ${c}28`, borderRadius:10,
              padding:'11px 10px', position:'relative', overflow:'hidden',
              transition:'transform .15s',
            }}
            onMouseEnter={e=>e.currentTarget.style.transform='scale(1.04)'}
            onMouseLeave={e=>e.currentTarget.style.transform=''}
            >
              <div style={{ position:'absolute', bottom:0, left:0, width:`${pct*100}%`, height:2,
                            background:c, boxShadow:`0 0 6px ${c}` }}/>
              <div style={{ fontSize:8, color:C.mu, fontFamily:C.ui, fontWeight:600, marginBottom:4 }}>{s}</div>
              <div style={{ fontSize:15, fontWeight:800, color:c, fontFamily:C.font,
                            textShadow:`0 0 10px ${c}50` }}>
                {v>=0?'+':''}{v.toFixed(2)}%
              </div>
            </div>
          )
        })}
      </div>
      <div style={{ marginTop:14, background:C.bgC, border:`1px solid ${C.bd}`, borderRadius:11, padding:'14px 16px' }}>
        <div style={{ fontSize:9, fontWeight:700, color:C.tx, fontFamily:C.ui, marginBottom:12, letterSpacing:.4 }}>
          INSTITUTIONAL FLOWS TODAY
        </div>
        {[{l:'FII',v:4320,col:C.bull},{l:'DII',v:-820,col:C.cy}].map(({l,v,col})=>{
          const pos=v>=0; const pct=Math.min(Math.abs(v)/6000*100,100)
          return (
            <div key={l} style={{ marginBottom:10 }}>
              <div style={{ display:'flex', justifyContent:'space-between', marginBottom:5 }}>
                <span style={{ fontSize:10, color:C.tx, fontFamily:C.ui, fontWeight:600 }}>{l}</span>
                <span style={{ fontSize:11, fontWeight:700, color:pos?C.bull:C.bear, fontFamily:C.font }}>
                  {pos?'+':'-'}₹{Math.abs(v).toLocaleString('en-IN')} Cr
                </span>
              </div>
              <div style={{ height:6, background:`${pos?C.bull:C.bear}18`, borderRadius:4, overflow:'hidden' }}>
                <div style={{
                  width:`${pct}%`, height:'100%', background:pos?C.bull:C.bear,
                  borderRadius:4, boxShadow:`4px 0 12px ${pos?C.bull:C.bear}50`,
                }}/>
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

// ─── Risk mock ────────────────────────────────────────────────────
const POSITIONS = [
  {sym:'RELIANCE',  qty:50,   entry:2890, ltp:2934,   pnl:+2200, b:true },
  {sym:'BTCUSDT',   qty:0.12, entry:98500,ltp:103820, pnl:+638,  b:true },
  {sym:'HDFCBANK',  qty:100,  entry:1760, ltp:1748,   pnl:-1200, b:false},
]
function RiskMock() {
  return (
    <div style={{ display:'flex', flexDirection:'column', gap:10 }}>
      <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr 1fr', gap:8 }}>
        {[
          {l:'Risk Level',  v:'LOW',     c:C.bull},
          {l:'Daily P&L',   v:'+₹1,638', c:C.bull},
          {l:'Max Drawdown',v:'2.4%',    c:C.amb},
        ].map(({l,v,c})=>(
          <div key={l} style={{
            background:C.bgC, border:`1px solid ${c}20`, borderRadius:10, padding:'10px 12px',
            boxShadow:`0 0 12px ${c}0A`,
          }}>
            <div style={{ fontSize:8, color:C.mu, fontFamily:C.ui, fontWeight:600, letterSpacing:.5, marginBottom:4 }}>{l}</div>
            <div style={{ fontSize:16, fontWeight:800, color:c, fontFamily:C.font,
                          textShadow:`0 0 10px ${c}40` }}>{v}</div>
          </div>
        ))}
      </div>
      <div style={{ background:C.bgC, border:`1px solid ${C.bd}`, borderRadius:11, overflow:'hidden' }}>
        <div style={{ padding:'9px 14px', background:C.bgP, borderBottom:`1px solid ${C.bd}` }}>
          <span style={{ fontSize:10, fontWeight:700, color:C.bear, fontFamily:C.ui }}>OPEN POSITIONS</span>
        </div>
        {POSITIONS.map((p,i)=>(
          <div key={i} style={{
            display:'grid', gridTemplateColumns:'1.2fr 1fr 1fr 1fr',
            padding:'10px 14px', alignItems:'center',
            borderBottom:i<POSITIONS.length-1?`1px solid ${C.bd}`:'none',
          }}>
            <div style={{ fontSize:11, fontWeight:700, color:C.tx, fontFamily:C.font }}>{p.sym}</div>
            <div style={{ fontSize:10, color:C.mu, fontFamily:C.font }}>{p.qty} @ {p.entry.toLocaleString()}</div>
            <div style={{ fontSize:11, fontWeight:600, color:C.tx, fontFamily:C.font }}>{p.ltp.toLocaleString()}</div>
            <div style={{ fontSize:11, fontWeight:700, color:p.b?C.bull:C.bear, fontFamily:C.font,
                          textShadow:`0 0 8px ${p.b?C.bull:C.bear}40` }}>
              {p.b?'+':''}{p.pnl>=1000?`₹${(p.pnl/1000).toFixed(1)}K`:`₹${p.pnl}`}
            </div>
          </div>
        ))}
      </div>
      <div style={{
        display:'flex', alignItems:'center', gap:10, padding:'11px 14px',
        background:'rgba(255,61,90,.06)', border:`1px solid rgba(255,61,90,.2)`, borderRadius:10,
      }}>
        <span style={{ color:C.bear, display:'flex' }}>{ICONS.shield(16)}</span>
        <div>
          <div style={{ fontSize:11, fontWeight:700, color:C.bear, fontFamily:C.ui }}>Risk Guardian Active</div>
          <div style={{ fontSize:10, color:C.mu, fontFamily:C.ui, marginTop:2 }}>
            Kill-switch trigger: HDFCBANK exceeds -3% — monitoring...
          </div>
        </div>
      </div>
    </div>
  )
}

// ─── Main page ────────────────────────────────────────────────────
export default function Login() {
  return (
    <div style={{
      height:'100vh', overflowY:'auto', overflowX:'hidden',
      background:C.bg, fontFamily:C.ui, position:'relative',
    }}>
      <style>{CSS}</style>
      <BgGrid3D/>
      <Nav/>
      <Ticker/>

      {/* ── HERO ─────────────────────────────────────────────────── */}
      <div style={{
        position:'relative', zIndex:1,
        display:'flex', minHeight:'calc(100vh - 82px)',
      }}>
        {/* Left — copy + signal preview */}
        <div style={{
          flex:1, padding:'52px 56px 48px',
          display:'flex', flexDirection:'column', justifyContent:'center',
        }}>
          {/* Badge */}
          <div className="fu" style={{
            display:'inline-flex', alignItems:'center', gap:7,
            background:'rgba(56,189,248,.09)', border:`1px solid rgba(56,189,248,.2)`,
            borderRadius:20, padding:'5px 15px', width:'fit-content', marginBottom:24,
            boxShadow:'0 0 20px rgba(56,189,248,.08)',
          }}>
            <div style={{ width:6, height:6, borderRadius:'50%', background:C.ac,
                          boxShadow:`0 0 10px ${C.ac}`, animation:'blink 1.8s infinite' }}/>
            <span style={{ fontSize:9, color:C.ac, fontFamily:C.ui, fontWeight:700, letterSpacing:.6 }}>
              INDIA'S INSTITUTIONAL TRADING INTELLIGENCE PLATFORM
            </span>
          </div>

          {/* Headline */}
          <h1 className="fu1" style={{
            fontSize:'clamp(26px,2.9vw,42px)', fontWeight:900,
            fontFamily:C.ui, letterSpacing:-1.2, lineHeight:1.1, margin:'0 0 20px',
          }}>
            <span style={{ color:C.tx }}>Trade smarter with</span><br/>
            <span style={{
              background:'linear-gradient(135deg, #38BDF8 0%, #818CF8 40%, #A855F7 70%, #00D9A3 100%)',
              WebkitBackgroundClip:'text', WebkitTextFillColor:'transparent',
              filter:'drop-shadow(0 0 20px rgba(56,189,248,.3))',
            }}>
              AI-powered signals
            </span><br/>
            <span style={{ color:C.tx }}>&amp; real-time intelligence</span>
          </h1>

          {/* Sub */}
          <p className="fu2" style={{
            fontSize:14, color:C.mu, fontFamily:C.ui, lineHeight:1.8,
            margin:'0 0 28px', maxWidth:520,
          }}>
            TradeX Terminal combines multi-agent AI, live NSE/BSE data, FII/DII flows,
            India VIX, and crypto derivatives intelligence into one unified platform —
            built for professional traders and fund managers.
          </p>

          {/* Stats */}
          <div className="fu2" style={{ display:'flex', gap:10, marginBottom:32, flexWrap:'wrap' }}>
            <StatPill val="150+" label="Symbols Tracked"  color={C.ac}   icon={ICONS.signal(12)}/>
            <StatPill val="24/7" label="Monitoring"       color={C.bull} icon={ICONS.activity(12)}/>
            <StatPill val="6"    label="AI Agents Active" color={C.cy}   icon={ICONS.cpu(12)}/>
            <StatPill val="~84%" label="Signal Accuracy"  color={C.amb}  icon={ICONS.target(12)}/>
          </div>

          {/* Signal preview */}
          <div className="fu3">
            <div style={{
              fontSize:9, color:C.di, fontFamily:C.ui, fontWeight:700,
              letterSpacing:.6, marginBottom:10, textTransform:'uppercase',
            }}>
              Platform preview — signal intelligence
            </div>
            <SignalTable/>
          </div>
        </div>

        {/* Right — 3D login card */}
        <div style={{
          width:380, flexShrink:0, display:'flex', flexDirection:'column',
          justifyContent:'center', padding:'32px 36px',
          borderLeft:`1px solid ${C.bd}`,
          background:'linear-gradient(180deg, rgba(6,12,24,.92) 0%, rgba(2,4,10,.96) 100%)',
          backdropFilter:'blur(24px)',
        }}>
          <div className="fu" style={{ width:'100%' }}>
            <LoginCard/>
          </div>

          {/* Floating rings */}
          <div style={{ marginTop:24, display:'flex', justifyContent:'center', position:'relative', height:40 }}>
            {[
              { sz:36, color:C.ac,   dur:'8s',  del:'0s'  },
              { sz:26, color:C.pu,   dur:'6s',  del:'-2s' },
              { sz:18, color:C.bull, dur:'10s', del:'-4s' },
            ].map(({sz,color,dur,del},i)=>(
              <div key={i} style={{
                position:'absolute',
                width:sz, height:sz, borderRadius:'50%',
                border:`1px solid ${color}40`,
                top:'50%', left:`calc(50% + ${(i-1)*20}px)`,
                transform:'translate(-50%, -50%)',
                animation:`spinSlow ${dur} linear ${del} infinite`,
                boxShadow:`0 0 ${sz*0.6}px ${color}20`,
              }}/>
            ))}
          </div>

          {/* Trust badges */}
          <div style={{ marginTop:18 }}>
            <div style={{
              fontSize:8, color:C.di, fontFamily:C.ui, textAlign:'center',
              letterSpacing:.6, marginBottom:10, fontWeight:700,
            }}>SECURED WITH</div>
            <div style={{ display:'flex', justifyContent:'center', gap:8 }}>
              {['Supabase Auth','TLS 1.3','SOC 2'].map(b=>(
                <div key={b} style={{
                  padding:'4px 10px',
                  background:'rgba(56,189,248,.05)', border:`1px solid ${C.bd}`,
                  borderRadius:5, fontSize:8, color:C.mu, fontFamily:C.ui, fontWeight:600,
                }}>{b}</div>
              ))}
            </div>
          </div>
        </div>
      </div>

      {/* ── FEATURE SECTIONS ──────────────────────────────────────── */}

      {/* 01 · MARKET NEWS */}
      <Section accent={C.cy}>
        <div style={{ display:'grid', gridTemplateColumns:'1fr 1.1fr', gap:64, alignItems:'center' }}>
          <div>
            <SecHdr num="01" label="Market News" color={C.cy}
              title={<>Every market-moving headline<br/><span style={{ color:C.cy }}>classified in real time</span></>}/>
            <p style={{ fontSize:14, color:C.mu, fontFamily:C.ui, lineHeight:1.8, marginBottom:28, maxWidth:420 }}>
              TradeX pulls from 6 financial RSS sources simultaneously — Economic Times, Moneycontrol,
              Business Standard, LiveMint, CNBC-TV18, and Bloomberg Quint — and runs every headline
              through a Gemini Flash LLM to classify it as <span style={{ color:C.bull }}>bullish</span>,{' '}
              <span style={{ color:C.bear }}>bearish</span>, or neutral.
            </p>
            <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:8 }}>
              <Chip icon={ICONS.rss(14)}          text="6 live RSS feeds"            color={C.cy}/>
              <Chip icon={ICONS.network(14)}       text="Gemini Flash LLM classifier" color={C.pu}/>
              <Chip icon={ICONS.target(14)}        text="Per-symbol headline matching" color={C.bull}/>
              <Chip icon={ICONS.zap(14)}           text="<2 sec classification time"  color={C.amb}/>
              <Chip icon={ICONS.building(14)}      text="NSE / BSE announcements"     color={C.ac}/>
              <Chip icon={ICONS.bell(14)}          text="HIGH / MEDIUM / LOW impact"  color={C.bear}/>
            </div>
          </div>
          <NewsMock/>
        </div>
      </Section>

      {/* 02 · AI TRADING SIGNALS */}
      <Section alt accent={C.bull}>
        <div style={{ display:'grid', gridTemplateColumns:'1.1fr 1fr', gap:64, alignItems:'center' }}>
          <div>
            <SignalTable/>
            <div style={{ display:'flex', gap:8, marginTop:14, flexWrap:'wrap' }}>
              {[{l:'STRONG BUY',c:'#00E5B0'},{l:'BUY',c:C.bull},{l:'HOLD',c:C.amb},{l:'SELL',c:C.bear},{l:'STRONG SELL',c:'#C0392B'}].map(({l,c})=>(
                <div key={l} style={{
                  display:'inline-flex', alignItems:'center', gap:5,
                  background:`${c}10`, border:`1px solid ${c}25`,
                  borderRadius:4, padding:'3px 9px',
                }}>
                  <div style={{ width:4, height:4, borderRadius:'50%', background:c, boxShadow:`0 0 5px ${c}` }}/>
                  <span style={{ fontSize:9, fontWeight:700, color:c, fontFamily:C.font }}>{l}</span>
                </div>
              ))}
            </div>
          </div>
          <div>
            <SecHdr num="02" label="AI Trading Signals" color={C.bull}
              title={<>High-conviction signals —<br/><span style={{ color:C.bull }}>not noise, not alerts</span></>}/>
            <p style={{ fontSize:14, color:C.mu, fontFamily:C.ui, lineHeight:1.8, marginBottom:28, maxWidth:420 }}>
              TradeX's Random Forest + Dynamic Weighting engine fuses price action, volume,
              technical indicators, and sentiment scores. Only signals with high confidence
              across multiple timeframes reach your dashboard.
            </p>
            <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:8 }}>
              <Chip icon={ICONS.gitBranch(14)}  text="Random Forest classifier"   color={C.bull}/>
              <Chip icon={ICONS.sliders(14)}    text="Dynamic weighting model"    color={C.cy}/>
              <Chip icon={ICONS.layers(14)}     text="Multi-timeframe confluence" color={C.ac}/>
              <Chip icon={ICONS.barChart(14)}   text="Volume confirmation filter" color={C.pu}/>
              <Chip icon={ICONS.target(14)}     text="~84% historical accuracy"   color={C.amb}/>
              <Chip icon={ICONS.refresh(14)}    text="5-minute refresh cycle"     color={C.ind}/>
            </div>
          </div>
        </div>
      </Section>

      {/* 03 · AGENTIC ANALYSIS */}
      <Section accent={C.pu}>
        <div style={{ display:'grid', gridTemplateColumns:'1fr 1.1fr', gap:64, alignItems:'start' }}>
          <div>
            <SecHdr num="03" label="Agentic Analysis System" color={C.pu}
              title={<>6 autonomous AI agents<br/><span style={{ color:C.pu }}>working in parallel, 24/7</span></>}/>
            <p style={{ fontSize:14, color:C.mu, fontFamily:C.ui, lineHeight:1.8, marginBottom:28, maxWidth:420 }}>
              Each agent runs on its own schedule, fetches its own data, and writes results to
              a shared state store. The Signal Engine aggregates all agent outputs before generating
              a final recommendation.
            </p>
            <div style={{ display:'flex', flexDirection:'column', gap:0 }}>
              {[
                {icon:ICONS.barChart(14),    step:'DATA INGESTION',   desc:'Price, volume, OHLCV, FII/DII, VIX',          c:C.ac},
                {icon:ICONS.rss(14),         step:'SENTIMENT LAYER',  desc:'News classification per symbol + market-wide', c:C.cy},
                {icon:ICONS.candlestick(14), step:'TECHNICAL LAYER',  desc:'20+ chart patterns + indicator confluence',    c:C.pu},
                {icon:ICONS.fileText(14),    step:'FUNDAMENTAL LAYER',desc:'P/E, ROE, growth, debt ratios — daily',        c:C.amb},
                {icon:ICONS.network(14),     step:'SIGNAL SYNTHESIS', desc:'RF/DW engine fuses all layers → BUY/SELL',     c:C.bull},
                {icon:ICONS.shield(14),      step:'RISK GATE',        desc:'Guardian validates signal vs. portfolio risk', c:C.bear},
              ].map(({icon,step,desc,c},i)=>(
                <div key={i} style={{ display:'flex', gap:12, position:'relative' }}>
                  {i<5 && <div style={{ position:'absolute', left:16, top:36, width:1, height:'100%', background:C.bd, zIndex:0 }}/>}
                  <div style={{
                    width:32, height:32, borderRadius:'50%', background:`${c}14`,
                    border:`1px solid ${c}30`, display:'flex', alignItems:'center',
                    justifyContent:'center', flexShrink:0, zIndex:1,
                    margin:'10px 0', boxShadow:`0 0 12px ${c}20`, color:c,
                  }}>{icon}</div>
                  <div style={{ padding:'10px 0', flex:1 }}>
                    <div style={{ fontSize:9, fontWeight:700, color:c, fontFamily:C.ui, letterSpacing:.7, textTransform:'uppercase' }}>{step}</div>
                    <div style={{ fontSize:11, color:C.mu, fontFamily:C.ui, marginTop:2 }}>{desc}</div>
                  </div>
                </div>
              ))}
            </div>
          </div>
          <div>
            <div style={{ fontSize:9, color:C.di, fontFamily:C.ui, fontWeight:700, letterSpacing:.6, textTransform:'uppercase', marginBottom:12 }}>
              Agent status monitor — all 6 agents active
            </div>
            <AgentPipeline/>
          </div>
        </div>
      </Section>

      {/* 04 · INDIA MARKET INTELLIGENCE */}
      <Section alt accent={C.ac}>
        <div style={{ display:'grid', gridTemplateColumns:'1.1fr 1fr', gap:64, alignItems:'start' }}>
          <div>
            <SectorHeat/>
            <div style={{ display:'grid', gridTemplateColumns:'repeat(3,1fr)', gap:8, marginTop:14 }}>
              {[
                {l:'NIFTY 50',  v:'24,765', c:'+0.82%', col:C.bull},
                {l:'BANK NIFTY',v:'52,140', c:'-0.14%', col:C.bear},
                {l:'INDIA VIX', v:'13.8',   c:'-5.2%',  col:C.bull},
              ].map(({l,v,c,col})=>(
                <div key={l} style={{ background:C.bgC, border:`1px solid ${C.bd}`, borderRadius:10, padding:'10px 12px' }}>
                  <div style={{ fontSize:8, color:C.mu, fontFamily:C.ui, fontWeight:600, letterSpacing:.5, marginBottom:4 }}>{l}</div>
                  <div style={{ fontSize:16, fontWeight:800, color:C.tx, fontFamily:C.font }}>{v}</div>
                  <div style={{ fontSize:9, fontWeight:700, color:col, fontFamily:C.font, marginTop:2 }}>
                    {col===C.bull?'▲':'▼'} {c}
                  </div>
                </div>
              ))}
            </div>
          </div>
          <div>
            <SecHdr num="04" label="India Market Intelligence" color={C.ac}
              title={<>Complete NSE / BSE<br/><span style={{ color:C.ac }}>coverage in one view</span></>}/>
            <p style={{ fontSize:14, color:C.mu, fontFamily:C.ui, lineHeight:1.8, marginBottom:28, maxWidth:420 }}>
              Real-time Nifty 50, Bank Nifty, Sensex, Midcap 100, and Smallcap 100 data alongside
              India VIX and all 8 NSE sector indices — with a colour-coded heatmap.
            </p>
            <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:8 }}>
              <Chip icon={ICONS.flag(14)}      text="150+ NSE / BSE symbols"     color={C.ac}/>
              <Chip icon={ICONS.gauge(14)}     text="India VIX with signal"       color={C.amb}/>
              <Chip icon={ICONS.building(14)}  text="FII / DII institutional flows" color={C.bull}/>
              <Chip icon={ICONS.grid(14)}      text="8 sector heatmap"            color={C.cy}/>
              <Chip icon={ICONS.trendUp(14)}   text="Sensex · Midcap · Smallcap"  color={C.pu}/>
              <Chip icon={ICONS.trendDown(14)} text="52-week high / low tracking"  color={C.bear}/>
            </div>
          </div>
        </div>
      </Section>

      {/* 05 · RISK ENGINE */}
      <Section accent={C.bear}>
        <div style={{ display:'grid', gridTemplateColumns:'1fr 1.1fr', gap:64, alignItems:'start' }}>
          <div>
            <SecHdr num="05" label="Risk Engine" color={C.bear}
              title={<>Real-time portfolio protection —<br/><span style={{ color:C.bear }}>before losses become drawdowns</span></>}/>
            <p style={{ fontSize:14, color:C.mu, fontFamily:C.ui, lineHeight:1.8, marginBottom:28, maxWidth:420 }}>
              The Risk Guardian agent monitors every open position in real time. It tracks unrealized P&L,
              correlation between positions, and portfolio drawdown — and can trigger an automatic
              kill-switch via broker API.
            </p>
            <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:8 }}>
              <Chip icon={ICONS.barChart(14)}      text="Per-position P&L monitoring"    color={C.bear}/>
              <Chip icon={ICONS.alertTriangle(14)} text="Drawdown threshold alerts"       color={C.amb}/>
              <Chip icon={ICONS.link(14)}          text="Correlated risk detection"       color={C.pu}/>
              <Chip icon={ICONS.zap(14)}           text="Auto kill-switch via broker API" color={C.bear}/>
              <Chip icon={ICONS.pieChart(14)}      text="Portfolio exposure breakdown"    color={C.ac}/>
              <Chip icon={ICONS.trendDown(14)}     text="Real-time unrealized P&L"        color={C.bull}/>
            </div>
          </div>
          <RiskMock/>
        </div>
      </Section>

      {/* ── FOOTER ────────────────────────────────────────────────── */}
      <footer style={{
        borderTop:`1px solid ${C.bd}`, padding:'28px 64px',
        position:'relative', zIndex:1,
        display:'flex', alignItems:'center', justifyContent:'space-between',
        background:'rgba(2,4,10,0.85)', backdropFilter:'blur(20px)',
      }}>
        <div style={{ display:'flex', alignItems:'center', gap:10 }}>
          <div style={{
            width:28, height:28, borderRadius:7,
            background:'linear-gradient(135deg, #0EA5E9, #818CF8)',
            display:'flex', alignItems:'center', justifyContent:'center',
            boxShadow:'0 0 14px rgba(14,165,233,.3)',
          }}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
              <polyline points="3,17 8,10 12,13 17,6" stroke="white" strokeWidth="2.5"
                        strokeLinecap="round" strokeLinejoin="round"/>
              <polyline points="17,6 21,6 21,10" stroke="white" strokeWidth="2.5"
                        strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
          </div>
          <span style={{ fontSize:11, fontWeight:600, color:C.mu, fontFamily:C.ui }}>
            TradeX Terminal — Institutional trading intelligence for Indian &amp; global markets
          </span>
        </div>
        <div style={{ display:'flex', gap:8 }}>
          {['Supabase Auth','TLS 1.3','SOC 2'].map(b=>(
            <div key={b} style={{
              padding:'3px 9px',
              background:'rgba(56,189,248,.04)', border:`1px solid ${C.bd}`,
              borderRadius:4, fontSize:8, color:C.mu, fontFamily:C.ui, fontWeight:600,
            }}>{b}</div>
          ))}
        </div>
      </footer>
    </div>
  )
}
