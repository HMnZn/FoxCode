/**
 * TraceList — 「轨迹」视角：只看工具调用与压缩/重试/错误这类过程事件。
 *
 * 与 MessageList（会话视角：对话 + 思考）互补：这里不渲染助手正文与思考，
 * 而是把每个工具批次归到触发它的那条用户消息下，配上耗时/状态与通知事件。
 */
import { useEffect, useMemo, useRef } from 'react'
import { AlertTriangle, CheckCircle2, Info, Layers, Wrench, XCircle } from 'lucide-react'
import { Chip } from '@/components/ui'
import { NoticePart } from '@/components/content'
import { ToolCallCard } from '@/components/chat/ToolCallCard'
import type { Block, NoticeBlock, RunStatus, ToolsBlock } from '@/store/timeline'
import { formatClock, truncate } from '@/lib/format'
import { cn } from '@/lib/cn'

type TraceEntry =
  | { kind: 'tools'; id: string; ts: number; block: ToolsBlock; trigger?: string; turn: number }
  | { kind: 'notice'; id: string; ts: number; block: NoticeBlock }

const NOTICE_ICON: Record<NoticeBlock['tone'], typeof Info> = {
  info: Info,
  success: CheckCircle2,
  warn: AlertTriangle,
  danger: XCircle,
}

const NOTICE_TONE: Record<NoticeBlock['tone'], string> = {
  info: 'text-info',
  success: 'text-success',
  warn: 'text-warn',
  danger: 'text-danger',
}

function buildEntries(blocks: Block[]): TraceEntry[] {
  const entries: TraceEntry[] = []
  let trigger: string | undefined
  let turn = 0
  for (const block of blocks) {
    if (block.kind === 'user') {
      trigger = block.text
      turn += 1
      continue
    }
    if (block.kind === 'tools') {
      entries.push({
        kind: 'tools',
        id: block.id,
        ts: block.calls[0]?.startedAt ?? Date.now(),
        block,
        trigger,
        turn,
      })
      continue
    }
    if (block.kind === 'notice') {
      entries.push({ kind: 'notice', id: block.id, ts: block.ts, block })
    }
  }
  return entries
}

function ToolsEntry({
  block,
  trigger,
  turn,
}: {
  block: ToolsBlock
  trigger?: string
  turn: number
}) {
  const running = block.calls.filter((call) => call.status === 'running').length
  const awaiting = block.calls.filter((call) => call.status === 'awaiting-approval').length
  const failed = block.calls.filter((call) => call.status === 'error').length
  const blocked = block.calls.filter((call) => call.status === 'blocked').length
  const done = block.calls.length - running - awaiting

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <span className="inline-flex items-center gap-1.5 text-[12.5px] font-medium text-fg">
          <Layers size={13} className="text-fg-muted" />
          工具批次
          <span className="font-mono text-2xs text-fg-subtle">#{turn || 1}</span>
        </span>
        <Chip size="xs">
          {done}/{block.calls.length} 完成
        </Chip>
        {running ? (
          <Chip size="xs" tone="info">
            {running} 进行中
          </Chip>
        ) : null}
        {awaiting ? (
          <Chip size="xs" tone="warn">
            {awaiting} 等待授权
          </Chip>
        ) : null}
        {failed ? (
          <Chip size="xs" tone="danger">
            {failed} 出错
          </Chip>
        ) : null}
        {blocked ? (
          <Chip size="xs" tone="warn">
            {blocked} 被拒绝
          </Chip>
        ) : null}
      </div>

      {trigger ? (
        <div className="flex items-start gap-2 rounded-md border border-line/70 bg-surface/50 px-2.5 py-1.5">
          <span className="mt-0.5 shrink-0 text-2xs text-fg-subtle">触发</span>
          <span className="min-w-0 text-[12px] leading-5 text-fg-muted">
            {truncate(trigger.replace(/\s+/g, ' ').trim(), 140)}
          </span>
        </div>
      ) : null}

      <div className="flex flex-col gap-0.5">
        {block.calls.map((call) => (
          <ToolCallCard key={call.id} call={call} />
        ))}
      </div>
    </div>
  )
}

export interface TraceListProps {
  blocks: Block[]
  status: RunStatus
}

export function TraceList({ blocks, status }: TraceListProps) {
  const entries = useMemo(() => buildEntries(blocks), [blocks])
  const scroller = useRef<HTMLDivElement>(null)
  const stick = useRef(true)
  const tail = entries[entries.length - 1]
  const tailSize =
    tail?.kind === 'tools'
      ? tail.block.calls.reduce(
          (sum, call) => sum + call.updates.length + (call.result?.length ?? 0),
          0,
        )
      : (tail?.block.description?.length ?? 0)

  useEffect(() => {
    const node = scroller.current
    if (!node || !stick.current) return
    node.scrollTop = node.scrollHeight
  }, [entries.length, tailSize, status])

  const toolCalls = useMemo(
    () => blocks.reduce((sum, block) => (block.kind === 'tools' ? sum + block.calls.length : sum), 0),
    [blocks],
  )
  const notices = entries.filter((entry) => entry.kind === 'notice').length

  return (
    <div className="relative min-h-0 flex-1">
      <div
        ref={scroller}
        onScroll={() => {
          const node = scroller.current
          if (!node) return
          stick.current = node.scrollHeight - node.scrollTop - node.clientHeight < 64
        }}
        className="scroll-quiet h-full overflow-y-auto"
      >
        <div className="mx-auto flex w-full max-w-[920px] flex-col gap-4 px-4 py-5">
          <div className="flex flex-wrap items-center gap-2">
            <span className="inline-flex items-center gap-1.5 text-[13px] font-medium text-fg">
              <Wrench size={13} className="text-fg-muted" />
              执行轨迹
            </span>
            <Chip size="xs">{toolCalls} 次工具调用</Chip>
            <Chip size="xs">{notices} 条事件</Chip>
            {status === 'streaming' ? (
              <Chip size="xs" tone="info">
                运行中
              </Chip>
            ) : null}
          </div>

          {entries.length === 0 ? (
            <div className="flex flex-col items-center gap-2 py-16 text-center">
              <span className="flex h-9 w-9 items-center justify-center rounded-lg border border-line bg-surface-2 text-fg-subtle">
                <Wrench size={16} />
              </span>
              <p className="text-[13px] text-fg">还没有工具调用</p>
              <p className="max-w-[380px] text-2xs leading-5 text-fg-subtle">
                工具调用、压缩上下文与重试事件都会出现在这里；对话与思考在「会话」视角。
              </p>
            </div>
          ) : null}

          {entries.map((entry) =>
            entry.kind === 'tools' ? (
              <ToolsEntry key={entry.id} block={entry.block} trigger={entry.trigger} turn={entry.turn} />
            ) : (
              <div key={entry.id} className="flex flex-col gap-1">
                <div className="flex items-center gap-2 text-2xs text-fg-subtle">
                  {(() => {
                    const Icon = NOTICE_ICON[entry.block.tone] ?? Info
                    return <Icon size={12} className={cn(NOTICE_TONE[entry.block.tone])} />
                  })()}
                  <span className="font-mono tabular-nums">{formatClock(entry.ts)}</span>
                  {entry.block.title ? <span>{entry.block.title}</span> : null}
                </div>
                <NoticePart
                  tone={entry.block.tone}
                  title={entry.block.title}
                  description={entry.block.description}
                  collapsible={Boolean(entry.block.description && entry.block.description.length > 240)}
                />
              </div>
            ),
          )}
          <div className="h-2" />
        </div>
      </div>
    </div>
  )
}

/** Exported for tests: how many tool-call groups and notice events a trace shows. */
export function traceEntryCounts(blocks: Block[]): { tools: number; notices: number } {
  const entries = buildEntries(blocks)
  return {
    tools: entries.filter((entry) => entry.kind === 'tools').length,
    notices: entries.filter((entry) => entry.kind === 'notice').length,
  }
}
