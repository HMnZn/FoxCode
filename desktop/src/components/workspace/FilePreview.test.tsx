import { describe, expect, it } from 'vitest'
import { fitHtml } from '@/components/workspace/FilePreview'

const STYLE_MARK = 'img,svg,video,canvas{max-width:100% !important'

describe('fitHtml', () => {
  it('把收敛样式插在 head 里、页面样式之后', () => {
    const html = '<!doctype html>\n<html><head><title>t</title></head><body>x</body></html>'
    const out = fitHtml(html)
    expect(out).toContain(STYLE_MARK)
    expect(out.indexOf('<title>')).toBeLessThan(out.indexOf(STYLE_MARK))
    expect(out.indexOf(STYLE_MARK)).toBeLessThan(out.indexOf('</head>'))
    expect(out).toContain("script-src 'unsafe-inline' blob:")
  })

  it('没有 head 就插在 html 根标签之后', () => {
    const out = fitHtml('<html lang="zh"><body>正文</body></html>')
    expect(out.indexOf(STYLE_MARK)).toBeLessThan(out.indexOf('正文'))
  })

  it('碎片 HTML 也能拿到样式', () => {
    const out = fitHtml('<div>片段</div>')
    expect(out.startsWith('<style>')).toBe(true)
    expect(out).toContain('<div>片段</div>')
  })
})
