import { useMemo, useState } from 'react'
import {
  Gauge,
  History,
  MessageSquare,
  Plus,
  Puzzle,
  Settings,
  Sparkles,
  Trash2,
} from 'lucide-react'
import { Button, Chip, ConfirmDialog, IconButton, Tooltip } from '@/components/ui'
import { FoxMark } from '@/components/brand/Fox'
import { basename, formatCost, formatRelative, formatTokens } from '@/lib/format'
import { useSession } from '@/store/sessionStore'
import { useUi, VIEW_LABEL, type View } from '@/store/uiStore'
import type { SessionSummary } from '@/types/protocol'
import { cn } from '@/lib/cn'

const NAV: Array<{ view: View; icon: typeof MessageSquare }> = [
  { view: 'chat', icon: MessageSquare },
  { view: 'sessions', icon: History },
  { view: 'skills', icon: Sparkles },
  { view: 'extensions', icon: Puzzle },
  { view: 'usage', icon: Gauge },
  { view: 'settings', icon: Settings },
]

export function Sidebar() {
  const collapsed = useUi((s) => s.sidebarCollapsed)
  const view = useUi((s) => s.view)
  const setView = useUi((s) => s.setView)
  const host = useSession((s) => s.host)
  const sessions = useSession((s) => s.sessions)
  const openSession = useSession((s) => s.openSession)
  const newSession = useSession((s) => s.newSession)
  const deleteSession = useSession((s) => s.deleteSession)
  const [pendingDelete, setPendingDelete] = useState<SessionSummary | null>(null)

  const isLive = (session: SessionSummary) =>
    session.live === true || (host?.sessionFile != null && session.file === host.sessionFile)

  const recent = useMemo(
    () => [...sessions].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 6),
    [sessions],
  )

  if (collapsed) {
    return (
      <nav
        aria-label="主导航"
        className="flex w-14 shrink-0 flex-col items-center gap-1 bg-surface px-2.5 pt-4 pb-1.5"
      >
        <span className="fox-tile size-8 shrink-0">
          <FoxMark size={20} />
        </span>
        <IconButton
          label="新建会话"
          variant="soft"
          size="md"
          className="mt-2"
          onClick={() => {
            setView('chat')
            void newSession()
          }}
        >
          <Plus size={15} />
        </IconButton>
        {NAV.map(({ view: target, icon: Icon }) => (
          <Tooltip key={target} content={VIEW_LABEL[target]} side="right">
            <IconButton
              label={VIEW_LABEL[target]}
              variant="ghost"
              size="md"
              className={cn(
                'text-fg-subtle',
                view === target && 'bg-interactive text-fg',
              )}
              onClick={() => setView(target)}
            >
              <Icon size={16} />
            </IconButton>
          </Tooltip>
        ))}
      </nav>
    )
  }

  return (
    <nav aria-label="主导航" className="flex w-[264px] shrink-0 flex-col bg-surface px-3 pt-1 pb-1.5">
      <div className="flex h-[60px] items-center gap-2 pb-1 pl-1">
        <span className="fox-tile size-6 shrink-0">
          <FoxMark size={17} />
        </span>
        <span className="flex min-w-0 flex-1 items-baseline gap-1.5">
          <span className="truncate text-[18px] leading-[24px] font-semibold tracking-[0.04em] text-fg">
            FoxCode
          </span>
          <span className="shrink-0 text-[11px] font-medium tracking-[0.2em] text-accent">
            灵狐
          </span>
        </span>
      </div>

      <Button
        variant="primary"
        size="md"
        block
        iconLeft={<Plus size={14} />}
        className="mx-0.5 mb-3 h-[38px]"
        onClick={() => {
          setView('chat')
          void newSession()
        }}
      >
        新建会话
      </Button>

      <div className="flex flex-col gap-1">
        {NAV.map(({ view: target, icon: Icon }) => (
          <button
            key={target}
            type="button"
            onClick={() => setView(target)}
            className={cn(
              'group mx-0.5 flex min-h-9 items-center gap-2 rounded-md px-2 py-[7px] text-left text-[13.5px] leading-5 transition-colors duration-150',
              view === target
                ? 'bg-interactive font-medium text-fg'
                : 'text-fg-muted hover:bg-interactive hover:text-fg',
            )}
          >
            <Icon size={15} className={cn(view === target ? 'text-fg' : 'text-fg-subtle')} />
            <span className="flex-1 truncate">{VIEW_LABEL[target]}</span>
          </button>
        ))}
      </div>

      <div className="mt-4 flex min-h-0 flex-1 flex-col px-0.5">
        <div className="mb-1.5 flex items-center justify-between px-1.5">
          <span className="text-[11px] font-medium tracking-[0.08em] text-fg-caption uppercase">
            最近会话
          </span>
          <Chip size="xs" mono>
            {sessions.length}
          </Chip>
        </div>
        <div className="scroll-quiet -mx-1 min-h-0 flex-1 overflow-y-auto px-1 pb-2">
          {recent.length === 0 ? (
            <p className="px-1.5 py-2 text-[12px] text-fg-caption">暂无历史会话</p>
          ) : (
            recent.map((session) => (
              <div key={session.id} className="group relative">
                <button
                  type="button"
                  onClick={() => {
                    setView('chat')
                    void openSession(session.id)
                  }}
                  className="flex w-full flex-col gap-0.5 rounded-md px-2 py-1.5 pr-7 text-left transition-colors hover:bg-interactive"
                >
                  <span className="flex items-center gap-1.5">
                    <span className="truncate text-[12.5px] text-fg-muted group-hover:text-fg">
                      {session.title}
                    </span>
                    {isLive(session) ? (
                      <Chip size="xs" tone="success">
                        当前
                      </Chip>
                    ) : null}
                  </span>
                  <span className="flex items-center gap-1.5 text-2xs text-fg-caption tabular-nums">
                    <span>{formatRelative(session.updatedAt)}</span>
                    <span className="opacity-40">·</span>
                    <span>{session.messageCount} 条</span>
                    <span className="opacity-40">·</span>
                    <span>{formatTokens(session.totalTokens)}</span>
                    {session.cost > 0 ? (
                      <>
                        <span className="opacity-40">·</span>
                        <span>{formatCost(session.cost)}</span>
                      </>
                    ) : null}
                  </span>
                </button>
                <Tooltip
                  content={isLive(session) ? '当前会话不能删除' : '删除会话'}
                  side="left"
                >
                  <IconButton
                    label={`删除会话 ${session.title}`}
                    variant="ghost"
                    size="xs"
                    disabled={isLive(session)}
                    className="absolute top-1 right-1 opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100 disabled:cursor-not-allowed disabled:opacity-30"
                    onClick={() => setPendingDelete(session)}
                  >
                    <Trash2 size={12} />
                  </IconButton>
                </Tooltip>
              </div>
            ))
          )}
        </div>
      </div>

      <footer className="flex items-center justify-between gap-2 border-t border-line px-1.5 pt-2.5">
        <span className="truncate font-mono text-2xs text-fg-caption">
          {host?.hostVersion ?? '未连接'}
        </span>
        <Chip size="xs" tone={host?.transport === 'mock' ? 'warn' : 'success'}>
          {host?.transport === 'mock' ? '演示' : 'sidecar'}
        </Chip>
      </footer>

      <ConfirmDialog
        open={pendingDelete != null}
        tone="danger"
        title="删除这个会话？"
        description={
          pendingDelete
            ? `将从磁盘删除 ${basename(pendingDelete.file)}，此操作不可撤销。`
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
    </nav>
  )
}
