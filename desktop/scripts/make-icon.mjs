#!/usr/bin/env node
/**
 * Runs the icon renderer inside a real Electron runtime.
 *
 *   node scripts/make-icon.mjs
 *
 * `icon.mjs` is an Electron *main* script (it imports app/BrowserWindow), so it
 * cannot run under plain Node — and the `electron` npm shim is unusable here
 * because an inherited ELECTRON_RUN_AS_NODE would boot it as Node. Same launch
 * path as scripts/shot.mjs.
 */
import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { electronBinary, electronEnv, electronFlags } from './electron-bin.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')

// Same soft-mode fallback as scripts/dev.mjs: on machines where the Chromium
// sandbox cannot start, a flag-less launch dies before the first paint. An
// explicit FOXCODE_ELECTRON_FLAGS always wins.
if (!process.env.FOXCODE_ELECTRON_FLAGS) {
  process.env.FOXCODE_ELECTRON_FLAGS = [
    '--no-sandbox',
    '--disable-gpu',
    '--disable-crash-reporter',
    `--user-data-dir=${path.join(root, '..', '.build-cache', 'electron-userdata-icon')}`,
  ].join(' ')
}

const child = spawn(electronBinary(root), [path.join(here, 'icon.mjs'), ...electronFlags()], {
  stdio: 'inherit',
  env: electronEnv(),
})

child.on('exit', (code) => process.exit(code ?? 1))
child.on('error', (error) => {
  console.error(`failed to launch Electron: ${error}`)
  process.exit(1)
})
