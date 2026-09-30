/**
 * Native embedded terminals backed by a real pseudoterminal.
 *
 * `node-pty` maps to forkpty(3) on macOS/Linux and ConPTY on supported Windows
 * versions. Unlike the old stdio-pipe implementation, the spawned shell sees
 * a TTY: prompts, colours, line editing, Ctrl+C, completion and interactive
 * programs all use their normal terminal protocol. The renderer side is
 * xterm.js; this file only owns processes and byte streams.
 */
const { EventEmitter } = require('node:events')
const fs = require('node:fs')
const path = require('node:path')

/**
 * node-pty 1.1 ships `spawn-helper` beside its prebuilt addon. Some npm clients
 * currently extract that helper as 0644 on macOS, which makes forkpty fail with
 * the unhelpful `posix_spawnp failed`. Repair only that known helper before the
 * addon is loaded. electron-builder places it under app.asar.unpacked.
 */
function ensureSpawnHelperExecutable() {
  if (process.platform === 'win32') return
  const packageRoot = path.resolve(path.dirname(require.resolve('node-pty')), '..')
  const unpackedRoot = packageRoot
    .replace('app.asar' + path.sep, 'app.asar.unpacked' + path.sep)
    .replace('node_modules.asar' + path.sep, 'node_modules.asar.unpacked' + path.sep)
  const candidates = [
    path.join(unpackedRoot, 'prebuilds', `${process.platform}-${process.arch}`, 'spawn-helper'),
    path.join(unpackedRoot, 'build', 'Release', 'spawn-helper'),
  ]
  for (const helper of candidates) {
    if (!fs.existsSync(helper)) continue
    const mode = fs.statSync(helper).mode
    if ((mode & 0o111) === 0) fs.chmodSync(helper, mode | 0o755)
    return
  }
}

ensureSpawnHelperExecutable()
const pty = require('node-pty')

const MAX_SESSIONS = 4
const DEFAULT_COLS = 80
const DEFAULT_ROWS = 24

function terminalEnvironment() {
  const env = {
    ...process.env,
    TERM: 'xterm-256color',
    COLORTERM: 'truecolor',
    FORCE_COLOR: '1',
    PYTHONIOENCODING: 'utf-8',
    PYTHONUTF8: '1',
  }
  delete env.ELECTRON_RUN_AS_NODE
  delete env.NO_COLOR

  if (process.platform === 'darwin') {
    // Finder-launched apps do not inherit the user's interactive PATH. Give
    // the login shell the conventional executable roots before it loads its
    // own profile, matching Terminal.app and VS Code more closely.
    const additions = [
      '/opt/homebrew/bin',
      '/opt/homebrew/sbin',
      '/usr/local/bin',
      ...(env.HOME ? [`${env.HOME}/.local/bin`] : []),
    ]
    env.PATH = [...additions, ...(env.PATH || '').split(':')]
      .filter(Boolean)
      .filter((value, index, values) => values.indexOf(value) === index)
      .join(':')
  }
  return env
}

/** Return the user's real interactive shell and its login arguments. */
function resolveShell() {
  const env = terminalEnvironment()
  if (process.platform === 'win32') {
    return { shell: process.env.ComSpec || 'cmd.exe', args: [], env }
  }
  if (process.platform === 'darwin') {
    return { shell: process.env.SHELL || '/bin/zsh', args: ['-l'], env }
  }
  return { shell: process.env.SHELL || '/bin/bash', args: ['-l'], env }
}

function dimension(value, fallback) {
  const number = Number(value)
  return Number.isInteger(number) && number > 0 ? number : fallback
}

class TerminalSessions extends EventEmitter {
  constructor() {
    super()
    /** @type {Map<string, import('node-pty').IPty>} */
    this.sessions = new Map()
    this.seq = 0
  }

  get size() {
    return this.sessions.size
  }

  /** Spawn a native PTY rooted at `cwd`. */
  start(options = {}) {
    const { shell, args, env } = resolveShell()
    const cwd = String(options.cwd || process.cwd())
    if (this.sessions.size >= MAX_SESSIONS) {
      throw new Error(`同时最多 ${MAX_SESSIONS} 个终端`)
    }
    const id = `term-${++this.seq}`
    const processHandle = pty.spawn(shell, args, {
      name: 'xterm-256color',
      cols: dimension(options.cols, DEFAULT_COLS),
      rows: dimension(options.rows, DEFAULT_ROWS),
      cwd,
      env: { ...env, PWD: cwd },
      useConpty: true,
    })

    this.sessions.set(id, processHandle)
    processHandle.onData((data) => this.emit('data', { id, data }))
    processHandle.onExit(({ exitCode, signal }) => {
      if (!this.sessions.delete(id)) return
      this.emit('exit', { id, code: exitCode ?? null, signal: signal ?? null })
    })
    return { id, shell, cwd, pid: processHandle.pid ?? null }
  }

  /** Forward raw terminal input, including control and escape sequences. */
  write(id, data) {
    const processHandle = this.sessions.get(String(id))
    if (!processHandle) return false
    processHandle.write(String(data))
    return true
  }

  resize(id, cols, rows) {
    const processHandle = this.sessions.get(String(id))
    if (!processHandle) return false
    processHandle.resize(dimension(cols, DEFAULT_COLS), dimension(rows, DEFAULT_ROWS))
    return true
  }

  kill(id) {
    const key = String(id)
    const processHandle = this.sessions.get(key)
    if (!processHandle) return false
    this.sessions.delete(key)
    try {
      processHandle.kill()
    } finally {
      this.emit('exit', { id: key, code: null, signal: null })
    }
    return true
  }

  dispose() {
    for (const [id, processHandle] of this.sessions) {
      this.sessions.delete(id)
      try {
        processHandle.kill()
      } catch {
        /* already gone */
      }
    }
  }
}

module.exports = { DEFAULT_COLS, DEFAULT_ROWS, MAX_SESSIONS, TerminalSessions, resolveShell }
