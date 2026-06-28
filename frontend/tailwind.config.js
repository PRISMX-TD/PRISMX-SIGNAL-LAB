/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // 黑紫主题 / black & purple theme
        ink: {
          950: '#070509',
          900: '#0b0810',
          850: '#110c1a',
          800: '#171022',
          700: '#1f1730',
          600: '#2a2042',
        },
        prism: {
          300: '#c4a8ff',
          400: '#a779ff',
          500: '#8b46ff',
          600: '#7a2fff',
          700: '#6320d6',
        },
        glow: '#b388ff',
        up: '#2fe6a0',
        down: '#ff4d6d',
      },
      fontFamily: {
        display: ['Orbitron', 'Space Grotesk', 'sans-serif'],
        sans: ['Sora', 'system-ui', 'sans-serif'],
        mono: ['"JetBrains Mono"', 'ui-monospace', 'monospace'],
      },
      boxShadow: {
        prism: '0 0 24px rgba(139, 70, 255, 0.35)',
        'prism-lg': '0 0 48px rgba(139, 70, 255, 0.45)',
      },
      backgroundImage: {
        'prism-grid':
          'linear-gradient(rgba(139,70,255,0.06) 1px, transparent 1px), linear-gradient(90deg, rgba(139,70,255,0.06) 1px, transparent 1px)',
      },
      keyframes: {
        breathe: {
          '0%, 100%': { opacity: '1' },
          '50%': { opacity: '0.35' },
        },
        'fade-in-up': {
          '0%': { opacity: '0', transform: 'translateY(8px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
        'glow-pulse': {
          '0%, 100%': { boxShadow: '0 0 16px rgba(139,70,255,0.3)' },
          '50%': { boxShadow: '0 0 32px rgba(139,70,255,0.6)' },
        },
      },
      animation: {
        breathe: 'breathe 2s ease-in-out infinite',
        'fade-in-up': 'fade-in-up 0.4s ease-out both',
        'glow-pulse': 'glow-pulse 2.5s ease-in-out infinite',
      },
    },
  },
  plugins: [],
}
