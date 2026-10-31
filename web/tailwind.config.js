import { colors, brand, statusColors, fontFamily, fontSize } from './src/theme/designTokens.js';
/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: {
        brand,
        ink: { DEFAULT: colors.text, heading: colors.navy, secondary: colors.secondary },
        status: statusColors,
        surface: {
          DEFAULT: colors.surface, canvas: colors.canvas, muted: colors.content,
          hover: colors.hover, border: colors.border, divider: colors.divider,
          sidebar: colors.sidebar, header: colors.header, input: colors.input,
        },
      },
      fontSize,
      fontFamily: {
        sans: fontFamily,
        mono: ['ui-monospace', 'SFMono-Regular', 'Menlo', 'monospace'],
      },
      boxShadow: {
        subtle: '0 1px 2px 0 rgba(0, 0, 0, 0.03)',
        card: '0 1px 3px 0 rgba(0, 0, 0, 0.04), 0 1px 2px -1px rgba(0, 0, 0, 0.02)',
        'card-hover': '0 4px 6px -1px rgba(0, 0, 0, 0.05), 0 2px 4px -2px rgba(0, 0, 0, 0.03)',
        popover: '0 10px 25px -5px rgba(0, 0, 0, 0.08), 0 8px 10px -6px rgba(0, 0, 0, 0.04)',
      },
      keyframes: {
        'fade-in': { '0%': { opacity:'0', transform:'translateY(2px)' }, '100%': { opacity:'1', transform:'none' } },
      },
      animation: { 'fade-in': 'fade-in .18s ease-out' },
    },
  },
  plugins: [],
}
