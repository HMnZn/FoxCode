import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties, ReactNode, UIEvent } from 'react'
import { AlertTriangle, Check, ChevronDown, ChevronRight, Copy, Loader2, Terminal } from 'lucide-react'
import { cn } from '@/lib/cn'

/* ------------------------------------------------------------------ *
 * ToolOutput — terminal-like renderer for stdout/stderr with ANSI
 * handling. Safe at import time: no window/document access.
 * ------------------------------------------------------------------ */

export interface ToolOutputProps {
  stdout?: string
  stderr?: string
  exitCode?: number | null
  truncated?: boolean
  /** Default 320; 0 disables the height cap. */
  maxHeight?: number
  emptyHint?: string
  language?: string
  streaming?: boolean
  onCopy?: (text: string) => void
}

export interface CliLineProps {
  text: string
  tone?: 'default' | 'success' | 'danger' | 'muted'
  prompt?: string
}

export interface OutputSectionProps {
  label: string
  children: ReactNode
  collapsible?: boolean
  defaultCollapsed?: boolean
  className?: string
  count?: number
}

/* ------------------------------------------------------------------ *
 * ANSI parsing — SGR colour/bold only, everything else stripped
 * ------------------------------------------------------------------ */

export type AnsiTone = 'default' | 'bold' | 'muted' | 'info' | 'success' | 'warn' | 'danger' | 'think' | 'accent'

export interface AnsiSegment {
  text: string
  className: string
}

const TONE_CLASS: Record<AnsiTone, string> = {
  default: '',
  bold: 'font-semibold text-fg',
  muted: 'text-fg-muted',
  info: 'text-info',
  success: 'text-success',
  warn: 'text-warn',
  danger: 'text-danger',
  think: 'text-think',
  accent: 'text-accent',
}

const FG_TONES: Record<number, AnsiTone> = {
  30: 'muted',
  31: 'danger',
  32: 'success',
  33: 'warn',
  34: 'info',
  35: 'think',
  36: 'think',
  37: 'muted',
  90: 'muted',
  91: 'danger',
  92: 'success',
  93: 'warn',
  94: 'info',
  95: 'think',
  96: 'think',
  97: 'muted',
}

/**
 * ANSI escape matcher.
 *  - OSC: ESC ] … BEL | ST  (window titles and friends)
 *  - CSI: ESC [ params final-byte
 *  - other Fe/Fs escapes: ESC followed by a single byte
 */
const ANSI_RE = /\u001b\][\s\S]*?(?:\u0007|\u001b\\)|\u001b\[[0-9;?]*[a-zA-Z@`~]|\u001b[@-Z\\-_]/g
/** C0 controls that are not tab / newline (already split) / carriage return. */
const OTHER_C0_RE = /[\u0000-\u0008\u000b-\u001f\u007f]/g

/** Strip every ANSI escape sequence from a chunk of text. */
export function stripAnsi(text: string): string {
  if (typeof text !== 'string' || text.length === 0) return ''
  return text.replace(ANSI_RE, '').replace(OTHER_C0_RE, '')
}

function hasAnsi(text: string): boolean {
  return text.indexOf('\u001b') !== -1
}

/** True when the slice starting at `index` is an SGR sequence; returns its end. */
function sgrEndAt(text: string, index: number): number {
  if (text.charCodeAt(index) !== 0x1b || text.charCodeAt(index + 1) !== 0x5b) return -1
  let i = index + 2
  while (i < text.length) {
    const code = text.charCodeAt(i)
    if (code >= 0x30 && code <= 0x39) {
      i += 1
      continue
    }
    if (code === 0x3b) {
      i += 1
      continue
    }
    return code === 0x6d ? i + 1 : -1
  }
  return -1
}

/**
 * Strip ANSI escapes and split the text into coloured segments per line.
 * Supports the 8/16 SGR fg codes (30–37, 90–97), bold (1m), and reset (0m/22m/39m);
 * unsupported sequences are dropped without leaking control characters.
 */
export function parseAnsi(text: string): AnsiSegment[][] {
  if (typeof text !== 'string' || text.length === 0) return []
  const lines = text.split(/\r\n|\r|\n/)
  const out: AnsiSegment[][] = []

  for (const raw of lines) {
    const segments: AnsiSegment[] = []
    let tone: AnsiTone = 'default'
    const push = (value: string): void => {
      if (value.length === 0) return
      const previous = segments[segments.length - 1]
      if (previous && previous.className === TONE_CLASS[tone]) {
        previous.text += value
        return
      }
      segments.push({ text: value, className: TONE_CLASS[tone] })
    }

    if (!hasAnsi(raw)) {
      push(raw.replace(OTHER_C0_RE, ''))
      out.push(segments)
      continue
    }

    let cursor = 0
    while (cursor < raw.length) {
      const esc = raw.indexOf('\u001b', cursor)
      if (esc === -1) {
        push(raw.slice(cursor).replace(OTHER_C0_RE, ''))
        break
      }
      if (esc > cursor) push(raw.slice(cursor, esc).replace(OTHER_C0_RE, ''))

      const end = sgrEndAt(raw, esc)
      if (end !== -1) {
        const params = raw.slice(esc + 2, end - 1)
        const codes = params.length === 0 ? [0] : params.split(';').map((p) => Number(p || '0'))
        for (const code of codes) {
          if (!Number.isFinite(code) || code === 0 || code === 22 || code === 39) {
            tone = 'default'
            continue
          }
          if (code === 1) {
            tone = 'bold'
            continue
          }
          const mapped = FG_TONES[code]
          if (mapped) tone = mapped
        }
        cursor = end
        continue
      }

      /* Non-SGR sequence: skip it whole so its text payload never leaks. */
      let after = esc + 2
      if (raw.charCodeAt(esc + 1) === 0x5d) {
        while (after < raw.length) {
          const code = raw.charCodeAt(after)
          if (code === 0x07) {
            after += 1
            break
          }
          if (code === 0x1b && raw.charCodeAt(after + 1) === 0x5c) {
            after += 2
            break
          }
          after += 1
        }
      } else if (raw.charCodeAt(esc + 1) === 0x5b) {
        while (after < raw.length) {
          const code = raw.charCodeAt(after)
          after += 1
          if (code >= 0x40 && code <= 0x7e) break
        }
      } else {
        after = esc + 2
      }
      cursor = Math.min(after, raw.length)
    }
    out.push(segments)
  }
  return out
}

function AnsiText({ text, className }: { text: string; className?: string }): ReactNode {
  const lines = useMemo(() => parseAnsi(text), [text])
  if (lines.length === 0) return null
  return (
    <div className={cn('font-mono text-[12px] leading-[1.55]', className)}>
      {lines.map((segments, li) => (
        <div key={li} className={cn('whitespace-pre-wrap break-all')}>
          {segments.length === 0 ? (
            <span>{'\u00a0'}</span>
          ) : (
            segments.map((segment, si) => (
              <span key={si} className={segment.className}>
                {segment.text}
              </span>
            ))
          )}
        </div>
      ))}
    </div>
  )
}

/* ------------------------------------------------------------------ *
 * Small chrome pieces
 * ------------------------------------------------------------------ */

function ExitChip({ exitCode, streaming }: { exitCode: number | null | undefined; streaming: boolean }): ReactNode {
  if (streaming) {
    return (
      <span className="inline-flex shrink-0 items-center gap-1 rounded-xs bg-warn-soft px-1.5 py-px font-mono text-2xs text-warn">
        <Loader2 size={10} className="animate-spin-slow" />
        运行中
      </span>
    )
  }
  if (exitCode === undefined || exitCode === null) return null
  const ok = exitCode === 0
  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center gap-1 rounded-xs px-1.5 py-px font-mono text-2xs',
        ok ? 'bg-success-soft text-success' : 'bg-danger-soft text-danger',
      )}
      title={ok ? '命令执行成功' : `命令以退出码 ${exitCode} 结束`}
    >
      {ok ? <Check size={10} /> : <AlertTriangle size={10} />}
      exit {exitCode}
    </span>
  )
}

function SectionLabel({ children }: { children: ReactNode }): ReactNode {
  return (
    <div className="px-2 py-1 text-2xs uppercase tracking-wide text-fg-subtle">{children}</div>
  )
}

/* ------------------------------------------------------------------ *
 * OutputSection
 * ------------------------------------------------------------------ */

function OutputSectionBase({
  label,
  children,
  collapsible = false,
  defaultCollapsed = false,
  className,
  count,
}: OutputSectionProps): ReactNode {
  const [collapsed, setCollapsed] = useState(defaultCollapsed)
  const text = count === undefined ? label : `${label} · ${count}`
  return (
    <div className={cn('min-w-0', className)}>
      {collapsible ? (
        <button
          type="button"
          aria-expanded={!collapsed}
          onClick={() => setCollapsed((prev) => !prev)}
          className={cn(
            'flex w-full items-center gap-1 px-2 py-1 text-left text-2xs uppercase tracking-wide',
            'text-fg-subtle transition-colors hover:bg-surface-2 hover:text-fg-muted',
          )}
        >
          {collapsed ? <ChevronRight size={11} /> : <ChevronDown size={11} />}
          <span className="truncate">{text}</span>
        </button>
      ) : (
        <SectionLabel>{text}</SectionLabel>
      )}
      {collapsed ? null : <div className="min-w-0">{children}</div>}
    </div>
  )
}

export const OutputSection = memo(OutputSectionBase)
OutputSection.displayName = 'OutputSection'

/* ------------------------------------------------------------------ *
 * CliLine
 * ------------------------------------------------------------------ */

const CLI_TONE: Record<NonNullable<CliLineProps['tone']>, string> = {
  default: 'text-fg',
  success: 'text-success',
  danger: 'text-danger',
  muted: 'text-fg-muted',
}

function CliLineBase({ text, tone = 'default', prompt = '$' }: CliLineProps): ReactNode {
  return (
    <div className="flex min-w-0 items-start gap-2 font-mono text-[12px] leading-[1.55]">
      {prompt ? <span className="shrink-0 select-none text-accent">{prompt}</span> : null}
      <span className={cn('min-w-0 whitespace-pre-wrap break-all', CLI_TONE[tone])}>{text}</span>
    </div>
  )
}

export const CliLine = memo(CliLineBase)
CliLine.displayName = 'CliLine'

/* ------------------------------------------------------------------ *
 * ToolOutput
 * ------------------------------------------------------------------ */

function isNearBottom(el: HTMLElement, threshold = 48): boolean {
  return el.scrollHeight - el.scrollTop - el.clientHeight <= threshold
}

function collectCopyText(stdout: string, stderr: string): string {
  const parts: string[] = []
  const cleanOut = stripAnsi(stdout)
  const cleanErr = stripAnsi(stderr)
  if (cleanOut.length > 0) parts.push(cleanOut)
  if (cleanErr.length > 0) parts.push(`[stderr]\n${cleanErr}`)
  return parts.join('\n')
}

function ToolOutputBase({
  stdout,
  stderr,
  exitCode,
  truncated = false,
  maxHeight = 320,
  emptyHint = '无输出',
  language,
  streaming = false,
  onCopy,
}: ToolOutputProps): ReactNode {
  const out = typeof stdout === 'string' ? stdout : ''
  const err = typeof stderr === 'string' ? stderr : ''
  const hasContent = out.length > 0 || err.length > 0

  const scrollerRef = useRef<HTMLDivElement | null>(null)
  const pinnedRef = useRef(true)
  const [copied, setCopied] = useState(false)

  const onScroll = useCallback((event: UIEvent<HTMLDivElement>) => {
    pinnedRef.current = isNearBottom(event.currentTarget)
  }, [])

  /* Auto-scroll while streaming, but only while the reader stays pinned. */
  useEffect(() => {
    if (!streaming) return
    const el = scrollerRef.current
    if (!el) return
    if (pinnedRef.current) el.scrollTop = el.scrollHeight
  }, [streaming, out, err])

  useEffect(() => {
    if (!copied) return
    const handle = setTimeout(() => setCopied(false), 1400)
    return () => clearTimeout(handle)
  }, [copied])

  const copy = useCallback(() => {
    const text = collectCopyText(out, err)
    if (text.length === 0) return
    setCopied(true)
    if (onCopy) {
      onCopy(text)
      return
    }
    const clipboard = typeof navigator === 'undefined' ? undefined : navigator.clipboard
    if (!clipboard || typeof clipboard.writeText !== 'function') return
    void clipboard.writeText(text).catch(() => undefined)
  }, [out, err, onCopy])

  const style = useMemo<CSSProperties>(() => (maxHeight > 0 ? { maxHeight } : {}), [maxHeight])

  return (
    <div className={cn('surface-card overflow-hidden')}>
      <div className="flex items-center gap-2 border-b border-line bg-surface-2/70 px-2 py-1">
        <span className="flex shrink-0 items-center gap-1 text-fg-subtle">
          <Terminal size={12} />
          {language ? (
            <span className="font-mono text-2xs text-fg-muted">{language}</span>
          ) : null}
        </span>
        <ExitChip exitCode={exitCode} streaming={streaming} />
        {truncated ? (
          <span
            className="shrink-0 rounded-xs bg-surface-3 px-1.5 py-px text-2xs text-fg-subtle"
            title="输出已被截断"
          >
            已截断
          </span>
        ) : null}
        <span className="ml-auto flex shrink-0 items-center gap-1">
          <button
            type="button"
            onClick={copy}
            disabled={!hasContent}
            className={cn(
              'flex items-center gap-1 rounded-xs px-1.5 py-0.5 text-2xs text-fg-subtle',
              'transition-colors hover:bg-surface-3 hover:text-fg',
              !hasContent && 'cursor-default opacity-50 hover:bg-transparent hover:text-fg-subtle',
            )}
          >
            {copied ? <Check size={11} /> : <Copy size={11} />}
            {copied ? '已复制' : '复制'}
          </button>
        </span>
      </div>

      <div
        ref={scrollerRef}
        onScroll={onScroll}
        className="scroll-quiet overflow-auto"
        style={{ ...style, overflowAnchor: 'none' }}
      >
        {!hasContent ? (
          <div className="px-3 py-3 text-[12px] italic text-fg-subtle">
            {streaming ? '等待输出…' : emptyHint}
          </div>
        ) : (
          <>
            {out.length > 0 ? (
              <OutputSection label="stdout" collapsible={out.length > 2000 || err.length > 0}>
                <AnsiText text={out} className="px-3 pb-2" />
              </OutputSection>
            ) : null}
            {err.length > 0 ? (
              <OutputSection
                label="stderr"
                collapsible={err.length > 2000}
                className={out.length > 0 ? 'border-t border-line' : undefined}
              >
                <AnsiText text={err} className="px-3 pb-2 text-danger" />
              </OutputSection>
            ) : null}
            {streaming ? (
              <div className="flex items-center gap-1 px-3 pb-2 text-2xs text-fg-subtle">
                <span className="inline-block h-3 w-[6px] animate-blink bg-accent" />
              </div>
            ) : null}
          </>
        )}
      </div>
    </div>
  )
}

export const ToolOutput = memo(ToolOutputBase)
ToolOutput.displayName = 'ToolOutput'

export default ToolOutput
