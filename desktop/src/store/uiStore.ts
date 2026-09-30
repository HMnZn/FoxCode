import { create } from 'zustand'

export type View = 'chat' | 'sessions' | 'skills' | 'extensions' | 'usage' | 'settings'
export type Theme = 'dark' | 'light'
/** 聊天页的两个视角：会话（对话 + 思考）与轨迹（工具调用与压缩/重试事件）。 */
export type ChatView = 'chat' | 'trace'

export const CHAT_VIEW_LABEL: Record<ChatView, string> = {
  chat: '会话',
  trace: '轨迹',
}

export const VIEW_LABEL: Record<View, string> = {
  chat: '会话',
  sessions: '历史会话',
  skills: '技能',
  extensions: '扩展',
  usage: '用量',
  settings: '设置',
}

// v2 adopts the Harness shell defaults: the conversation is the primary
// surface and the right sidebar opens on demand instead of occupying a third
// of every new window. v4 drops the inspector's own tab choice — the panel's
// tabs (开始 / 文件 / 打开的文件 / 终端) live in `railStore` and are not a
// preference worth persisting. v5 adds the two pane widths: the three columns
// are draggable, and a squeezed conversation is exactly what that fixes.
const PREF_KEY = 'foxcode.ui.v5'

/** 三栏的宽度约束：中列是主战场，永远给它留够地方。 */
export const SIDEBAR_DEFAULT_WIDTH = 320
export const SIDEBAR_MIN_WIDTH = 208
export const SIDEBAR_MAX_WIDTH = 460
export const INSPECTOR_MIN_WIDTH = 300
/** 中列最小宽度：右栏再宽也不能把正文挤到读不了。 */
export const MAIN_MIN_WIDTH = 420
/** 侧栏收起时只剩图标条（见 `Sidebar`）。 */
const SIDEBAR_COLLAPSED_WIDTH = 56

function clampWidth(width: number, min: number, max: number): number {
  if (!Number.isFinite(width)) return min
  return Math.min(Math.max(Math.round(width), min), Math.max(min, max))
}

interface Prefs {
  theme: Theme
  sidebarCollapsed: boolean
  inspectorOpen: boolean
  chatView: ChatView
  sidebarWidth: number
  /** `null` = 跟着当前标签自动（文件/终端宽一点），用户拖过之后才固定下来。 */
  inspectorWidth: number | null
}

function loadPrefs(): Prefs {
  const fallback: Prefs = {
    theme: 'dark',
    sidebarCollapsed: false,
    inspectorOpen: true,
    chatView: 'chat',
    sidebarWidth: SIDEBAR_DEFAULT_WIDTH,
    inspectorWidth: null,
  }
  try {
    const raw = window.localStorage.getItem(PREF_KEY)
    if (!raw) return fallback
    return { ...fallback, ...(JSON.parse(raw) as Partial<Prefs>) }
  } catch {
    return fallback
  }
}

function savePrefs(prefs: Prefs): void {
  try {
    window.localStorage.setItem(PREF_KEY, JSON.stringify(prefs))
  } catch {
    /* storage disabled: preferences stay in-memory */
  }
}

interface UiStore extends Prefs {
  view: View
  setView(view: View): void
  setChatView(chatView: ChatView): void
  paletteOpen: boolean
  setPaletteOpen(open: boolean): void
  toggleSidebar(): void
  toggleInspector(open?: boolean): void
  setTheme(theme: Theme): void
  toggleTheme(): void
  /** 拖拽分栏：宽度会夹在「最小值」与「中列不被挤没了」之间。 */
  setSidebarWidth(width: number): void
  setInspectorWidth(width: number | null): void
  /** 窗口变窄时把两个宽度重新夹一遍（不然中列会被两个固定宽度挤到零）。 */
  clampPaneWidths(): void
  /** Composer draft survives view switches; keyed per session file. */
  drafts: Record<string, string>
  setDraft(key: string, value: string): void
  clearDraft(key: string): void
  /** Explicit skill selected for a draft; selection alone never sends a message. */
  selectedSkills: Record<string, string>
  setSelectedSkill(key: string, name: string | null): void
}

const initial = loadPrefs()

/**
 * 右栏最多能有多宽：留给中列 `MAIN_MIN_WIDTH`，侧栏按当前状态算。
 * 下限就是 `INSPECTOR_MIN_WIDTH` —— 窗口很窄时宁可挤中列，也不能让面板细到不能用。
 */
export function inspectorMaxWidth(sidebarWidth: number, collapsed: boolean): number {
  const sidebar = collapsed ? SIDEBAR_COLLAPSED_WIDTH : sidebarWidth
  return Math.max(INSPECTOR_MIN_WIDTH, window.innerWidth - sidebar - MAIN_MIN_WIDTH)
}

export const useUi = create<UiStore>((set, get) => {
  const persist = () => {
    const { theme, sidebarCollapsed, inspectorOpen, chatView, sidebarWidth, inspectorWidth } = get()
    savePrefs({ theme, sidebarCollapsed, inspectorOpen, chatView, sidebarWidth, inspectorWidth })
  }

  return {
    ...initial,
    view: 'chat',
    paletteOpen: false,
    drafts: {},
    selectedSkills: {},

    setView: (view) => set({ view, paletteOpen: false }),
    setChatView: (chatView) => {
      set({ chatView })
      persist()
    },
    setPaletteOpen: (paletteOpen) => set({ paletteOpen }),

    toggleSidebar: () => {
      set((state) => ({ sidebarCollapsed: !state.sidebarCollapsed }))
      persist()
    },
    toggleInspector: (open) => {
      set((state) => ({ inspectorOpen: open ?? !state.inspectorOpen }))
      persist()
    },
    setTheme: (theme) => {
      set({ theme })
      persist()
    },
    toggleTheme: () => {
      set({ theme: get().theme === 'dark' ? 'light' : 'dark' })
      persist()
    },

    setSidebarWidth: (width) => {
      const { inspectorWidth, inspectorOpen } = get()
      const rail = inspectorOpen ? (inspectorWidth ?? 0) : 0
      const max = Math.min(SIDEBAR_MAX_WIDTH, window.innerWidth - rail - MAIN_MIN_WIDTH)
      set({ sidebarWidth: clampWidth(width, SIDEBAR_MIN_WIDTH, max) })
      persist()
    },

    setInspectorWidth: (width) => {
      if (width === null) {
        set({ inspectorWidth: null })
        persist()
        return
      }
      const { sidebarWidth, sidebarCollapsed } = get()
      set({
        inspectorWidth: clampWidth(
          width,
          INSPECTOR_MIN_WIDTH,
          inspectorMaxWidth(sidebarWidth, sidebarCollapsed),
        ),
      })
      persist()
    },

    clampPaneWidths: () => {
      const { sidebarWidth, sidebarCollapsed, inspectorWidth, inspectorOpen } = get()
      const rail = inspectorOpen ? (inspectorWidth ?? 0) : 0
      const nextSidebar = clampWidth(
        sidebarWidth,
        SIDEBAR_MIN_WIDTH,
        Math.min(SIDEBAR_MAX_WIDTH, window.innerWidth - rail - MAIN_MIN_WIDTH),
      )
      const nextInspector =
        inspectorWidth === null
          ? null
          : clampWidth(
              inspectorWidth,
              INSPECTOR_MIN_WIDTH,
              inspectorMaxWidth(nextSidebar, sidebarCollapsed),
            )
      if (nextSidebar === sidebarWidth && nextInspector === inspectorWidth) return
      set({ sidebarWidth: nextSidebar, inspectorWidth: nextInspector })
      persist()
    },

    setDraft: (key, value) => set((state) => ({ drafts: { ...state.drafts, [key]: value } })),
    clearDraft: (key) =>
      set((state) => {
        const drafts = { ...state.drafts }
        delete drafts[key]
        return { drafts }
      }),
    setSelectedSkill: (key, name) =>
      set((state) => {
        const selectedSkills = { ...state.selectedSkills }
        if (name) selectedSkills[key] = name
        else delete selectedSkills[key]
        return { selectedSkills }
      }),
  }
})

/** Mirror the theme class onto `<html>` so CSS variables switch. */
export function applyTheme(theme: Theme): void {
  const root = document.documentElement
  root.classList.toggle('light', theme === 'light')
  root.classList.toggle('dark', theme === 'dark')
  root.style.colorScheme = theme
}
