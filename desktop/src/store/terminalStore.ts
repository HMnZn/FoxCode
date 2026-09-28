/**
 * 内嵌终端状态：一个终端标签 ↔ 一个 shell 进程。
 *
 * 为什么和 `filesStore` 一样单独放一个 store：终端跟会话时间线没有耦合，数据也不
 * 来自宿主 —— 它是 Electron 主进程里的一个 shell（见 `electron/terminal.js`），
 * 走 `bridge.terminal`。放在这里，工作区门之后、还没有会话时也能用。
 *
 * 面板的开关不在这里：标签开不开由 `railStore` 决定，这里只负责「有没有一个
 * 活着的 shell」。收起面板不停进程，关掉标签才会（见 `railStore.close`）。
 *
 * 「本地回显」是这里的关键决定：管道上的 shell 不是终端，它不会把自己收到的命令行
 * 打回来（cmd/PowerShell/bash 在非交互模式下都不打印提示符）。所以提示符和用户敲的
 * 那一行由我们自己写进回看里，shell 只负责输出结果。
 */
import { create } from 'zustand'
import { getBridge } from '@/bridge'
import type { TerminalDriver } from '@/bridge/terminal'
import { EMPTY_SCREEN, appendOutput, type TerminalScreen } from '@/lib/terminalText'
import { useSession } from '@/store/sessionStore'

export type TerminalStatus = 'idle' | 'starting' | 'running' | 'exited'

export const TERMINAL_PROMPT = '❯'

/**
 * 输出合并窗口（毫秒）。一个 dev server 每秒能吐几十个 chunk，每个都触发一次
 * 重渲染的话面板会拖垮整个窗口；攒 25ms 一次性折叠进屏幕模型即可。
 */
const FLUSH_MS = 25

/** 历史记录里留多少条命令。 */
const MAX_HISTORY = 50

interface TerminalState {
  status: TerminalStatus
  /** 主进程给的会话 id；输出/退出事件按它过滤。 */
  id: string | null
  shell: string | null
  cwd: string | null
  exitCode: number | null
  error: string | null
  screen: TerminalScreen
  input: string
  history: string[]
  /** 上/下键在历史里的位置；null = 没在翻历史。 */
  cursor: number | null

  /** 打开面板并保证有一个跑在 `cwd`（默认宿主 cwd）里的 shell。 */
  ensure(cwd?: string): Promise<void>
  restart(): Promise<void>
  submit(): void
  setInput(value: string): void
  recall(step: number): void
  clear(): void
  stop(): void
  /** 收到一段原始输出（内部用，也方便测试直接喂数据）。 */
  feed(chunk: string): void
  /** 把攒下的输出折进屏幕。 */
  flush(): void
}

let pending: string[] = []
let flushTimer: ReturnType<typeof setTimeout> | null = null
let unsubscribes: Array<() => void> = []

/** 订阅只做一次；驱动是单例，重复 start 不该叠加监听。 */
function subscribe(driver: TerminalDriver): void {
  if (unsubscribes.length) return
  unsubscribes = [
    driver.onData(({ id, data }) => {
      const state = useTerminal.getState()
      if (state.id !== id || !data) return
      state.feed(data)
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
  screen: EMPTY_SCREEN,
  input: '',
  history: [],
  cursor: null,

  ensure: async (cwd) => {
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
    set({ status: 'starting', error: null, cwd: target, exitCode: null })
    try {
      const info = await driver.start({ cwd: target })
      set({ id: info.id, shell: info.shell, cwd: info.cwd, status: 'running' })
    } catch (error) {
      set({
        status: 'idle',
        id: null,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  },

  restart: async () => {
    const cwd = get().cwd ?? undefined
    get().stop()
    set({ screen: EMPTY_SCREEN, error: null, exitCode: null })
    await get().ensure(cwd)
  },

  submit: () => {
    const { input, id, status } = get()
    const line = input
    set({ input: '', cursor: null })
    if (!line.trim() || status !== 'running' || !id) return

    const history = [line, ...get().history.filter((item) => item !== line)].slice(0, MAX_HISTORY)
    const name = line.trim().split(/\s+/)[0]
    if (name === 'clear' || name === 'cls') {
      set({ history })
      get().clear()
      return
    }

    // 提示符与命令行由本地回显（见文件头注释），shell 只会把结果写回来。
    set((state) => ({
      history,
      screen: appendOutput(state.screen, `${TERMINAL_PROMPT} ${line}\n`),
    }))
    const driver = getBridge().terminal
    // Windows 的 cmd 从管道读命令行时按 ANSI 代码页解码（管道没有控制台输入代码页，
    // `chcp 65001` 管不到它）。实测非 ASCII 行不只是乱码：引号会被吃掉，cmd 于是停在
    // `More? ` 等一个永远不来的闭合引号（两次真窗口验证都是这个结局）。命令行是 shell
    // 真正要执行的东西，宁可拒发并说明，也不要把用户的提示符卡死。
    if (getBridge().platform === 'win32' && /[^\x20-\x7e]/.test(line)) {
      set((state) => ({
        screen: appendOutput(
          state.screen,
          '（这行没有发出去：Windows 的 cmd 按 ANSI 代码页读取管道里的命令行，非 ASCII 参数会被误读，实测会吃掉引号并让终端卡在 More?。把中文写进脚本文件，或改用 ASCII 参数。）\n',
        ),
      }))
      return
    }
    const enter = getBridge().platform === 'win32' ? '\r\n' : '\n'
    void driver.write(id, line + enter)
  },

  setInput: (input) => set({ input }),
  recall: (step) => {
    const { history, cursor } = get()
    if (!history.length) return
    if (step < 0) {
      const next = cursor === null ? 0 : Math.min(cursor + 1, history.length - 1)
      set({ cursor: next, input: history[next] })
      return
    }
    if (cursor === null) return
    const next = cursor - 1
    set({ cursor: next < 0 ? null : next, input: next < 0 ? '' : history[next] })
  },

  clear: () => {
    cancelFlush()
    set({ screen: EMPTY_SCREEN })
  },

  stop: () => {
    const { id } = get()
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
    set((state) => ({ screen: appendOutput(state.screen, text) }))
  },
}))

/** 面板收起时不停进程：再打开时回看与工作目录都还在（同 VS Code 的行为）。 */
