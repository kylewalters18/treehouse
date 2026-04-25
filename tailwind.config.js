import typography from "@tailwindcss/typography";

/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  darkMode: "class",
  theme: {
    extend: {
      // Dark Modern 2026 chrome ladder, swapped in for Tailwind's default
      // neutral palette so every existing `bg/border/text-neutral-*` class
      // tracks the editor chrome without per-call rewrites.
      colors: {
        neutral: {
          50: "#fafafa",
          100: "#ededed",
          200: "#d7d7d7",
          300: "#bfbfbf",
          400: "#a3a3a3",
          500: "#8C8C8C",
          600: "#555555",
          700: "#333536",
          800: "#2A2B2C",
          900: "#191A1B",
          950: "#121314",
        },
      },
      fontFamily: {
        mono: ["ui-monospace", "SFMono-Regular", "Menlo", "monospace"],
      },
    },
  },
  plugins: [typography],
};
