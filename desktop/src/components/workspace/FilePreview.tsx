/**
 * 文件预览体：右侧工作台里「一个打开的文件」这个标签的内容。
 *
 * 三种视角（差异 / 原文 / 渲染）都在这里，宿主读盘、渲染方式的选择见
 * `lib/preview.ts`；这个文件只负责把它们画出来。
 */
import { useMemo, useState } from 'react'
import { ArrowLeft, Copy, FolderOpen, RefreshCw } from 'lucide-react'
import { Button, Chip, IconButton, Tabs, Tooltip, toast } from '@/components/ui'
import { getBridge } from '@/bridge'
import { TOKEN_CLASS } from '@/components/content/CodeBlock'
import { JsonViewer } from '@/components/content/JsonViewer'
import { Markdown } from '@/components/content/Markdown'
import { detectLanguage, tokenize } from '@/lib/highlight'
import type { Token } from '@/lib/highlight'
import { basename, shortPath } from '@/lib/format'
import { extensionHint, parseUnifiedDiff } from '@/lib/diff'
import {
  describeImage,
  imageDataUrl,
  renderKindOf,
  svgDataUrl,
} from '@/lib/preview'
import type { RenderKind } from '@/lib/preview'
import type { DiffLine, FileDiff } from '@/lib/diff'
import type { FileContent } from '@/types/protocol'
import { fileTabId, useRail } from '@/store/railStore'
import { useFiles, type PreviewMode } from '@/store/filesStore'
import { cn } from '@/lib/cn'

function copy(text: string, what: string) {
  void navigator.clipboard?.writeText(text).then(
    () => toast.success({ title: `已复制${what}`, duration: 1400 }),
    () => toast.danger({ title: '复制失败' }),
  )
}

/** 差异行：旧/新两个行号槽 + 内容，颜色按增删区分。 */
function DiffRow({ line }: { line: DiffLine }) {
  const tone =
    line.kind === 'added'
      ? 'bg-success/10 text-success'
      : line.kind === 'removed'
        ? 'bg-danger/10 text-danger'
        : line.kind === 'meta'
          ? 'text-fg-subtle'
          : 'text-fg-muted'
  return (
    <div className={cn('flex w-max min-w-full items-start', tone)}>
      <span className="w-10 shrink-0 select-none px-1.5 text-right font-mono text-[10px] leading-[18px] text-fg-subtle/70 tabular-nums">
        {line.oldNumber ?? ''}
      </span>
      <span className="w-10 shrink-0 select-none px-1.5 text-right font-mono text-[10px] leading-[18px] text-fg-subtle/70 tabular-nums">
        {line.newNumber ?? ''}
      </span>
      <span className="flex-1 whitespace-pre px-1.5 leading-[18px]">{line.text || ' '}</span>
    </div>
  )
}

function DiffBody({ parsed, path }: { parsed: FileDiff; path: string }) {
  if (parsed.hunks.length === 0) {
    return <p className="px-3 py-3 text-2xs text-fg-subtle">这份差异里没有可显示的 hunk。</p>
  }
  return (
    <div className="scroll-quiet min-h-0 flex-1 overflow-auto font-mono text-[11.5px]">
      {parsed.header.length ? (
        <div className="border-b border-line px-1.5 py-1 text-[10.5px] text-fg-subtle">
          {parsed.header.map((line, index) => (
            <div key={`${index}-${line}`} className="truncate" title={line}>
              {line}
            </div>
          ))}
        </div>
      ) : null}
      {parsed.hunks.map((hunk, index) => (
        <div key={`${hunk.header}-${index}`}>
          <div className="bg-surface-2 px-1.5 text-[10.5px] leading-[18px] text-fg-subtle">
            {hunk.header}
          </div>
          {hunk.lines.map((line, lineIndex) => (
            <DiffRow key={`${index}-${lineIndex}`} line={line} />
          ))}
        </div>
      ))}
      <div className="px-3 py-2 text-[10.5px] text-fg-subtle">— {path} 的差异结束 —</div>
    </div>
  )
}

/** 原文：复用正文代码块那套高亮（同一份 token 配色）。 */
function SourceBody({ text, path, truncated }: { text: string; path: string; truncated: boolean }) {
  const lines = useMemo(() => {
    const language = detectLanguage(extensionHint(path) || null, text)
    const tokens: Token[] = tokenize(text, language)
    const out: React.ReactNode[][] = [[]]
    let key = 0
    for (const token of tokens) {
      const parts = token.text.split('\n')
      parts.forEach((part, index) => {
        if (index > 0) out.push([])
        if (part) {
          out[out.length - 1].push(
            <span key={key++} className={TOKEN_CLASS[token.kind]}>
              {part}
            </span>,
          )
        }
      })
    }
    return out
  }, [path, text])

  return (
    <div className="scroll-quiet min-h-0 flex-1 overflow-auto font-mono text-[11.5px]">
      {lines.map((tokens, index) => (
        <div key={index} className="flex w-max min-w-full items-start hover:bg-surface-2/60">
          <span className="w-10 shrink-0 select-none px-1.5 text-right text-[10px] leading-[18px] text-fg-subtle/70 tabular-nums">
            {index + 1}
          </span>
          <span className="flex-1 whitespace-pre px-1.5 leading-[18px] text-fg-muted">
            {tokens.length ? tokens : ' '}
          </span>
        </div>
      ))}
      {truncated ? (
        <div className="px-3 py-2 text-[10.5px] text-fg-subtle">…（文件很长，只预览了开头）</div>
      ) : null}
    </div>
  )
}

/**
 * 渲染：把文件当它本来的样子画出来，而不是显示它的字节。
 *
 * - 图片：宿主已经把 base64 放进 `content.data`（`file://` 在开发模式下会被
 *   webSecurity 拦掉，所以走宿主读盘这一条路）。
 * - HTML：进不具备同源权限的 iframe；允许页面自己的脚本，阻断网络、弹窗与宿主访问。
 * - SVG：文本内联成 `data:` URL 交给浏览器画（`<img>` 里的 SVG 本来也不跑脚本）。
 * - Markdown / JSON：复用正文那两套渲染器，配色与聊天里一致。
 */
const PREVIEW_CSP =
  '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; ' +
  "script-src 'unsafe-inline' blob:; style-src 'unsafe-inline'; " +
  'img-src data: blob:; media-src data: blob:; font-src data:; worker-src blob:">'

const FIT_STYLE =
  '<style>html,body{max-width:100%;overflow-x:hidden}' +
  'img,svg,video,canvas{max-width:100% !important;height:auto !important}' +
  'pre,table{max-width:100%;overflow-x:auto}</style>'

/**
 * iframe 里的页面不归我们的 CSS 管：一个按 1200px 画出来的 HTML/内联 SVG 会在
 * 面板里横向溢出、右边永远看不到（用户报的「大图显示不全」有一半是这种页面）。
 * 这里往 `srcDoc` 里插一段收敛样式：媒体元素缩到容器宽度，代码块和表格自己滚。
 *
 * 插在 `</head>` 之前 —— 排在页面自己的样式后面，同权重时我们说了算。
 */
export function fitHtml(html: string): string {
  const head = /<head[^>]*>/i.exec(html)
  const close = /<\/head\s*>/i.exec(html)
  if (head && close && head.index < close.index) {
    const afterHead = head.index + head[0].length
    // CSP must precede page scripts; the fit style stays last so it wins ties.
    return `${html.slice(0, afterHead)}${PREVIEW_CSP}${html.slice(afterHead, close.index)}${FIT_STYLE}${html.slice(close.index)}`
  }
  const root = /<html[^>]*>/i.exec(html)
  if (root) {
    const at = root.index + root[0].length
    return `${html.slice(0, at)}<head>${PREVIEW_CSP}${FIT_STYLE}</head>${html.slice(at)}`
  }
  return FIT_STYLE + PREVIEW_CSP + html
}

function RenderBody({
  content,
  kind,
  path,
}: {
  content: FileContent
  kind: RenderKind
  path: string
}) {
  const parsedJson = useMemo(() => {
    if (kind !== 'json' || content.binary) return null
    try {
      return { value: JSON.parse(content.text) as unknown, error: null as string | null }
    } catch (error) {
      return { value: null, error: error instanceof Error ? error.message : String(error) }
    }
  }, [content.binary, content.text, kind])

  /**
   * 图默认缩到容器里（`max-h-full` + `object-contain`）—— 大图以前只会横向被夹住，
   * 竖着溢出就得滚，边缘还常常看不到。双击回到原始像素，再双击又收回来。
   */
  const [actual, setActual] = useState(false)
  const fitClass = actual
    ? 'm-auto max-w-none rounded-md'
    : 'm-auto max-h-full max-w-full object-contain rounded-md'
  const zoomProps = {
    title: actual ? '双击回到「适应窗口」' : '双击查看原始大小',
    onDoubleClick: () => setActual((value) => !value),
  }

  if (kind === 'image') {
    const source = imageDataUrl(content)
    if (!source) {
      return (
        <p className="px-3 py-3 text-2xs text-fg-subtle">
          {content.error ?? '这张图片没有可内嵌的内容。'}
        </p>
      )
    }
    return (
      <div className="scroll-quiet flex min-h-0 flex-1 overflow-auto bg-surface-2/40 p-3">
        {/* `m-auto` 而不是 `items-center`：小图居中，大图仍然可以从顶部滚（居中 + overflow 会裁掉上边）。 */}
        <img
          src={source}
          alt={path}
          className={cn(fitClass, 'shadow-sm')}
          draggable={false}
          {...zoomProps}
        />
      </div>
    )
  }

  if (content.binary) {
    return <p className="px-3 py-3 text-2xs text-fg-subtle">二进制文件，不能当文本预览。</p>
  }

  if (kind === 'svg') {
    return (
      <div className="scroll-quiet flex min-h-0 flex-1 overflow-auto bg-surface-2/40 p-3">
        <img src={svgDataUrl(content.text)} alt={path} className={fitClass} {...zoomProps} />
      </div>
    )
  }

  if (kind === 'html') {
    // 白色底：待预览的 HTML 基本都假设自己是浅色页面，套深色主题反而看不出原样。
    return (
      <iframe
        title={`预览 ${path}`}
        sandbox="allow-scripts"
        referrerPolicy="no-referrer"
        srcDoc={fitHtml(content.text)}
        className="min-h-0 w-full flex-1 border-0 bg-white"
      />
    )
  }

  if (kind === 'markdown') {
    return (
      <div className="scroll-quiet min-h-0 flex-1 overflow-auto px-3 py-3">
        <Markdown content={content.text} />
      </div>
    )
  }

  if (parsedJson?.error) {
    return <p className="px-3 py-3 text-2xs text-fg-subtle">JSON 解析失败：{parsedJson.error}</p>
  }

  return (
    <div className="scroll-quiet min-h-0 flex-1 overflow-auto px-3 py-3">
      <JsonViewer value={parsedJson?.value} name={basename(path)} />
    </div>
  )
}

export function FileTab({ path }: { path: string }) {
  const preview = useFiles((s) => s.previews[path])
  const setMode = useFiles((s) => s.setMode)
  const openFiles = useRail((s) => s.openFiles)
  const parsed = useMemo(
    () => (preview?.diff?.diff ? parseUnifiedDiff(preview.diff.diff)[0] ?? null : null),
    [preview?.diff?.diff],
  )

  if (!preview) {
    return <p className="px-3 py-3 text-2xs text-fg-subtle">这个文件的预览已经关掉了。</p>
  }

  const absolute = preview.diff?.absolute ?? preview.content?.absolute ?? preview.path
  const renderKind = renderKindOf(preview.path)
  // 图片没有「差异/原文」可言：即使调用方按默认的 diff 打开，也直接落到渲染。
  const image = renderKind === 'image'
  const mode: PreviewMode = image ? 'render' : preview.mode
  const modeItems = [
    ...(image
      ? []
      : [
          { value: 'diff', label: '差异' },
          { value: 'source', label: '原文' },
        ]),
    ...(renderKind ? [{ value: 'render', label: '渲染' }] : []),
  ]
  const additions = mode === 'diff' ? preview.diff?.additions : null
  const deletions = mode === 'diff' ? preview.diff?.deletions : null

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-1 border-b border-line px-2 py-1.5">
        <Tooltip content="回到文件列表" side="bottom">
          <IconButton label="返回文件列表" variant="ghost" size="xs" onClick={openFiles}>
            <ArrowLeft size={13} />
          </IconButton>
        </Tooltip>
        <span className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-fg" title={preview.path}>
          {shortPath(preview.path, 2)}
        </span>
        <Tabs
          value={mode}
          onChange={(value) => void setMode(preview.path, value as PreviewMode)}
          items={modeItems}
          size="sm"
          variant="pill"
        />
      </div>

      <div className="flex shrink-0 flex-wrap items-center gap-1.5 border-b border-line px-3 py-1.5">
        {mode === 'diff' && additions != null ? (
          <span className="font-mono text-[10.5px] tabular-nums">
            <span className="text-success">+{additions}</span>{' '}
            <span className="text-danger">−{deletions ?? 0}</span>
          </span>
        ) : null}
        {preview.diff?.untracked ? <Chip size="xs" tone="neutral">未跟踪</Chip> : null}
        {image && preview.content ? (
          <Chip size="xs" tone="neutral">{describeImage(preview.content)}</Chip>
        ) : null}
        {preview.diff?.binary || preview.content?.binary ? (
          <Chip size="xs" tone="warn">二进制</Chip>
        ) : null}
        {preview.diff?.truncated || preview.content?.truncated ? (
          <Chip size="xs" tone="neutral">已截断</Chip>
        ) : null}
        <div className="ml-auto flex items-center">
          <Tooltip content="复制路径" side="bottom">
            <IconButton
              label="复制文件路径"
              variant="ghost"
              size="xs"
              onClick={() => copy(absolute, '路径')}
            >
              <Copy size={12} />
            </IconButton>
          </Tooltip>
          <Tooltip content="在文件管理器中显示" side="bottom">
            <IconButton
              label="在文件管理器中显示"
              variant="ghost"
              size="xs"
              onClick={() => {
                void getBridge()
                  .reveal(absolute)
                  .then((ok) => {
                    if (!ok) toast.danger({ title: '这个宿主没有文件管理器' })
                  })
              }}
            >
              <FolderOpen size={12} />
            </IconButton>
          </Tooltip>
          <Tooltip content="重新读取" side="bottom">
            <IconButton
              label="重新读取预览"
              variant="ghost"
              size="xs"
              loading={preview.loading}
              onClick={() => void setMode(preview.path, preview.mode)}
            >
              <RefreshCw size={12} />
            </IconButton>
          </Tooltip>
          <Tooltip content="关闭这一个标签" side="bottom">
            <IconButton
              label={`关闭 ${basename(preview.path)}`}
              variant="ghost"
              size="xs"
              onClick={() => useRail.getState().close(fileTabId(preview.path))}
            >
              <span className="text-[13px] leading-none">×</span>
            </IconButton>
          </Tooltip>
        </div>
      </div>

      {preview.loading && !preview.diff && !preview.content ? (
        <p className="px-3 py-3 text-2xs text-fg-subtle">读取中…</p>
      ) : null}

      {preview.error ? (
        <div className="flex flex-col items-start gap-2 px-3 py-3">
          <p className="text-2xs text-fg-muted">{preview.error}</p>
          {mode !== 'source' ? (
            <Button variant="outline" size="xs" onClick={() => void setMode(preview.path, 'source')}>
              看原文
            </Button>
          ) : null}
        </div>
      ) : null}

      {!preview.error && mode === 'diff' && parsed ? (
        <DiffBody parsed={parsed} path={preview.path} />
      ) : null}
      {!preview.error && mode === 'source' && preview.content && !preview.content.binary ? (
        <SourceBody
          text={preview.content.text}
          path={preview.path}
          truncated={Boolean(preview.content.truncated)}
        />
      ) : null}
      {!preview.error && mode === 'source' && preview.content?.binary ? (
        <p className="px-3 py-3 text-2xs text-fg-subtle">二进制文件，不能当文本预览。</p>
      ) : null}
      {!preview.error && mode === 'render' && renderKind && preview.content ? (
        <RenderBody content={preview.content} kind={renderKind} path={preview.path} />
      ) : null}
      {!preview.error && mode === 'render' && !renderKind ? (
        <p className="px-3 py-3 text-2xs text-fg-subtle">这个文件没有可以渲染的样子，切到「原文」看内容。</p>
      ) : null}
    </div>
  )
}
