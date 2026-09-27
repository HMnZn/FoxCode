/**
 * Tailwind runs through PostCSS instead of the `@tailwindcss/vite` plugin.
 *
 * The Vite plugin has to be imported from `vite.config.ts`, and Vite bundles
 * that config before executing it — which drags the `@tailwindcss/oxide`
 * native addon (`.node`) through the config bundler and fails on Windows.
 * PostCSS config is resolved at runtime by Vite itself, so the native addon is
 * loaded normally.
 */
export default {
  plugins: {
    '@tailwindcss/postcss': {},
  },
}
