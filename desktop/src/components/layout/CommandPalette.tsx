import { useEffect, useMemo, useRef, useState } from 'react'
import {
  CircleStop,
  Download,
  FolderOpen,
  FolderTree,
  GitFork,
  Moon,
  PanelRight,
  PanelLeft,
  Plus,
  RefreshCw,
  Search,
  Sparkles,
  Wand2,
} from 'lucide-react'
import { Chip, Kbd } from '@/components/ui'
import { useSession } from '@/store/sessionStore'
import { useWorkspace, samePath, workspaceName } from '@/store/workspaceStore'
import { useUi, VIEW_LABEL } from '@/store/uiStore'
import { formatRelative, shortPath } from '@/lib/format'
import { cn } from '@/lib/cn'

interface PaletteItem {
  id: string
  group: string
  label: string
  hint?: string
  icon?: React.ReactNode
  keywords?: string
  run(): void
}

export function CommandPalette() {
  const open = useUi((s) => s.paletteOpen)
  const setPaletteOpen = useUi((s) => s.setPaletteOpen)
  const setView = useUi((s) => s.setView)
  const toggleTheme = useUi((s) => s.toggleTheme)
  const toggleSidebar = useUi((s) => s.toggleSidebar)
  const toggleInspector = useUi((s) => s.toggleInspector)
  const setInspectorTab = useUi((s) => s.setInspectorTab)

  const host = useSession((s) => s.host)
  const sessions = useSession((s) => s.sessions)
  const timeline = useSession((s) => s.timeline)
  const newSession = useSession((s) => s.newSession)
  const forkSession = useSession((s) => s.forkSession)
  const compact = useSession((s) => s.compact)
  const abort = useSession((s) => s.abort)
  const exportSession = useSession((s) => s.exportSession)
  const refreshHost = useSession((s) => s.refreshHost)
  const openSession = useSession((s) => s.openSession)
  const runCommand = useSession((s) => s.runCommand)
  const invokeSkill = useSession((s) => s.invokeSkill)
  const recentWorkspaces = useWorkspace((s) => s.recent)
  const pickWorkspace = useWorkspace((s) => s.pick)
  const openWorkspace = useWorkspace((s) => s.open)

  const [query, setQuery] = useState('')
  const [index, setIndex] = useState(0)
  const input = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!open) return
    setQuery('')
    setIndex(0)
    const node = input.current
    if (node) {
      node.focus()
      node.select()
    }
  }, [open])

  const busy = timeline.status === 'streaming' || timeline.status === 'compacting'

  const items = useMemo<PaletteItem[]>(() => {
    const list: PaletteItem[] = [
      ...(Object.keys(VIEW_LABEL) as Array<keyof typeof VIEW_LABEL>).map((view) => ({
        id: `view:${view}`,
        group: '前往',
        label: VIEW_LABEL[view],
        keywords: `view goto ${view}`,
        run: () => setView(view),
      })),
      {
        id: 'session:new',
        group: '会话',
        label: '新建会话',
        icon: <Plus size={13} />,
        keywords: 'new session',
        run: () => void newSession(),
      },
      {
        id: 'session:fork',
        group: '会话',
        label: '分叉当前会话',
        icon: <GitFork size={13} />,
        keywords: 'fork branch',
        run: () => void forkSession(),
      },
      {
        id: 'session:compact',
        group: '会话',
        label: '压缩上下文',
        icon: <Sparkles size={13} />,
        keywords: 'compact summarize',
        run: () => void compact(),
      },
      ...(busy
        ? [
            {
              id: 'session:abort',
              group: '会话',
              label: '中止当前运行',
              icon: <CircleStop size={13} />,
              keywords: 'stop abort cancel esc',
              run: () => void abort(),
            },
          ]
        : []),
      {
        id: 'session:export-md',
        group: '会话',
        label: '导出为 Markdown',
        icon: <Download size={13} />,
        keywords: 'export markdown',
        run: () => void exportSession('markdown'),
      },
      {
        id: 'session:export-json',
        group: '会话',
        label: '导出为 JSON',
        icon: <Download size={13} />,
        keywords: 'export json',
        run: () => void exportSession('json'),
      },
      {
        id: 'host:reload',
        group: '宿主',
        label: '重新加载宿主信息',
        icon: <RefreshCw size={13} />,
        keywords: 'reload refresh host',
        run: () => void refreshHost(),
      },
      {
        id: 'ui:theme',
        group: '界面',
        label: '切换深色 / 浅色',
        icon: <Moon size={13} />,
        keywords: 'theme dark light',
        run: () => toggleTheme(),
      },
      {
        id: 'ui:sidebar',
        group: '界面',
        label: '折叠 / 展开侧栏',
        icon: <PanelLeft size={13} />,
        keywords: 'sidebar ctrl+b',
        run: () => toggleSidebar(),
      },
      {
        id: 'ui:inspector',
        group: '界面',
        label: '折叠 / 展开检查器',
        icon: <PanelRight size={13} />,
        keywords: 'inspector panel ctrl+j',
        run: () => toggleInspector(),
      },
      {
        id: 'ui:inspector-usage',
        group: '界面',
        label: '检查器：用量',
        keywords: 'usage tokens cost',
        run: () => setInspectorTab('usage'),
      },
      {
        id: 'ui:inspector-files',
        group: '界面',
        label: '检查器：文件',
        keywords: 'files touched',
        run: () => setInspectorTab('files'),
      },
      ...(host?.commands ?? []).map((command) => ({
        id: `command:${command.name}`,
        group: '命令',
        label: `/${command.name}`,
        hint: command.description,
        keywords: `command slash ${command.name}`,
        run: () => {
          setView('chat')
          void runCommand(command.name)
        },
      })),
      ...(host?.skills ?? []).map((skill) => ({
        id: `skill:${skill.name}`,
        group: '技能',
        label: skill.name,
        hint: skill.description,
        icon: <Wand2 size={13} />,
        keywords: `skill ${skill.name}`,
        run: () => {
          setView('chat')
          void invokeSkill(skill.name)
        },
      })),
      ...sessions.slice(0, 6).map((session) => ({
        id: `recent:${session.id}`,
        group: '最近会话',
        label: session.title,
        hint: formatRelative(session.updatedAt),
        keywords: `session ${session.file}`,
        run: () => {
          setView('chat')
          void openSession(session.id)
        },
      })),
      {
        id: 'workspace:pick',
        group: '工作区',
        label: '切换工作区…',
        hint: host?.cwd ? shortPath(host.cwd, 34) : undefined,
        icon: <FolderOpen size={13} />,
        keywords: 'workspace cwd folder 目录 文件夹',
        run: () => void pickWorkspace(),
      },
      ...recentWorkspaces
        .filter((path) => !samePath(host?.cwd, path))
        .slice(0, 5)
        .map((path) => ({
          id: `workspace:${path}`,
          group: '工作区',
          label: `切换到 ${workspaceName(path)}`,
          hint: shortPath(path, 32),
          icon: <FolderTree size={13} />,
          keywords: `workspace ${path}`,
          run: () => void openWorkspace(path),
        })),
    ]
    return list
  }, [
    abort,
    busy,
    compact,
    exportSession,
    forkSession,
    host?.cwd,
    host?.commands,
    host?.skills,
    invokeSkill,
    newSession,
    openSession,
    openWorkspace,
    pickWorkspace,
    recentWorkspaces,
    refreshHost,
    runCommand,
    sessions,
    setInspectorTab,
    setView,
    toggleInspector,
    toggleSidebar,
    toggleTheme,
  ])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return items
    return items.filter((item) =>
      `${item.label} ${item.hint ?? ''} ${item.keywords ?? ''} ${item.group}`
        .toLowerCase()
        .includes(q),
    )
  }, [items, query])

  useEffect(() => {
    setIndex(0)
  }, [query])

  const grouped = useMemo(() => {
    const map = new Map<string, PaletteItem[]>()
    for (const item of filtered) {
      const bucket = map.get(item.group) ?? []
      bucket.push(item)
      map.set(item.group, bucket)
    }
    return [...map.entries()]
  }, [filtered])

  const run = (item: PaletteItem | undefined) => {
    if (!item) return
    item.run()
    setPaletteOpen(false)
  }

  if (!open) return null

  const active = filtered[Math.min(index, filtered.length - 1)]

  return (
    <div
      className="fixed inset-0 z-50 flex justify-center bg-black/35 pt-[12vh] backdrop-blur-[2px]"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) setPaletteOpen(false)
      }}
    >
      <div
        role="dialog"
        aria-label="命令面板"
        className="animate-rise flex h-fit max-h-[62vh] w-[600px] max-w-[92vw] flex-col overflow-hidden rounded-panel bg-overlay/95 backdrop-blur-[24px] shadow-[0_0_0_0.5px_var(--color-line-strong),0_24px_64px_-24px_rgb(0_0_0/0.72)]"
      >
        <div className="flex items-center gap-2 border-b border-line px-3 py-2">
          <Search size={14} className="shrink-0 text-fg-subtle" />
          <input
            ref={input}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                event.preventDefault()
                setPaletteOpen(false)
                return
              }
              if (event.key === 'ArrowDown') {
                event.preventDefault()
                setIndex((i) => (filtered.length ? (i + 1) % filtered.length : 0))
                return
              }
              if (event.key === 'ArrowUp') {
                event.preventDefault()
                setIndex((i) => (filtered.length ? (i - 1 + filtered.length) % filtered.length : 0))
                return
              }
              if (event.key === 'Enter') {
                event.preventDefault()
                run(active)
              }
            }}
            placeholder="搜索视图、命令、技能、会话…"
            className="min-w-0 flex-1 bg-transparent text-[13px] text-fg outline-none placeholder:text-fg-subtle"
          />
          <Chip size="xs" mono>
            {filtered.length}
          </Chip>
        </div>

        <div className="scroll-quiet min-h-0 flex-1 overflow-y-auto p-1">
          {filtered.length === 0 ? (
            <p className="px-3 py-6 text-center text-[12.5px] text-fg-subtle">没有匹配项</p>
          ) : (
            grouped.map(([group, groupItems]) => (
              <div key={group} className="pb-1">
                <div className="px-2 py-1.5 text-[11px] leading-[15px] text-fg-subtle">
                  {group}
                </div>
                {groupItems.map((item) => {
                  const position = filtered.indexOf(item)
                  return (
                    <button
                      key={item.id}
                      type="button"
                      onMouseMove={() => setIndex(position)}
                      onClick={() => run(item)}
                      className={cn(
                        'flex min-h-[34px] w-full items-center gap-2 rounded-md px-2 py-1.5 text-left',
                        'transition-colors duration-100',
                        position === index ? 'bg-interactive text-fg' : 'text-fg-muted hover:bg-interactive',
                      )}
                    >
                      <span className="flex h-4 w-4 shrink-0 items-center justify-center text-fg-subtle">
                        {item.icon ?? <Sparkles size={12} />}
                      </span>
                      <span className="min-w-0 shrink-0 truncate text-[12.5px] text-fg">
                        {item.label}
                      </span>
                      {item.hint ? (
                        <span className="min-w-0 flex-1 truncate text-2xs text-fg-subtle">
                          {item.hint}
                        </span>
                      ) : (
                        <span className="flex-1" />
                      )}
                    </button>
                  )
                })}
              </div>
            ))
          )}
        </div>

        <footer className="flex items-center gap-3 border-t border-line px-3 py-1.5 text-2xs text-fg-subtle">
          <span className="inline-flex items-center gap-1">
            <Kbd>↑</Kbd>
            <Kbd>↓</Kbd> 选择
          </span>
          <span className="inline-flex items-center gap-1">
            <Kbd>Enter</Kbd> 执行
          </span>
          <span className="inline-flex items-center gap-1">
            <Kbd>Esc</Kbd> 关闭
          </span>
        </footer>
      </div>
    </div>
  )
}
