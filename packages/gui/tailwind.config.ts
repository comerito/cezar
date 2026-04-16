import type { Config } from 'tailwindcss';

const config: Config = {
  darkMode: 'class',
  content: ['./src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        bg: {
          DEFAULT: 'hsl(220 14% 8%)',
          elevated: 'hsl(220 14% 11%)',
          subtle: 'hsl(220 14% 14%)',
        },
        fg: {
          DEFAULT: 'hsl(220 10% 95%)',
          muted: 'hsl(220 8% 65%)',
          subtle: 'hsl(220 8% 45%)',
        },
        border: {
          DEFAULT: 'hsl(220 14% 18%)',
        },
        accent: {
          DEFAULT: 'hsl(152 68% 45%)',
          hover: 'hsl(152 68% 52%)',
        },
        danger: {
          DEFAULT: 'hsl(0 72% 58%)',
        },
      },
      fontFamily: {
        mono: ['ui-monospace', 'SFMono-Regular', 'Menlo', 'monospace'],
      },
    },
  },
};

export default config;
