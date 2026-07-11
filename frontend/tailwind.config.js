/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // 设计稿主色调 / design token colors
        ink: {
          950: '#06040b',
          900: '#08050e',
          850: '#0d0918',
          800: '#150e22',
          700: '#1d152e',
          600: '#2a2042',
        },
        prism: {
          200: '#e9d5ff',
          300: '#a78bfa',
          400: '#a855f7',
          500: '#8b5cf6',
          600: '#7c3aed',
          700: '#6d28d9',
        },
        // 强调色 / accent colors
        neon: {
          violet: '#a78bfa',
          cyan: '#33e1ff',
          pink: '#ff4ddb',
          lime: '#9dff5b',
        },
        glow: '#a78bfa',
        up: '#2ee07e',
        down: '#ff4d67',
        // 设计稿语义色 / design semantic colors
        card: 'rgba(255,255,255,0.065)',
        line: 'rgba(255,255,255,0.09)',
      },
      fontFamily: {
        display: ['"Space Grotesk"', 'Orbitron', 'sans-serif'],
        sans: ['"Space Grotesk"', 'Sora', 'system-ui', 'sans-serif'],
        mono: ['"JetBrains Mono"', 'ui-monospace', 'monospace'],
      },
      // 统一圆角规范 / unified radius tokens: card 18 / inner 12 / pill 10
      borderRadius: {
        card: '18px',
        inner: '12px',
        pill: '10px',
      },
      boxShadow: {
        prism: '0 0 24px rgba(139, 92, 246, 0.35)',
        'prism-lg': '0 0 48px rgba(139, 92, 246, 0.45)',
        'neon-cyan': '0 0 24px rgba(51, 225, 255, 0.45)',
        'neon-pink': '0 0 24px rgba(255, 77, 219, 0.45)',
        // 液态玻璃：外发光 + 内高光 / liquid glass: outer glow + inner highlight
        glass: '0 12px 32px rgba(0, 0, 0, 0.35), inset 0 1px 0 rgba(255, 255, 255, 0.10)',
        'glass-lg':
          '0 24px 60px rgba(0, 0, 0, 0.55), 0 0 40px rgba(139, 92, 246, 0.18), inset 0 1px 0 rgba(255, 255, 255, 0.10)',
      },
      backgroundImage: {
        'prism-grid':
          'linear-gradient(rgba(139,92,246,0.06) 1px, transparent 1px), linear-gradient(90deg, rgba(139,92,246,0.06) 1px, transparent 1px)',
        // 收敛为紫系单义渐变：品牌/交互统一用紫 / converged to purple-only brand gradient
        'neon-gradient':
          'linear-gradient(120deg, #a855f7 0%, #7c3aed 55%, #a78bfa 100%)',
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
        drift: {
          '0%, 100%': { transform: 'translate(0, 0) scale(1)' },
          '25%': { transform: 'translate(2%, -1.5%) scale(1.04)' },
          '50%': { transform: 'translate(-1%, 1%) scale(1.02)' },
          '75%': { transform: 'translate(1.5%, 0.5%) scale(1.03)' },
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
        drift: 'drift 18s ease-in-out infinite',
        'drift-slow': 'drift 24s ease-in-out infinite',
      },
    },
  },
  plugins: [],
}
