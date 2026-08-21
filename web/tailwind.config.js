/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: {
        brand: {
          50:'#eef4ff',100:'#dae6ff',200:'#bdd2ff',300:'#90b3ff',400:'#5c88fb',
          500:'#3663f3',600:'#2043e8',700:'#1a34d5',800:'#1c2eac',900:'#1d2d88',950:'#151d53',
        },
        surface: {
          DEFAULT:'#ffffff', muted:'#f7f8fa', border:'#e4e7ec', hover:'#f1f3f7',
        },
      },
      fontFamily: {
        sans: ['Inter','ui-sans-serif','system-ui','-apple-system','Segoe UI','Roboto','sans-serif'],
        mono: ['ui-monospace','SFMono-Regular','Menlo','monospace'],
      },
      boxShadow: {
        card: '0 1px 2px 0 rgb(16 24 40 / 0.04), 0 1px 3px 0 rgb(16 24 40 / 0.06)',
        popover: '0 8px 24px -4px rgb(16 24 40 / 0.12), 0 4px 8px -4px rgb(16 24 40 / 0.06)',
      },
      keyframes: {
        'fade-in': { '0%': { opacity:'0', transform:'translateY(2px)' }, '100%': { opacity:'1', transform:'none' } },
      },
      animation: { 'fade-in': 'fade-in .18s ease-out' },
    },
  },
  plugins: [],
}
