import { isValidElement, memo, useState } from 'react'
import type { AnchorHTMLAttributes, ComponentPropsWithoutRef, ReactNode } from 'react'
import ReactMarkdown from 'react-markdown'
import type { Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { ImageOff } from 'lucide-react'
import { cn } from '@/lib/cn'
import { CodeBlock, InlineCode } from './CodeBlock'

/* ------------------------------------------------------------------ *
 * Bridge to the Electron preload (may be absent in a plain browser).
 * ------------------------------------------------------------------ */

interface FoxcodeWindow {
  foxcode?: { openExternal?: (url: string) => void | Promise<void> }
}

function openExternal(url: string): boolean {
  if (typeof window === 'undefined') return false
  try {
    const api = (window as unknown as FoxcodeWindow).foxcode
    if (api && typeof api.openExternal === 'function') {
      void api.openExternal(url)
      return true
    }
  } catch {
    /* fall through to plain anchor behaviour */
  }
  return false
}

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

function textOf(children: ReactNode): string {
  if (children === null || children === undefined || typeof children === 'boolean') return ''
  if (typeof children === 'string' || typeof children === 'number') return String(children)
  if (Array.isArray(children)) return children.map(textOf).join('')
  if (isValidElement(children)) {
    const props = children.props as { children?: ReactNode }
    return textOf(props.children)
  }
  return ''
}

const LANGUAGE_HINT = /language-([\w+#-]+)/

/**
 * Module-level streaming flag. The component map below must stay referentially
 * stable or every markdown tree remounts on each streamed delta — a stale
 * boolean inside a module constant would be the only alternative, so the live
 * value is carried by a ref that `Markdown` refreshes during render.
 */
const liveFlags = { streaming: false }

function Caret() {
  return (
    <span
      aria-hidden
      className="ml-0.5 inline-block h-[1.05em] w-[2px] translate-y-[0.16em] animate-blink bg-accent align-baseline"
    />
  )
}

function Paragraph({ children }: { children?: ReactNode }) {
  return (
    <p className="relative my-2 leading-[24px] first:mt-0 last:mb-0">
      {children}
      {liveFlags.streaming ? <Caret /> : null}
    </p>
  )
}

/**
 * Type ladder borrowed from the DSH desktop design language: 14px/24px body,
 * then 21/30, 19/28 and 18/26 for the top three levels. The chat body is the
 * one place where a slightly larger size than the 13.5px UI text is right —
 * long prose and code fences are what the eye spends time on.
 */
function Heading({ level, children }: { level: 1 | 2 | 3 | 4 | 5 | 6; children?: ReactNode }) {
  const size =
    level === 1
      ? 'text-[21px] leading-[30px] font-bold'
      : level === 2
        ? 'text-[19px] leading-[28px] font-bold'
        : level === 3
          ? 'text-[18px] leading-[26px] font-bold'
          : level === 4
            ? 'text-[14px] leading-[24px] font-semibold'
            : 'text-[13px] leading-[20px] font-semibold'
  const Tag = `h${level}` as 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6'
  return (
    <Tag
      className={cn(
        'mt-5 mb-2 text-fg first:mt-0',
        level >= 5 && 'text-fg-muted',
        size,
      )}
    >
      {children}
    </Tag>
  )
}

function Image(props: ComponentPropsWithoutRef<'img'>) {
  const [status, setStatus] = useState<'loading' | 'error'>('loading')
  const { className, alt, ...rest } = props

  if (status === 'error') {
    return (
      <span className="my-1.5 inline-flex max-w-full items-center gap-1.5 rounded-md border border-line bg-surface-2 px-2 py-1 text-2xs text-fg-subtle">
        <ImageOff size={12} />
        <span className="truncate">{alt || '图片加载失败'}</span>
      </span>
    )
  }

  return (
    <img
      {...rest}
      alt={alt ?? ''}
      onError={() => setStatus('error')}
      className={cn('my-1.5 max-w-full rounded-md border border-line', className)}
    />
  )
}

function CodeRenderer({ className, children }: { className?: string; children?: ReactNode }) {
  const raw = textOf(children)
  const block = raw.includes('\n') || /\blanguage-/.test(className ?? '')
  const language = className ? (LANGUAGE_HINT.exec(className)?.[1] ?? undefined) : undefined
  if (!block) return <InlineCode className={className}>{children}</InlineCode>
  return (
    <CodeBlock
      code={raw.replace(/\n$/, '')}
      language={language}
      showLineNumbers={raw.split('\n').length > 4}
      className="my-2"
    />
  )
}

function Link({ href, children, ...rest }: AnchorHTMLAttributes<HTMLAnchorElement>) {
  const external = typeof href === 'string' && /^https?:\/\//i.test(href)
  return (
    <a
      {...rest}
      href={href}
      target={external ? '_blank' : undefined}
      rel="noreferrer noopener"
      className="text-accent underline decoration-accent/35 underline-offset-2 transition-colors hover:decoration-accent"
      onClick={(event) => {
        if (!external || typeof href !== 'string') return
        if (openExternal(href)) event.preventDefault()
      }}
    >
      {children}
    </a>
  )
}

/**
 * Module-level component map: referentially stable for the lifetime of the
 * module so React keeps the same element types (and the same DOM) while tokens
 * stream in.
 */
const MARKDOWN_COMPONENTS: Components = {
  h1: ({ children }) => <Heading level={1}>{children}</Heading>,
  h2: ({ children }) => <Heading level={2}>{children}</Heading>,
  h3: ({ children }) => <Heading level={3}>{children}</Heading>,
  h4: ({ children }) => <Heading level={4}>{children}</Heading>,
  h5: ({ children }) => <Heading level={5}>{children}</Heading>,
  h6: ({ children }) => <Heading level={6}>{children}</Heading>,

  p: ({ children }) => <Paragraph>{children}</Paragraph>,

  ul: ({ children }) => <ul className="my-1.5 list-disc space-y-0.5 pl-5 first:mt-0 last:mb-0">{children}</ul>,
  ol: ({ children }) => <ol className="my-1.5 list-decimal space-y-0.5 pl-5 first:mt-0 last:mb-0">{children}</ol>,
  li: ({ children, className }) => (
    <li className={cn('leading-[24px] marker:text-fg-subtle', /task-list-item/.test(className ?? '') && 'list-none', className)}>
      {children}
    </li>
  ),

  blockquote: ({ children }) => (
    <blockquote className="my-2 border-l-2 border-accent/45 bg-surface-2/40 py-1 pr-2.5 pl-3 text-fg-muted italic">
      {children}
    </blockquote>
  ),

  a: Link,
  img: (props) => <Image {...props} />,

  hr: () => <hr className="my-3.5 border-0 border-t border-line" />,

  table: ({ children }) => (
    <div className="scroll-quiet my-2.5 w-full overflow-x-auto rounded-md border border-line">
      <table className="w-full border-collapse text-[13px] leading-[22px]">{children}</table>
    </div>
  ),
  thead: ({ children }) => <thead className="sticky top-0 z-10 bg-surface-2">{children}</thead>,
  tbody: ({ children }) => <tbody>{children}</tbody>,
  tr: ({ children }) => <tr className="border-b border-line last:border-b-0">{children}</tr>,
  th: ({ children }) => (
    <th className="border-r border-line px-2.5 py-1.5 text-left text-[13px] font-medium whitespace-nowrap text-fg-muted last:border-r-0">
      {children}
    </th>
  ),
  td: ({ children }) => <td className="border-r border-line/60 px-2.5 py-1.5 align-top last:border-r-0">{children}</td>,

  del: ({ children }) => <del className="text-fg-subtle line-through">{children}</del>,
  strong: ({ children }) => <strong className="font-semibold text-fg">{children}</strong>,
  em: ({ children }) => <em className="italic">{children}</em>,
  small: ({ children }) => <small className="text-[12px] leading-[20px] text-fg-muted">{children}</small>,

  pre: ({ children }) => <>{children}</>,
  code: ({ className, children }) => <CodeRenderer className={className}>{children}</CodeRenderer>,

  input: ({ type, checked, ...rest }) => {
    if (type !== 'checkbox') return <input {...rest} type={type} checked={checked} readOnly />
    return (
      <input
        {...rest}
        type="checkbox"
        checked={Boolean(checked)}
        readOnly
        tabIndex={-1}
        className="mr-1.5 size-3 translate-y-[0.5px] accent-accent align-middle"
      />
    )
  },

  section: ({ children, className }) => {
    if (/(^|\s)(footnotes|markdown-alert)(\s|$)/.test(className ?? '')) {
      return <section className={cn('my-2 text-fg-muted', className)}>{children}</section>
    }
    return <section className={className}>{children}</section>
  },

  sup: ({ children }) => <sup className="text-[0.75em] text-accent">{children}</sup>,
  abbr: ({ children, title }) => (
    <abbr title={title} className="decoration-fg-subtle underline decoration-dotted">
      {children}
    </abbr>
  ),
}

/* ------------------------------------------------------------------ *
 * Public API
 * ------------------------------------------------------------------ */

export interface MarkdownProps {
  content: string
  streaming?: boolean
  className?: string
}

function MarkdownImpl({ content, streaming = false, className }: MarkdownProps) {
  liveFlags.streaming = streaming

  return (
    <div
      className={cn(
        'min-w-0 text-[14px] leading-[24px] text-fg break-words',
        streaming && 'animate-fade',
        className,
      )}
      data-streaming={streaming ? '' : undefined}
    >
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={MARKDOWN_COMPONENTS}>
        {content}
      </ReactMarkdown>
    </div>
  )
}

export const Markdown = memo(MarkdownImpl)
Markdown.displayName = 'Markdown'

/**
 * Same renderer, plus a caret. When the last block is a paragraph the paragraph
 * itself appends the caret (via `liveFlags`); otherwise a standalone trailing
 * caret keeps the "still typing" affordance visible.
 */
function StreamingMarkdownImpl({ content, streaming = true, className }: MarkdownProps) {
  return (
    <div className="relative">
      <Markdown content={content} streaming={streaming} className={className} />
      {!hasTrailingParagraph(content) && streaming ? (
        <span className="mt-1 inline-block h-[1.05em] w-[2px] translate-y-[0.16em] animate-blink bg-accent align-baseline" />
      ) : null}
    </div>
  )
}

/**
 * True when the stream currently ends inside a paragraph — in that case the
 * paragraph renderer already draws the caret and a second one would double up.
 */
function hasTrailingParagraph(content: string): boolean {
  const tail = content.slice(-400)
  if (/(\n\s*```|\n\s*#{1,6}\s|\n\s*[-*+]\s|\n\s*\d+[.)]\s|\n\s*\|)/.test(tail)) return false
  if (/<\/(p|div|ul|ol|table|pre|blockquote|h[1-6])>\s*$/.test(tail)) return false
  return tail.trim().length > 0
}

export const StreamingMarkdown = memo(StreamingMarkdownImpl)
StreamingMarkdown.displayName = 'StreamingMarkdown'
