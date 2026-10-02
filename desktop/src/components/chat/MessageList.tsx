import { useEffect, useRef, useState } from 'react'
import { ArrowDown, Check, ChevronDown, ChevronRight, CornerDownLeft, FileCheck2, RefreshCw, Slash, Sparkles, Wrench, X } from 'lucide-react'
import { Button, Chip } from '@/components/ui'
import { FoxMascot } from '@/components/brand/Fox'
import { Markdown, NoticePart, StreamingMarkdown, ThinkingPart } from '@/components/content'
import { ToolCallCard } from '@/components/chat/ToolCallCard'
import type { AssistantBlock, Block, PlanBlock, RecoveryBlock, RunStatus, ToolsBlock, UserBlock } from '@/store/timeline'
import { useSession } from '@/store/sessionStore'
import { TOOL_STATUS_LABEL } from '@/types/protocol'
import { displayUserText, formatCost, formatTokens } from '@/lib/format'
import { cn } from '@/lib/cn'
import { useFiles } from '@/store/filesStore'
import { useRail } from '@/store/railStore'
import { preferredMode } from '@/lib/preview'

const STOP_LABEL: Record<string, string> = {
  stop: '完成',
  length: '达到长度上限',
  toolUse: '请求工具',
  error: '出错',
  aborted: '已中止',
  pending: '进行中',
}

/**
 * "The model ran out of output budget" has several spellings, and it is never a
 * success: on deepseek-style thinking formats the reasoning tokens come out of
 * the same `max_tokens`, so thinking mode makes this fire much earlier. Shown
 * inline (not only in the hover footer) because a truncated answer otherwise
 * looks like the model simply stopped talking.
 */
const TRUNCATED_REASONS = new Set(['length', 'max_tokens', 'maxTokens', 'max_output_tokens'])

const SUGGESTIONS = [
  '读一遍 packages/fox_agent_core/src/agent_loop.py，用中文讲清楚事件是怎么发出来的',
  '找出仓库里所有会写磁盘的地方，并按风险排序',
  '给 fox_ai 的 EventStream 补一组单元测试，覆盖取消与错误路径',
  '把 README.md:214 列出的「未实现项」整理成一份可执行路线图',
]

function UserBubble({ block }: { block: UserBlock }) {
  const text = displayUserText(block.text)
  return (
    <div className="flex justify-end">
      <div className="flex max-w-[70.2%] flex-col items-end gap-1.5">
        <div className="flex max-w-full flex-col gap-2 rounded-xl bg-bubble px-3 py-2.5 text-[14px] leading-[22px] whitespace-pre-wrap text-fg">
          {block.images?.length ? (
            <div className="grid max-w-[520px] grid-cols-2 gap-2">
              {block.images.map((image, index) => (
                <img
                  key={`${image.name}-${index}`}
                  src={`data:${image.mimeType};base64,${image.data}`}
                  alt={image.name || `图片 ${index + 1}`}
                  className="max-h-64 min-h-20 w-full rounded-lg object-contain bg-canvas/40"
                />
              ))}
            </div>
          ) : null}
          {text ? <span>{text}</span> : null}
        </div>
        {block.queued ? (
          <Chip size="xs" tone="info">
            {block.queued === 'steer' ? '插话中' : '排队中（当前任务结束后发送）'}
          </Chip>
        ) : null}
      </div>
    </div>
  )
}

function PlanCard({ block }: { block: PlanBlock }) {
  const answerPlan = useSession((state) => state.answerPlan)
  const pending = !block.decision
  const accepted = block.decision === 'accepted'
  return (
    <section className="overflow-hidden rounded-xl border border-info/30 bg-surface shadow-soft">
      <div className="flex items-center gap-2 border-b border-line bg-info-soft/35 px-4 py-3">
        <FileCheck2 size={16} className="text-info" aria-hidden="true" />
        <h3 className="text-[14px] font-medium text-fg">实施计划</h3>
        <Chip size="xs" tone={pending ? 'info' : accepted ? 'success' : 'neutral'}>
          {pending ? '等待确认' : accepted ? '已批准' : '暂不实施'}
        </Chip>
      </div>
      <div className="flex flex-col gap-4 px-4 py-4 text-[13px] leading-5 text-fg-muted">
        <p className="text-fg">{block.plan.summary}</p>
        <ol className="list-decimal space-y-1.5 pl-5">
          {block.plan.steps.map((step, index) => <li key={`${index}-${step}`}>{step}</li>)}
        </ol>
        {block.plan.files?.length ? (
          <div>
            <div className="mb-1 text-2xs font-medium tracking-wide text-fg-subtle">涉及文件</div>
            <div className="flex flex-wrap gap-1.5">
              {block.plan.files.map((file) => <code key={file} className="rounded bg-surface-3 px-1.5 py-0.5 text-[11px]">{file}</code>)}
            </div>
          </div>
        ) : null}
        {block.plan.verification?.length ? (
          <div>
            <div className="mb-1 text-2xs font-medium tracking-wide text-fg-subtle">验证</div>
            <ul className="list-disc space-y-1 pl-5">
              {block.plan.verification.map((item) => <li key={item}>{item}</li>)}
            </ul>
          </div>
        ) : null}
        {block.plan.risks?.length ? (
          <div>
            <div className="mb-1 text-2xs font-medium tracking-wide text-warn">风险</div>
            <ul className="list-disc space-y-1 pl-5">
              {block.plan.risks.map((item) => <li key={item}>{item}</li>)}
            </ul>
          </div>
        ) : null}
        {pending ? (
          <div className="flex justify-end gap-2 border-t border-line pt-3">
            <Button variant="ghost" size="sm" onClick={() => void answerPlan(block.toolCallId, 'reject')}>
              <X size={13} /> 暂不实施
            </Button>
            <Button size="sm" onClick={() => void answerPlan(block.toolCallId, 'accept')}>
              <Check size={13} /> 开始实施
            </Button>
          </div>
        ) : null}
      </div>
    </section>
  )
}

function AssistantBlockView({ block }: { block: AssistantBlock }) {
  const showThinking = block.thinking.length > 0 || block.thinkingStreaming
  return (
    <div className="group flex flex-col gap-1.5">
      {showThinking ? (
        <ThinkingPart
          text={block.thinking}
          streaming={block.thinkingStreaming}
          durationMs={block.thinkingMs}
        />
      ) : null}

      {block.text ? (
        block.textStreaming ? (
          <StreamingMarkdown content={block.text} streaming />
        ) : (
          <Markdown content={block.text} />
        )
      ) : null}

      {block.error && block.stopReason !== 'aborted' ? (
        <NoticePart tone="danger" title="模型调用失败" description={block.error} />
      ) : null}

      {TRUNCATED_REASONS.has(block.stopReason ?? '') ? (
        <NoticePart
          tone="warn"
          title="达到输出上限"
          description="这次回答被 max_tokens 截断了。思考与正文共享同一个上限，可在模型设置中提高最大输出。"
        />
      ) : null}

      <div
        className={cn(
          'flex items-center gap-2 text-2xs text-fg-subtle opacity-0 transition-opacity',
          'group-hover:opacity-100',
          block.textStreaming && 'opacity-100',
        )}
      >
        {block.textStreaming ? (
          <>
            <span className="text-accent">{block.thinkingStreaming ? '思考中…' : '生成中…'}</span>
            <span className="opacity-40">·</span>
          </>
        ) : null}
        {block.model ? <span className="font-mono">{block.model}</span> : null}
        {block.usage ? (
          <>
            <span className="opacity-40">·</span>
            <span className="font-mono tabular-nums">↑{formatTokens(block.usage.input)}</span>
            <span className="font-mono tabular-nums">↓{formatTokens(block.usage.output)}</span>
            {block.usage.cacheRead ? (
              <span className="font-mono tabular-nums">
                cache {formatTokens(block.usage.cacheRead)}
              </span>
            ) : null}
            {block.usage.cost ? (
              <span className="font-mono">{formatCost(block.usage.cost.total)}</span>
            ) : null}
          </>
        ) : null}
        {block.stopReason ? (
          <>
            <span className="opacity-40">·</span>
            <span>{STOP_LABEL[block.stopReason] ?? block.stopReason}</span>
          </>
        ) : null}
      </div>
    </div>
  )
}

/** `read_file ×2 · bash` — unique tool names in call order, repeats counted. */
function callNames(block: ToolsBlock): string {
  const seen = new Map<string, number>()
  for (const call of block.calls) {
    const name = call.name || 'tool'
    seen.set(name, (seen.get(name) ?? 0) + 1)
  }
  return Array.from(seen, ([name, count]) => (count > 1 ? `${name} ×${count}` : name)).join(' · ')
}

function ToolsBlockView({ block }: { block: ToolsBlock }) {
  const [open, setOpen] = useState(false)
  const pending = block.calls.filter(
    (call) => call.status === 'running' || call.status === 'awaiting-approval',
  ).length
  const failed = block.calls.filter(
    (call) => call.status === 'error' || call.status === 'blocked',
  ).length
  // Approvals are answered above the composer, but the row that explains *what*
  // is asking for permission must not stay folded while it waits on the user.
  const asks = block.calls.some((call) => call.status === 'awaiting-approval')
  const resultPreview =
    block.calls.length === 1 && block.calls[0].result
      ? block.calls[0].result.split(/\r?\n/, 1)[0].trim()
      : ''

  useEffect(() => {
    if (asks) setOpen(true)
  }, [asks])

  return (
    <div className="flex flex-col gap-1">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        className="flex min-h-[34px] w-full items-center gap-2 rounded-md px-2 text-left text-[13px] leading-5 text-fg-muted transition-colors hover:bg-interactive hover:text-fg"
      >
        <ChevronRight
          size={13}
          className={cn('shrink-0 text-fg-subtle transition-transform', open && 'rotate-90')}
          aria-hidden="true"
        />
        <span className="shrink-0 text-fg-subtle">{block.calls.length} 项工具调用</span>
        <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-fg-muted">
          {callNames(block)}
          {resultPreview ? <span className="text-fg-subtle"> · {resultPreview}</span> : null}
        </span>
        {failed ? <span className="shrink-0 text-danger">{failed} 失败</span> : null}
        {pending ? <span className="shrink-0 text-accent">{pending} 运行中</span> : null}
        <span className="shrink-0 text-2xs text-fg-subtle">{open ? '收起' : '展开'}</span>
      </button>

      {open ? (
        <div className="flex flex-col gap-1">
          {block.calls.map((call) => (
            <ToolCallCard key={call.id} call={call} />
          ))}
        </div>
      ) : null}
    </div>
  )
}

function RecoveryCard({ block }: { block: RecoveryBlock }) {
  const retrying = block.status === 'retrying'
  const recovered = block.status === 'recovered'
  const title = block.recovery === 'context'
    ? retrying ? '正在恢复上下文窗口' : recovered ? '上下文恢复完成' : '上下文恢复失败'
    : retrying ? '正在恢复模型连接' : recovered ? '模型连接已恢复' : '模型调用失败'
  return (
    <section className={cn(
      'my-2 overflow-hidden rounded-lg border bg-surface shadow-soft',
      retrying ? 'border-warn/30' : recovered ? 'border-success/30' : 'border-danger/30',
    )} aria-label={title}>
      <div className="flex items-center gap-2 border-b border-line px-3 py-2.5">
        <RefreshCw
          size={14}
          aria-hidden="true"
          className={cn(retrying && 'animate-spin text-warn', recovered && 'text-success', block.status === 'failed' && 'text-danger')}
        />
        <span className="text-[12.5px] font-medium text-fg">{title}</span>
        <Chip size="xs" tone={retrying ? 'warn' : recovered ? 'success' : 'danger'}>
          {block.attempts.length} 次重试
        </Chip>
      </div>
      <div className="flex flex-col gap-1.5 px-3 py-2.5 text-2xs text-fg-muted">
        {block.attempts.map((item) => (
          <div key={`${item.attempt}:${item.ts}`} className="grid min-w-0 grid-cols-[48px_minmax(0,1fr)] gap-2">
            <span className="font-medium text-fg-subtle">第 {item.attempt} 次</span>
            <span className="min-w-0 break-words font-mono">{item.message}</span>
          </div>
        ))}
        {block.finalError ? (
          <div className="mt-1 border-t border-line pt-2 text-danger">最终错误：{block.finalError}</div>
        ) : null}
      </div>
    </section>
  )
}

function BlockView({ block }: { block: Block }) {
  switch (block.kind) {
    case 'user':
      return <UserBubble block={block} />
    case 'assistant':
      return <AssistantBlockView block={block} />
    case 'tools':
      return <ToolsBlockView block={block} />
    case 'plan':
      return <PlanCard block={block} />
    case 'notice':
      return (
        <NoticePart
          tone={block.tone}
          title={block.title}
          description={block.description}
          collapsible={Boolean(block.description && block.description.length > 240)}
        />
      )
    case 'recovery':
      return <RecoveryCard block={block} />
    default:
      return null
  }
}

/** Compact completion artifact; every row opens the real diff in the right rail. */
function EditedFilesCard() {
  const changes = useFiles((state) => state.changes)
  const openFile = useRail((state) => state.openFile)
  const openFiles = useRail((state) => state.openFiles)
  const [expanded, setExpanded] = useState(false)
  // Git's `files` may include edits that existed before this conversation.
  // Completion cards only claim files observed after the host baseline.
  const files = changes?.sessionFiles ?? (changes?.repo ? [] : changes?.files ?? [])
  if (!files.length) return null
  const shown = expanded ? files : files.slice(0, 4)
  const additions = files.reduce((total, file) => total + file.additions, 0)
  const deletions = files.reduce((total, file) => total + file.deletions, 0)
  return (
    <section className="overflow-hidden rounded-xl border border-line bg-surface shadow-soft">
      <button
        type="button"
        onClick={openFiles}
        className="flex w-full items-center gap-3 border-b border-line px-4 py-3 text-left hover:bg-interactive"
      >
        <FileCheck2 size={16} className="text-fg-muted" aria-hidden="true" />
        <span className="font-medium text-fg">已编辑 {files.length} 个文件</span>
        <span className="font-mono text-[11px]">
          {additions ? <span className="text-success">+{additions}</span> : null}
          {additions && deletions ? ' ' : null}
          {deletions ? <span className="text-danger">−{deletions}</span> : null}
        </span>
        <span className="ml-auto text-2xs text-fg-subtle">在工作区改动中查看</span>
      </button>
      <div className="divide-y divide-line/70">
        {shown.map((file) => (
          <button
            type="button"
            key={`${file.status}-${file.path}`}
            onClick={() => openFile(file.path, preferredMode(file.path, 'diff'))}
            className="flex min-h-9 w-full items-center gap-3 px-4 text-left text-xs hover:bg-interactive"
          >
            <span className="min-w-0 flex-1 truncate font-mono text-fg-muted">{file.display}</span>
            <span className="shrink-0 font-mono text-[11px]">
              {file.additions ? <span className="text-success">+{file.additions}</span> : null}
              {file.additions && file.deletions ? ' ' : null}
              {file.deletions ? <span className="text-danger">−{file.deletions}</span> : null}
            </span>
          </button>
        ))}
      </div>
      {files.length > 4 ? (
        <button
          type="button"
          onClick={() => setExpanded((value) => !value)}
          className="flex w-full items-center gap-1 border-t border-line px-4 py-2 text-2xs text-fg-subtle hover:bg-interactive hover:text-fg"
        >
          <ChevronDown size={12} className={cn('transition-transform', expanded && 'rotate-180')} />
          {expanded ? '收起' : `再显示 ${files.length - 4} 个文件`}
        </button>
      ) : null}
    </section>
  )
}

function Welcome({ onSuggestion }: { onSuggestion?: (text: string) => void }) {
  const hints = [
    { icon: CornerDownLeft, label: 'Enter 发送', detail: 'Shift + Enter 换行' },
    { icon: Slash, label: '/ 唤起命令', detail: '技能、模板、会话命令' },
    { icon: Sparkles, label: 'Ctrl + K', detail: '命令面板' },
    { icon: Wrench, label: '工具卡片', detail: '点击展开参数与输出' },
  ]
  return (
    <div className="flex min-h-[60vh] flex-col items-center justify-center gap-7 px-6">
      <div className="flex flex-col items-center gap-3">
        <div className="relative grid place-items-center">
          <span
            className="pointer-events-none absolute size-36 rounded-full bg-fox-glow blur-3xl"
            aria-hidden="true"
          />
          <FoxMascot size={118} className="relative animate-rise" label="FoxCode 灵狐" />
        </div>
        <h1 className="text-[20px] leading-[28px] font-medium text-fg">开始一段新会话</h1>
        <p className="max-w-[440px] text-center text-[12.5px] leading-5 text-fg-muted">
          这个界面直接消费 <span className="font-mono text-fg-muted">AgentSessionRuntime</span> 的事件流：
          文本、思考、工具调用与授权请求都是真实协议帧。没有连接 Python sidecar 时，界面运行在演示宿主上。
        </p>
      </div>

      <div className="grid w-full max-w-[800px] grid-cols-1 gap-3 sm:grid-cols-2">
        {SUGGESTIONS.map((text) => (
          <button
            key={text}
            type="button"
            onClick={() => onSuggestion?.(text)}
            className="flex min-h-14 w-full items-center gap-3.5 rounded-xl border-[0.5px] border-line-heavy bg-surface px-5 py-3.5 text-left text-[14px] leading-[1.4] text-fg-muted transition-colors hover:bg-interactive hover:text-fg [corner-shape:round]"
          >
            {text}
          </button>
        ))}
      </div>

      <div className="flex flex-wrap items-center justify-center gap-x-5 gap-y-2 text-2xs text-fg-subtle">
        {hints.map(({ icon: Icon, label, detail }) => (
          <span key={label} className="inline-flex items-center gap-1.5">
            <Icon size={12} />
            <span>{label}</span>
            <span className="opacity-60">{detail}</span>
          </span>
        ))}
      </div>
    </div>
  )
}

export interface MessageListProps {
  blocks: Block[]
  status: RunStatus
  onSuggestion?(text: string): void
}

export function MessageList({ blocks, status, onSuggestion }: MessageListProps) {
  const scroller = useRef<HTMLDivElement>(null)
  const stick = useRef(true)
  const [showJump, setShowJump] = useState(false)

  const onScroll = () => {
    const node = scroller.current
    if (!node) return
    const distance = node.scrollHeight - node.scrollTop - node.clientHeight
    stick.current = distance < 64
    setShowJump(distance > 240)
  }

  // A cheap change signal: last block length + streaming text length.
  const tail = blocks[blocks.length - 1]
  const tailSize =
    tail?.kind === 'assistant'
      ? tail.text.length + tail.thinking.length
      : tail?.kind === 'tools'
        ? tail.calls.reduce((sum, c) => sum + c.updates.length + (c.result?.length ?? 0), 0)
        : 0

  useEffect(() => {
    const node = scroller.current
    if (!node || !stick.current) return
    node.scrollTop = node.scrollHeight
  }, [blocks.length, tailSize, status])

  return (
    <div className="relative min-h-0 flex-1">
      <div ref={scroller} onScroll={onScroll} className="scroll-quiet h-full overflow-y-auto">
        <div className="mx-auto flex w-full max-w-[984px] flex-col gap-4 px-8 py-4">
          {blocks.length === 0 ? <Welcome onSuggestion={onSuggestion} /> : null}
          {blocks.map((block) => (
            <BlockView key={block.id} block={block} />
          ))}
          {status === 'idle' && blocks.length > 0 ? <EditedFilesCard /> : null}
          <div className="h-2" />
        </div>
      </div>

      {showJump ? (
        <button
          type="button"
          onClick={() => {
            const node = scroller.current
            if (node) node.scrollTop = node.scrollHeight
            stick.current = true
            setShowJump(false)
          }}
          className="absolute bottom-4 left-1/2 flex h-7 -translate-x-1/2 items-center gap-1.5 rounded-full border border-line bg-surface-2/95 px-3 text-2xs text-fg-muted shadow-elev-2 backdrop-blur hover:text-fg"
        >
          <ArrowDown size={12} />
          跳到最新
        </button>
      ) : null}

      {status === 'compacting' ? (
        <div className="pointer-events-none absolute inset-x-0 top-0 flex justify-center pt-2">
          <Chip size="xs" tone="info">
            正在压缩上下文…
          </Chip>
        </div>
      ) : null}
    </div>
  )
}

export { TOOL_STATUS_LABEL }
