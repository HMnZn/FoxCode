/**
 * 右侧工作台的标签模型：开始 / 文件 / 每个打开的文件 / 终端。
 *
 * 为什么单独一个 store：标签回答的是「现在开着什么」，而不是某一类数据 ——
 * 文件内容归 `filesStore`，shell 归 `terminalStore`，这里只记住顺序与焦点。
 * 面板的展开/收起仍然留在 `uiStore.inspectorOpen`（那是要持久化的偏好）。
 *
 * 为什么开着文件要单独一个标签而不是在列表里替换：看一个文件的同时还要看
 * 改动清单、还要跑命令，本来就是并行的三件事（和编辑器里一样的诉求）。
 */
import { create } from 'zustand'
import { useFiles, type PreviewMode } from '@/store/filesStore'
import { useTerminal } from '@/store/terminalStore'
import { useUi } from '@/store/uiStore'

export type RailTabKind = 'home' | 'files' | 'file' | 'terminal'

export interface RailTab {
  /** `home` / `files` / `file:<path>` / `terminal`。 */
  id: string
  kind: RailTabKind
  /** kind === 'file' 时的会话内路径（相对工作区）。 */
  path?: string
}

export const HOME_TAB: RailTab = { id: 'home', kind: 'home' }
export const FILES_TAB: RailTab = { id: 'files', kind: 'files' }
export const TERMINAL_TAB: RailTab = { id: 'terminal', kind: 'terminal' }

export function fileTabId(path: string): string {
  return `file:${path}`
}

interface RailState {
  tabs: RailTab[]
  activeId: string

  activate(id: string): void
  /** 打开（或聚焦）一个文件标签；已经开着就只切过去，不重新取内容。 */
  openFile(path: string, mode?: PreviewMode): void
  openFiles(): void
  openHome(): void
  /** 打开（或聚焦）终端标签，并按需要起一个 shell。 */
  openTerminal(cwd?: string): void
  /** Ctrl+`：没开就开，开着且就在眼前就收起来（保留原来的手感）。 */
  toggleTerminal(): void
  close(id: string): void
  reset(): void
}

/** 同一个标签只应该有一份；重复打开等于切过去。 */
function withTab(tabs: RailTab[], tab: RailTab): RailTab[] {
  return tabs.some((item) => item.id === tab.id) ? tabs : [...tabs, tab]
}

export const useRail = create<RailState>((set, get) => ({
  tabs: [HOME_TAB],
  activeId: HOME_TAB.id,

  activate: (id) => {
    if (get().activeId === id) return
    if (!get().tabs.some((tab) => tab.id === id)) return
    set({ activeId: id })
  },

  openFile: (path, mode) => {
    const tab: RailTab = { id: fileTabId(path), kind: 'file', path }
    set((state) => ({ tabs: withTab(state.tabs, tab), activeId: tab.id }))
    useUi.getState().toggleInspector(true)
    void useFiles.getState().open(path, mode)
  },

  openFiles: () => {
    set((state) => ({ tabs: withTab(state.tabs, FILES_TAB), activeId: FILES_TAB.id }))
    useUi.getState().toggleInspector(true)
  },

  openHome: () => {
    set({ activeId: HOME_TAB.id })
    useUi.getState().toggleInspector(true)
  },

  openTerminal: (cwd) => {
    set((state) => ({ tabs: withTab(state.tabs, TERMINAL_TAB), activeId: TERMINAL_TAB.id }))
    useUi.getState().toggleInspector(true)
    void useTerminal.getState().ensure(cwd)
  },

  toggleTerminal: () => {
    const ui = useUi.getState()
    const state = get()
    if (ui.inspectorOpen && state.activeId === TERMINAL_TAB.id) {
      state.close(TERMINAL_TAB.id)
      return
    }
    state.openTerminal()
  },

  close: (id) => {
    // 「开始」是这块面板永远可用的落点，关掉它只会留下一块空白。
    if (id === HOME_TAB.id) return
    const { tabs, activeId } = get()
    const index = tabs.findIndex((tab) => tab.id === id)
    if (index < 0) return
    if (tabs[index].kind === 'terminal') useTerminal.getState().stop()
    if (tabs[index].kind === 'file' && tabs[index].path) {
      useFiles.getState().close(tabs[index].path as string)
    }
    const next = tabs.filter((tab) => tab.id !== id)
    // 关掉当前标签后落到左边那个；关的是第一个可见标签就落到右边。
    const fallback = next[Math.max(0, index - 1)] ?? next[0] ?? HOME_TAB
    set({ tabs: next.length ? next : [HOME_TAB], activeId: activeId === id ? fallback.id : activeId })
  },

  reset: () => {
    // 换工作区等于换了一整套相对路径：旧目录的预览与那里的 shell 都不再适用。
    useFiles.getState().reset()
    useTerminal.getState().stop()
    set({ tabs: [HOME_TAB], activeId: HOME_TAB.id })
  },
}))
