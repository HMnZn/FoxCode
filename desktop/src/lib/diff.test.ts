/**
 * `parseUnifiedDiff` 的单元测试：行号、增删计数与文件头。
 *
 * 这些断言盯着的是「预览面板会不会把行号标错」—— 差异行号错位比不显示更糟。
 */
import { describe, expect, it } from 'vitest'
import { extensionHint, parseEditDiff, parseUnifiedDiff } from '@/lib/diff'

const SAMPLE = [
  'diff --git a/demo.py b/demo.py',
  'index 1111111..2222222 100644',
  '--- a/demo.py',
  '+++ b/demo.py',
  '@@ -1,4 +1,5 @@',
  ' import os',
  '-print("a")',
  '+print("b")',
  '+print("c")',
  ' ',
  ' def main():',
  '@@ -20,3 +21,2 @@ def main():',
  '     return 0',
  '-    # gone',
  '\\ No newline at end of file',
].join('\n')

describe('parseUnifiedDiff', () => {
  it('separates the file header from the hunks', () => {
    const parsed = parseUnifiedDiff(SAMPLE)[0]
    expect(parsed.header).toHaveLength(4)
    expect(parsed.path).toBe('demo.py')
    expect(parsed.status).toBe('modified')
    expect(parsed.hunks).toHaveLength(2)
    expect(parsed.hunks[0].header).toBe('@@ -1,4 +1,5 @@')
  })

  it('counts additions and deletions', () => {
    const parsed = parseUnifiedDiff(SAMPLE)[0]
    expect(parsed.additions).toBe(2)
    expect(parsed.deletions).toBe(2)
  })

  it('tracks old and new line numbers independently', () => {
    const [first] = parseUnifiedDiff(SAMPLE)[0].hunks
    const numbers = first.lines.map((line) => [line.kind, line.oldNumber ?? null, line.newNumber ?? null])
    expect(numbers).toEqual([
      ['context', 1, 1],
      ['removed', 2, null],
      ['added', null, 2],
      ['added', null, 3],
      ['context', 3, 4],
      ['context', 4, 5],
    ])
  })

  it('restarts numbering at each hunk', () => {
    const second = parseUnifiedDiff(SAMPLE)[0].hunks[1]
    expect(second.lines[0]).toMatchObject({ kind: 'context', oldNumber: 20, newNumber: 21 })
    expect(second.lines[1]).toMatchObject({ kind: 'removed', oldNumber: 21 })
    expect(second.lines[2]).toMatchObject({ kind: 'meta' })
  })

  it('survives empty and header-only input', () => {
    expect(parseUnifiedDiff('')).toEqual([])
    const only = parseUnifiedDiff('--- a/x\n+++ b/x\n')[0]
    expect(only.hunks).toEqual([])
    expect(only.path).toBe('x')
  })

  it('keeps separate files, renames and binary metadata', () => {
    const files = parseUnifiedDiff([
      SAMPLE,
      'diff --git a/old.txt b/new.txt',
      'similarity index 100%',
      'rename from old.txt',
      'rename to new.txt',
      'diff --git a/icon.png b/icon.png',
      'Binary files a/icon.png and b/icon.png differ',
    ].join('\n'))
    expect(files).toHaveLength(3)
    expect(files[1]).toMatchObject({ path: 'new.txt', oldPath: 'old.txt', status: 'renamed' })
    expect(files[2]).toMatchObject({ path: 'icon.png', binary: true, hunks: [] })
  })

  it('handles CRLF, added and deleted files and streaming tails', () => {
    const added = parseUnifiedDiff('--- /dev/null\r\n+++ b/new.txt\r\n@@ -0,0 +1,2 @@\r\n+first')[0]
    expect(added).toMatchObject({ path: 'new.txt', status: 'added', additions: 1 })
    expect(added.hunks[0].lines[0]).toMatchObject({ kind: 'added', newNumber: 1, text: 'first' })
    const deleted = parseUnifiedDiff('--- a/old.txt\n+++ /dev/null\n@@ -1 +0,0 @@\n-gone')[0]
    expect(deleted).toMatchObject({ path: 'old.txt', status: 'deleted', deletions: 1 })
  })

})

describe('extensionHint', () => {
  it('reads the extension as a language hint', () => {
    expect(extensionHint('desktop/src/App.tsx')).toBe('tsx')
    expect(extensionHint('fox_serve\\workspace_files.py')).toBe('py')
    expect(extensionHint('README')).toBe('')
    expect(extensionHint('archive.tar.gz')).toBe('gz')
  })
})

describe('parseEditDiff', () => {
  it('preserves unchanged context and independent line numbers', () => {
    const parsed = parseEditDiff('start\nold\nend', 'start\nnew\nextra\nend', 'demo.txt')
    expect(parsed).toMatchObject({ path: 'demo.txt', additions: 2, deletions: 1 })
    expect(parsed.hunks[0].lines.map((line) => [line.kind, line.oldNumber, line.newNumber])).toEqual([
      ['context', 1, 1], ['removed', 2, undefined], ['added', undefined, 2],
      ['added', undefined, 3], ['context', 3, 4],
    ])
  })

  it('omits hunks for identical content and reports creation/deletion', () => {
    expect(parseEditDiff('same', 'same', 'x').hunks).toEqual([])
    expect(parseEditDiff('', 'new', 'x').status).toBe('added')
    expect(parseEditDiff('old', '', 'x').status).toBe('deleted')
  })
})
