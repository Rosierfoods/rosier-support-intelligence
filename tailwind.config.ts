import type { Config } from 'tailwindcss';

const config: Config = {
  content: ['./src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        brand: { DEFAULT: '#784900', 600: '#784900', 500: '#A56312', 100: '#F3EBDD', 50: '#FAF6EE' },
        sand: '#E7E0CE',
        canvas: '#FBF9F5',
        ink: { DEFAULT: '#2A2219', muted: '#6B6258', faint: '#9A9186' },
        line: '#E8E2D6',
      },
      fontFamily: { sans: ['var(--font-poppins)', 'system-ui', 'sans-serif'] },
      boxShadow: { card: '0 1px 2px rgba(42,34,25,0.04), 0 1px 1px rgba(42,34,25,0.03)' },
      fontSize: { '2xs': ['0.6875rem', '1rem'] },
    },
  },
  plugins: [],
};
export default config;
