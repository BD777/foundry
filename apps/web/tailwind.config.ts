import type { Config } from "tailwindcss";

// Streamdown uses semantic Tailwind colors; bridge them to Foundry's theme
// instead of leaving its menus, code and tables with unconfigured defaults.
const themeColor = (token: string) =>
  `color-mix(in srgb, var(--fdy-${token}) calc(<alpha-value> * 100%), transparent)`;

export default {
  darkMode: ["selector", '[data-theme="dark"]'],
  content: [
    "./index.html",
    "./src/**/*.{ts,tsx}",
    "./node_modules/streamdown/dist/*.js",
  ],
  theme: {
    extend: {
      colors: {
        background: themeColor("panel"),
        foreground: themeColor("ink"),
        border: themeColor("line"),
        muted: {
          DEFAULT: themeColor("panel-soft"),
          foreground: themeColor("ink-muted"),
        },
        primary: {
          DEFAULT: themeColor("brass"),
          foreground: themeColor("on-accent"),
        },
        sidebar: themeColor("paper-side"),
        red: {
          50: themeColor("error-surface"),
          100: themeColor("error-surface"),
          600: themeColor("error-text"),
          700: themeColor("error-text"),
          800: themeColor("error-text"),
        },
      },
    },
  },
  plugins: [],
} satisfies Config;
