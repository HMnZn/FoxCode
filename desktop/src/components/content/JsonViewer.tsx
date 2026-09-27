import { memo, useCallback, useMemo, useState } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import { ChevronDown, ChevronRight } from 'lucide-react'
import { cn } from '@/lib/cn'
import { pluralize, truncate } from '@/lib/format'

/* ------------------------------------------------------------------ *
 * JsonViewer — collapsible, cycle-safe JSON tree with no dependency.
 * Safe at import time: no window/document access.
 * ------------------------------------------------------------------ */

export type JsonSize = 'sm' | 'md'

export interface JsonViewerProps {
  value: unknown
  name?: string
  /** Initial expansion depth (default 1). */
  depth?: number
  collapsed?: boolean
  maxHeight?: number
  className?: string
  size?: JsonSize
}

export interface JsonValueBadgeProps {
  value: unknown
  className?: string
  size?: JsonSize
}

export interface KeyValueListProps {
  entries: Array<{ key: string; value: unknown }>
  className?: string
  size?: JsonSize
}

const MAX_DEPTH = 24
const ARRAY_PAGE = 50
const STRING_TRUNCATE = 160

/* ------------------------------------------------------------------ *
 * Type helpers
 * ------------------------------------------------------------------ */

type JsonKind =
  | 'object'
  | 'array'
  | 'string'
  | 'number'
  | 'boolean'
  | 'null'
  | 'undefined'
  | 'function'
  | 'symbol'
  | 'bigint'
  | 'circular'

function kindOf(value: unknown): JsonKind {
  if (value === null) return 'null'
  if (value === undefined) return 'undefined'
  if (Array.isArray(value)) return 'array'
  switch (typeof value) {
    case 'object':
      /* Date / Map / class instances: rendered as a shallow labelled node. */
      return 'object'
    case 'string':
      return 'string'
    case 'number':
      return 'number'
    case 'boolean':
      return 'boolean'
    case 'bigint':
      return 'bigint'
    case 'symbol':
      return 'symbol'
    case 'function':
      return 'function'
    default:
      return 'undefined'
  }
}

function isContainer(kind: JsonKind): boolean {
  return kind === 'object' || kind === 'array'
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function countKeys(value: unknown): number {
  if (Array.isArray(value)) return value.length
  if (isPlainRecord(value)) {
    try {
      return Object.keys(value).length
    } catch {
      return 0
    }
  }
  return 0
}

function typeLabel(kind: JsonKind): string {
  switch (kind) {
    case 'object':
      return 'object'
    case 'array':
      return 'array'
    case 'string':
      return 'string'
    case 'number':
      return 'number'
    case 'boolean':
      return 'boolean'
    case 'null':
      return 'null'
    case 'undefined':
      return 'undefined'
    case 'function':
      return 'function'
    case 'symbol':
      return 'symbol'
    case 'bigint':
      return 'bigint'
    default:
      return 'circular'
  }
}

/* ------------------------------------------------------------------ *
 * Primitive rendering
 * ------------------------------------------------------------------ */

const PRIMITIVE_CLASS: Record<string, string> = {
  string: 'text-success',
  number: 'text-info',
  boolean: 'text-accent',
  null: 'text-fg-subtle',
  undefined: 'italic text-fg-subtle',
  function: 'italic text-think',
  symbol: 'italic text-think',
  bigint: 'text-info',
  circular: 'italic text-warn',
}

function previewOf(value: unknown, kind: JsonKind): string {
  switch (kind) {
    case 'string': {
      const text = String(value)
      return `"${truncate(text, 96)}"`
    }
    case 'number':
      return String(value)
    case 'boolean':
      return String(value)
    case 'bigint':
      return `${String(value)}n`
    case 'function':
      return 'ƒ'
    case 'symbol':
      return 'Symbol()'
    case 'null':
      return 'null'
    case 'undefined':
      return 'undefined'
    case 'circular':
      return '[Circular]'
    case 'array':
      return `[${countKeys(value)}]`
    default:
      return `{${countKeys(value)}}`
  }
}

function PrimitiveValue({ value, kind }: { value: unknown; kind: JsonKind }): ReactNode {
  const [expanded, setExpanded] = useState(false)

  if (kind === 'string') {
    const text = String(value)
    if (text.length > STRING_TRUNCATE && !expanded) {
      const shown = text.slice(0, STRING_TRUNCATE)
      return (
        <>
          <span className={cn('break-all', PRIMITIVE_CLASS.string)}>"{shown}…"</span>
          <button
            type="button"
            onClick={() => setExpanded(true)}
            className={cn(
              'ml-1 shrink-0 rounded-xs px-1 text-2xs text-fg-subtle underline decoration-dotted',
              'transition-colors hover:bg-surface-2 hover:text-fg-muted',
            )}
          >
            展开
          </button>
        </>
      )
    }
    return (
      <span className={cn('break-all', PRIMITIVE_CLASS.string)}>
        "{text}"
        {expanded && text.length > STRING_TRUNCATE ? (
          <button
            type="button"
            onClick={() => setExpanded(false)}
            className="ml-1 rounded-xs px-1 text-2xs text-fg-subtle underline decoration-dotted transition-colors hover:text-fg-muted"
          >
            收起
          </button>
        ) : null}
      </span>
    )
  }

  return <span className={PRIMITIVE_CLASS[kind] ?? 'text-fg-muted'}>{previewOf(value, kind)}</span>
}

/* ------------------------------------------------------------------ *
 * Tree nodes
 * ------------------------------------------------------------------ */

interface NodeShellProps {
  label: string | undefined
  bracketOpen: string
  bracketClose: string
  summary: string
  open: boolean
  onToggle: () => void
  disabled?: boolean
  size: JsonSize
  children: ReactNode
}

const ICON_STYLE: CSSProperties = { marginTop: 2 }

function NodeShell({
  label,
  bracketOpen,
  bracketClose,
  summary,
  open,
  onToggle,
  disabled,
  size,
  children,
}: NodeShellProps): ReactNode {
  const textSize = size === 'sm' ? 'text-[11px]' : 'text-[12px]'
  const head = (
    <>
      <span className="shrink-0 text-fg-subtle" style={ICON_STYLE}>
        {disabled ? null : open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
      </span>
      {label !== undefined ? <span className="shrink-0 font-mono text-fg-muted">{label}</span> : null}
      {label !== undefined ? <span className="shrink-0 text-fg-subtle">:</span> : null}
      <span className="shrink-0 font-mono text-fg-muted">{bracketOpen}</span>
      {open ? null : <span className="min-w-0 font-mono text-fg-subtle">{summary}</span>}
      {open ? null : <span className="shrink-0 font-mono text-fg-muted">{bracketClose}</span>}
    </>
  )
  return (
    <div className="min-w-0">
      {disabled ? (
        <div className={cn('flex min-w-0 items-start gap-1 px-0.5', textSize)}>{head}</div>
      ) : (
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={open}
          className={cn(
            'flex w-full min-w-0 items-start gap-1 rounded-xs px-0.5 text-left',
            'transition-colors hover:bg-surface-2',
            textSize,
          )}
        >
          {head}
        </button>
      )}
      {open ? <div className="ml-3 border-l border-line pl-2">{children}</div> : null}
    </div>
  )
}

interface JsonNodeProps {
  value: unknown
  name: string | undefined
  depthLeft: number
  rootDepth: number
  size: JsonSize
  seen: WeakSet<object>
}

function JsonNode({ value, name, depthLeft, rootDepth, size, seen }: JsonNodeProps): ReactNode {
  const kind = kindOf(value)
  const [open, setOpen] = useState(depthLeft > 0)

  const selfRef = isPlainRecord(value)
    ? (() => {
        try {
          return seen.has(value)
        } catch {
          return false
        }
      })()
    : false

  const entries = useMemo<Array<{ key: string; value: unknown }>>(() => {
    if (kind === 'array' && Array.isArray(value)) {
      return value.slice(0, ARRAY_PAGE).map((item, index) => ({ key: String(index), value: item }))
    }
    if (kind === 'object' && isPlainRecord(value)) {
      try {
        return Object.keys(value).map((key) => ({ key, value: value[key] }))
      } catch {
        return []
      }
    }
    return []
  }, [kind, value])

  const [showAll, setShowAll] = useState(false)

  if (selfRef) {
    return (
      <div className={cn('flex items-start gap-1', size === 'sm' ? 'text-[11px]' : 'text-[12px]')}>
        {name !== undefined ? (
          <>
            <span className="shrink-0 font-mono text-fg-muted">{name}</span>
            <span className="shrink-0 text-fg-subtle">:</span>
          </>
        ) : null}
        <span className="italic text-warn">[Circular]</span>
      </div>
    )
  }

  if (!isContainer(kind)) {
    if (kind === 'object') {
      /* Date / Map / class instance — show a shallow, safe preview. */
      const ctor = (value as { constructor?: { name?: string } } | null)?.constructor?.name
      return (
        <div className={cn('flex items-start gap-1', size === 'sm' ? 'text-[11px]' : 'text-[12px]')}>
          {name !== undefined ? (
            <>
              <span className="shrink-0 font-mono text-fg-muted">{name}</span>
              <span className="shrink-0 text-fg-subtle">:</span>
            </>
          ) : null}
          <span className="font-mono italic text-fg-subtle">{ctor ?? 'Object'}</span>
        </div>
      )
    }
    return (
      <div className={cn('flex items-start gap-1', size === 'sm' ? 'text-[11px]' : 'text-[12px]')}>
        {name !== undefined ? (
          <>
            <span className="shrink-0 font-mono text-fg-muted">{name}</span>
            <span className="shrink-0 text-fg-subtle">:</span>
          </>
        ) : null}
        <PrimitiveValue value={value} kind={kind} />
      </div>
    )
  }

  const arr = kind === 'array'
  const total = countKeys(value)
  const visible = arr && !showAll && total > ARRAY_PAGE ? entries.slice(0, ARRAY_PAGE) : entries
  const capped = rootDepth >= MAX_DEPTH
  const truncated = arr && !capped && !showAll && total > ARRAY_PAGE ? total - ARRAY_PAGE : 0

  const childSeen = useMemo(() => {
    if (capped) return seen
    const next = new WeakSet<object>()
    try {
      next.add(value as object)
    } catch {
      return seen
    }
    return next
  }, [value, capped, seen])

  const summaryText = arr ? `${total} ${pluralize(total, 'item')}` : `${total} ${pluralize(total, 'key')}`

  return (
    <NodeShell
      label={name}
      bracketOpen={arr ? '[' : '{'}
      bracketClose={arr ? ']' : '}'}
      summary={total === 0 ? '' : summaryText}
      open={open && !capped}
      onToggle={() => setOpen((prev) => !prev)}
      disabled={capped}
      size={size}
    >
      {capped ? (
        <div className="font-mono text-2xs italic text-fg-subtle">达到最大深度 {MAX_DEPTH}</div>
      ) : (
        <>
          {visible.map((entry) => (
            <JsonNode
              key={entry.key}
              value={entry.value}
              name={entry.key}
              depthLeft={depthLeft - 1}
              rootDepth={rootDepth + 1}
              size={size}
              seen={childSeen}
            />
          ))}
          {total === 0 ? (
            <div className="font-mono text-2xs italic text-fg-subtle">空</div>
          ) : null}
          {truncated > 0 ? (
            <button
              type="button"
              onClick={() => setShowAll(true)}
              className={cn(
                'mt-0.5 rounded-xs bg-surface-2 px-1.5 py-px font-mono text-2xs text-fg-muted',
                'transition-colors hover:bg-surface-3 hover:text-fg',
              )}
            >
              显示全部 ({total})
            </button>
          ) : null}
        </>
      )}
    </NodeShell>
  )
}

/* ------------------------------------------------------------------ *
 * JsonViewer
 * ------------------------------------------------------------------ */

function JsonViewerBase({
  value,
  name,
  depth = 1,
  collapsed = false,
  maxHeight = 320,
  className,
  size = 'md',
}: JsonViewerProps): ReactNode {
  const initialDepth = Number.isFinite(depth) ? Math.max(0, Math.floor(depth)) : 1
  const [closed, setClosed] = useState(Boolean(collapsed))
  const rootKind = kindOf(value)
  const isRootContainer = isContainer(rootKind)

  const toggle = useCallback(() => setClosed((prev) => !prev), [])

  const style = useMemo<CSSProperties>(
    () => (maxHeight > 0 ? { maxHeight } : {}),
    [maxHeight],
  )
  const seen = useMemo(() => new WeakSet<object>(), [])

  const body = (
    <div className={cn('scroll-quiet overflow-auto px-2 py-1.5 font-mono', style)}>
      <JsonNode
        value={value}
        name={undefined}
        depthLeft={initialDepth}
        rootDepth={1}
        size={size}
        seen={seen}
      />
    </div>
  )

  return (
    <div className={cn('surface-card overflow-hidden text-[12px]', className)}>
      {name !== undefined || isRootContainer ? (
        <div className="flex items-center gap-1.5 border-b border-line bg-surface-2/70 px-2 py-1">
          <button
            type="button"
            onClick={toggle}
            aria-expanded={!closed}
            className={cn(
              'flex min-w-0 items-center gap-1 rounded-xs px-1 py-0.5 text-2xs text-fg-muted',
              'transition-colors hover:bg-surface-3 hover:text-fg',
            )}
          >
            {closed ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
            <span className="truncate font-mono text-fg-muted">{name ?? 'JSON'}</span>
            <span className="shrink-0 text-fg-subtle">{typeLabel(rootKind)}</span>
          </button>
          <span className="ml-auto shrink-0 text-2xs tabular-nums text-fg-subtle">
            {isRootContainer ? countKeys(value) : ''}
          </span>
        </div>
      ) : null}
      {closed ? null : body}
    </div>
  )
}

export const JsonViewer = memo(JsonViewerBase)
JsonViewer.displayName = 'JsonViewer'

/* ------------------------------------------------------------------ *
 * JsonValueBadge
 * ------------------------------------------------------------------ */

function JsonValueBadgeBase({ value, className, size = 'sm' }: JsonValueBadgeProps): ReactNode {
  const kind = kindOf(value)
  const label = useMemo(() => {
    if (kind === 'array') {
      const count = countKeys(value)
      return `array · ${count} ${pluralize(count, 'item')}`
    }
    if (kind === 'object') {
      const count = countKeys(value)
      return `object · ${count} ${pluralize(count, 'key')}`
    }
    if (kind === 'string') return `string · ${String(value).length}`
    if (kind === 'null' || kind === 'undefined' || kind === 'circular') return typeLabel(kind)
    return `${typeLabel(kind)} ${previewOf(value, kind)}`
  }, [kind, value])

  return (
    <span
      className={cn(
        'inline-flex max-w-full shrink-0 items-center gap-1 truncate rounded-xs bg-surface-2 px-1.5 py-px',
        'font-mono',
        size === 'sm' ? 'text-2xs' : 'text-[11px]',
        PRIMITIVE_CLASS[kind] ?? 'text-fg-muted',
        className,
      )}
      title={label}
    >
      {label}
    </span>
  )
}

export const JsonValueBadge = memo(JsonValueBadgeBase)
JsonValueBadge.displayName = 'JsonValueBadge'

/* ------------------------------------------------------------------ *
 * KeyValueList — compact two-column list for settings/session panels
 * ------------------------------------------------------------------ */

function KeyValueListBase({ entries, className, size = 'sm' }: KeyValueListProps): ReactNode {
  const textSize = size === 'sm' ? 'text-[11px]' : 'text-[12px]'
  if (!Array.isArray(entries) || entries.length === 0) {
    return <div className={cn('text-2xs italic text-fg-subtle', className)}>无数据</div>
  }
  return (
    <dl className={cn('grid grid-cols-[minmax(0,auto)_minmax(0,1fr)] gap-x-3 gap-y-1', textSize, className)}>
      {entries.map((entry, index) => (
        <div key={`${entry.key}:${index}`} className="contents">
          <dt className="min-w-0 truncate font-mono text-fg-muted" title={entry.key}>
            {entry.key}
          </dt>
          <dd className="m-0 min-w-0 text-fg">
            <KvValue value={entry.value} size={size} />
          </dd>
        </div>
      ))}
    </dl>
  )
}

function KvValue({ value, size }: { value: unknown; size: JsonSize }): ReactNode {
  const kind = kindOf(value)
  if (isContainer(kind) || kind === 'circular') {
    return <JsonValueBadge value={value} size={size} />
  }
  return (
    <span className={cn('break-all font-mono', size === 'sm' ? 'text-[11px]' : 'text-[12px]')}>
      <PrimitiveValue value={value} kind={kind} />
    </span>
  )
}

export const KeyValueList = memo(KeyValueListBase)
KeyValueList.displayName = 'KeyValueList'

export default JsonViewer
