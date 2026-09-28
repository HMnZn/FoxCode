/**
 * Minimal NDJSON client for a future Python `fox serve` sidecar.
 *
 * The FoxCode Python packages are untouched by this UI project, so the sidecar
 * is opt-in: set `FOXCODE_SERVE_CMD` (and optionally `FOXCODE_SERVE_ARGS`) to a
 * command that speaks one JSON object per line on stdin/stdout, then the shell
 * forwards frames to the renderer instead of falling back to the demo host.
 *
 * Line protocol (both directions):
 *   -> {"id":"c1","method":"prompt","params":{...}}      request
 *   -> {"id":"c2","method":"permission.answer","params":{...}}
 *   <- {"id":"c1","result":{...}}                        response
 *   <- {"id":"c1","error":"..."}                         response error
 *   <- {"frame":{"type":"message_update",...}}           unsolicited host frame
 *   <- {"event":"transport","status":{...}}              transport state change
 */
const { spawn } = require('node:child_process')
const { EventEmitter } = require('node:events')

/** Set `FOXCODE_SIDECAR_DEBUG=1` to echo every NDJSON line to the main-process log. */
const DEBUG = process.env.FOXCODE_SIDECAR_DEBUG === '1'

/**
 * These commands are answered synchronously by `fox_serve` (they rebuild or
 * rewrite the runtime), so they get a much longer budget than the 30s默认值。
 * `prompt` is deliberately absent: the sidecar queues it and answers at once,
 * then streams progress as frames.
 */
const SLOW_METHODS = new Set([
  'compact',
  'reload',
  'extensions.set',
  'sessions.open',
  'sessions.new',
  'sessions.fork',
  'session.export',
  'cwd.change',
  'trust.set',
  'permission.set',
  'model.select',
  'run_command',
  'invoke_skill',
])

/** Abort is interactive control traffic; waiting the generic 30s is useless. */
const FAST_METHOD_TIMEOUTS = new Map([['abort', 5_000]])

class Sidecar extends EventEmitter {
  /**
   * @param {string} command
   * @param {string[]} args
   * @param {string} cwd
   * @param {Record<string, string>} [extraEnv] merged over `process.env`
   */
  constructor(command, args, cwd, extraEnv = {}) {
    super()
    this.command = command
    this.args = args
    this.cwd = cwd
    this.extraEnv = extraEnv
    this.seq = 0
    this.pending = new Map()
    this.expired = new Set()
    this.buffer = ''
    this.child = null
    this.stopping = false
  }

  start() {
    if (this.child) return
    this.emit('transport', {
      state: 'connecting',
      detail: `${this.command} ${this.args.join(' ')}`.trim(),
      since: Date.now(),
    })

    let child
    try {
      child = spawn(this.command, this.args, {
        cwd: this.cwd,
        // Pipes are required for the line protocol; the sandbox permits them
        // for the packaged app because it runs outside the restricted harness.
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, ...this.extraEnv, PYTHONUNBUFFERED: '1', PYTHONIOENCODING: 'utf-8' },
      })
    } catch (error) {
      this.emit('transport', {
        state: 'offline',
        detail: `无法启动 fox serve：${String(error)}`,
        since: Date.now(),
      })
      return
    }

    this.child = child

    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk) => this.ingest(chunk))

    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk) => this.emit('stderr', String(chunk).trimEnd()))

    child.on('error', (error) => {
      this.emit('transport', {
        state: 'offline',
        detail: `fox serve 进程错误：${error.message}`,
        since: Date.now(),
      })
    })

    child.on('exit', (code, signal) => {
      this.child = null
      if (this.stopping) return
      this.emit('transport', {
        state: 'offline',
        detail: `fox serve 已退出（code=${code ?? 'null'} signal=${signal ?? 'none'}）`,
        since: Date.now(),
      })
      for (const [, pending] of this.pending) {
        clearTimeout(pending.timer)
        pending.reject(new Error('sidecar exited before responding'))
      }
      this.pending.clear()
    })

    // NOTE: no optimistic `ready` here. The child needs seconds to import the
    // Python stack, and it sends its own `{"event":"transport","status":…"ready"}`
    // line once the runtime is up — that one is authoritative. Claiming ready at
    // spawn time would light up the UI long before the host can answer anything.
  }

  ingest(chunk) {
    if (DEBUG) this.emit('stderr', `<- ${String(chunk).trimEnd().slice(0, 300)}`)
    this.buffer += chunk
    let index = this.buffer.indexOf('\n')
    while (index >= 0) {
      const line = this.buffer.slice(0, index).trim()
      this.buffer = this.buffer.slice(index + 1)
      if (line) this.handleLine(line)
      index = this.buffer.indexOf('\n')
    }
  }

  handleLine(line) {
    let payload
    try {
      payload = JSON.parse(line)
    } catch {
      this.emit('stderr', `无法解析宿主输出：${line.slice(0, 400)}`)
      return
    }

    if (payload.frame) {
      this.emit('frame', payload.frame)
      return
    }
    if (payload.event === 'transport' && payload.status) {
      this.emit('transport', payload.status)
      return
    }
    if (payload.event === 'permission' && payload.request) {
      this.emit('permission', payload.request)
      return
    }
    if (payload.id && this.pending.has(payload.id)) {
      const pending = this.pending.get(payload.id)
      this.pending.delete(payload.id)
      clearTimeout(pending.timer)
      if (payload.error) pending.reject(new Error(String(payload.error)))
      else pending.resolve(payload.result)
      return
    }
    // A response may arrive after its caller timed out.  It is not an unknown
    // protocol message and should not flood the log with misleading warnings.
    if (payload.id && this.expired.delete(payload.id)) return
    this.emit('stderr', `未识别的宿主消息：${line.slice(0, 400)}`)
  }

  request(method, params) {
    if (!this.child) return Promise.reject(new Error('fox serve 未运行'))
    const id = `c${(this.seq += 1)}`
    const line = `${JSON.stringify({ id, method, params })}\n`
    if (DEBUG) this.emit('stderr', `-> ${line.trimEnd().slice(0, 300)}`)
    // `prompt` 在 fox_serve 里是「入队后立刻返回」，进度由帧驱动，所以默认
    // 30s 足够；但压缩/重载/换会话/导出这些同步命令可能跑很久，给它们放宽。
    const timeout = FAST_METHOD_TIMEOUTS.get(method) ?? (SLOW_METHODS.has(method) ? 300_000 : 30_000)
    return new Promise((resolve, reject) => {
      const pending = { resolve, reject, timer: null }
      this.pending.set(id, pending)
      pending.timer = setTimeout(() => {
        if (!this.pending.has(id)) return
        this.pending.delete(id)
        this.expired.add(id)
        // Bound the diagnostic set if a broken child never sends late replies.
        if (this.expired.size > 1_000) this.expired.delete(this.expired.values().next().value)
        reject(new Error(`${method} 超时（${Math.round(timeout / 1000)}s）`))
      }, timeout)
      pending.timer.unref?.()
      this.child.stdin.write(line, 'utf8', (error) => {
        if (!error) return
        this.pending.delete(id)
        clearTimeout(pending.timer)
        reject(error)
      })
    })
  }

  stop() {
    this.stopping = true
    if (!this.child) return
    for (const [, pending] of this.pending) clearTimeout(pending.timer)
    this.child.stdin.end()
    this.child.kill()
    this.child = null
  }
}

module.exports = { Sidecar }
