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
import { isBusyStatus, useSession } from '@/store/sessionStore'
import { useRail } from '@/store/railStore'
import { useUi } from '@/store/uiStore'
import { useWorkspace } from '@/store/workspaceStore'
import { WorkspacePicker } from '@/components/workspace/WorkspacePicker'

export function App() {
  const view = useUi((s) => s.view)
  const inspectorOpen = useUi((s) => s.inspectorOpen)
  const init = useSession((s) => s.init)
  const abort = useSession((s) => s.abort)
  const newSession = useSession((s) => s.newSession)
  const hostCwd = useSession((s) => s.host?.cwd)
  const queueLength = useSession((s) => s.queue.length)
  const timelineStatus = useSession((s) => s.timeline.status)
  const drainQueue = useSession((s) => s.drainQueue)
  const workspace = useWorkspace((s) => s.current)
  const syncWorkspace = useWorkspace((s) => s.syncHost)

  useEffect(() => {
    void init()
  }, [init])

  // 排队消息只在本机等着：这一轮**真的**跑完了才放下一条（`drainQueue()` 自己还会再问一次宿主
  // 忙不忙），否则会撞上宿主「运行中不接受 prompt」的守卫。注意这里不能判 `status === 'idle'`：
  // 带工具的一轮中间也会有 `turn_end`，那时工具还在跑。
  useEffect(() => {
    if (isBusyStatus(timelineStatus) || queueLength === 0) return
    void drainQueue()
  }, [drainQueue, queueLength, timelineStatus])

  // 每 4 秒和宿主对账，并刷新左侧会话树。后台 runtime 完成时当前页面
  // 不一定订阅它的正文帧，但 sessions.list 会更新「运行中」圆点和时间。
  useEffect(() => {
    let polling = false
    let disposed = false
    const poll = async () => {
      // A slow sidecar must not accumulate a new pair of 30s requests every
      // four seconds.  One in-flight reconciliation cycle is enough.
      if (polling || disposed) return
      polling = true
      try {
        await Promise.allSettled([
          useSession.getState().reconcile(),
          useSession.getState().refreshSessions(),
        ])
      } finally {
        polling = false
      }
    }
    const timer = window.setInterval(() => {
      void poll()
    }, 4000)
    return () => {
      disposed = true
      window.clearInterval(timer)
    }
  }, [])

  // The workspace is remembered in the renderer, so once the host introduces
  // itself we push the remembered folder back into it.
  useEffect(() => {
    void syncWorkspace()
  }, [syncWorkspace, hostCwd, workspace])

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
      if (mod && event.code === 'Backquote') {
        event.preventDefault()
        // Ctrl+` used to launch an OS terminal window; the terminal now lives
        // inside the window as a tab of the right-hand workbench (same key,
        // same promise: a shell at the workspace).
        useRail.getState().toggleTerminal()
        return
      }
      if (mod && event.altKey && event.code === 'KeyP') {
        event.preventDefault()
        useRail.getState().openFiles()
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

  // 窗口变窄时把两个栏宽重新夹一遍，否则两个固定宽度能把中列挤到零（就是用户说的
  // 「预览挤占中间、中间的字都漂移了」）。
  useEffect(() => {
    const onResize = () => useUi.getState().clampPaneWidths()
    onResize()
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

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

  // DSH frame: the sidebar and caption share one fill while the complete
  // workbench (conversation + optional details) is one rounded document.
  // Keeping the inspector inside this document is important: when it opens it
  // should split the workspace, not look like a second app bolted to its edge.
  return (
    <div className="flex h-full min-h-0 flex-col bg-surface text-fg">
      <TitleBar />

      <div className="flex min-h-0 flex-1 gap-0 bg-surface">
        <Sidebar />

        <section className="flex min-w-0 flex-1 overflow-hidden rounded-tl-[16px] bg-canvas [corner-shape:round]">
          <main className="flex min-w-0 flex-1 flex-col overflow-hidden bg-canvas">
            {view === 'chat' ? <ChatPage /> : null}
            {view === 'sessions' ? <SessionsPage /> : null}
            {view === 'skills' ? <SkillsPage /> : null}
            {view === 'extensions' ? <ExtensionsPage /> : null}
            {view === 'usage' ? <UsagePage /> : null}
            {view === 'settings' ? <SettingsPage /> : null}
          </main>

          {view === 'chat' && inspectorOpen ? <Inspector /> : null}
        </section>
      </div>

      <CommandPalette />
      <Toaster />
    </div>
  )
}
