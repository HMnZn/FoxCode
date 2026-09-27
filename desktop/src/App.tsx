import { useCallback, useEffect } from 'react'
import { Toaster } from '@/components/ui'
import { CommandPalette } from '@/components/layout/CommandPalette'
import { Inspector } from '@/components/layout/Inspector'
import { Sidebar } from '@/components/layout/Sidebar'
import { TitleBar } from '@/components/layout/TitleBar'
import { ChatPage } from '@/pages/ChatPage'
import { ExtensionsPage } from '@/pages/ExtensionsPage'
import { SessionsPage } from '@/pages/SessionsPage'
import { SettingsPage } from '@/pages/SettingsPage'
import { SkillsPage } from '@/pages/SkillsPage'
import { UsagePage } from '@/pages/UsagePage'
import { useSession } from '@/store/sessionStore'
import { useUi } from '@/store/uiStore'
import { useWorkspace } from '@/store/workspaceStore'
import { WorkspacePicker } from '@/components/workspace/WorkspacePicker'

export function App() {
  const view = useUi((s) => s.view)
  const inspectorOpen = useUi((s) => s.inspectorOpen)
  const init = useSession((s) => s.init)
  const abort = useSession((s) => s.abort)
  const newSession = useSession((s) => s.newSession)
  const host = useSession((s) => s.host)
  const workspace = useWorkspace((s) => s.current)
  const syncWorkspace = useWorkspace((s) => s.syncHost)

  useEffect(() => {
    void init()
  }, [init])

  // 每 4 秒和宿主对账一次：界面还锁着、宿主却已经没有在跑的一轮时自己解锁（结束帧
  // 丢了就永远「生成中」），以及长时间没有新帧时提示「可能卡住」。
  // 放在 App 而不是 ChatPage：切到「用量」页时同样需要有人盯着。
  useEffect(() => {
    const timer = window.setInterval(() => {
      void useSession.getState().reconcile()
    }, 4000)
    return () => window.clearInterval(timer)
  }, [])

  // The workspace is remembered in the renderer, so once the host introduces
  // itself we push the remembered folder back into it.
  useEffect(() => {
    void syncWorkspace()
  }, [syncWorkspace, host, workspace])

  const onKeyDown = useCallback(
    (event: KeyboardEvent) => {
      const mod = event.metaKey || event.ctrlKey
      const target = event.target as HTMLElement | null
      const inField =
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        target?.isContentEditable === true

      // The workspace gate owns the window until a folder is chosen.
      if (!useWorkspace.getState().current) return

      if (mod && !event.shiftKey && event.code === 'KeyK') {
        event.preventDefault()
        useUi.getState().setPaletteOpen(!useUi.getState().paletteOpen)
        return
      }
      if (mod && event.code === 'KeyN' && !event.shiftKey) {
        event.preventDefault()
        void newSession()
        return
      }
      if (mod && event.code === 'KeyB') {
        event.preventDefault()
        useUi.getState().toggleSidebar()
        return
      }
      if (mod && event.code === 'KeyJ') {
        event.preventDefault()
        useUi.getState().toggleInspector()
        return
      }
      if (event.key === 'Escape' && !inField) {
        const ui = useUi.getState()
        if (ui.paletteOpen) {
          ui.setPaletteOpen(false)
          return
        }
        // Escape outside a field stops a run instead of closing the window.
        if (useSession.getState().timeline.status === 'streaming') void abort()
      }
    },
    [abort, newSession],
  )

  useEffect(() => {
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [onKeyDown])

  // Nothing else is reachable before a workspace exists: the agent's cwd, its
  // sessions and its trust state all hang off this one choice.
  if (!workspace) {
    return (
      <div className="flex h-full min-h-0 flex-col bg-surface text-fg">
        <TitleBar />
        <div className="flex min-h-0 flex-1 flex-col rounded-tl-[16px] bg-canvas [corner-shape:round]">
          <WorkspacePicker />
        </div>
        <Toaster />
      </div>
    )
  }

  // DSH frame: a sidebar-filled strip on top (drag region), then a single row
  // of columns. Only the first content column is rounded, so the strip reads as
  // the window chrome around the workbench.
  return (
    <div className="flex h-full min-h-0 flex-col bg-surface text-fg">
      <TitleBar />

      <div className="flex min-h-0 flex-1 gap-0 bg-surface">
        <Sidebar />

        <main className="flex min-w-0 flex-1 flex-col overflow-hidden rounded-tl-[16px] bg-canvas [corner-shape:round]">
          {view === 'chat' ? <ChatPage /> : null}
          {view === 'sessions' ? <SessionsPage /> : null}
          {view === 'skills' ? <SkillsPage /> : null}
          {view === 'extensions' ? <ExtensionsPage /> : null}
          {view === 'usage' ? <UsagePage /> : null}
          {view === 'settings' ? <SettingsPage /> : null}
        </main>

        {view === 'chat' && inspectorOpen ? <Inspector /> : null}
      </div>

      <CommandPalette />
      <Toaster />
    </div>
  )
}
