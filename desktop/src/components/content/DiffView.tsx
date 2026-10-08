import { memo, useMemo, useState } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import { ChevronDown, ChevronRight } from 'lucide-react'
import { cn } from '@/lib/cn'
import { pluralize, shortPath } from '@/lib/format'

import type { DiffHunk, DiffLine, FileDiff } from '@/lib/diff'

export interface DiffViewProps {
  diff: FileDiff | FileDiff[]
  view?: 'unified' | 'split'
  showLineNumbers?: boolean
  maxHeight?: number
  collapsible?: boolean
  defaultCollapsed?: boolean
  wrap?: boolean
}

/* ------------------------------------------------------------------ *
 * Word-level emphasis (longest common substring)
 * ------------------------------------------------------------------ */

export interface EmphasisRange {
  start: number
  end: number
}

export interface Emphasis {
  old?: EmphasisRange
  next?: EmphasisRange
}

const EMPHASIS_CAP = 400

/** Longest common substring dispatch: start/end offsets plus the LCS string. */
function commonSubstring(a: string, b: string): { start: number; end: number; text: string } {
  const n = Math.min(a.length, EMPHASIS_CAP)
  const m = Math.min(b.length, EMPHASIS_CAP)
  if (n === 0 || m === 0) return { start: 0, end: 0, text: '' }
  let best = 0
  let bestI = 0
  let prev = new Int32Array(m + 1)
  for (let i = 1; i <= n; i += 1) {
    const cur = new Int32Array(m + 1)
    const ca = a.charCodeAt(i - 1)
    for (let j = 1; j <= m; j += 1) {
      if (ca === b.charCodeAt(j - 1)) {
        const run = (prev[j - 1] ?? 0) + 1
        cur[j] = run
        if (run > best) {
          best = run
          bestI = i
        }
      }
    }
    prev = cur
  }
  if (best === 0) {
    return { start: 0, end: Math.min(a.length, EMPHASIS_CAP), text: '' }
  }
  return {
    start: bestI - best,
    end: bestI,
    text: a.slice(bestI - best, bestI),
  }
}

/**
 * Highlight the differing middle of a removed/added pair: the shared
 * prefix and suffix stay plain, everything between is emphasized.
 */
function emphasisOfPair(oldText: string, nextText: string): Emphasis {
  const truncated = oldText.length > EMPHASIS_CAP || nextText.length > EMPHASIS_CAP
  const a = oldText.slice(0, EMPHASIS_CAP)
  const b = nextText.slice(0, EMPHASIS_CAP)
  let start = 0
  const max = Math.min(a.length, b.length)
  while (start < max && a.charCodeAt(start) === b.charCodeAt(start)) start += 1
  let endA = a.length
  let endB = b.length
  while (endA > start && endB > start && a.charCodeAt(endA - 1) === b.charCodeAt(endB - 1)) {
    endA -= 1
    endB -= 1
  }
  if (truncated) {
    const common = commonSubstring(a, b)
    if (common.end > common.start) {
      start = common.start
      endA = common.end
      endB = common.start + (common.end - common.start)
    }
  }
  const oldRange: EmphasisRange = { start, end: endA }
  const nextRange: EmphasisRange = { start, end: endB }
  const oldReal = oldRange.end > oldRange.start
  const newReal = nextRange.end > nextRange.start
  return {
    old: oldReal ? oldRange : undefined,
    next: newReal ? nextRange : undefined,
  }
}

function emphasizeRuns(text: string, range: EmphasisRange | undefined, tone: 'add' | 'del'): ReactNode {
  if (!range || range.end <= range.start || range.start >= text.length) return text
  const start = Math.max(0, range.start)
  const end = Math.min(text.length, range.end)
  if (end <= start) return text
  const before = text.slice(0, start)
  const mid = text.slice(start, end)
  const after = text.slice(end)
  const style: CSSProperties = {
    backgroundColor: `color-mix(in srgb, var(--color-${tone === 'add' ? 'success' : 'danger'}) 26%, transparent)`,
    borderRadius: '2px',
  }
  return (
    <>
      {before}
      <span style={style}>{mid}</span>
      {after}
    </>
  )
}

/* ------------------------------------------------------------------ *
 * Shared chrome
 * ------------------------------------------------------------------ */

const STATUS_META: Record<FileDiff['status'], { label: string; className: string }> = {
  added: { label: '新增', className: 'bg-success-soft text-success' },
  modified: { label: '修改', className: 'bg-warn-soft text-warn' },
  deleted: { label: '删除', className: 'bg-danger-soft text-danger' },
  renamed: { label: '重命名', className: 'bg-info-soft text-info' },
}

function CellWidth(): number {
  return 44
}

function SignCell({ value, tone }: { value: string; tone: 'add' | 'del' | 'ctx' }): ReactNode {
  return (
    <span
      className={cn(
        'inline-block shrink-0 select-none text-center',
        tone === 'add' && 'text-success',
        tone === 'del' && 'text-danger',
        tone === 'ctx' && 'text-transparent',
      )}
      style={{ width: 12 }}
      aria-hidden="true"
    >
      {value}
    </span>
  )
}

function NumberCell({ value }: { value: number | undefined }): ReactNode {
  return (
    <span
      className="inline-block shrink-0 select-none text-right tabular-nums text-fg-subtle/70"
      style={{ width: CellWidth() }}
    >
      {value === undefined ? '' : value}
    </span>
  )
}

/* ------------------------------------------------------------------ *
 * DiffView
 * ------------------------------------------------------------------ */

const UNIFIED_BG: Record<DiffLine['kind'], string> = {
  added: 'bg-success-soft',
  removed: 'bg-danger-soft',
  context: '',
  meta: 'bg-surface-2',
}

function renderMetaRow(line: DiffLine, wrap: boolean, key: string): ReactNode {
  return (
    <div
      key={key}
      className={cn(
        'flex min-w-max px-2 text-[11px] italic text-fg-subtle',
        wrap && 'min-w-0 whitespace-pre-wrap break-all',
      )}
    >
      <span className={cn(wrap ? 'whitespace-pre-wrap break-all' : 'whitespace-pre')}>
        {line.text}
      </span>
    </div>
  )
}

function DiffViewBase({
  diff,
  view = 'unified',
  showLineNumbers = true,
  maxHeight = 420,
  collapsible = true,
  defaultCollapsed = false,
  wrap = false,
}: DiffViewProps): ReactNode {
  const files = useMemo<FileDiff[]>(() => {
    const list = Array.isArray(diff) ? diff : [diff]
    return list.filter((f): f is FileDiff => Boolean(f) && typeof f === 'object')
  }, [diff])

  const scrollStyle = useMemo<CSSProperties>(
    () => (maxHeight > 0 ? { maxHeight } : {}),
    [maxHeight],
  )
  const [collapsedMap, setCollapsedMap] = useState<Record<number, boolean>>({})

  if (files.length === 0) {
    return (
      <div className={cn('surface-card px-3 py-2 text-[12px] text-fg-subtle')}>无差异内容</div>
    )
  }

  return (
    <div className="flex flex-col gap-2">
      {files.map((file, fi) => {
        const collapsed = collapsible ? (collapsedMap[fi] ?? defaultCollapsed) : false
        const meta = STATUS_META[file.status] ?? STATUS_META.modified
        const fileKey = `${fi}:${file.path}`
        return (
          <div key={fileKey} className={cn('surface-card overflow-hidden')}>
            {/* sticky file header */}
            <div
              className={cn(
                'sticky top-0 z-10 flex items-center gap-2 border-b border-line bg-surface px-2 py-1.5',
                'text-[12px]',
              )}
            >
              {collapsible ? (
                <button
                  type="button"
                  aria-expanded={!collapsed}
                  onClick={() => setCollapsedMap((prev) => ({ ...prev, [fi]: !collapsed }))}
                  className={cn(
                    'flex shrink-0 items-center gap-1 rounded-xs px-1 py-0.5 text-fg-muted',
                    'transition-colors hover:bg-surface-2 hover:text-fg',
                  )}
                >
                  {collapsed ? <ChevronRight size={13} /> : <ChevronDown size={13} />}
                  <span className={cn('rounded-xs px-1.5 py-px text-2xs font-medium', meta.className)}>
                    {meta.label}
                  </span>
                </button>
              ) : (
                <span className={cn('shrink-0 rounded-xs px-1.5 py-px text-2xs font-medium', meta.className)}>
                  {meta.label}
                </span>
              )}

              <span
                className={cn('min-w-0 flex-1 truncate font-mono text-[12px] text-fg')}
                title={file.path}
              >
                {shortPath(file.path, 4)}
              </span>

              {file.oldPath && file.oldPath !== file.path ? (
                <span className="hidden shrink-0 font-mono text-[11px] text-fg-subtle sm:inline">
                  ← {shortPath(file.oldPath, 2)}
                </span>
              ) : null}

              {file.binary ? (
                <span className="shrink-0 rounded-xs bg-surface-2 px-1.5 py-px text-2xs text-fg-subtle">
                  二进制
                </span>
              ) : (
                <DiffStat additions={file.additions} deletions={file.deletions} />
              )}
            </div>

            {collapsed ? null : (
              <div
                className={cn('scroll-quiet overflow-auto', wrap && 'overflow-x-hidden')}
                style={scrollStyle}
              >
                {file.binary ? (
                  <div className="px-3 py-2 text-[12px] text-fg-subtle">二进制文件，无法显示差异</div>
                ) : file.hunks.length === 0 ? (
                  <div className="px-3 py-2 text-[12px] text-fg-subtle">无差异内容</div>
                ) : view === 'split' ? (
                  <SplitBody file={file} wrap={wrap} showLineNumbers={showLineNumbers} />
                ) : (
                  <UnifiedBody file={file} wrap={wrap} showLineNumbers={showLineNumbers} />
                )}
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}

export const DiffView = memo(DiffViewBase)
DiffView.displayName = 'DiffView'

/* ------------------------------------------------------------------ *
 * Unified body
 * ------------------------------------------------------------------ */

function UnifiedBody({
  file,
  wrap,
  showLineNumbers,
}: {
  file: FileDiff
  wrap: boolean
  showLineNumbers: boolean
}): ReactNode {
  const rows: ReactNode[] = []
  file.hunks.forEach((hunk, hi) => {
    rows.push(
      <div
        key={`${hi}:h`}
        className="min-w-max bg-surface-2 px-2 py-0.5 font-mono text-[11px] text-fg-subtle"
      >
        <span className="whitespace-pre">{hunk.header}</span>
        {hunk.oldLines === 0 ? <span className="ml-2 opacity-70">新增文件内容</span> : null}
      </div>,
    )

    const pendingRemoved: DiffLine[] = []
    const pendingAdded: DiffLine[] = []
    const flush = (): void => {
      const pairs = Math.max(pendingRemoved.length, pendingAdded.length)
      for (let k = 0; k < pairs; k += 1) {
        const rem = pendingRemoved[k]
        const add = pendingAdded[k]
        if (rem) {
          const emph = add ? emphasisOfPair(rem.text, add.text) : {}
          rows.push(renderUnifiedLine(rem, wrap, showLineNumbers, emph.old, 'del', `${hi}:r${k}`))
        }
        if (add) {
          const emph = rem ? emphasisOfPair(rem.text, add.text) : {}
          rows.push(renderUnifiedLine(add, wrap, showLineNumbers, emph.next, 'add', `${hi}:a${k}`))
        }
      }
      pendingRemoved.length = 0
      pendingAdded.length = 0
    }

    hunk.lines.forEach((line, li) => {
      if (line.kind === 'removed') {
        pendingRemoved.push(line)
        return
      }
      if (line.kind === 'added') {
        pendingAdded.push(line)
        return
      }
      flush()
      if (line.kind === 'meta') rows.push(renderMetaRow(line, wrap, `${hi}:m${li}`))
      else rows.push(renderUnifiedLine(line, wrap, showLineNumbers, undefined, 'ctx', `${hi}:c${li}`))
    })
    flush()
  })

  return <div className={cn('py-0.5')}>{rows}</div>
}

function renderUnifiedLine(
  line: DiffLine,
  wrap: boolean,
  showLineNumbers: boolean,
  emphasis: EmphasisRange | undefined,
  tone: 'add' | 'del' | 'ctx',
  key: string,
): ReactNode {
  const inner = tone === 'add' ? emphasizeRuns(line.text, emphasis, 'add') : tone === 'del' ? emphasizeRuns(line.text, emphasis, 'del') : line.text
  const sign = tone === 'add' ? '+' : tone === 'del' ? '-' : ' '
  return (
    <div
      key={key}
      className={cn(
        'flex min-w-max items-start px-2',
        !wrap && 'whitespace-pre',
        wrap && 'min-w-0 whitespace-pre-wrap break-all',
        UNIFIED_BG[line.kind],
      )}
    >
      {showLineNumbers ? (
        <span className="flex shrink-0 select-none">
          <NumberCell value={line.oldNumber} />
          <NumberCell value={line.newNumber} />
        </span>
      ) : null}
      <SignCell value={sign} tone={tone} />
      <span className={cn(!wrap && 'whitespace-pre', wrap && 'whitespace-pre-wrap break-all')}>
        {inner}
      </span>
    </div>
  )
}

/* ------------------------------------------------------------------ *
 * Split body
 * ------------------------------------------------------------------ */

interface SplitCell {
  kind: DiffLine['kind']
  text: string
  number?: number
  emphasis?: EmphasisRange
}

interface SplitRow {
  key: string
  oldSide?: SplitCell
  newSide?: SplitCell
}

function SplitBody({
  file,
  wrap,
  showLineNumbers,
}: {
  file: FileDiff
  wrap: boolean
  showLineNumbers: boolean
}): ReactNode {
  const rows: ReactNode[] = []
  file.hunks.forEach((hunk, hi) => {
    rows.push(
      <div
        key={`${hi}:sh`}
        className={cn(
          'bg-surface-2 px-2 py-0.5 font-mono text-[11px] text-fg-subtle',
          wrap ? 'whitespace-pre-wrap break-all' : 'w-max whitespace-pre',
        )}
      >
        {hunk.header}
      </div>,
    )

    for (const row of buildSplitRows(hunk, hi)) {
      rows.push(
        <SplitGridRow
          key={row.key}
          row={row}
          wrap={wrap}
          showLineNumbers={showLineNumbers}
        />,
      )
    }
  })
  return <div className="py-0.5">{rows}</div>
}

function buildSplitRows(hunk: DiffHunk, hi: number): SplitRow[] {
  const rows: SplitRow[] = []
  let pendingRemoved: DiffLine[] = []
  let pendingAdded: DiffLine[] = []
  let tail = 0

  const flush = (): void => {
    pendingRemoved.forEach((_line, idx) => {
      const rem = pendingRemoved[idx]
      const add = pendingAdded[idx]
      const emph = rem && add ? emphasisOfPair(rem.text, add.text) : {}
      rows.push({
        key: `${hi}:pr${tail}_${idx}`,
        oldSide: rem
          ? { kind: 'removed', text: rem.text, number: rem.oldNumber, emphasis: emph.old }
          : undefined,
        newSide: add
          ? { kind: 'added', text: add.text, number: add.newNumber, emphasis: emph.next }
          : undefined,
      })
    })
    for (let idx = pendingRemoved.length; idx < pendingAdded.length; idx += 1) {
      const add = pendingAdded[idx]
      if (!add) continue
      rows.push({
        key: `${hi}:pa${tail}_${idx}`,
        newSide: { kind: 'added', text: add.text, number: add.newNumber },
      })
    }
    pendingRemoved = []
    pendingAdded = []
    tail += 1
  }

  hunk.lines.forEach((line, li) => {
    if (line.kind === 'removed') {
      pendingRemoved.push(line)
      return
    }
    if (line.kind === 'added') {
      pendingAdded.push(line)
      return
    }
    flush()
    if (line.kind === 'meta') {
      rows.push({
        key: `${hi}:sm${li}`,
        oldSide: { kind: 'meta', text: line.text, emphasis: undefined },
      })
      return
    }
    rows.push({
      key: `${hi}:sc${li}`,
      oldSide: { kind: 'context', text: line.text, number: line.oldNumber },
      newSide: { kind: 'context', text: line.text, number: line.newNumber },
    })
  })
  flush()
  return rows
}

function SplitGridRow({
  row,
  wrap,
  showLineNumbers,
}: {
  row: SplitRow
  wrap: boolean
  showLineNumbers: boolean
}): ReactNode {
  return (
    <div className={cn('flex min-w-max items-stretch', wrap && 'min-w-0')}>
      <SplitGridCell cell={row.oldSide} wrap={wrap} showLineNumbers={showLineNumbers} side="old" />
      <span className="w-px shrink-0 self-stretch bg-line" aria-hidden="true" />
      <SplitGridCell cell={row.newSide} wrap={wrap} showLineNumbers={showLineNumbers} side="new" />
    </div>
  )
}

function SplitGridCell({
  cell,
  wrap,
  showLineNumbers,
  side,
}: {
  cell: SplitCell | undefined
  wrap: boolean
  showLineNumbers: boolean
  side: 'old' | 'new'
}): ReactNode {
  if (!cell) {
    return (
      <div
        className={cn(
          'shrink-0 bg-surface-2/40',
          wrap ? 'min-w-0 flex-1' : 'w-[46ch]',
        )}
        aria-hidden="true"
      />
    )
  }
  if (cell.kind === 'meta') {
    return (
      <div className={cn('min-w-0 flex-1 bg-surface-2 px-2 text-[11px] italic text-fg-subtle')}>
        <span className={cn(wrap ? 'whitespace-pre-wrap break-all' : 'whitespace-pre')}>
          {cell.text}
        </span>
      </div>
    )
  }
  const tone: 'add' | 'del' | 'ctx' =
    cell.kind === 'added' ? 'add' : cell.kind === 'removed' ? 'del' : 'ctx'
  const sign = tone === 'add' ? '+' : tone === 'del' ? '-' : ' '
  const inner =
    tone === 'add' ? emphasizeRuns(cell.text, cell.emphasis, 'add') : tone === 'del' ? emphasizeRuns(cell.text, cell.emphasis, 'del') : cell.text
  return (
    <div
      className={cn(
        'flex min-w-0 flex-1 items-start px-2',
        UNIFIED_BG[cell.kind],
        !wrap && 'whitespace-pre',
        wrap && 'whitespace-pre-wrap break-all',
      )}
      data-side={side}
    >
      {showLineNumbers ? <NumberCell value={cell.number} /> : null}
      <SignCell value={sign} tone={tone} />
      <span className={cn('min-w-0', !wrap && 'whitespace-pre', wrap && 'whitespace-pre-wrap break-all')}>
        {inner}
      </span>
    </div>
  )
}

/* ------------------------------------------------------------------ *
 * DiffStat
 * ------------------------------------------------------------------ */

export interface DiffStatProps {
  additions: number
  deletions: number
  className?: string
}

function DiffStatBase({ additions, deletions, className }: DiffStatProps): ReactNode {
  const add = Number.isFinite(additions) ? Math.max(0, additions) : 0
  const del = Number.isFinite(deletions) ? Math.max(0, deletions) : 0
  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center gap-1.5 rounded-xs bg-surface-2 px-1.5 py-px',
        'font-mono text-2xs tabular-nums',
        className,
      )}
      title={`${add} ${pluralize(add, 'addition')} / ${del} ${pluralize(del, 'deletion')}`}
    >
      <span className={cn(add > 0 ? 'text-success' : 'text-fg-subtle')}>+{add}</span>
      <span className={cn(del > 0 ? 'text-danger' : 'text-fg-subtle')}>−{del}</span>
    </span>
  )
}

export const DiffStat = memo(DiffStatBase)
DiffStat.displayName = 'DiffStat'

export default DiffView
