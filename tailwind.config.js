
/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  darkMode: "class",
  theme: {
    extend: {
      // treehouse chrome ladder: a cool-biased grey scale swapped in for
      // Tailwind's default neutral palette so every existing
      // `bg/border/text-neutral-*` class tracks the editor chrome.
      // Surface roles: chrome (title/status/tab strips) < 950 (panels,
      // editor) < 900 (raised rows, inputs) < 800 (hairlines, chips).
      // Keep in sync with monaco-theme.ts / monaco-shiki.ts / xterm.
      colors: {
        chrome: "#0B0C0E",
        neutral: {
          50: "#F4F5F7",
          100: "#E6E8EB",
          200: "#D0D4D9",
          300: "#B4BAC2",
          400: "#9AA1AA",
          500: "#7D858F",
          600: "#555C65",
          700: "#2C3137",
          800: "#22262B",
          900: "#16191D",
          950: "#0F1114",
        },
        // One accent. `blue-*` is already the app's focus / selection /
        // primary-action hue everywhere, so retune the scale rather than
        // introduce a new name. 600 keeps white text legible on buttons.
        blue: {
          50: "#EEF4FF",
          100: "#DCE8FF",
          200: "#BCD4FF",
          300: "#98BDFF",
          400: "#6AA1FF",
          500: "#4F8CF5",
          600: "#3874E0",
          700: "#2B5DBD",
          800: "#234A93",
          900: "#1B3566",
          950: "#111F3B",
        },
      },
      fontFamily: {
        sans: [
          "Geist Variable",
          "-apple-system",
          "BlinkMacSystemFont",
          "Segoe UI",
          "sans-serif",
        ],
        mono: [
          "Geist Mono Variable",
          "ui-monospace",
          "SFMono-Regular",
          "Menlo",
          "monospace",
        ],
      },
    },
  },
  plugins: [],
};
