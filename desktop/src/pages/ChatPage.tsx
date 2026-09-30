import { useMemo } from 'react'
import { AlertTriangle, Folder, GitFork, RotateCcw, ShieldCheck } from 'lucide-react'
import { Button, Chip, IconButton, Tooltip } from '@/components/ui'
import { MessageList } from '@/components/chat/MessageList'
import { TraceList } from '@/components/chat/TraceList'
import { Composer } from '@/components/chat/Composer'
import { SessionStatusBar } from '@/components/chat/SessionStatusBar'
import { PermissionPrompt } from '@/components/chat/PermissionPrompt'
import { useSession } from '@/store/sessionStore'
import { CHAT_VIEW_LABEL, useUi, type ChatView } from '@/store/uiStore'
import { useWorkspace } from '@/store/workspaceStore'
import { basename, displayUserText, shortPath } from '@/lib/format'
import { cn } from '@/lib/cn'
import { FoxMark } from '@/components/brand/Fox'

const CHAT_VIEWS: ReadonlyArray<{ value: ChatView; label: string }> = [
  { value: 'chat', label: CHAT_VIEW_LABEL.chat },
  { value: 'trace', label: CHAT_VIEW_LABEL.trace },
]

function headerTitle(blocks: ReturnType<typeof useSession.getState>['timeline']['blocks'], fallback: string) {
  const first = blocks.find((block) => block.kind === 'user')
  if (first && first.kind === 'user') return displayUserText(first.text).split('\n')[0]?.slice(0, 80) ?? fallback
  return fallback
}

export function ChatPage() {
  const host = useSession((s) => s.host)
  const timeline = useSession((s) => s.timeline)
  const answerPermission = useSession((s) => s.answerPermission)
  const forkSession = useSession((s) => s.forkSession)
  const compact = useSession((s) => s.compact)
  const setTrust = useSession((s) => s.setTrust)
  const setDraft = useUi((s) => s.setDraft)
  const chatView = useUi((s) => s.chatView)
  const setChatView = useUi((s) => s.setChatView)
  const failedWorkspace = useWorkspace((s) => s.failedFor)
  const workspaceError = useWorkspace((s) => s.lastError)
  const workspaceApplying = useWorkspace((s) => s.applying)
  const retryWorkspace = useWorkspace((s) => s.retry)

  const draftKey = host?.sessionFile ?? 'draft'
  // 会话视图保留工具调用：真实宿主里一轮经常只有工具、没有正文，折叠成一行
  // 让「调用了什么」可见，展开后才铺开参数与输出。
  const pending = useMemo(
    () => timeline.permissions.filter((request) => !timeline.decisions[request.id]),
    [timeline.permissions, timeline.decisions],
  )

  const title = headerTitle(
    timeline.blocks,
    host?.sessionFile ? basename(host.sessionFile).replace(/\.jsonl$/, '') : '新会话',
  )
  const hasConversation = timeline.blocks.some(
    (block) => block.kind !== 'notice' || block.title !== '会话已打开',
  )
  const emptySession = chatView === 'chat' && !hasConversation

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-canvas">
      {!emptySession ? <header className="grid h-[76px] shrink-0 grid-rows-[40px_36px] border-b border-line px-5 pt-2">
        <div className="flex min-w-0 items-center gap-2">
          <div className="flex min-w-0 flex-1 items-center gap-2">
            <h1 className="max-w-[420px] truncate text-[14px] font-medium text-fg">{title}</h1>
            {host?.cwd ? (
              <>
                <span className="text-fg-caption">/</span>
                <Tooltip content={host.cwd} side="bottom">
                  <span className="max-w-[260px] truncate text-[12px] text-fg-subtle">
                    {shortPath(host.cwd, 32)}
                  </span>
                </Tooltip>
              </>
            ) : null}
          </div>

          {timeline.status === 'error' ? <Chip size="xs" tone="danger">运行出错</Chip> : null}
          {timeline.totals.turns > 0 ? (
            <span className="hidden text-[11px] text-fg-caption xl:inline">
              {timeline.totals.turns} 回合 · {timeline.totals.toolCalls} 工具
            </span>
          ) : null}
          <Tooltip content="压缩上下文" side="bottom">
            <IconButton label="压缩上下文" size="sm" onClick={() => void compact()}>
              <RotateCcw size={14} />
            </IconButton>
          </Tooltip>
          <Tooltip content="分叉当前会话" side="bottom">
            <IconButton label="分叉当前会话" size="sm" onClick={() => void forkSession()}>
              <GitFork size={14} />
            </IconButton>
          </Tooltip>
        </div>

        <div role="group" aria-label="会话与轨迹切换" className="flex items-end gap-8 pl-2">
          {CHAT_VIEWS.map((option) => (
            <button
              key={option.value}
              type="button"
              aria-pressed={chatView === option.value}
              onClick={() => setChatView(option.value)}
              className={cn(
                'relative h-8 border-0 bg-transparent px-0 text-[13px] font-medium transition-colors',
                chatView === option.value ? 'text-info' : 'text-fg-subtle hover:text-fg',
                'after:absolute after:right-0 after:bottom-[-1px] after:left-0 after:h-0.5 after:rounded-full after:content-[\'\']',
                chatView === option.value ? 'after:bg-info' : 'after:bg-transparent',
              )}
            >
              {option.label}
            </button>
          ))}
        </div>
      </header> : null}

      {host?.projectTrusted === false ? (
        <div className="flex items-center gap-2 border-b border-warn/25 bg-warn-soft/50 px-4 py-1.5 text-2xs text-fg">
          <AlertTriangle size={13} className="shrink-0 text-warn" />
          <span>当前项目未受信任：宿主会在工具执行前静态拦截写入与命令。</span>
          <Button
            variant="secondary"
            size="xs"
            className="ml-auto"
            iconLeft={<ShieldCheck size={12} />}
            onClick={() => void setTrust(true)}
          >
            信任本项目
          </Button>
        </div>
      ) : null}

      {failedWorkspace ? (
        <div className="flex items-center gap-2 border-b border-warn/25 bg-warn-soft/50 px-4 py-1.5 text-2xs text-fg">
          <AlertTriangle size={13} className="shrink-0 text-warn" />
          <span className="line-clamp-2 min-w-0 flex-1 break-words">
            工作区未生效：{workspaceError ?? '宿主拒绝了这次切换'}
            {` · 目标 ${shortPath(failedWorkspace, 40)}`}
            {host?.cwd ? `，宿主仍停在 ${shortPath(host.cwd, 40)}` : ''}
          </span>
          <Button
            variant="secondary"
            size="xs"
            className="ml-auto"
            loading={workspaceApplying !== null}
            onClick={() => void retryWorkspace()}
          >
            重试切换
          </Button>
        </div>
      ) : null}

      {host?.sidecarError ? (
        <div className="flex items-center gap-2 border-b border-danger/25 bg-danger-soft/40 px-4 py-1.5 text-2xs text-danger">
          <AlertTriangle size={13} className="shrink-0" />
          <span className="truncate">sidecar: {host.sidecarError}</span>
        </div>
      ) : null}

      {chatView === 'trace' ? (
        <TraceList blocks={timeline.blocks} status={timeline.status} />
      ) : emptySession ? (
        <div className="scroll-quiet flex min-h-0 flex-1 overflow-y-auto px-6">
          <div className="mx-auto flex min-h-full w-full max-w-[1120px] flex-col justify-center pb-[10vh]">
            <div className="mb-8 flex flex-wrap items-center justify-center gap-3 text-center">
              <FoxMark size={34} tone="outline" label="FoxCode 灵狐" />
              <h2 className="text-[30px] leading-9 font-medium tracking-[-0.025em] text-fg">
                FoxCode
              </h2>
              <span className="rounded-full bg-info-soft px-2 py-0.5 text-[11px] text-info">预览版</span>
            </div>
            <div className="mb-3 flex items-center justify-center gap-7 px-4 text-[13px] text-fg-muted">
              <span className="inline-flex items-center gap-1.5 font-medium text-fg">
                <Folder size={15} /> {host?.cwd ? basename(host.cwd) : '工作区'}
              </span>
            </div>
            <Composer draftKey={draftKey} hero />
          </div>
        </div>
      ) : (
        <MessageList
          blocks={timeline.blocks}
          status={timeline.status}
          onSuggestion={(text) => setDraft(draftKey, text)}
        />
      )}

      {!emptySession ? <div
        className={cn(
          'relative z-10 -mt-9 shrink-0 px-4 pt-9 pb-3',
          'bg-[linear-gradient(180deg,transparent_0px,var(--color-canvas)_36px)]',
        )}
      >
        {pending.length > 0 ? (
          <div className="mx-auto mb-2 flex max-w-[952px] flex-col gap-2">
            {pending.map((request) => (
              <PermissionPrompt
                key={request.id}
                request={request}
                busy={false}
                onAnswer={(decision, reason) => void answerPermission(request.id, decision, reason)}
              />
            ))}
          </div>
        ) : null}

        <div className="mx-auto w-full max-w-[952px]">
          <Composer draftKey={draftKey} />
        </div>
      </div> : null}
      {!emptySession ? <SessionStatusBar /> : null}
    </div>
  )
}
