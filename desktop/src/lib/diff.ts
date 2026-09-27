/**
 * 统一差异（unified diff）解析：给右侧栏的预览面板提供「带行号、带增删着色」的行。
 *
 * 只做前端要用的那点事：
 *
 * - 文件头（`diff --git`/`index`/`---`/`+++`）与 hunk 头分开，前者弱化显示；
 * - 每个 hunk 自己维护新旧两套行号，这样删除行只占旧行号、新增行只占新行号；
 * - 不认识的边界行（`\ No newline at end of file` 之类）当 `meta`，不破坏行号。
 */

export type DiffLineKind = 'meta' | 'hunk' | 'context' | 'add' | 'del'

export interface DiffLine {
  kind: DiffLineKind
  /** 去掉首个 +/-/空格标记之后的正文。 */
  text: string
  /** 旧文件里的行号（新增行与服务端 meta 为 null）。 */
  oldNo: number | null
  /** 新文件里的行号（删除行与 meta 为 null）。 */
  newNo: number | null
}

export interface DiffHunk {
  /** `@@ -1,4 +1,6 @@ 函数名` 原样保留。 */
  header: string
  lines: DiffLine[]
}

export interface ParsedDiff {
  /** 第一个 hunk 之前的文件头行。 */
  header: string[]
  hunks: DiffHunk[]
  additions: number
  deletions: number
  /** 旧/新路径（来自 `---` / `+++`）。 */
  from: string | null
  to: string | null
}

const HUNK_RE = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/

/** 解析一份统一差异；空串返回空结果而不是抛错。 */
export function parseUnifiedDiff(diff: string): ParsedDiff {
  const result: ParsedDiff = {
    header: [],
    hunks: [],
    additions: 0,
    deletions: 0,
    from: null,
    to: null,
  }
  if (!diff) return result

  const lines = diff.split('\n')
  // 末尾换行会切出一个空串，它不是内容。
  if (lines.length && lines[lines.length - 1] === '') lines.pop()

  let current: DiffHunk | null = null
  let oldNo = 0
  let newNo = 0

  for (const line of lines) {
    const hunk = HUNK_RE.exec(line)
    if (hunk) {
      current = { header: line, lines: [] }
      result.hunks.push(current)
      oldNo = Number(hunk[1])
      newNo = Number(hunk[2])
      continue
    }

    if (!current) {
      result.header.push(line)
      if (line.startsWith('--- ')) result.from = line.slice(4).trim()
      else if (line.startsWith('+++ ')) result.to = line.slice(4).trim()
      continue
    }

    if (line.startsWith('\\')) {
      current.lines.push({ kind: 'meta', text: line, oldNo: null, newNo: null })
      continue
    }
    if (line.startsWith('+')) {
      result.additions += 1
      current.lines.push({ kind: 'add', text: line.slice(1), oldNo: null, newNo })
      newNo += 1
      continue
    }
    if (line.startsWith('-')) {
      result.deletions += 1
      current.lines.push({ kind: 'del', text: line.slice(1), oldNo, newNo: null })
      oldNo += 1
      continue
    }
    current.lines.push({
      kind: 'context',
      text: line.startsWith(' ') ? line.slice(1) : line,
      oldNo,
      newNo,
    })
    oldNo += 1
    newNo += 1
  }

  return result
}

/** 差异是否只是一次「整文件替换」（宿主在对比超时后会这样退化）。 */
export function isWholeFileReplacement(hunks: DiffHunk[]): boolean {
  return hunks.length === 1 && hunks[0].lines.every((line) => line.kind !== 'context')
}

/** 取文件名的扩展名当语言提示（`App.tsx` → `tsx`）。 */
export function extensionHint(path: string): string {
  const name = path.replace(/\\/g, '/').split('/').pop() ?? ''
  const dot = name.lastIndexOf('.')
  if (dot <= 0 || dot === name.length - 1) return ''
  return name.slice(dot + 1).toLowerCase()
}
