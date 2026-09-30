/**
 * The in-app terminal.
 *
 * This is a *shell* feature, not a host feature: it is the Electron main process
 * that spawns the shell (`electron/terminal.js`), so it works with and without a
 * `fox serve` sidecar — the same reason `nativeShell()` exists for "reveal in
 * file manager". Both bridges therefore share one driver factory:
 *
 *  - inside Electron, `window.foxcode.terminal` is the real thing;
 *  - in a plain browser (or jsdom, which is where the component tests run) there
 *    is no shell to spawn, and `demoDriver()` answers a few commands instead so
 *    the panel is still explorable instead of dead.
 */
export interface TerminalStartOptions {
  cwd: string
  cols?: number
  rows?: number
}

export interface TerminalSessionInfo {
  id: string
  shell: string
  cwd: string
  pid: number | null
}

export interface TerminalDataEvent {
  id: string
  data: string
}

export interface TerminalExitEvent {
  id: string
  code: number | null
  signal: string | null
}

export interface TerminalDriver {
  readonly kind: 'native' | 'demo'
  start(options: TerminalStartOptions): Promise<TerminalSessionInfo>
  write(id: string, data: string): Promise<boolean>
  resize(id: string, cols: number, rows: number): Promise<boolean>
  kill(id: string): Promise<boolean>
  onData(listener: (payload: TerminalDataEvent) => void): () => void
  onExit(listener: (payload: TerminalExitEvent) => void): () => void
}

/** The surface `desktop/electron/preload.js` exposes as `window.foxcode.terminal`. */
export interface TerminalApi {
  start(options: TerminalStartOptions): Promise<TerminalSessionInfo>
  write(id: string, data: string): Promise<boolean>
  resize(id: string, cols: number, rows: number): Promise<boolean>
  kill(id: string): Promise<boolean>
  onData(listener: (payload: TerminalDataEvent) => void): () => void
  onExit(listener: (payload: TerminalExitEvent) => void): () => void
}

/**
 * Pick the best available driver.
 *
 * Note that this deliberately does *not* look at `window.foxcode.available`:
 * that flag only reports whether a sidecar was configured, while the terminal
 * lives in the main process either way.
 */
export function terminalDriver(): TerminalDriver {
  const api = typeof window === 'undefined' ? undefined : window.foxcode?.terminal
  return api ? nativeTerminalDriver(api) : demoDriver()
}

/** Wrap the preload surface as a driver (used by the IPC bridge). */
export function nativeTerminalDriver(api: TerminalApi): TerminalDriver {
  return {
    kind: 'native',
    start: (options) => api.start(options),
    write: (id, data) => api.write(id, data),
    resize: (id, cols, rows) => api.resize(id, cols, rows),
    kill: (id) => api.kill(id),
    onData: (listener) => api.onData(listener),
    onExit: (listener) => api.onExit(listener),
  }
}

/** Files the demo shell pretends to see, mirroring the demo host's tree. */
const DEMO_ENTRIES = ['README.md', 'main.py', 'pyproject.toml', 'desktop/', 'fox_serve/']

export const DEMO_HELP = [
  'help    显示这份帮助',
  'ls      列出目录（演示数据）',
  'pwd     打印工作目录',
  'echo    原样回显',
  'clear   清屏',
  'exit    结束这个演示终端',
].join('\r\n')

/**
 * A tiny scripted shell. It never touches the OS: it exists so the panel has
 * something truthful to show when there is no Electron shell underneath.
 */
export function demoDriver(): TerminalDriver {
  const dataListeners = new Set<(payload: TerminalDataEvent) => void>()
  const exitListeners = new Set<(payload: TerminalExitEvent) => void>()
  let id = 'demo-terminal'
  let cwd = ''

  const emit = (chunk: string) => {
    for (const listener of dataListeners) listener({ id, data: chunk })
  }

  return {
    kind: 'demo',
    start: (options) => {
      cwd = options.cwd
      emit(`演示终端：没有 Electron 外壳，命令不会真的执行。输入 help 看可用命令。\r\n`)
      return Promise.resolve({ id, shell: 'demo', cwd, pid: null })
    },
    write: (_id, data) => {
      for (const raw of String(data).split('\n')) {
        const line = raw.replace(/\r$/, '').trim()
        if (!line) continue
        if (line === 'exit') {
          emit('再见。\r\n')
          for (const listener of exitListeners) listener({ id, code: 0, signal: null })
          continue
        }
        const [name, ...rest] = line.split(/\s+/)
        if (name === 'help') emit(`${DEMO_HELP}\r\n`)
        else if (name === 'ls' || name === 'dir') emit(`${DEMO_ENTRIES.join('  ')}\r\n`)
        else if (name === 'pwd' || name === 'cd') emit(`${cwd}\r\n`)
        else if (name === 'echo') emit(`${rest.join(' ')}\r\n`)
        else emit(`（演示终端）没有真的执行：${line}\r\n`)
      }
      return Promise.resolve(true)
    },
    resize: () => Promise.resolve(true),
    kill: () => {
      for (const listener of exitListeners) listener({ id, code: 0, signal: null })
      return Promise.resolve(true)
    },
    onData: (listener) => {
      dataListeners.add(listener)
      return () => dataListeners.delete(listener)
    },
    onExit: (listener) => {
      exitListeners.add(listener)
      return () => exitListeners.delete(listener)
    },
  }
}
