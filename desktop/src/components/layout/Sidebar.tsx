import { useEffect, useMemo, useState } from 'react'
import {
  ChevronDown,
  Folder,
  FolderOpen,
  FolderPlus,
  Gauge,
  History,
  MessageSquarePlus,
  Pin,
  Puzzle,
  Search,
  Settings,
  Sparkles,
} from 'lucide-react'
import { IconButton, StatusDot, Tooltip } from '@/components/ui'
import { SessionMenu } from '@/components/sessions/SessionMenu'
import { WorkspaceMenu } from '@/components/workspace/WorkspaceMenu'
import { FoxMark } from '@/components/brand/Fox'
import { formatRelative } from '@/lib/format'
import { pinnedFirst, usePins } from '@/store/pinStore'
import { useSession } from '@/store/sessionStore'
import { samePath, useWorkspace, workspaceLabel } from '@/store/workspaceStore'
import { useUi, SIDEBAR_DEFAULT_WIDTH, type View } from '@/store/uiStore'
import { Splitter } from '@/components/layout/Splitter'
import type { SessionSummary } from '@/types/protocol'
import { cn } from '@/lib/cn'

const SECONDARY_NAV: Array<{ view: View; label: string; icon: typeof Puzzle }> = [
  { view: 'extensions', label: '插件', icon: Puzzle },
  { view: 'skills', label: '技能', icon: Sparkles },
  { view: 'usage', label: '用量', icon: Gauge },
  { view: 'sessions', label: '全部会话', icon: History },
]

function normalize(value: string): string {
  return value.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
}

export function Sidebar() {
  const collapsed = useUi((state) => state.sidebarCollapsed)
  const view = useUi((state) => state.view)
  const setView = useUi((state) => state.setView)
  const sidebarWidth = useUi((state) => state.sidebarWidth)
  const setSidebarWidth = useUi((state) => state.setSidebarWidth)
  const host = useSession((state) => state.host)
  const sessions = useSession((state) => state.sessions)
  const openSession = useSession((state) => state.openSession)
  const newSession = useSession((state) => state.newSession)
  const currentWorkspace = useWorkspace((state) => state.current)
  const recentWorkspaces = useWorkspace((state) => state.recent)
  const aliases = useWorkspace((state) => state.aliases)
  const hiddenWorkspaces = useWorkspace((state) => state.hidden)
  const pickWorkspace = useWorkspace((state) => state.pick)
  const openWorkspace = useWorkspace((state) => state.open)
  const adoptWorkspace = useWorkspace((state) => state.adopt)
  const pinned = usePins((state) => state.pinned)
  const [query, setQuery] = useState('')
  const [searching, setSearching] = useState(false)
  const [expandedWorkspaces, setExpandedWorkspaces] = useState<Set<string>>(
    () => new Set(currentWorkspace ? [normalize(currentWorkspace)] : []),
  )

  const workspaces = useMemo(() => {
    const rows: string[] = []
    for (const path of [
      ...recentWorkspaces,
      currentWorkspace,
      ...sessions.map((session) => session.cwd),
    ]) {
      if (!path) continue
      // 被移除的工作区仍然可能带着会话出现（`current` 与宿主 cwd 也会带回来），
      // 所以过滤必须发生在这里，而不是只把路径从 recent 里删掉。
      if (hiddenWorkspaces.some((entry) => samePath(entry, path))) continue
      if (rows.some((entry) => samePath(entry, path))) continue
      rows.push(path)
    }
    return rows
  }, [currentWorkspace, hiddenWorkspaces, recentWorkspaces, sessions])

  useEffect(() => {
    const path = host?.cwd ?? currentWorkspace
    if (!path) return
    const key = normalize(path)
    setExpandedWorkspaces((current) => {
      if (current.has(key)) return current
      return new Set([...current, key])
    })
  }, [currentWorkspace, host?.cwd])

  const visibleSessions = useMemo(() => {
    const needle = query.trim().toLowerCase()
    return [...sessions]
      .filter((session) => !needle || session.title.toLowerCase().includes(needle))
      .sort((a, b) => b.updatedAt - a.updatedAt)
  }, [query, sessions])

  // 置顶只改组内顺序：会话本来按工作区分组，把置顶的行拎到全局顶部会让它们
  // 脱离自己所属的工作区（折叠起来时更是看不见）。
  const orderedSessions = useMemo(
    () => pinnedFirst(visibleSessions, pinned),
    [pinned, visibleSessions],
  )

  const currentFile = normalize(host?.sessionFile ?? '')
  const isCurrentSession = (session: SessionSummary) =>
    session.live === true || normalize(session.file) === currentFile

  const toggleWorkspace = (workspace: string) => {
    const key = normalize(workspace)
    setExpandedWorkspaces((current) => {
      const next = new Set(current)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  const selectSession = async (session: SessionSummary) => {
    setView('chat')
    const previous = currentWorkspace
    if (session.cwd) adoptWorkspace(session.cwd)
    try {
      await openSession(session.id)
    } catch {
      if (previous) adoptWorkspace(previous)
    }
  }

  const startNew = () => {
    setView('chat')
    const timeline = useSession.getState().timeline
    const hasConversation = timeline.blocks.some(
      (block) => block.kind !== 'notice' || block.title !== '会话已打开',
    )
    if (!hasConversation && timeline.status === 'idle') return
    void newSession()
  }

  /**
   * 「在这个工作区新建对话」：当前工作区只是开一条新会话，别的工作区要先切过去
   * ——宿主的 `cwd.change` 会在新目录下开一条新会话，这正是「在这个文件夹里对话」
   * 的意思。忙碌时 `open` 只把目录记进列表并提示（不会打断正在跑的会话）。
   */
  const startNewIn = (workspace: string) => {
    if (samePath(workspace, host?.cwd ?? currentWorkspace)) {
      startNew()
      return
    }
    setView('chat')
    void openWorkspace(workspace)
  }

  if (collapsed) {
    return (
      <nav id="primary-sidebar" aria-label="主导航" className="flex w-14 shrink-0 flex-col items-center border-r border-line bg-surface py-2">
        <span className="mb-3 grid size-9 place-items-center"><FoxMark size={24} tone="outline" /></span>
        <Tooltip content="新会话" side="right">
          <IconButton label="新建会话" variant="outline" size="md" onClick={startNew}>
            <MessageSquarePlus size={16} />
          </IconButton>
        </Tooltip>
        <Tooltip content="加入工作区" side="right">
          <IconButton label="加入工作区" variant="ghost" size="md" onClick={() => void pickWorkspace()}>
            <FolderPlus size={16} />
          </IconButton>
        </Tooltip>
        <span className="flex-1" />
        <Tooltip content="设置" side="right">
          <IconButton
            label="设置"
            variant="ghost"
            size="md"
            active={view === 'settings'}
            onClick={() => setView('settings')}
          >
            <Settings size={16} />
          </IconButton>
        </Tooltip>
      </nav>
    )
  }

  return (
    <nav
      id="primary-sidebar"
      aria-label="主导航"
      className="relative flex shrink-0 flex-col border-r border-line bg-surface"
      style={{ width: sidebarWidth }}
    >
      {/* 往右拖变宽；手势只算出增量，宽度约束在 `uiStore`（中列永远留着能读的宽度）。 */}
      <Splitter
        label="调整侧栏宽度"
        className="absolute top-0 -right-[2px] h-full"
        onResize={(delta) => setSidebarWidth(useUi.getState().sidebarWidth + delta)}
        onReset={() => setSidebarWidth(SIDEBAR_DEFAULT_WIDTH)}
      />      <button
        type="button"
        aria-label="会话"
        onClick={() => setView('chat')}
        className="flex h-[58px] items-center gap-2 border-b border-line px-4 text-left hover:bg-interactive/50"
      >
        <FoxMark size={25} tone="outline" />
        <span className="text-[18px] font-semibold tracking-[-0.01em] text-fg">FoxCode</span>
        <span className="sr-only">灵狐</span>
        <span className="rounded-sm bg-fg px-1.5 py-0.5 text-[9px] font-semibold tracking-wide text-canvas">HARNESS</span>
      </button>

      <div className="px-3 py-3">
        <button
          type="button"
          aria-label="新建会话"
          onClick={startNew}
          className="flex h-11 w-full items-center justify-center gap-2 rounded-lg border border-line-strong bg-canvas text-[14px] font-medium text-fg shadow-card hover:bg-surface-2"
        >
          <MessageSquarePlus size={16} />
          新会话
        </button>
      </div>

      <div className="flex gap-1 border-b border-line px-3 pb-3">
        {SECONDARY_NAV.slice(0, 3).map(({ view: target, label, icon: Icon }) => (
          <button
            key={target}
            type="button"
            onClick={() => setView(target)}
            className={cn(
              'flex h-8 flex-1 items-center justify-center gap-1.5 rounded-md text-[12px] text-fg-subtle hover:bg-interactive hover:text-fg',
              view === target && 'bg-interactive text-fg',
            )}
          >
            <Icon size={13} /> {label}
          </button>
        ))}
      </div>

      <section className="flex min-h-0 flex-1 flex-col">
        <header className="flex h-11 shrink-0 items-center gap-1 px-4">
          <span className="text-[13px] font-medium text-fg-subtle">工作区</span>
          <span className="flex-1" />
          <Tooltip content="搜索会话" side="bottom">
            <IconButton label="搜索会话" variant="ghost" size="xs" onClick={() => setSearching((value) => !value)}>
              <Search size={14} />
            </IconButton>
          </Tooltip>
          <Tooltip content="加入工作区目录" side="bottom">
            <IconButton label="加入工作区" variant="ghost" size="xs" onClick={() => void pickWorkspace()}>
              <FolderPlus size={15} />
            </IconButton>
          </Tooltip>
        </header>

        {searching ? (
          <div className="px-3 pb-2">
            <input
              autoFocus
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="搜索当前工作区会话"
              className="h-8 w-full rounded-md border border-line-strong bg-canvas px-2.5 text-[12px] text-fg outline-none focus:border-focus"
            />
          </div>
        ) : null}

        <div className="scroll-quiet min-h-0 flex-1 overflow-y-auto px-2 pb-3">
          {workspaces.map((workspace) => {
            const active = samePath(workspace, currentWorkspace) || samePath(workspace, host?.cwd)
            const expanded = expandedWorkspaces.has(normalize(workspace))
            const label = workspaceLabel(workspace, aliases)
            const workspaceSessions = orderedSessions.filter((session) =>
              session.cwd ? samePath(session.cwd, workspace) : active,
            )
            return (
              <div key={workspace} className="group/ws mb-1">
                <div className="flex items-center gap-0.5">
                  <button
                    type="button"
                    aria-expanded={expanded}
                    aria-label={`${expanded ? '折叠' : '展开'}工作区 ${label}`}
                    onClick={() => toggleWorkspace(workspace)}
                    className={cn(
                      'flex h-9 min-w-0 flex-1 items-center gap-2 rounded-md px-2 text-left text-[13px] text-fg-muted hover:bg-interactive hover:text-fg',
                      active && 'font-medium text-fg',
                    )}
                    title={workspace}
                  >
                    {expanded ? (
                      <FolderOpen size={15} className={active ? 'text-info' : undefined} />
                    ) : (
                      <Folder size={15} />
                    )}
                    <span className="min-w-0 flex-1 truncate">{label}</span>
                    <ChevronDown
                      size={13}
                      className={cn('text-fg-caption transition-transform', !expanded && '-rotate-90')}
                    />
                  </button>
                  <Tooltip content="在此工作区新建对话" side="bottom">
                    <IconButton
                      label={`在 ${label} 新建对话`}
                      variant="ghost"
                      size="xs"
                      className="opacity-0 group-hover/ws:opacity-100 focus-visible:opacity-100"
                      onClick={() => startNewIn(workspace)}
                    >
                      <MessageSquarePlus size={13} />
                    </IconButton>
                  </Tooltip>
                  <span className="opacity-0 transition-opacity group-hover/ws:opacity-100 focus-within:opacity-100 has-[[aria-expanded=true]]:opacity-100">
                    <WorkspaceMenu
                      path={workspace}
                      active={active}
                      label={`工作区操作 ${label}`}
                      triggerClassName="size-6 px-0"
                      onNewConversation={() => startNewIn(workspace)}
                    />
                  </span>
                </div>

                {expanded ? (
                  <div className="ml-2 border-l border-line pl-1.5">
                    {workspaceSessions.length === 0 ? (
                      <p className="px-2 py-2 text-[11px] text-fg-caption">还没有会话</p>
                    ) : (
                      workspaceSessions.map((session) => {
                        const selected = isCurrentSession(session)
                        const isPinned = pinned.includes(session.id)
                        return (
                          <div key={session.id} className="group relative">
                            <button
                              type="button"
                              aria-label={`打开会话 ${session.title || '新会话'}`}
                              onClick={() => void selectSession(session)}
                              className={cn(
                                'flex min-h-9 w-full items-center gap-2 rounded-md px-2 pr-7 text-left hover:bg-interactive',
                                selected && 'bg-interactive text-fg',
                              )}
                            >
                              <StatusDot tone={session.running ? 'warn' : selected ? 'success' : 'idle'} pulse={session.running} />
                              <span className="min-w-0 flex-1 truncate text-[12.5px] text-fg-muted">{session.title || '新会话'}</span>
                              {isPinned ? (
                                <Pin size={10} className="shrink-0 text-fg-caption" aria-hidden="true" />
                              ) : null}
                              <span className="shrink-0 text-[10px] text-fg-caption">
                                {session.running ? '运行中' : formatRelative(session.updatedAt)}
                              </span>
                            </button>
                            <span className="absolute top-1 right-0 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100 has-[[aria-expanded=true]]:opacity-100">
                              <SessionMenu
                                session={session}
                                live={selected}
                                label={`会话操作 ${session.title || '新会话'}`}
                                triggerClassName="size-7 px-0"
                              />
                            </span>
                          </div>
                        )
                      })
                    )}
                  </div>
                ) : null}
              </div>
            )
          })}
        </div>
      </section>

      <footer className="border-t border-line p-2">
        <button
          type="button"
          aria-label="设置"
          onClick={() => setView('settings')}
          className={cn(
            'flex h-9 w-full items-center gap-2 rounded-md px-2 text-[13px] text-fg-muted hover:bg-interactive hover:text-fg',
            view === 'settings' && 'bg-interactive text-fg',
          )}
        >
          <Settings size={15} /> 设置
          <span className="ml-auto font-mono text-[10px] text-fg-caption">{host?.hostVersion ?? 'offline'}</span>
        </button>
      </footer>
    </nav>
  )
}
