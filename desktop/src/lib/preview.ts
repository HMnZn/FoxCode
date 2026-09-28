/**
 * 预览面板「能不能渲染、渲染成什么」的判断，集中在这里。
 *
 * 为什么按后缀而不是按内容嗅探：这几类文件的渲染方式由类型决定（HTML 进沙箱、
 * SVG 当图片、JSON 进树），而右侧栏拿到的只是一个路径加一份文本 —— 后缀是最便宜
 * 也最可预测的依据。图片更特殊：它的 base64 由宿主的 `files.read` 给出（`kind`）。
 */
import type { FileContent } from '@/types/protocol'
import type { PreviewMode } from '@/store/filesStore'

export type RenderKind = 'image' | 'svg' | 'html' | 'markdown' | 'json'

/** 宿主能内嵌 base64 的图片后缀（与 `fox_serve/workspace_files.py` 的 `IMAGE_MIMES` 对齐）。 */
const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico', 'avif'])

/** 路径 → 渲染方式；`null` 表示这个文件没有「渲染」这一视角。 */
export function renderKindOf(path: string): RenderKind | null {
  const name = path.split(/[\\/]/).pop() ?? ''
  const dot = name.lastIndexOf('.')
  if (dot <= 0 || dot === name.length - 1) return null
  const extension = name.slice(dot + 1).toLowerCase()
  if (IMAGE_EXTENSIONS.has(extension)) return 'image'
  if (extension === 'svg') return 'svg'
  if (extension === 'html' || extension === 'htm') return 'html'
  if (extension === 'md' || extension === 'markdown' || extension === 'mdx') return 'markdown'
  if (extension === 'json') return 'json'
  return null
}

/**
 * 点一个文件时先看哪个视角。
 *
 * - 图片：只有渲染（差异与原文对一张 PNG 都没有意义），而且渲染要的 base64 只有
 *   `render` 这一模式会去取。
 * - 从目录树点开 HTML/SVG/Markdown/JSON：直接看渲染结果（想读源码就切「原文」）。
 * - 从「改动」清单点开：保留差异（那是这份清单存在的理由），渲染是旁边一个页签。
 */
export function preferredMode(path: string, fallback: Extract<PreviewMode, 'diff' | 'source'>): PreviewMode {
  const kind = renderKindOf(path)
  if (kind === 'image') return 'render'
  if (kind && fallback === 'source') return 'render'
  return fallback
}

/** 宿主给的图片 → `data:` URL。 */
export function imageDataUrl(content: FileContent): string | null {
  if (!content.data) return null
  const mime = content.mime || 'image/png'
  return `data:${mime};base64,${content.data}`
}

/** SVG 是文本，直接内联成 `data:` URL 让浏览器去画（不解析它的脚本）。 */
export function svgDataUrl(text: string): string {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(text)}`
}

/** 图片大小、MIME 之类给人看的说明，用在预览页签的信息条上。 */
export function describeImage(content: FileContent): string {
  const mime = (content.mime || '').replace(/^image\//, '').toUpperCase()
  const size =
    content.size >= 1024 * 1024
      ? `${(content.size / (1024 * 1024)).toFixed(1)} MB`
      : `${Math.max(1, Math.round(content.size / 1024))} KB`
  return mime ? `${mime} · ${size}` : size
}
