/**
 * Embedded terminals: one shell process per panel, spoken to over pipes.
 *
 * Why not a real PTY: a PTY on Windows needs ConPTY (node-pty is a native module
 * and would have to be rebuilt against Electron's ABI), and this app ships as a
 * plain Electron bundle. So each terminal is a shell with `stdio: 'pipe'`:
 *
 *  - output is line-oriented text (the renderer draws it, our own prompt
 *    included, because a shell reading from a pipe prints no prompt);
 *  - full-screen TUI programs (vim, top) cannot be driven — they need cursor
 *    addressing, which is exactly what we do not forward;
 *  - there is no `resize`: the shell has no window size to report.
 *
 * Everything else — command history, long-running servers, `git`, python
 * scripts, Ctrl+C by restarting the shell — behaves like a normal shell.
 */
const { EventEmitter } = require('node:events')
const { spawn } = require('node:child_process')

/** How many shells may live at once; the UI only ever opens one. */
const MAX_SESSIONS = 4

/**
 * Ask the OS for a shell that is happy on pipes.
 *
 * `TERM=dumb` + `NO_COLOR=1` are deliberate: they tell programs "no cursor
 * tricks, no colour", which is the truth for this panel and also keeps the
 * scrollback readable. Without them, a tool that *always* colours its output
 * (python's traceback highlighter, cargo) would fill the transcript with escape
 * sequences we then have to strip again.
 *
 * On Windows we also run `chcp 65001`: cmd.exe picks the console code page at
 * startup (936 on a Chinese system), and every tool that prints through the
 * console — python included — inherits it. With the page switched to UTF-8, the
 * bytes arriving on the pipe are UTF-8 and decode cleanly (see `decode` below).
 *
 * Known Windows limitation: `chcp` changes the *console* code pages, and a pipe
 * has no console — cmd keeps decoding the commands it reads from stdin with the
 * ANSI page, so a non-ASCII **command line** can arrive mangled (the renderer
 * warns about that in `terminalStore.submit`). Output is not affected: `decode`
 * falls back to the OEM page for anything that is not valid UTF-8.
 */
function resolveShell() {
  const env = { ...process.env, TERM: 'dumb', NO_COLOR: '1' }
  delete env.FORCE_COLOR
  delete env.CLICOLOR_FORCE
  // A pipe is not a console, so python picks the ANSI code page for its stdout
  // (936 on a Chinese system) and our UTF-8 decode turns its output into
  // diamonds. Both variables are python's own escape hatch, so ask for UTF-8.
  env.PYTHONIOENCODING = 'utf-8'
  env.PYTHONUTF8 = '1'
  if (process.platform === 'win32') {
    // `/Q` turns command echo off, `/D` skips AutoRun scripts, `/K` switches the
    // code page and then stays interactive.
    return {
      shell: process.env.ComSpec || 'cmd.exe',
      args: ['/Q', '/D', '/K', 'chcp 65001>nul'],
      env,
    }
  }
  if (process.platform === 'darwin') {
    return { shell: process.env.SHELL || '/bin/zsh', args: ['-l'], env }
  }
  return { shell: process.env.SHELL || '/bin/bash', args: [], env }
}

const UTF8 = new TextDecoder('utf-8', { fatal: false })
/** Absent when Node is built without full ICU; then UTF-8 is all we can decode. */
const GBK = (() => {
  try {
    return new TextDecoder('gbk')
  } catch {
    return null
  }
})()

/**
 * Decode a chunk of shell output.
 *
 * A chunk is *usually* UTF-8 (that is the code page we asked for), but cmd's
 * own banner is printed before `chcp 65001` runs and therefore still carries the
 * OEM page — on a Chinese system that is GBK. So UTF-8 is tried first and a
 * replacement character means "these bytes were not UTF-8": decode them again
 * with the OEM page instead of showing the user a row of diamonds.
 */
function decode(chunk) {
  const text = UTF8.decode(chunk)
  if (!text.includes('\uFFFD') || !GBK) return text
  return GBK.decode(chunk)
}

class TerminalSessions extends EventEmitter {
  constructor() {
    super()
    /** @type {Map<string, import('node:child_process').ChildProcess>} */
    this.sessions = new Map()
    this.seq = 0
  }

  get size() {
    return this.sessions.size
  }

  /**
   * Spawn a shell rooted at `cwd`.
   * @param {{ cwd?: string, exists?: (path: string) => boolean }} options
   */
  start(options = {}) {
    const { shell, args, env } = resolveShell()
    const cwd = String(options.cwd || process.cwd())
    if (this.sessions.size >= MAX_SESSIONS) {
      throw new Error(`同时最多 ${MAX_SESSIONS} 个终端`)
    }
    const id = `term-${++this.seq}`
    const child = spawn(shell, args, {
      cwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    })

    child.stdout.on('data', (bytes) => this.emit('data', { id, data: decode(bytes) }))
    child.stderr.on('data', (bytes) => this.emit('data', { id, data: decode(bytes) }))
    child.on('error', (error) => {
      this.emit('data', { id, data: `\r\n启动失败：${error.message}\r\n` })
      this.finish(id, null, null)
    })
    child.on('exit', (code, signal) => this.finish(id, code ?? null, signal ?? null))
    // 用户对着已经退出的终端敲字不该抛异常，所以 stdin 的 EPIPE 直接吞掉。
    child.stdin.on('error', () => {})

    this.sessions.set(id, child)
    return { id, shell, cwd, pid: child.pid ?? null }
  }

  /** Send raw keystrokes (a whole line, or a control character). */
  write(id, data) {
    const child = this.sessions.get(String(id))
    if (!child || child.exitCode !== null || !child.stdin.writable) return false
    child.stdin.write(String(data))
    return true
  }

  /** Close stdin so the shell exits on its own; force-kill after a grace period. */
  kill(id) {
    const key = String(id)
    const child = this.sessions.get(key)
    if (!child) return false
    try {
      child.stdin.end()
    } catch {
      /* already gone */
    }
    const timer = setTimeout(() => {
      if (this.sessions.has(key)) child.kill()
    }, 1200)
    timer.unref?.()
    return true
  }

  /** Force-kill leftovers; called when the window or the app goes away. */
  dispose() {
    for (const [id, child] of this.sessions) {
      this.sessions.delete(id)
      try {
        child.kill()
      } catch {
        /* already gone */
      }
    }
  }

  finish(id, code, signal) {
    if (!this.sessions.delete(id)) return
    this.emit('exit', { id, code, signal })
  }
}

module.exports = { MAX_SESSIONS, TerminalSessions, decode, resolveShell }
