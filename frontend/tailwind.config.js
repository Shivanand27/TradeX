/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,jsx}'],
  theme: {
    extend: {
      fontFamily: {
        mono: ['"IBM Plex Mono"', 'monospace'],
        sans: ['"IBM Plex Sans"', 'sans-serif'],
      },
      colors: {
        terminal: {
          bg:     '#060809',
          bg2:    '#0a0d10',
          bg3:    '#0f1317',
          bg4:    '#14191f',
          bg5:    '#1a2028',
          bd:     '#1f2830',
          bd2:    '#2a3540',
          amber:  '#ff8c00',
          amber2: '#cc7000',
          adim:   '#7a4200',
          cyan:   '#00d4ff',
          cyan2:  '#009abf',
          green:  '#00e676',
          green2: '#00a854',
          red:    '#ff3b4e',
          red2:   '#c02030',
          yellow: '#ffd600',
          mag:    '#e040fb',
          t1:     '#c8d8e8',
          t2:     '#6a8099',
          t3:     '#334455',
        }
      },
      animation: {
        'pulse-slow': 'pulse 1.6s ease-in-out infinite',
        'blink':      'blink 1.3s ease-in-out infinite',
      },
      keyframes: {
        blink: {
          '0%, 100%': { opacity: 1 },
          '50%':      { opacity: 0.15 },
        }
      }
    }
  },
  plugins: []
}
