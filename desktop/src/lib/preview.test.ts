import { describe, expect, it } from 'vitest'

import type { FileContent } from '@/types/protocol'

import { describeImage, imageDataUrl, preferredMode, renderKindOf, svgDataUrl } from './preview'

function content(patch: Partial<FileContent> = {}): FileContent {
  return {
    path: 'poster.png',
    absolute: 'C:\\proj\\poster.png',
    text: '',
    truncated: false,
    binary: false,
    size: 1024,
    ...patch,
  }
}

describe('renderKindOf', () => {
  it('knows the image, page and document extensions', () => {
    expect(renderKindOf('assets/cover.PNG')).toBe('image')
    expect(renderKindOf('poster.svg')).toBe('svg')
    expect(renderKindOf('report.html')).toBe('html')
    expect(renderKindOf('docs/handbook.md')).toBe('markdown')
    expect(renderKindOf('desktop/package.json')).toBe('json')
  })

  it('leaves plain source files alone', () => {
    expect(renderKindOf('main.py')).toBeNull()
    expect(renderKindOf('README')).toBeNull()
    // 只认最后一个后缀：`a.html.txt` 是文本。
    expect(renderKindOf('a.html.txt')).toBeNull()
  })
})

describe('preferredMode', () => {
  it('always renders an image, whichever list it was clicked from', () => {
    expect(preferredMode('shot.png', 'diff')).toBe('render')
    expect(preferredMode('shot.png', 'source')).toBe('render')
  })

  it('renders pages clicked from the file list and shows the diff first from the change list', () => {
    expect(preferredMode('report.html', 'source')).toBe('render')
    expect(preferredMode('report.html', 'diff')).toBe('diff')
    expect(preferredMode('main.py', 'diff')).toBe('diff')
    expect(preferredMode('main.py', 'source')).toBe('source')
  })
})

describe('imageDataUrl', () => {
  it('builds a data url from the host payload', () => {
    expect(imageDataUrl(content({ kind: 'image', mime: 'image/gif', data: 'AAA' }))).toBe(
      'data:image/gif;base64,AAA',
    )
  })

  it('falls back to png and stays null without data', () => {
    expect(imageDataUrl(content({ kind: 'image', data: 'AAA' }))).toBe('data:image/png;base64,AAA')
    expect(imageDataUrl(content({ kind: 'image', data: null }))).toBeNull()
  })

  it('describes what the picture is, not the file path', () => {
    expect(describeImage(content({ mime: 'image/png', size: 1048576 }))).toBe('PNG · 1.0 MB')
    // 宿主没给 MIME 时只剩大小，不留一个空荡荡的「· 」。
    expect(describeImage(content({ mime: null, size: 2048 }))).toBe('2 KB')
  })
})

describe('svgDataUrl', () => {
  it('percent-encodes inline markup instead of base64', () => {
    const url = svgDataUrl('<svg xmlns="http://www.w3.org/2000/svg"><circle r="4" /></svg>')

    expect(url.startsWith('data:image/svg+xml;charset=utf-8,')).toBe(true)
    expect(url).not.toContain('<')
    expect(decodeURIComponent(url.split(',')[1])).toContain('<circle r="4" />')
  })
})
