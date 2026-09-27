import { create } from 'zustand'

export type View = 'chat' | 'sessions' | 'skills' | 'extensions' | 'usage' | 'settings'
export type InspectorTab = 'context' | 'files' | 'usage'
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

const PREF_KEY = 'foxcode.ui.v1'

interface Prefs {
  theme: Theme
  sidebarCollapsed: boolean
  inspectorOpen: boolean
  inspectorTab: InspectorTab
  chatView: ChatView
}

function loadPrefs(): Prefs {
  const fallback: Prefs = {
    theme: 'dark',
    sidebarCollapsed: false,
    inspectorOpen: true,
    inspectorTab: 'context',
    chatView: 'chat',
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
  setInspectorTab(tab: InspectorTab): void
  setTheme(theme: Theme): void
  toggleTheme(): void
  /** Composer draft survives view switches; keyed per session file. */
  drafts: Record<string, string>
  setDraft(key: string, value: string): void
  clearDraft(key: string): void
}

const initial = loadPrefs()

export const useUi = create<UiStore>((set, get) => {
  const persist = () => {
    const { theme, sidebarCollapsed, inspectorOpen, inspectorTab, chatView } = get()
    savePrefs({ theme, sidebarCollapsed, inspectorOpen, inspectorTab, chatView })
  }

  return {
    ...initial,
    view: 'chat',
    paletteOpen: false,
    drafts: {},

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
    setInspectorTab: (inspectorTab) => {
      set({ inspectorTab, inspectorOpen: true })
      persist()
    },
    setTheme: (theme) => {
      set({ theme })
      persist()
    },
    toggleTheme: () => {
      set((state) => ({ theme: state.theme === 'dark' ? 'light' : 'dark' }))
      persist()
    },

    setDraft: (key, value) => set((state) => ({ drafts: { ...state.drafts, [key]: value } })),
    clearDraft: (key) =>
      set((state) => {
        const drafts = { ...state.drafts }
        delete drafts[key]
        return { drafts }
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
