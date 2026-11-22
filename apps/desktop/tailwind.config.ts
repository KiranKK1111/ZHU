import containerQueries from "@tailwindcss/container-queries";
import type { Config } from "tailwindcss";

// Every color, radius, shadow and duration resolves to a --zhu-* design token
// (src/styles/tokens.css). Components never hardcode raw colors.
const config: Config = {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  darkMode: ["selector", '[data-theme="dark"]'],
  theme: {
    extend: {
      colors: {
        bg: "var(--zhu-bg)",
        sidebar: "var(--zhu-sidebar)",
        surface: "var(--zhu-surface)",
        "surface-2": "var(--zhu-surface-2)",
        "surface-3": "var(--zhu-surface-3)",
        hover: "var(--zhu-hover)",
        active: "var(--zhu-active)",
        fg: "var(--zhu-text)",
        "fg-2": "var(--zhu-text-2)",
        "fg-3": "var(--zhu-text-3)",
        accent: "var(--zhu-accent)",
        "accent-hover": "var(--zhu-accent-hover)",
        "accent-fg": "var(--zhu-accent-fg)",
        "accent-soft": "var(--zhu-accent-soft)",
        border: "var(--zhu-border)",
        "border-subtle": "var(--zhu-border-subtle)",
        focus: "var(--zhu-focus)",
        success: "var(--zhu-success)",
        "success-soft": "var(--zhu-success-soft)",
        warning: "var(--zhu-warning)",
        "warning-soft": "var(--zhu-warning-soft)",
        danger: "var(--zhu-error)",
        "danger-soft": "var(--zhu-error-soft)",
        recording: "var(--zhu-recording)",
        "recording-soft": "var(--zhu-recording-soft)",
        scrim: "var(--zhu-scrim)",
      },
      borderRadius: {
        xs: "var(--zhu-radius-xs)",
        sm: "var(--zhu-radius-sm)",
        md: "var(--zhu-radius-md)",
        lg: "var(--zhu-radius-lg)",
        xl: "var(--zhu-radius-xl)",
      },
      boxShadow: {
        1: "var(--zhu-shadow-1)",
        2: "var(--zhu-shadow-2)",
        3: "var(--zhu-shadow-3)",
      },
      fontFamily: {
        sans: "var(--zhu-font-sans)",
        mono: "var(--zhu-font-mono)",
      },
      fontSize: {
        display: ["var(--zhu-text-display)", { lineHeight: "1.2", fontWeight: "650" }],
        page: ["var(--zhu-text-page)", { lineHeight: "1.25", fontWeight: "650" }],
        section: ["var(--zhu-text-section)", { lineHeight: "1.35", fontWeight: "600" }],
        card: ["var(--zhu-text-card)", { lineHeight: "1.4", fontWeight: "600" }],
        body: ["var(--zhu-text-body)", { lineHeight: "1.55" }],
        secondary: ["var(--zhu-text-secondary)", { lineHeight: "1.5" }],
        caption: ["var(--zhu-text-caption)", { lineHeight: "1.4", fontWeight: "450" }],
      },
      transitionDuration: {
        fast: "var(--zhu-motion-fast)",
        normal: "var(--zhu-motion-normal)",
        slow: "var(--zhu-motion-slow)",
      },
      transitionTimingFunction: {
        standard: "var(--zhu-ease-standard)",
        emphasized: "var(--zhu-ease-emphasized)",
      },
      spacing: {
        "titlebar": "var(--zhu-titlebar-h)",
        "sidebar": "var(--zhu-sidebar-w)",
        "sidebar-collapsed": "var(--zhu-sidebar-w-collapsed)",
        "context": "var(--zhu-context-w)",
      },
      // The cursor utilities follow ZHU's own pointer when it is switched on (see globals.css).
      cursor: {
        default: "var(--zhu-cursor, default)",
        pointer: "var(--zhu-cursor-action, pointer)",
        text: "var(--zhu-cursor-text, text)",
      },
      zIndex: {
        toast: "60",
        modal: "50",
        popover: "40",
        drawer: "45",
      },
    },
  },
  plugins: [containerQueries],
};

export default config;
