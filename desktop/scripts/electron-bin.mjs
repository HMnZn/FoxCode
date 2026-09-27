/**
 * Shared Electron launcher helpers.
 *
 * Why not the `electron` npm shim: it runs `node cli.js` first, which inherits
 * whatever the surrounding shell exported. Some harnesses export
 * `ELECTRON_RUN_AS_NODE=1`, and an Electron started that way boots as a plain
 * Node runtime — `require('electron')` then returns a path string and the app
 * dies on `ipcMain` being undefined. We spawn the real binary with a scrubbed
 * environment instead.
 */
import fs from 'node:fs'
import path from 'node:path'

/** Absolute path to the Electron executable inside `node_modules`. */
export function electronBinary(root) {
  const dir = path.join(root, 'node_modules', 'electron')
  const pathFile = path.join(dir, 'path.txt')
  const name = fs.existsSync(pathFile) ? fs.readFileSync(pathFile, 'utf8').trim() : ''
  const exe = path.join(dir, 'dist', name || 'electron.exe')
  if (!fs.existsSync(exe)) {
    throw new Error(
      `Electron binary not found at ${exe}. Run \`node node_modules/electron/install.js\` to download it.`,
    )
  }
  return exe
}

/**
 * Extra Chromium switches, read from `FOXCODE_ELECTRON_FLAGS`.
 *
 * Needed in restricted environments where the Chromium sandbox cannot start
 * (`--no-sandbox --disable-gpu`), and for debugging (`--remote-debugging-port`).
 */
export function electronFlags() {
  return (process.env.FOXCODE_ELECTRON_FLAGS ?? '').split(/\s+/).filter(Boolean)
}

/** Environment for the Electron child: inherits ours, minus the run-as-node trap. */
export function electronEnv(extra = {}) {
  const env = { ...process.env, ...extra }
  delete env.ELECTRON_RUN_AS_NODE
  return env
}
