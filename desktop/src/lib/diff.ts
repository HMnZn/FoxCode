/** Shared diff parsing for tool cards, approvals and workspace previews. */

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
  header: string[]
  oldPath?: string
  status: 'added' | 'modified' | 'deleted' | 'renamed'
  hunks: DiffHunk[]
  additions: number
  deletions: number
  binary?: boolean
}

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
      header: [],
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
        header: [raw],
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
        raw,
      )
      head.hunks.push(hunk)
      oldCursor = hunk.oldStart
      newCursor = hunk.newStart
      continue
    }

    /* ---- trailer / metadata form lines (only outside a hunk body) ---- */
    if (!hunk) {
      ensure().header.push(raw)
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
        pendingOldPath = stripGitPrefix(raw.slice(4))
        continue
      }
      if (raw.startsWith('+++ ')) {
        pendingNewPath = stripGitPrefix(raw.slice(4))
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
    header: [],
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


/** 取文件名的扩展名当语言提示（`App.tsx` → `tsx`）。 */
export function extensionHint(path: string): string {
  const name = path.replace(/\\/g, '/').split('/').pop() ?? ''
  const dot = name.lastIndexOf('.')
  if (dot <= 0 || dot === name.length - 1) return ''
  return name.slice(dot + 1).toLowerCase()
}
