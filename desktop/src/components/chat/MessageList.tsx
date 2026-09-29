import { useEffect, useRef, useState } from 'react'
import { ArrowDown, ChevronRight, CornerDownLeft, Slash, Sparkles, Wrench } from 'lucide-react'
import { Chip } from '@/components/ui'
import { FoxMascot } from '@/components/brand/Fox'
import { Markdown, NoticePart, StreamingMarkdown, ThinkingPart } from '@/components/content'
import { ToolCallCard } from '@/components/chat/ToolCallCard'
import type { AssistantBlock, Block, RunStatus, ToolsBlock, UserBlock } from '@/store/timeline'
import { TOOL_STATUS_LABEL } from '@/types/protocol'
import { formatCost, formatTokens } from '@/lib/format'
import { cn } from '@/lib/cn'

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
  return (
    <div className="flex justify-end">
      <div className="flex max-w-[70.2%] flex-col items-end gap-1.5">
        <div className="rounded-xl bg-bubble px-4 py-2.5 text-[14px] leading-[22px] whitespace-pre-wrap text-fg">
          {block.text}
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
        <NoticePart tone="danger" title="本轮出错" description={block.error} />
      ) : null}

      {TRUNCATED_REASONS.has(block.stopReason ?? '') ? (
        <NoticePart
          tone="warn"
          title="达到输出上限"
          description="这次回答被 max_tokens 截断了。思考与正文共享同一个上限，可在 ~/.foxcode/settings.json 的 stream_options.max_tokens 调大它（比如 65536）。"
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

function BlockView({ block }: { block: Block }) {
  switch (block.kind) {
    case 'user':
      return <UserBubble block={block} />
    case 'assistant':
      return <AssistantBlockView block={block} />
    case 'tools':
      return <ToolsBlockView block={block} />
    case 'notice':
      return (
        <NoticePart
          tone={block.tone}
          title={block.title}
          description={block.description}
          collapsible={Boolean(block.description && block.description.length > 240)}
        />
      )
    default:
      return null
  }
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
