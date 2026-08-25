/**
 * Dev-only Tailwind config for public/pages/projects.html.
 * Mirrors the theme that used to live inline in a <script>tailwind.config = {...}</script>
 * block when the page loaded Tailwind from cdn.tailwindcss.com at runtime.
 * Run `npm run build:css` in this folder after changing Tailwind classes in
 * projects.html or projects.js, then commit the regenerated
 * public/css/projects-tailwind.css.
 */
module.exports = {
  content: [
    "../public/pages/projects.html",
    "../public/js/projects.js",
  ],
  theme: {
    extend: {
      fontFamily: {
        sans: ["Calibri", "Segoe UI", "Inter", "system-ui", "sans-serif"],
        // Was 'JetBrains Mono' loaded from Google Fonts — swapped for a
        // system monospace stack so the page has zero external font deps.
        mono: ["Consolas", "SF Mono", "Menlo", "Cascadia Code", "monospace"],
      },
      colors: {
        hitt: {
          ink: "#171717",
          charcoal: "#211916",
          teal: "#5C757C",
          sage: "#ABAF96",
          cream: "#DAD4B2",
          olive: "#B3B07D",
          amber: "#BC9A1C",
          canvas: "#F5F4EE",
          mist: "#EFEDE3",
          green: "#6E8F5A",
          red: "#B24A3A",
        },
      },
      boxShadow: {
        card: "0 1px 2px rgba(23,23,23,0.06), 0 1px 1px rgba(23,23,23,0.04)",
        cardHover: "0 8px 20px rgba(23,23,23,0.14), 0 2px 6px rgba(23,23,23,0.08)",
        lift: "0 18px 30px rgba(23,23,23,0.22)",
      },
    },
  },
  plugins: [],
};
