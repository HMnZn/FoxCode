import { fileURLToPath, URL } from 'node:url'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

/**
 * The dev server needs eval-free-but-inline scripts (React refresh preamble),
 * so the strict CSP is injected into the built HTML only.
 */
const cspPlugin = {
  name: 'foxcode-build-csp',
  transformIndexHtml: {
    order: 'post' as const,
    handler(html: string, ctx: { server?: unknown }) {
      if (ctx.server) return html
      const meta = `<meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self' ws://127.0.0.1:* http://127.0.0.1:*" />`
      return html.replace('</head>', `    ${meta}\n  </head>`)
    },
  },
}

export default defineConfig({
  // Relative base so the production bundle can be loaded from file:// inside Electron.
  base: './',
  plugins: [react(), cspPlugin],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  server: {
    // Bind IPv4 explicitly: Vite's default ("localhost") can end up on ::1 only,
    // and scripts/dev.mjs polls http://127.0.0.1:<port> to know when to launch Electron.
    host: '127.0.0.1',
    port: 5273,
    strictPort: true,
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'chrome134',
    sourcemap: true,
    chunkSizeWarningLimit: 1500,
  },
})
