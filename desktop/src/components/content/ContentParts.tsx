import { memo, useEffect, useState } from 'react'
import type { ComponentType, ReactNode } from 'react'
import { AlertTriangle, Brain, CheckCircle2, ChevronRight, Info, Sparkles, XCircle } from 'lucide-react'
import { cn } from '@/lib/cn'
import { formatDuration, formatTokens } from '@/lib/format'
import { Markdown, StreamingMarkdown } from './Markdown'

type Icon = ComponentType<{ size?: number | string; className?: string }>

/* ------------------------------------------------------------------ *
 * TextPart
 * ------------------------------------------------------------------ */

export interface TextPartProps {
  text: string
  streaming?: boolean
  className?: string
}

function TextPartImpl({ text, streaming = false, className }: TextPartProps) {
  if (streaming) return <StreamingMarkdown content={text} streaming className={className} />
  return <Markdown content={text} className={className} />
}

export const TextPart = memo(TextPartImpl)
TextPart.displayName = 'TextPart'

/* ------------------------------------------------------------------ *
 * ThinkingPart
 * ------------------------------------------------------------------ */

export interface ThinkingPartProps {
  text: string
  streaming?: boolean
  durationMs?: number
  tokenCount?: number
  defaultExpanded?: boolean
  className?: string
}

const PROSE_CLASS =
  'border-l border-think/30 pl-3 text-fg-muted [&_*]:!text-fg-muted [&_code]:text-think [&_a]:text-think'

function ThinkingPartImpl({
  text,
  streaming = false,
  durationMs,
  tokenCount,
  defaultExpanded = false,
  className,
}: ThinkingPartProps) {
  // 默认折叠：思考过程只在用户点开时展开，流式期间也不自动展开
  // （折叠态会显示「思考中…」状态与一行预览，不打断阅读）。
  const [expanded, setExpanded] = useState<boolean>(defaultExpanded)
  const [userToggled, setUserToggled] = useState(false)

  useEffect(() => {
    // 用户手动切换过后就不再被 streaming 状态抢走控制权。
    if (userToggled) return
    if (!streaming && !defaultExpanded) setExpanded(false)
  }, [streaming, defaultExpanded, userToggled])

  const Icon: Icon = streaming ? Sparkles : Brain
  const hasBody = text.trim().length > 0

  return (
    <div className={cn('my-2 min-w-0', className)}>
      <button
        type="button"
        onClick={() => {
          setUserToggled(true)
          setExpanded((v) => !v)
        }}
        aria-expanded={expanded}
        className={cn(
          'group flex w-full items-center gap-1.5 rounded-sm py-0.5 text-left text-2xs transition-colors',
          streaming ? 'shimmer-text' : 'text-fg-subtle hover:text-fg-muted',
        )}
      >
        <ChevronRight
          size={12}
          className={cn('shrink-0 transition-transform duration-150', expanded && 'rotate-90')}
        />
        <Icon size={12} className="shrink-0 text-think" />
        <span className="shrink-0 font-medium">思考过程</span>
        {typeof durationMs === 'number' && durationMs > 0 ? (
          <span className="shrink-0 text-fg-subtle/80">{formatDuration(durationMs)}</span>
        ) : null}
        {typeof tokenCount === 'number' && tokenCount > 0 ? (
          <span className="shrink-0 text-fg-subtle/80">{formatTokens(tokenCount)} tokens</span>
        ) : null}
        {streaming ? <span className="shrink-0 text-fg-subtle/70">思考中…</span> : null}
        {!streaming && !expanded && hasBody ? (
          <span className="ml-auto shrink-0 text-fg-subtle/70 opacity-0 transition-opacity group-hover:opacity-100">
            展开
          </span>
        ) : null}
      </button>

      {expanded ? (
        <div className={cn('animate-fade mt-1 space-y-1 text-[12.5px] leading-[1.65] italic', PROSE_CLASS)}>
          {hasBody ? (
            streaming ? (
              <StreamingMarkdown content={text} streaming />
            ) : (
              <Markdown content={text} />
            )
          ) : (
            <span className="text-fg-subtle">…</span>
          )}
        </div>
      ) : null}

      {!expanded && hasBody ? (
        <div className="mt-0.5 truncate pl-[18px] text-[11.5px] text-fg-subtle/70 italic">
          {text.replace(/\s+/g, ' ').trim().slice(0, 160)}
        </div>
      ) : null}
    </div>
  )
}

export const ThinkingPart = memo(ThinkingPartImpl)
ThinkingPart.displayName = 'ThinkingPart'

/* ------------------------------------------------------------------ *
 * NoticePart
 * ------------------------------------------------------------------ */

export type NoticeTone = 'info' | 'success' | 'warn' | 'danger'

export interface NoticePartProps {
  tone: NoticeTone
  icon?: Icon
  title: string
  description?: ReactNode
  collapsible?: boolean
  className?: string
}

interface ToneStyle {
  wrap: string
  icon: string
  Icon: Icon
}

const TONE: Record<NoticeTone, ToneStyle> = {
  info: { wrap: 'border-info/35 bg-info-soft text-info', icon: 'text-info', Icon: Info },
  success: { wrap: 'border-success/35 bg-success-soft text-success', icon: 'text-success', Icon: CheckCircle2 },
  warn: { wrap: 'border-warn/35 bg-warn-soft text-warn', icon: 'text-warn', Icon: AlertTriangle },
  danger: { wrap: 'border-danger/35 bg-danger-soft text-danger', icon: 'text-danger', Icon: XCircle },
}

function NoticePartImpl({
  tone,
  icon,
  title,
  description,
  collapsible = false,
  className,
}: NoticePartProps) {
  const [open, setOpen] = useState(!collapsible)
  const style = TONE[tone] ?? TONE.info
  const Icon: Icon = icon ?? style.Icon
  const interactive = collapsible && description !== undefined && description !== null
  const shown = open && description !== undefined && description !== null

  return (
    <div
      className={cn(
        'my-2 flex min-w-0 items-start gap-2 rounded-md border px-2.5 py-2 text-[12.5px]',
        style.wrap,
        className,
      )}
    >
      <Icon size={14} className={cn('mt-[0.15em] shrink-0', style.icon)} />

      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-1.5">
          <div className={cn('min-w-0 font-medium text-fg', interactive && 'cursor-pointer select-none')}
            onClick={interactive ? () => setOpen((v) => !v) : undefined}
          >
            {title}
          </div>
          {interactive ? (
            <button
              type="button"
              onClick={() => setOpen((v) => !v)}
              aria-expanded={open}
              className="shrink-0 rounded-xs px-1 text-2xs text-fg-subtle transition-colors hover:bg-surface-3 hover:text-fg"
            >
              {open ? '收起' : '详情'}
            </button>
          ) : null}
        </div>

        {shown ? (
          <div className="animate-fade mt-0.5 min-w-0 text-fg-muted break-words">
            {typeof description === 'string' ? (
              <p className="my-0 whitespace-pre-wrap">{description}</p>
            ) : (
              description
            )}
          </div>
        ) : null}
      </div>
    </div>
  )
}

export const NoticePart = memo(NoticePartImpl)
NoticePart.displayName = 'NoticePart'
