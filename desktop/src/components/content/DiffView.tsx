import { memo, useMemo, useState } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import { ChevronDown, ChevronRight } from 'lucide-react'
import { cn } from '@/lib/cn'
import { pluralize, shortPath } from '@/lib/format'

/* ------------------------------------------------------------------ *
 * DiffView — dependency-free unified/split renderer for `git diff`
 * and synthesized edit diffs.
 *
 * `desktop/src/lib/highlight.ts` is not present in this workspace, so
 * the local fallback `lineTone()` below is used instead of importing
 * `classifyLine` / `Language` from `@/lib/highlight`.
 * ------------------------------------------------------------------ */

export interface DiffHunk {
  header: string
  oldStart: number
  oldLines: number
  newStart: number
  newLines: number
  lines: DiffLine[]
}

export interface DiffLine {
  kind: 'context' | 'added' | 'removed' | 'meta'
  text: string
  oldNumber?: number
  newNumber?: number
}

export interface FileDiff {
  path: string
  oldPath?: string
  status: 'added' | 'modified' | 'deleted' | 'renamed'
  hunks: DiffHunk[]
  additions: number
  deletions: number
  binary?: boolean
}

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
 * Local fallback line classifier (stand-in for @/lib/highlight)
 * ------------------------------------------------------------------ */

/** Classify a raw unified-diff line by its leading sigil. */
export function lineTone(line: string): 'added' | 'removed' | 'context' | 'meta' {
  if (line.startsWith('+++') || line.startsWith('---')) return 'meta'
  if (line.startsWith('@@')) return 'meta'
  if (line.startsWith('\\')) return 'meta'
  if (line.startsWith('+')) return 'added'
  if (line.startsWith('-')) return 'removed'
  if (line.startsWith('diff ') || line.startsWith('index ')) return 'meta'
  return 'context'
}

/* ------------------------------------------------------------------ *
 * Unified diff parser
 * ------------------------------------------------------------------ */

const HUNK_RE = /^@@+ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@+[ \t]?(.*)$/
const GIT_HEADER_RE = /^diff --git (?:"((?:[^"\\]|\\.)*)"|(\S+)) (?:"((?:[^"\\]|\\.)*)"|(\S+))/

function stripGitPrefix(raw: string): string {
  let p = raw.trim()
  if (p.length >= 2 && p.startsWith('"') && p.endsWith('"')) {
    p = p.slice(1, -1).replace(/\\(.)/g, '$1')
  }
  if (p === '/dev/null') return p
  if (p.startsWith('a/') || p.startsWith('b/')) p = p.slice(2)
  return p
}

function makeHunk(
  oldStart: number,
  oldLines: number,
  newStart: number,
  newLines: number,
  header: string,
): DiffHunk {
  return { oldStart, oldLines, newStart, newLines, header, lines: [] }
}

/**
 * Parse real `git diff` / `diff -u` output into structured file diffs.
 * Never throws; a truncated (streaming) trailing hunk is emitted as-is.
 */
export function parseUnifiedDiff(text: string): FileDiff[] {
  const files: FileDiff[] = []
  if (typeof text !== 'string' || text.length === 0) return files

  const rawLines = text.split(/\r\n|\r|\n/)
  if (rawLines.length > 0 && rawLines[rawLines.length - 1] === '') rawLines.pop()

  let current: FileDiff | null = null
  let hunk: DiffHunk | null = null
  let oldCursor = 0
  let newCursor = 0
  let pendingOldPath: string | null = null
  let pendingNewPath: string | null = null
  let sawBinary = false

  const ensure = (): FileDiff => {
    if (current) return current
    const fallback = pendingNewPath ?? pendingOldPath ?? 'unknown'
    current = {
      path: fallback === '/dev/null' ? 'unknown' : stripGitPrefix(fallback),
      status: 'modified',
      hunks: [],
      additions: 0,
      deletions: 0,
    }
    return current
  }

  const finish = (): void => {
    if (!current) return
    if (pendingOldPath && pendingNewPath && pendingOldPath !== pendingNewPath) {
      current.oldPath = stripGitPrefix(pendingOldPath)
      if (current.path === 'unknown' || current.path === '') {
        current.path = stripGitPrefix(pendingNewPath)
      }
    }
    current.binary = sawBinary ? true : undefined
    files.push(current)
    current = null
    hunk = null
  }

  for (const raw of rawLines) {
    const git = GIT_HEADER_RE.exec(raw)
    if (git) {
      finish()
      const left = git[1] ?? git[2] ?? ''
      const right = git[3] ?? git[4] ?? ''
      pendingOldPath = stripGitPrefix(left)
      pendingNewPath = stripGitPrefix(right)
      sawBinary = false
      current = {
        path: pendingNewPath === '/dev/null' ? pendingOldPath : pendingNewPath,
        status: 'modified',
        hunks: [],
        additions: 0,
        deletions: 0,
      }
      hunk = null
      continue
    }

    const parsed = HUNK_RE.exec(raw)
    if (parsed) {
      const head = ensure()
      hunk = makeHunk(
        Number(parsed[1]),
        parsed[2] === undefined ? 1 : Number(parsed[2]),
        Number(parsed[3]),
        parsed[4] === undefined ? 1 : Number(parsed[4]),
        parsed[5] ?? '',
      )
      head.hunks.push(hunk)
      oldCursor = hunk.oldStart
      newCursor = hunk.newStart
      continue
    }

    /* ---- trailer / metadata form lines (only outside a hunk body) ---- */
    if (!hunk) {
      if (raw.startsWith('Binary files ') || raw.startsWith('GIT binary patch')) {
        sawBinary = true
        const head = ensure()
        const bin = /^Binary files (?:"([^"]+)"|(\S+)) and (?:"([^"]+)"|(\S+)) differ/.exec(raw)
        if (bin) {
          const p = bin[3] ?? bin[4] ?? bin[1] ?? bin[2]
          if (p) head.path = stripGitPrefix(p)
        }
        continue
      }
      if (raw.startsWith('rename from ')) {
        const head = ensure()
        head.status = 'renamed'
        head.oldPath = stripGitPrefix(raw.slice('rename from '.length))
        continue
      }
      if (raw.startsWith('rename to ')) {
        const head = ensure()
        head.status = 'renamed'
        head.path = stripGitPrefix(raw.slice('rename to '.length))
        continue
      }
      if (raw.startsWith('copy from ') || raw.startsWith('copy to ')) continue
      if (raw.startsWith('similarity index ') || raw.startsWith('dissimilarity index ')) continue
      if (raw.startsWith('new file mode')) {
        ensure().status = 'added'
        continue
      }
      if (raw.startsWith('deleted file mode')) {
        ensure().status = 'deleted'
        continue
      }
      if (raw.startsWith('old mode ') || raw.startsWith('new mode ')) continue
      if (raw.startsWith('index ')) continue
      if (raw.startsWith('--- ')) {
        pendingOldPath = raw.slice(4).trim()
        continue
      }
      if (raw.startsWith('+++ ')) {
        pendingNewPath = raw.slice(4).trim()
        const head = ensure()
        const next = stripGitPrefix(pendingNewPath)
        if (next !== '/dev/null') head.path = next
        else if (pendingOldPath) head.path = stripGitPrefix(pendingOldPath)
        if (pendingOldPath === '/dev/null') head.status = 'added'
        else if (pendingNewPath === '/dev/null') head.status = 'deleted'
        else if (pendingOldPath && pendingOldPath !== pendingNewPath) {
          head.status = 'renamed'
          head.oldPath = stripGitPrefix(pendingOldPath)
        }
        continue
      }
      if (raw.length === 0) continue
      /* Unknown preamble (commit headers, `diff -u` timestamps, …) */
      continue
    }

    /* ---- hunk body ---- */
    const head = ensure()
    const sigil = raw.charAt(0)
    if (sigil === '\\') {
      hunk.lines.push({ kind: 'meta', text: raw })
      continue
    }
    if (sigil === '+') {
      hunk.lines.push({ kind: 'added', text: raw.slice(1), newNumber: newCursor })
      newCursor += 1
      head.additions += 1
      continue
    }
    if (sigil === '-') {
      hunk.lines.push({ kind: 'removed', text: raw.slice(1), oldNumber: oldCursor })
      oldCursor += 1
      head.deletions += 1
      continue
    }
    if (sigil === ' ') {
      hunk.lines.push({
        kind: 'context',
        text: raw.slice(1),
        oldNumber: oldCursor,
        newNumber: newCursor,
      })
      oldCursor += 1
      newCursor += 1
      continue
    }
    /* Truncated tail or malformed line — record as meta, keep going. */
    hunk.lines.push({ kind: 'meta', text: raw })
  }

  finish()
  return files
}

/* ------------------------------------------------------------------ *
 * Synthesized (old text → new text) diff
 * ------------------------------------------------------------------ */

const LCS_CAP = 2000

function lcsMatches(a: string[], b: string[]): Array<[number, number]> {
  const n = a.length
  const m = b.length
  const table: Int32Array[] = []
  for (let i = 0; i <= n; i += 1) table.push(new Int32Array(m + 1))
  for (let i = n - 1; i >= 0; i -= 1) {
    const row = table[i]
    const next = table[i + 1]
    if (!row || !next) continue
    for (let j = m - 1; j >= 0; j -= 1) {
      const below = next[j]
      if (a[i] === b[j]) row[j] = (below ?? 0) + 1
      else {
        const cur = row[j + 1] ?? 0
        row[j] = Math.max(below ?? 0, cur)
      }
    }
  }
  const pairs: Array<[number, number]> = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    const row = table[i]
    const next = table[i + 1]
    const below = next?.[j] ?? 0
    if (a[i] === b[j]) {
      pairs.push([i, j])
      i += 1
      j += 1
    } else if ((row?.[j + 1] ?? 0) >= below) j += 1
    else i += 1
  }
  return pairs
}

type DiffOp = { kind: 'keep' | 'remove' | 'add'; a: number; b: number }

function diffOps(a: string[], b: string[]): DiffOp[] {
  const ops: DiffOp[] = []
  const walk = (a0: number, a1: number, b0: number, b1: number): void => {
    while (a0 < a1 && b0 < b1 && a[a0] === b[b0]) {
      ops.push({ kind: 'keep', a: a0, b: b0 })
      a0 += 1
      b0 += 1
    }
    const tail: DiffOp[] = []
    while (a0 < a1 && b0 < b1 && a[a1 - 1] === b[b1 - 1]) {
      a1 -= 1
      b1 -= 1
      tail.push({ kind: 'keep', a: a1, b: b1 })
    }
    const na = a1 - a0
    const nb = b1 - b0
    if (na === 0 && nb === 0) {
      /* nothing interior */
    } else if (na === 0) {
      for (let k = b0; k < b1; k += 1) ops.push({ kind: 'add', a: -1, b: k })
    } else if (nb === 0) {
      for (let k = a0; k < a1; k += 1) ops.push({ kind: 'remove', a: k, b: -1 })
    } else if (na > LCS_CAP || nb > LCS_CAP) {
      for (let k = a0; k < a1; k += 1) ops.push({ kind: 'remove', a: k, b: -1 })
      for (let k = b0; k < b1; k += 1) ops.push({ kind: 'add', a: -1, b: k })
    } else {
      const subA = a.slice(a0, a1)
      const subB = b.slice(b0, b1)
      const matches = lcsMatches(subA, subB)
      let pa = a0
      let pb = b0
      for (const [mi, mj] of matches) {
        const ai = a0 + mi
        const bj = b0 + mj
        for (let k = pa; k < ai; k += 1) ops.push({ kind: 'remove', a: k, b: -1 })
        for (let k = pb; k < bj; k += 1) ops.push({ kind: 'add', a: -1, b: k })
        ops.push({ kind: 'keep', a: ai, b: bj })
        pa = ai + 1
        pb = bj + 1
      }
      for (let k = pa; k < a1; k += 1) ops.push({ kind: 'remove', a: k, b: -1 })
      for (let k = pb; k < b1; k += 1) ops.push({ kind: 'add', a: -1, b: k })
    }
    for (let k = tail.length - 1; k >= 0; k -= 1) {
      const op = tail[k]
      if (op) ops.push(op)
    }
  }
  walk(0, a.length, 0, b.length)
  return ops
}

/**
 * Compute a single-hunk line diff between two texts (no dependency).
 * Common prefix/suffix lines are trimmed first, then an LCS pass runs over
 * the remainder (capped at 2000×2000); over the cap the region degrades to
 * "whole region replaced".
 */
export function parseEditDiff(
  oldText: string,
  newText: string,
  path: string,
  context = 3,
): FileDiff {
  const a = typeof oldText === 'string' && oldText.length > 0 ? oldText.split(/\r\n|\r|\n/) : []
  const b = typeof newText === 'string' && newText.length > 0 ? newText.split(/\r\n|\r|\n/) : []
  const ctx = Number.isFinite(context) ? Math.max(0, Math.floor(context)) : 3

  const ops = diffOps(a, b)
  const additions = ops.filter((op) => op.kind === 'add').length
  const deletions = ops.filter((op) => op.kind === 'remove').length

  const firstChange = ops.findIndex((op) => op.kind !== 'keep')
  const allSame = firstChange === -1

  const file: FileDiff = {
    path: typeof path === 'string' && path.length > 0 ? path : 'unknown',
    status: a.length === 0 && b.length > 0 ? 'added' : b.length === 0 && a.length > 0 ? 'deleted' : 'modified',
    hunks: [],
    additions,
    deletions,
  }
  if (allSame) return file

  let lastChange = ops.length - 1
  while (lastChange > 0 && ops[lastChange]?.kind === 'keep') lastChange -= 1

  const from = Math.max(0, firstChange - ctx)
  const to = Math.min(ops.length - 1, lastChange + ctx)
  const window = ops.slice(from, to + 1)

  const lines: DiffLine[] = []
  let oldLines = 0
  let newLines = 0
  for (const op of window) {
    if (op.kind === 'keep') {
      const oldNumber = op.a + 1
      const newNumber = op.b + 1
      lines.push({ kind: 'context', text: a[op.a] ?? '', oldNumber, newNumber })
      oldLines += 1
      newLines += 1
    } else if (op.kind === 'remove') {
      const oldNumber = op.a + 1
      lines.push({ kind: 'removed', text: a[op.a] ?? '', oldNumber })
      oldLines += 1
    } else {
      const newNumber = op.b + 1
      lines.push({ kind: 'added', text: b[op.b] ?? '', newNumber })
      newLines += 1
    }
  }

  const first = lines[0]
  const oldStart = firstKindLine(first, 'old')
  const newStart = firstKindLine(first, 'new')
  const header = `@@ -${oldStart},${oldLines} +${newStart},${newLines} @@`
  file.hunks.push({
    header,
    oldStart,
    oldLines,
    newStart,
    newLines,
    lines,
  })
  return file
}

/** 1-based start line for whichever side the hunk window opens on. */
function firstKindLine(first: DiffLine | undefined, side: 'old' | 'new'): number {
  if (!first) return 1
  const num = side === 'old' ? first.oldNumber : first.newNumber
  return num === undefined ? 1 : num
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

const EMPTY_DIFF: FileDiff = {
  path: '',
  status: 'modified',
  hunks: [],
  additions: 0,
  deletions: 0,
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
    if (pendingRemoved.length > pendingAdded.length) {
      /* already covered by the first loop */
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

/* ------------------------------------------------------------------ *
 * MiniDiff — 3-line preview for collapsed tool cards
 * ------------------------------------------------------------------ */

export interface MiniDiffProps {
  diff: FileDiff | FileDiff[]
  maxLines?: number
  className?: string
}

function MiniDiffBase({ diff, maxLines = 3, className }: MiniDiffProps): ReactNode {
  const preview = useMemo(() => {
    const list = Array.isArray(diff) ? diff : [diff]
    const files = list.filter((f): f is FileDiff => Boolean(f) && typeof f === 'object')
    const rows: Array<{ key: string; kind: DiffLine['kind']; text: string }> = []
    let additions = 0
    let deletions = 0
    let binary = false
    let path = ''
    for (const file of files) {
      if (!path) path = file.path
      if (file.binary) binary = true
      additions += file.additions
      deletions += file.deletions
    }
    outer: for (let fi = 0; fi < files.length; fi += 1) {
      const file = files[fi]
      if (!file) continue
      for (let hi = 0; hi < file.hunks.length; hi += 1) {
        const hunk = file.hunks[hi]
        if (!hunk) continue
        for (let li = 0; li < hunk.lines.length; li += 1) {
          const line = hunk.lines[li]
          if (!line || line.kind === 'context') continue
          if (rows.length >= maxLines) break outer
          rows.push({ key: `${fi}:${hi}:${li}`, kind: line.kind, text: line.text })
        }
      }
    }
    return { files, rows, additions, deletions, binary, path }
  }, [diff, maxLines])

  if (preview.files.length === 0) {
    return <div className={cn('font-mono text-2xs text-fg-subtle', className)}>无差异内容</div>
  }

  return (
    <div className={cn('flex flex-col gap-1', className)}>
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-fg-muted">
          {shortPath(preview.path, 3)}
        </span>
        {preview.binary ? (
          <span className="text-2xs text-fg-subtle">二进制</span>
        ) : (
          <DiffStat additions={preview.additions} deletions={preview.deletions} />
        )}
      </div>
      {preview.rows.length === 0 ? (
        <div className="font-mono text-2xs text-fg-subtle">无代码差异</div>
      ) : (
        <div className="overflow-hidden rounded-xs border border-line bg-surface-2/60">
          {preview.rows.map((row) => (
            <div
              key={row.key}
              className={cn(
                'flex items-start gap-1 px-1.5 font-mono text-[11px] leading-[1.5]',
                row.kind === 'added' && 'bg-success-soft',
                row.kind === 'removed' && 'bg-danger-soft',
                row.kind === 'meta' && 'italic text-fg-subtle',
              )}
            >
              <span
                className={cn(
                  'shrink-0 select-none',
                  row.kind === 'added' ? 'text-success' : row.kind === 'removed' ? 'text-danger' : 'text-transparent',
                )}
              >
                {row.kind === 'added' ? '+' : row.kind === 'removed' ? '−' : ' '}
              </span>
              <span className="min-w-0 truncate whitespace-pre">{row.text || ' '}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

export const MiniDiff = memo(MiniDiffBase)
MiniDiff.displayName = 'MiniDiff'

export { EMPTY_DIFF }
export default DiffView
