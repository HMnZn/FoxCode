/**
 * `parseUnifiedDiff` 的单元测试：行号、增删计数与文件头。
 *
 * 这些断言盯着的是「预览面板会不会把行号标错」—— 差异行号错位比不显示更糟。
 */
import { describe, expect, it } from 'vitest'
import { extensionHint, isWholeFileReplacement, parseUnifiedDiff } from '@/lib/diff'

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
    const parsed = parseUnifiedDiff(SAMPLE)
    expect(parsed.header).toHaveLength(4)
    expect(parsed.from).toBe('a/demo.py')
    expect(parsed.to).toBe('b/demo.py')
    expect(parsed.hunks).toHaveLength(2)
    expect(parsed.hunks[0].header).toBe('@@ -1,4 +1,5 @@')
  })

  it('counts additions and deletions', () => {
    const parsed = parseUnifiedDiff(SAMPLE)
    expect(parsed.additions).toBe(2)
    expect(parsed.deletions).toBe(2)
  })

  it('tracks old and new line numbers independently', () => {
    const [first] = parseUnifiedDiff(SAMPLE).hunks
    const numbers = first.lines.map((line) => [line.kind, line.oldNo, line.newNo])
    expect(numbers).toEqual([
      ['context', 1, 1],
      ['del', 2, null],
      ['add', null, 2],
      ['add', null, 3],
      ['context', 3, 4],
      ['context', 4, 5],
    ])
  })

  it('restarts numbering at each hunk', () => {
    const second = parseUnifiedDiff(SAMPLE).hunks[1]
    expect(second.lines[0]).toMatchObject({ kind: 'context', oldNo: 20, newNo: 21 })
    expect(second.lines[1]).toMatchObject({ kind: 'del', oldNo: 21, newNo: null })
    expect(second.lines[2]).toMatchObject({ kind: 'meta', oldNo: null, newNo: null })
  })

  it('survives empty and header-only input', () => {
    expect(parseUnifiedDiff('').hunks).toEqual([])
    const only = parseUnifiedDiff('--- a/x\n+++ b/x\n')
    expect(only.hunks).toEqual([])
    expect(only.to).toBe('b/x')
  })

  it('detects a whole-file replacement', () => {
    const coarse = parseUnifiedDiff('@@ -1,1 +1,1 @@\n-old\n+new\n')
    expect(isWholeFileReplacement(coarse.hunks)).toBe(true)
    expect(isWholeFileReplacement(parseUnifiedDiff(SAMPLE).hunks)).toBe(false)
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
