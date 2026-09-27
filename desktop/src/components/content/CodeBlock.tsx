import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { Check, ChevronsDownUp, ChevronsUpDown, Copy } from 'lucide-react'
import { cn } from '@/lib/cn'
import { detectLanguage, tokenize } from '@/lib/highlight'
import type { Language, Token, TokenKind } from '@/lib/highlight'

/**
 * Token palette. Declared here (rather than in globals.css) so the highlighter
 * stays self-contained; values are CSS custom properties scoped by theme below
 * and referenced through Tailwind arbitrary values, so no dynamic class names
 * are generated and both themes keep contrast.
 *
 *   plain        #c9d1d9 / #3d4450    keyword     #c792ea / #8b3ea8
 *   string       #a5d6a7 / #2f7d4f    number      #f5b544 / #a35c00
 *   comment      #6b7484 / #79818f    function    #7fd1ff / #0b64a0
 *   class        #ffd479 / #96650a    type        #56d4c4 / #0f766e
 *   operator     #9aa3b2 / #59616f    punctuation #8b949e / #6b7280
 *   property     #79b8ff / #1f6feb    variable    #ffa657 / #b45309
 *   tag          #7ee787 / #116d3d    attribute   #ffd479 / #96650a
 *   regex        #f0883e / #c2410c    inserted    #3ddc97 / #12885b
 *   deleted      #ff6b6b / #cf2f2f
 */
export const TOKEN_CLASS: Record<TokenKind, string> = {
  plain: 'text-[var(--hl-plain)]',
  keyword: 'text-[var(--hl-keyword)]',
  string: 'text-[var(--hl-string)]',
  number: 'text-[var(--hl-number)]',
  comment: 'text-[var(--hl-comment)] italic',
  function: 'text-[var(--hl-function)]',
  class: 'text-[var(--hl-class)]',
  type: 'text-[var(--hl-type)]',
  operator: 'text-[var(--hl-operator)]',
  punctuation: 'text-[var(--hl-punctuation)]',
  property: 'text-[var(--hl-property)]',
  variable: 'text-[var(--hl-variable)]',
  tag: 'text-[var(--hl-tag)]',
  attribute: 'text-[var(--hl-attribute)]',
  regex: 'text-[var(--hl-regex)]',
  deleted: 'text-[var(--hl-deleted)]',
  inserted: 'text-[var(--hl-inserted)]',
}

const HL_THEME_ID = 'foxcode-hl-theme'

const HL_THEME_CSS = `:root{--hl-plain:#c9d1d9;--hl-keyword:#c792ea;--hl-string:#a5d6a7;--hl-number:#f5b544;--hl-comment:#6b7484;--hl-function:#7fd1ff;--hl-class:#ffd479;--hl-type:#56d4c4;--hl-operator:#9aa3b2;--hl-punctuation:#8b949e;--hl-property:#79b8ff;--hl-variable:#ffa657;--hl-tag:#7ee787;--hl-attribute:#ffd479;--hl-regex:#f0883e;--hl-inserted:#3ddc97;--hl-deleted:#ff6b6b}.light{--hl-plain:#3d4450;--hl-keyword:#8b3ea8;--hl-string:#2f7d4f;--hl-number:#a35c00;--hl-comment:#79818f;--hl-function:#0b64a0;--hl-class:#96650a;--hl-type:#0f766e;--hl-operator:#59616f;--hl-punctuation:#6b7280;--hl-property:#1f6feb;--hl-variable:#b45309;--hl-tag:#116d3d;--hl-attribute:#96650a;--hl-regex:#c2410c;--hl-inserted:#12885b;--hl-deleted:#cf2f2f}`

let hlThemeInjected = false

/** Idempotent, SSR/import-time safe palette injection. */
function ensureTheme(): void {
  if (hlThemeInjected) return
  hlThemeInjected = true
  if (typeof document === 'undefined' || !document.head) return
  try {
    if (document.getElementById(HL_THEME_ID)) return
    const style = document.createElement('style')
    style.id = HL_THEME_ID
    style.textContent = HL_THEME_CSS
    document.head.appendChild(style)
  } catch {
    /* headless / restricted renderer — colors simply fall back to inherit */
  }
}

type Line = { n: number; tokens: Token[] }

/** Group a token stream into lines without copying token text. */
function splitLines(tokens: Token[]): Line[] {
  const lines: Line[] = [{ n: 1, tokens: [] }]
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i]
    let start = 0
    let nl = token.text.indexOf('\n')
    while (nl !== -1) {
      if (nl > start) lines[lines.length - 1].tokens.push({ kind: token.kind, text: token.text.slice(start, nl) })
      start = nl + 1
      lines.push({ n: lines.length + 1, tokens: [] })
      nl = token.text.indexOf('\n', start)
    }
    if (start < token.text.length) {
      lines[lines.length - 1].tokens.push({ kind: token.kind, text: token.text.slice(start) })
    }
  }
  // A trailing newline is a real empty line (keeps the caret on its own row).
  if (lines.length > 1 && lines[lines.length - 1].tokens.length === 0 && lines[lines.length - 2].tokens.length === 0) {
    lines.pop()
  }
  return lines
}

/** Cheap liveness check so a diff fence is highlighted as a diff. */
function looksLikeDiff(code: string): boolean {
  return /^(diff --git |index |--- |\+\+\+ |@@ )/m.test(code)
}

export interface CodeBlockProps {
  code: string
  language?: string
  filename?: string
  showLineNumbers?: boolean
  wrap?: boolean
  maxHeight?: number
  streaming?: boolean
  onCopy?: (code: string) => void
  className?: string
}

function CodeBlockImpl({
  code,
  language,
  filename,
  showLineNumbers = false,
  wrap = false,
  maxHeight,
  streaming = false,
  onCopy,
  className,
}: CodeBlockProps) {
  ensureTheme()

  const [copied, setCopied] = useState(false)
  const [expanded, setExpanded] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(
    () => () => {
      if (timer.current !== null) clearTimeout(timer.current)
    },
    [],
  )

  const lang: Language = useMemo(() => {
    const detected = detectLanguage(language, code)
    return detected === 'text' && looksLikeDiff(code) ? 'diff' : detected
  }, [language, code])

  const lines = useMemo<Line[]>(() => {
    if (!code) return []
    return splitLines(tokenize(code, lang))
  }, [code, lang])

  const handleCopy = useCallback(() => {
    onCopy?.(code)
    const write = async (): Promise<void> => {
      try {
        const nav = typeof navigator === 'undefined' ? undefined : navigator
        if (nav?.clipboard?.writeText) {
          await nav.clipboard.writeText(code)
          return
        }
        const el = document.createElement('textarea')
        el.value = code
        el.setAttribute('readonly', '')
        el.style.position = 'fixed'
        el.style.opacity = '0'
        document.body.appendChild(el)
        el.select()
        document.execCommand('copy')
        document.body.removeChild(el)
      } catch {
        /* clipboard denied — nothing we can do, and it must not break the chat */
      }
    }
    void write()
    setCopied(true)
    if (timer.current !== null) clearTimeout(timer.current)
    timer.current = setTimeout(() => setCopied(false), 1200)
  }, [code, onCopy])

  const collapsible = typeof maxHeight === 'number' && maxHeight > 0 && lines.length > 3
  const clipped = collapsible && !expanded
  const showGutter = showLineNumbers && lines.length > 1

  return (
    <div
      className={cn(
        'group/code my-2.5 w-full min-w-0 overflow-hidden rounded-md border border-line bg-surface',
        className,
      )}
    >
      {/* header */}
      <div className="flex h-8 items-center gap-2 border-b border-line bg-surface-2 px-2.5">
        {filename ? (
          <span className="flex min-w-0 items-center gap-1.5 text-2xs font-mono text-fg-muted" title={filename}>
            <span aria-hidden className="inline-block size-1.5 shrink-0 rounded-full bg-accent/70" />
            <span className="truncate">{filename}</span>
          </span>
        ) : (
          <span className="text-2xs font-mono text-fg-subtle">{lang}</span>
        )}

        {filename ? (
          <span className="shrink-0 rounded-xs bg-surface-3 px-1.5 py-0.5 text-[10px] leading-4 text-fg-subtle">
            {lang}
          </span>
        ) : null}

        <span className="ml-auto" />

        {collapsible ? (
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            title={expanded ? '收起' : `展开全部 ${lines.length} 行`}
            className="flex h-6 shrink-0 items-center gap-1 rounded-sm px-1.5 text-2xs text-fg-subtle transition-colors hover:bg-surface-3 hover:text-fg"
          >
            {expanded ? <ChevronsDownUp size={12} /> : <ChevronsUpDown size={12} />}
            <span>{expanded ? '收起' : '展开'}</span>
          </button>
        ) : null}

        <button
          type="button"
          onClick={handleCopy}
          title={copied ? '已复制' : '复制代码'}
          className={cn(
            'flex h-6 shrink-0 items-center gap-1 rounded-sm px-1.5 text-2xs transition-colors',
            copied ? 'text-success' : 'text-fg-subtle hover:bg-surface-3 hover:text-fg',
          )}
        >
          {copied ? <Check size={12} /> : <Copy size={12} />}
          <span>{copied ? '已复制' : '复制'}</span>
        </button>
      </div>

      {/* body — `contain` keeps streaming re-layout inside this subtree */}
      <div
        className={cn('relative', clipped && 'overflow-hidden')}
        style={clipped && maxHeight ? { height: maxHeight } : undefined}
      >
        <pre
          className="scroll-quiet max-w-full overflow-x-auto overflow-y-auto bg-transparent font-mono text-[12px] leading-[1.6] [contain:content]"
          style={clipped ? { height: '100%' } : !collapsible && maxHeight ? { maxHeight } : undefined}
        >
          <code
            className={cn(
              'block w-fit min-w-full py-2',
              showGutter && lines.length > 1 && 'flex',
              wrap ? 'whitespace-pre-wrap break-words' : 'whitespace-pre',
            )}
          >
            {lines.length === 0 ? (
              <span className={cn('block px-3 text-fg-subtle', showGutter && 'flex-1')}>
                {streaming ? '' : ' '}
              </span>
            ) : showGutter ? (
              <>
                <span
                  aria-hidden
                  className="sticky left-0 z-10 select-none border-r border-line/60 bg-surface/95 py-2 pr-2.5 pl-3 text-right font-mono text-[11px] leading-[1.6] text-fg-subtle"
                >
                  {lines.map((line) => (
                    <span key={line.n} className="block">
                      {line.n}
                    </span>
                  ))}
                </span>
                <span className="block min-w-0 flex-1 py-2 pr-3.5 pl-3">
                  {lines.map((line) => (
                    <LineRow key={line.n} line={line} caret={streaming && line.n === lines.length} />
                  ))}
                </span>
              </>
            ) : (
              <span className="block px-3.5">
                {lines.map((line) => (
                  <LineRow key={line.n} line={line} caret={streaming && line.n === lines.length} />
                ))}
              </span>
            )}
          </code>
        </pre>

        {clipped && maxHeight ? (
          <div className="absolute inset-x-0 bottom-0 flex h-16 items-end justify-center bg-gradient-to-t from-surface via-surface/85 to-transparent pb-1.5">
            <button
              type="button"
              onClick={() => setExpanded(true)}
              className="rounded-full border border-line bg-surface-2 px-2.5 py-0.5 text-2xs text-fg-muted transition-colors hover:border-line-strong hover:text-fg"
            >
              展开全部 {lines.length} 行
            </button>
          </div>
        ) : null}
      </div>
    </div>
  )
}

function LineRow({ line, caret }: { line: Line; caret: boolean }) {
  return (
    <span className="block min-h-[1.6em]">
      {line.tokens.length === 0 ? <span> </span> : line.tokens.map((token, i) => <TokenSpan key={i} token={token} />)}
      {caret ? <Caret /> : null}
    </span>
  )
}

function TokenSpan({ token }: { token: Token }) {
  return <span className={TOKEN_CLASS[token.kind]}>{token.text}</span>
}

function Caret() {
  return (
    <span
      aria-hidden
      className={cn(
        'ml-0.5 inline-block h-[1.05em] w-[2px] translate-y-[0.16em] bg-accent align-baseline',
        'animate-blink',
      )}
    />
  )
}

export const CodeBlock = memo(CodeBlockImpl)
CodeBlock.displayName = 'CodeBlock'

/* ------------------------------------------------------------------ *
 * Inline code
 * ------------------------------------------------------------------ */

export interface InlineCodeProps {
  children?: ReactNode
  className?: string
  /** GFM sets this for ```` ```x ```` spans; inline code never needs it. */
  language?: string
}

function InlineCodeImpl({ children, className, language }: InlineCodeProps) {
  void language
  return (
    <code
      className={cn(
        'rounded-xs border border-line bg-surface-3 px-[0.35em] py-[0.12em] font-mono text-[0.86em] text-accent',
        className,
      )}
    >
      {children}
    </code>
  )
}

export const InlineCode = memo(InlineCodeImpl)
InlineCode.displayName = 'InlineCode'
