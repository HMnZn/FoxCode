import { useMemo } from 'react'
import { AlertTriangle, GitFork, Plus, RotateCcw, ShieldCheck } from 'lucide-react'
import { Button, Chip, SegmentedControl, StatusDot, Tooltip } from '@/components/ui'
import { MessageList } from '@/components/chat/MessageList'
import { TraceList } from '@/components/chat/TraceList'
import { Composer } from '@/components/chat/Composer'
import { PermissionPrompt } from '@/components/chat/PermissionPrompt'
import { useSession } from '@/store/sessionStore'
import { CHAT_VIEW_LABEL, useUi, type ChatView } from '@/store/uiStore'
import { useWorkspace } from '@/store/workspaceStore'
import { basename, shortPath } from '@/lib/format'
import { cn } from '@/lib/cn'

const CHAT_VIEWS: ReadonlyArray<{ value: ChatView; label: string }> = [
  { value: 'chat', label: CHAT_VIEW_LABEL.chat },
  { value: 'trace', label: CHAT_VIEW_LABEL.trace },
]

function headerTitle(blocks: ReturnType<typeof useSession.getState>['timeline']['blocks'], fallback: string) {
  const first = blocks.find((block) => block.kind === 'user')
  if (first && first.kind === 'user') return first.text.split('\n')[0]?.slice(0, 80) ?? fallback
  return fallback
}

export function ChatPage() {
  const host = useSession((s) => s.host)
  const timeline = useSession((s) => s.timeline)
  const transport = useSession((s) => s.transport)
  const answerPermission = useSession((s) => s.answerPermission)
  const newSession = useSession((s) => s.newSession)
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

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-canvas">
      <header className="flex h-[52px] shrink-0 items-center gap-2 border-b border-line px-4">
        <div className="flex min-w-0 flex-col">
          <h1 className="truncate text-[13.5px] font-medium text-fg">{title}</h1>
          <span className="flex items-center gap-1.5 text-2xs text-fg-subtle">
            <StatusDot
              tone={
                transport.state === 'ready'
                  ? 'success'
                  : transport.state === 'connecting' || transport.state === 'degraded'
                    ? 'warn'
                    : 'danger'
              }
              pulse={transport.state === 'connecting'}
            />
            <span className="truncate">
              {transport.state === 'ready'
                ? 'Python sidecar 已连接'
                : transport.state === 'connecting'
                  ? '正在连接 sidecar…'
                  : transport.state === 'degraded'
                    ? `sidecar 降级${transport.detail ? `：${transport.detail}` : ''}`
                    : '演示宿主（未连接 Python）'}
            </span>
            {host?.cwd ? (
              <>
                <span className="opacity-40">·</span>
                <span className="truncate font-mono">{host.cwd}</span>
              </>
            ) : null}
          </span>
        </div>

        <div className="ml-auto flex items-center gap-1.5">
          <SegmentedControl
            aria-label="会话与轨迹切换"
            size="xs"
            value={chatView}
            options={CHAT_VIEWS}
            onChange={(next) => setChatView(next)}
          />
          {timeline.status === 'error' ? (
            <Chip size="xs" tone="danger">
              运行出错
            </Chip>
          ) : null}
          {timeline.totals.turns > 0 ? (
            <Chip size="xs">
              {timeline.totals.turns} 回合 · {timeline.totals.toolCalls} 工具
            </Chip>
          ) : null}
          <Tooltip content="压缩上下文" side="bottom">
            <Button variant="ghost" size="xs" iconLeft={<RotateCcw size={12} />} onClick={() => void compact()}>
              压缩
            </Button>
          </Tooltip>
          <Tooltip content="分叉当前会话（保留历史，另存新文件）" side="bottom">
            <Button variant="ghost" size="xs" iconLeft={<GitFork size={12} />} onClick={() => void forkSession()}>
              分叉
            </Button>
          </Tooltip>
          <Button variant="secondary" size="xs" iconLeft={<Plus size={12} />} onClick={() => void newSession()}>
            新会话
          </Button>
        </div>
      </header>

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
      ) : (
        <MessageList
          blocks={timeline.blocks}
          status={timeline.status}
          onSuggestion={(text) => setDraft(draftKey, text)}
        />
      )}

      <div className={cn('relative z-10 shrink-0 px-4 pb-3', 'bg-canvas')}>
        {pending.length > 0 ? (
          <div className="mx-auto mb-2 flex max-w-[920px] flex-col gap-2">
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

        <div className="mx-auto w-full max-w-[920px]">
          <Composer draftKey={draftKey} />
        </div>
      </div>
    </div>
  )
}
