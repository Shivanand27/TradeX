// Design system — two themes: modern (default) and bloomberg (classic)
export const themes = {
  modern: {
    name: 'modern',

    // ── Backgrounds ─────────────────────────────────────────────
    bg:        '#09090B',   // deepest app background
    bgPanel:   '#0F0F13',   // panel / card surface
    bgCard:    '#141418',   // elevated card
    bgRow:     '#1A1A22',   // table row / list item
    bgActive:  '#1E2535',   // selected / hover state
    bgInput:   '#141418',   // input fields
    bgGrid:    '#27272E',   // grid lines
    bgSidebar: '#0C0C10',   // sidebar

    // ── Borders ──────────────────────────────────────────────────
    border:       'rgba(255,255,255,0.06)',
    borderAccent: '#3B82F6',
    borderHover:  'rgba(255,255,255,0.12)',
    borderStrong: 'rgba(255,255,255,0.16)',

    // ── Text ─────────────────────────────────────────────────────
    text:        '#F1F5F9',  // slate-100
    textMuted:   '#94A3B8',  // slate-400
    textDim:     '#475569',  // slate-600
    textInverse: '#09090B',

    // ── Primary accent ───────────────────────────────────────────
    accent:     '#3B82F6',  // blue-500
    accentBg:   'rgba(59,130,246,0.10)',
    accentGrad: 'linear-gradient(135deg,#3B82F6 0%,#8B5CF6 100%)',
    accentHover:'#2563EB',

    // ── Trading colours ──────────────────────────────────────────
    bull:    '#10B981',  // emerald-500
    bear:    '#EF4444',  // red-500
    cyan:    '#06B6D4',  // cyan-500
    amber:   '#F59E0B',  // amber-500
    purple:  '#8B5CF6',  // violet-500
    bullBg:  'rgba(16,185,129,0.08)',
    bearBg:  'rgba(239,68,68,0.08)',

    // ── Logo / brand ─────────────────────────────────────────────
    logoText: '#FFFFFF',
    logoBg:   'linear-gradient(135deg,#3B82F6 0%,#8B5CF6 100%)',

    // ── Effects ──────────────────────────────────────────────────
    glowAccent: '0 0 24px rgba(59,130,246,0.30)',
    glowBull:   '0 0 16px rgba(16,185,129,0.28)',
    glowBear:   '0 0 16px rgba(239,68,68,0.28)',
    panelGlass: 'blur(16px) saturate(160%)',

    // ── Shadows ──────────────────────────────────────────────────
    shadowSm:   '0 1px 4px rgba(0,0,0,0.55)',
    shadowMd:   '0 4px 16px rgba(0,0,0,0.55)',
    shadowLg:   '0 8px 40px rgba(0,0,0,0.65)',
    shadowCard: '0 2px 8px rgba(0,0,0,0.45), inset 0 1px 0 rgba(255,255,255,0.04)',

    // ── Shape ────────────────────────────────────────────────────
    radius:   6,
    radiusLg: 12,
    radiusSm: 3,

    // ── Typography ───────────────────────────────────────────────
    font:     '"IBM Plex Mono","JetBrains Mono",monospace',
    fontUI:   '"Inter","IBM Plex Sans",system-ui,sans-serif',
    fontSans: '"Inter","IBM Plex Sans",system-ui,sans-serif',

    // ── Helpers ──────────────────────────────────────────────────
    headerGrad:  'linear-gradient(180deg,rgba(59,130,246,0.06) 0%,transparent 100%)',
    panelBorder: '1px solid rgba(255,255,255,0.06)',
    accentBorder:'1px solid #3B82F6',
  },

  bloomberg: {
    name: 'bloomberg',

    bg:        '#060809',
    bgPanel:   '#0a0d10',
    bgCard:    '#0f1317',
    bgRow:     '#0f1317',
    bgActive:  '#14191f',
    bgInput:   '#14191f',
    bgGrid:    '#1f2830',
    bgSidebar: '#080b0e',

    border:       '#1f2830',
    borderAccent: '#ff8c00',
    borderHover:  '#2a3540',
    borderStrong: '#334455',

    text:        '#c8d8e8',
    textMuted:   '#6a8099',
    textDim:     '#334455',
    textInverse: '#000',

    accent:     '#ff8c00',
    accentBg:   'rgba(255,140,0,.10)',
    accentGrad: '#ff8c00',
    accentHover:'#e07a00',

    bull:    '#00e676',
    bear:    '#ff3b4e',
    cyan:    '#00d4ff',
    amber:   '#f5a523',
    purple:  '#e040fb',
    bullBg:  'rgba(0,230,118,.10)',
    bearBg:  'rgba(255,59,78,.15)',

    logoText: '#000',
    logoBg:   '#ff8c00',

    glowAccent: 'none',
    glowBull:   'none',
    glowBear:   'none',
    panelGlass: 'none',

    shadowSm:   'none',
    shadowMd:   'none',
    shadowLg:   'none',
    shadowCard: 'none',

    radius:   2,
    radiusLg: 3,
    radiusSm: 1,

    font:     '"IBM Plex Mono",monospace',
    fontUI:   '"IBM Plex Sans",sans-serif',
    fontSans: '"IBM Plex Sans",sans-serif',

    headerGrad:  '#0f1317',
    panelBorder: '1px solid #1f2830',
    accentBorder:'1px solid #ff8c00',
  },
}
