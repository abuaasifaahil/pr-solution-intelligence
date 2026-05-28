import type { Config } from 'tailwindcss';

const config: Config = {
  content: ['./app/**/*.{ts,tsx}', './components/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // Windows 11 Fluent — primary palette
        'win-blue': {
          50:  '#EBF3FE',
          100: '#D5E8FC',
          200: '#A8D0FA',
          300: '#6CB4F5',
          400: '#3A96F0',
          500: '#0078D4',
          600: '#005EA8',
          700: '#004578',
          800: '#003054',
          900: '#001D33',
        },
        'win-teal':   '#00B7C3',
        'win-green':  '#107C10',
        'win-red':    '#D13438',
        'win-orange': '#CA5010',
        'win-purple': '#7B2F8A',
        // Surfaces
        'surface-base':    '#F5F5F5',
        'surface-card':    '#FFFFFF',
        'surface-sidebar': '#F0F0F0',
        'surface-hover':   '#E8E8E8',
        'surface-active':  '#DFDFDF',
        // Text
        'text-primary':   '#1A1A1A',
        'text-secondary': '#616161',
        'text-tertiary':  '#8E8E8E',
        'text-inverse':   '#FFFFFF',
        'border-default': '#E0E0E0',
        'border-subtle':  '#F0F0F0',
      },
      fontFamily: {
        sans: ['"DM Sans"', '"Segoe UI Variable"', '"Segoe UI"', 'system-ui', 'sans-serif'],
        mono: ['"Cascadia Code"', '"Fira Code"', '"JetBrains Mono"', 'monospace'],
      },
      borderRadius: {
        sm: '4px', md: '8px', lg: '12px', xl: '16px',
      },
      boxShadow: {
        'win-2':  '0 1px 2px rgba(0,0,0,0.06), 0 1px 3px rgba(0,0,0,0.1)',
        'win-4':  '0 2px 4px rgba(0,0,0,0.04), 0 4px 8px rgba(0,0,0,0.08)',
        'win-8':  '0 4px 8px rgba(0,0,0,0.04), 0 8px 16px rgba(0,0,0,0.08)',
        'win-16': '0 8px 16px rgba(0,0,0,0.06), 0 16px 32px rgba(0,0,0,0.1)',
        'win-64': '0 16px 32px rgba(0,0,0,0.08), 0 32px 64px rgba(0,0,0,0.12)',
      },
      transitionTimingFunction: {
        'win-smooth': 'cubic-bezier(0.25, 0.1, 0.25, 1.0)',
        'win-decel':  'cubic-bezier(0, 0, 0, 1)',
      },
    },
  },
  plugins: [],
};

export default config;
