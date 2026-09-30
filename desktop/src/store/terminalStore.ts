/**
 * Native terminal lifecycle and replay buffer.
 *
 * The shell owns line editing, history, prompts and echo through a real PTY.
 * This store deliberately does not model an input box or parse terminal text;
 * xterm.js renders the raw byte stream and sends raw keyboard data back.
 */
import { create } from 'zustand'
import { getBridge } from '@/bridge'
import type { TerminalDriver, TerminalStartOptions } from '@/bridge/terminal'
import { useSession } from '@/store/sessionStore'

export type TerminalStatus = 'idle' | 'starting' | 'running' | 'exited'

const FLUSH_MS = 25

interface TerminalSize {
  cols?: number
  rows?: number
}

interface TerminalState {
  status: TerminalStatus
  id: string | null
  shell: string | null
  cwd: string | null
  exitCode: number | null
  error: string | null
  /** Raw PTY stream retained so the terminal can be remounted without losing scrollback. */
  output: string

  ensure(cwd?: string, size?: TerminalSize): Promise<void>
  restart(size?: TerminalSize): Promise<void>
  clear(): void
  stop(): void
  feed(chunk: string): void
  flush(): void
}

let pending: string[] = []
let flushTimer: ReturnType<typeof setTimeout> | null = null
let unsubscribes: Array<() => void> = []
/** A shell may print its first prompt before the IPC start promise reaches the renderer. */
const earlyOutput = new Map<string, string[]>()

function subscribe(driver: TerminalDriver): void {
  if (unsubscribes.length) return
  unsubscribes = [
    driver.onData(({ id, data }) => {
      if (!data) return
      const state = useTerminal.getState()
      if (state.id === id) {
        state.feed(data)
      } else if (state.status === 'starting' && !state.id) {
        const chunks = earlyOutput.get(id) ?? []
        chunks.push(data)
        earlyOutput.set(id, chunks)
      }
    }),
    driver.onExit(({ id, code }) => {
      const state = useTerminal.getState()
      if (state.id !== id) return
      state.flush()
      useTerminal.setState({ status: 'exited', exitCode: code, id: null })
    }),
  ]
}

function cancelFlush(): void {
  if (flushTimer !== null) {
    clearTimeout(flushTimer)
    flushTimer = null
  }
  pending = []
}

export const useTerminal = create<TerminalState>((set, get) => ({
  status: 'idle',
  id: null,
  shell: null,
  cwd: null,
  exitCode: null,
  error: null,
  output: '',

  ensure: async (cwd, size) => {
    const target = cwd ?? useSession.getState().host?.cwd ?? null
    if (!target) {
      set({ error: '还没有工作区：先选一个文件夹再开终端。' })
      return
    }
    const state = get()
    if ((state.status === 'running' || state.status === 'starting') && state.cwd === target) return
    if (state.status === 'running' || state.status === 'starting') get().stop()

    const driver = getBridge().terminal
    subscribe(driver)
    cancelFlush()
    earlyOutput.clear()
    set({ status: 'starting', error: null, cwd: target, exitCode: null })
    try {
      const options: TerminalStartOptions = { cwd: target, ...size }
      const info = await driver.start(options)
      set({ id: info.id, shell: info.shell, cwd: info.cwd, status: 'running' })
      const firstChunks = earlyOutput.get(info.id)
      earlyOutput.clear()
      if (firstChunks?.length) get().feed(firstChunks.join(''))
    } catch (error) {
      earlyOutput.clear()
      set({
        status: 'idle',
        id: null,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  },

  restart: async (size) => {
    const cwd = get().cwd ?? undefined
    get().stop()
    set({ output: '', error: null, exitCode: null })
    await get().ensure(cwd, size)
  },

  clear: () => {
    cancelFlush()
    set({ output: '' })
  },

  stop: () => {
    const { id } = get()
    cancelFlush()
    if (!id) {
      set({ status: 'idle', exitCode: null })
      return
    }
    const driver = getBridge().terminal
    set({ status: 'exited', id: null, exitCode: null })
    void driver.kill(id)
  },

  feed: (chunk) => {
    if (!chunk) return
    pending.push(chunk)
    if (flushTimer !== null) return
    flushTimer = setTimeout(() => {
      flushTimer = null
      useTerminal.getState().flush()
    }, FLUSH_MS)
  },

  flush: () => {
    if (!pending.length) return
    const text = pending.join('')
    pending = []
    set((state) => ({ output: state.output + text }))
  },
}))

/** Collapsing the panel keeps the PTY alive; closing its tab calls stop(). */
