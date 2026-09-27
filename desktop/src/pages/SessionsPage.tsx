/**
 * SessionsPage — 历史会话浏览器。
 *
 * 数据来自 `useSession().sessions`（宿主 `sessions.list` 的返回值），本地只做
 * 过滤 / 排序 / 统计，不复制任何会话状态：刷新、打开、新建、Fork、导出全部
 * 通过 sessionStore 的动作回到宿主。
 */
import { useDeferredValue, useMemo, useState, type MouseEvent } from 'react'
import { Download, FolderOpen, GitFork, Plus, RefreshCw, Search, Trash2 } from 'lucide-react'
import {
  Button,
  Chip,
  ConfirmDialog,
  EmptyState,
  IconButton,
  SegmentedControl,
  Select,
  StatusDot,
  TextInput,
  Tooltip,
} from '@/components/ui'
import { FoxMascot } from '@/components/brand/Fox'
import { useSession } from '@/store/sessionStore'
import { formatCost, formatRelative, formatTokens, shortPath } from '@/lib/format'
import type { SessionSummary } from '@/types/protocol'

type Scope = 'all' | 'workspace' | 'live'
type SortKey = 'updated' | 'created' | 'messages' | 'cost'

const SCOPE_OPTIONS: ReadonlyArray<{ value: Scope; label: string }> = [
  { value: 'all', label: '全部' },
  { value: 'workspace', label: '当前工作区' },
  { value: 'live', label: '活跃' },
]

const SORT_OPTIONS: ReadonlyArray<{ value: SortKey; label: string; hint: string }> = [
  { value: 'updated', label: '最近更新', hint: '按 updatedAt 降序' },
  { value: 'created', label: '创建时间', hint: '按 createdAt 降序' },
  { value: 'messages', label: '消息数', hint: '按 messageCount 降序' },
  { value: 'cost', label: '花费', hint: '按累计花费降序' },
]

/** 规范化路径，便于跨平台比较（宿主可能返回 Windows 或 POSIX 分隔符）。 */
function normalizePath(value: string): string {
  return value.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
}

export function SessionsPage() {
  const sessions = useSession((state) => state.sessions)
  const host = useSession((state) => state.host)
  const refreshSessions = useSession((state) => state.refreshSessions)
  const openSession = useSession((state) => state.openSession)
  const newSession = useSession((state) => state.newSession)
  const forkSession = useSession((state) => state.forkSession)
  const exportSession = useSession((state) => state.exportSession)
  const deleteSession = useSession((state) => state.deleteSession)

  const [query, setQuery] = useState('')
  const [scope, setScope] = useState<Scope>('all')
  const [sort, setSort] = useState<SortKey>('updated')
  const [refreshing, setRefreshing] = useState(false)
  const [pendingDelete, setPendingDelete] = useState<SessionSummary | null>(null)

  const deferredQuery = useDeferredValue(query)

  /** 当前工作目录：宿主未就绪时退回空串（比较结果恒为 false）。 */
  const hostCwd = normalizePath(host?.cwd ?? '')

  const visible = useMemo(() => {
    const needle = deferredQuery.trim().toLowerCase()
    const rows = sessions.filter((session) => {
      if (needle) {
        const haystack = `${session.title} ${session.id} ${session.cwd}`.toLowerCase()
        if (!haystack.includes(needle)) return false
      }
      if (scope === 'workspace') {
        if (!hostCwd) return false
        const cwd = normalizePath(session.cwd)
        if (cwd !== hostCwd && !cwd.startsWith(`${hostCwd}/`)) return false
      }
      if (scope === 'live' && !isLive(session, host?.sessionFile)) return false
      return true
    })

    const compare = (a: SessionSummary, b: SessionSummary): number => {
      switch (sort) {
        case 'created':
          return b.createdAt - a.createdAt
        case 'messages':
          return b.messageCount - a.messageCount
        case 'cost':
          return b.cost - a.cost
        case 'updated':
        default:
          return b.updatedAt - a.updatedAt
      }
    }
    return [...rows].sort(compare)
  }, [deferredQuery, host?.sessionFile, hostCwd, scope, sessions, sort])

  const stats = useMemo(
    () =>
      visible.reduce(
        (acc, session) => ({
          tokens: acc.tokens + (session.totalTokens ?? 0),
          cost: acc.cost + (session.cost ?? 0),
        }),
        { tokens: 0, cost: 0 },
      ),
    [visible],
  )

  const onRefresh = async () => {
    setRefreshing(true)
    try {
      await refreshSessions()
    } finally {
      setRefreshing(false)
    }
  }

  const onExport = (event: MouseEvent<HTMLElement>, format: 'json' | 'markdown') => {
    // 行本身可点击（打开会话），导出按钮必须吞掉冒泡事件。
    event.stopPropagation()
    void exportSession(format)
  }

  const filtered = query.trim().length > 0 || scope !== 'all'

  return (
    <div className="scroll-quiet flex h-full flex-col overflow-y-auto bg-canvas">
      <div className="mx-auto flex w-full max-w-[1100px] flex-col gap-4 p-6">
        <header className="flex flex-wrap items-center gap-2">
          <h1 className="text-[20px] leading-[28px] font-medium text-fg">历史会话</h1>
          <Chip size="sm" mono>
            {visible.length}
          </Chip>
          <span className="ml-auto flex items-center gap-2">
            <Button variant="secondary" iconLeft={<GitFork size={13} />} onClick={() => void forkSession()}>
              Fork 当前会话
            </Button>
            <Button variant="primary" iconLeft={<Plus size={13} />} onClick={() => void newSession()}>
              新建会话
            </Button>
            <IconButton label="刷新会话列表" onClick={() => void onRefresh()} loading={refreshing}>
              <RefreshCw size={14} aria-hidden="true" />
            </IconButton>
          </span>
        </header>

        <div className="flex flex-wrap items-center gap-2">
          <div className="w-[280px] min-w-[200px]">
            <TextInput
              size="sm"
              iconLeft={<Search size={13} aria-hidden="true" />}
              placeholder="搜索标题 / ID / 工作目录…"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onClear={() => setQuery('')}
              aria-label="搜索会话"
            />
          </div>
          <SegmentedControl
            value={scope}
            options={SCOPE_OPTIONS}
            onChange={setScope}
            size="sm"
            aria-label="会话范围"
          />
          <div className="ml-auto w-[150px]">
            <Select
              value={sort}
              options={SORT_OPTIONS}
              onChange={setSort}
              size="sm"
              align="end"
              aria-label="排序方式"
            />
          </div>
        </div>

        {visible.length === 0 ? (
          <EmptyState
            mascot={<FoxMascot size={92} />}
            title={sessions.length === 0 ? '还没有历史会话' : '没有匹配的会话'}
            description={
              sessions.length === 0
                ? '每一次会话都会以 JSONL 落盘，可以用「新建会话」开始第一次对话。'
                : filtered
                  ? '试试放宽搜索关键词、切换范围或换一个排序方式。'
                  : '刷新一次以重新读取宿主的会话目录。'
            }
            action={
              sessions.length === 0 ? (
                <Button variant="primary" iconLeft={<Plus size={13} />} onClick={() => void newSession()}>
                  新建会话
                </Button>
              ) : (
                <Button variant="outline" onClick={() => void onRefresh()} loading={refreshing}>
                  刷新
                </Button>
              )
            }
          />
        ) : (
          <div className="surface-card overflow-hidden">
            {visible.map((session, index) => {
              const live = isLive(session, host?.sessionFile)
              const tokens = session.totalTokens ?? 0
              const cost = session.cost ?? 0
              return (
                <div
                  key={session.id}
                  role="button"
                  tabIndex={0}
                  aria-label={`打开会话 ${session.title}`}
                  onClick={() => void openSession(session.id)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' || event.key === ' ') {
                      event.preventDefault()
                      void openSession(session.id)
                    }
                  }}
                  className={[
                    'group virtual-row flex cursor-pointer items-center gap-3 px-3 py-2.5 transition-colors',
                    'hover:bg-surface-2 focus-visible:bg-surface-2 focus-visible:outline-none',
                    index > 0 ? 'border-t border-line' : '',
                  ].join(' ')}
                >
                  {live ? (
                    <Tooltip content="当前活动会话" side="right" className="shrink-0">
                      <StatusDot tone="success" pulse />
                    </Tooltip>
                  ) : (
                    <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-fg-subtle/40" aria-hidden="true" />
                  )}

                  <div className="min-w-0 flex-1">
                    <div className="flex min-w-0 items-center gap-2">
                      <span className="truncate text-[13px] font-medium text-fg">
                        {session.title || '未命名会话'}
                      </span>
                      {live && (
                        <Chip size="xs" tone="success">
                          活跃
                        </Chip>
                      )}
                    </div>
                    <div className="mt-0.5 flex min-w-0 items-center gap-2 text-2xs text-fg-subtle">
                      <span className="shrink-0 font-mono">{formatRelative(session.updatedAt)}</span>
                      <span aria-hidden="true">·</span>
                      <span className="truncate font-mono" title={session.cwd}>
                        {session.cwd ? shortPath(session.cwd) : '（未记录目录）'}
                      </span>
                      <span aria-hidden="true">·</span>
                      <span className="shrink-0 font-mono">{session.id}</span>
                    </div>
                  </div>

                  <div className="hidden shrink-0 text-right text-2xs text-fg-subtle md:block md:w-[110px]">
                    <div className="truncate font-mono text-fg-muted" title={session.model ?? ''}>
                      {session.model ?? '—'}
                    </div>
                    <div className="font-mono tabular-nums">{session.messageCount} 条消息</div>
                  </div>

                  <div className="shrink-0 text-right text-2xs md:w-[130px]">
                    <div className="font-mono tabular-nums text-fg-muted">{formatTokens(tokens)} tokens</div>
                    <div className="font-mono tabular-nums text-fg-subtle">{formatCost(cost)}</div>
                  </div>

                  <span
                    className="flex shrink-0 items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100"
                    onClick={(event) => event.stopPropagation()}
                  >
                    <Tooltip content="导出为 JSON（含完整消息结构）" side="top">
                      <Button
                        size="xs"
                        variant="ghost"
                        iconLeft={<Download size={12} aria-hidden="true" />}
                        onClick={(event) => onExport(event, 'json')}
                      >
                        JSON
                      </Button>
                    </Tooltip>
                    <Tooltip content="导出为 Markdown（便于阅读与分享）" side="top">
                      <Button
                        size="xs"
                        variant="ghost"
                        iconLeft={<Download size={12} aria-hidden="true" />}
                        onClick={(event) => onExport(event, 'markdown')}
                      >
                        Markdown
                      </Button>
                    </Tooltip>
                    <Tooltip
                      content={live ? '当前活动会话不能删除' : '删除会话（不可撤销）'}
                      side="top"
                    >
                      <Button
                        size="xs"
                        variant="ghost"
                        disabled={live}
                        iconLeft={<Trash2 size={12} aria-hidden="true" />}
                        onClick={(event) => {
                          event.stopPropagation()
                          setPendingDelete(session)
                        }}
                      >
                        删除
                      </Button>
                    </Tooltip>
                  </span>
                </div>
              )
            })}
          </div>
        )}

        <footer className="flex flex-wrap items-center gap-2 border-t border-line pt-3 text-2xs text-fg-subtle">
          <FolderOpen size={12} aria-hidden="true" />
          <span>
            共 <span className="font-mono tabular-nums text-fg-muted">{visible.length}</span> 个会话
          </span>
          <span aria-hidden="true">·</span>
          <span>
            累计 <span className="font-mono tabular-nums text-fg-muted">{formatTokens(stats.tokens)}</span> tokens
          </span>
          <span aria-hidden="true">·</span>
          <span>
            花费 <span className="font-mono tabular-nums text-fg-muted">{formatCost(stats.cost)}</span>
          </span>
          {filtered && sessions.length !== visible.length && (
            <span className="ml-auto">
              已从 {sessions.length} 个会话中筛选
            </span>
          )}
        </footer>
      </div>

      <ConfirmDialog
        open={pendingDelete != null}
        tone="danger"
        title="删除这个会话？"
        description={
          pendingDelete
            ? `将从磁盘删除 ${pendingDelete.file}，此操作不可撤销。`
            : undefined
        }
        confirmLabel="删除"
        cancelLabel="取消"
        onCancel={() => setPendingDelete(null)}
        onConfirm={() => {
          const target = pendingDelete
          setPendingDelete(null)
          if (target) void deleteSession(target.id)
        }}
      />
    </div>
  )
}

/** 会话是否活跃：宿主置位 `live`，或它就是运行时当前的会话文件。 */
function isLive(session: SessionSummary, sessionFile: string | undefined): boolean {
  if (session.live === true) return true
  if (sessionFile == null || sessionFile === '') return false
  if (session.id === sessionFile) return true
  return normalizePath(session.file) === normalizePath(sessionFile)
}
