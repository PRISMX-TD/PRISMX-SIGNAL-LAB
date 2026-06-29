/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // 黑紫主题 / black & purple theme
        ink: {
          950: '#050307',
          900: '#0a0710',
          850: '#0f0a18',
          800: '#150e22',
          700: '#1d152e',
          600: '#2a2042',
        },
        prism: {
          300: '#cbb4ff',
          400: '#a779ff',
          500: '#8b46ff',
          600: '#7a2fff',
          700: '#6320d6',
        },
        // neon 强调色 / neon accents
        neon: {
          violet: '#b388ff',
          cyan: '#33e1ff',
          pink: '#ff4ddb',
          lime: '#9dff5b',
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
        'neon-cyan': '0 0 24px rgba(51, 225, 255, 0.45)',
        'neon-pink': '0 0 24px rgba(255, 77, 219, 0.45)',
        // 液态玻璃：外发光 + 内高光 / liquid glass: outer glow + inner highlight
        glass: '0 8px 32px rgba(0, 0, 0, 0.45), inset 0 1px 0 rgba(255, 255, 255, 0.08)',
        'glass-lg':
          '0 24px 60px rgba(0, 0, 0, 0.55), 0 0 40px rgba(139, 70, 255, 0.18), inset 0 1px 0 rgba(255, 255, 255, 0.10)',
      },
      backgroundImage: {
        'prism-grid':
          'linear-gradient(rgba(139,70,255,0.06) 1px, transparent 1px), linear-gradient(90deg, rgba(139,70,255,0.06) 1px, transparent 1px)',
        'neon-gradient':
          'linear-gradient(120deg, #33e1ff 0%, #8b46ff 45%, #ff4ddb 100%)',
        'glass-sheen':
          'linear-gradient(135deg, rgba(255,255,255,0.12) 0%, rgba(255,255,255,0.02) 40%, rgba(255,255,255,0) 60%)',
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
        float: {
          '0%, 100%': { transform: 'translateY(0)' },
          '50%': { transform: 'translateY(-18px)' },
        },
        'float-slow': {
          '0%, 100%': { transform: 'translate(0, 0)' },
          '50%': { transform: 'translate(20px, -24px)' },
        },
        'gradient-x': {
          '0%, 100%': { backgroundPosition: '0% 50%' },
          '50%': { backgroundPosition: '100% 50%' },
        },
        shimmer: {
          '0%': { transform: 'translateX(-150%)' },
          '100%': { transform: 'translateX(150%)' },
        },
        marquee: {
          '0%': { transform: 'translateX(0)' },
          '100%': { transform: 'translateX(-50%)' },
        },
      },
      animation: {
        breathe: 'breathe 2s ease-in-out infinite',
        'fade-in-up': 'fade-in-up 0.5s ease-out both',
        'glow-pulse': 'glow-pulse 2.5s ease-in-out infinite',
        float: 'float 6s ease-in-out infinite',
        'float-slow': 'float-slow 11s ease-in-out infinite',
        'gradient-x': 'gradient-x 6s ease infinite',
        shimmer: 'shimmer 2.5s ease-in-out infinite',
        marquee: 'marquee 30s linear infinite',
      },
    },
  },
  plugins: [],
}
