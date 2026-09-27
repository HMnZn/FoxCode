import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  ArrowLeft,
  Copy,
  FileCode2,
  FolderGit2,
  FolderOpen,
  GitFork,
  RefreshCw,
  Save,
  Sparkles,
  X,
} from 'lucide-react'
import {
  Button,
  Chip,
  EmptyState,
  IconButton,
  Switch,
  Tabs,
  TokenBar,
  Tooltip,
  toast,
} from '@/components/ui'
import { useSession } from '@/store/sessionStore'
import { useFiles, type PreviewMode } from '@/store/filesStore'
import { useUi, type InspectorTab } from '@/store/uiStore'
import { getBridge } from '@/bridge'
import { TOKEN_CLASS } from '@/components/content/CodeBlock'
import { detectLanguage, tokenize } from '@/lib/highlight'
import type { Token } from '@/lib/highlight'
import { basename, formatCost, formatDuration, formatTokens, shortPath } from '@/lib/format'
import { extensionHint, parseUnifiedDiff } from '@/lib/diff'
import type { DiffLine, ParsedDiff } from '@/lib/diff'
import { PERMISSION_LABEL } from '@/types/protocol'
import type { FileChange, FileChangeStatus } from '@/types/protocol'
import type { AssistantBlock } from '@/store/timeline'
import { cn } from '@/lib/cn'

const TAB_ITEMS = [
  { value: 'context', label: '上下文' },
  { value: 'files', label: '文件' },
  { value: 'usage', label: '用量' },
]

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-1.5 border-b border-line px-3 py-3 last:border-b-0">
      <h3 className="text-2xs font-medium tracking-wide text-fg-subtle uppercase">{title}</h3>
      {children}
    </section>
  )
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-2 text-[12px]">
      <span className="shrink-0 text-fg-subtle">{label}</span>
      <span className="min-w-0 text-right text-fg-muted">{children}</span>
    </div>
  )
}

function copy(text: string, what: string) {
  void navigator.clipboard?.writeText(text).then(
    () => toast.success({ title: `已复制${what}`, duration: 1400 }),
    () => toast.danger({ title: '复制失败' }),
  )
}

/* ------------------------------------------------------------------ */
/* 上下文                                                              */
/* ------------------------------------------------------------------ */

function ContextTab() {
  const host = useSession((s) => s.host)
  const timeline = useSession((s) => s.timeline)
  const compact = useSession((s) => s.compact)
  const forkSession = useSession((s) => s.forkSession)
  const newSession = useSession((s) => s.newSession)
  const exportSession = useSession((s) => s.exportSession)
  const setTrust = useSession((s) => s.setTrust)
  const busy = timeline.status !== 'idle' && timeline.status !== 'error'

  const window1024 = timeline.context.limit || host?.model?.contextWindow || 0
  // 上下文占用以「最近一次请求的 totalTokens」为准（compaction / 宿主估算会覆盖它），
  // 累计值只作降级：否则压缩后进度条不会回落。
  const context = timeline.context
  const settled =
    context.source === 'none' ? timeline.totals.input + timeline.totals.cacheRead : context.used
  // 正在流、还没拿到 usage 的那部分单独算：否则一整轮长回答期间这个数字一动不动，
  // 看起来就像卡住了。拿到权威 usage 后 `context.live` 会归零。
  const live = context.live ?? 0
  const used = settled + live
  const segments = useMemo(
    () =>
      context.source === 'none'
        ? [
            { label: '输入', value: timeline.totals.input, className: 'bg-info' },
            { label: '缓存读', value: timeline.totals.cacheRead, className: 'bg-accent' },
            { label: '输出', value: timeline.totals.output, className: 'bg-success' },
          ]
        : [
            { label: '输入', value: context.input, className: 'bg-info' },
            { label: '缓存读', value: context.cacheRead, className: 'bg-accent' },
            { label: '输出', value: context.output, className: 'bg-success' },
          ],
    [context, timeline.totals],
  )

  return (
    <>
      <Section title="运行时会话">
        <Row label="工作目录">
          <Tooltip content={host?.cwd ?? ''} side="left">
            <span className="font-mono text-2xs">{host ? shortPath(host.cwd, 3) : '—'}</span>
          </Tooltip>
        </Row>
        <Row label="会话文件">
          <button
            type="button"
            onClick={() => host?.sessionFile && copy(host.sessionFile, '会话路径')}
            className="max-w-[190px] truncate font-mono text-2xs hover:text-fg"
          >
            {host?.sessionFile ? basename(host.sessionFile) : '—'}
          </button>
        </Row>
        <Row label="模型">
          <span className="font-mono text-2xs">
            {host?.model?.displayName ?? '—'}
            {host?.model?.provider ? ` · ${host.model.provider}` : ''}
          </span>
        </Row>
        <Row label="权限模式">
          <Chip size="xs" tone={host?.permissionMode === 'full-access' ? 'warn' : 'neutral'}>
            {host ? PERMISSION_LABEL[host.permissionMode] : '—'}
          </Chip>
        </Row>
        <Row label="思考等级">
          <span className="font-mono text-2xs">{host?.thinkingLevel ?? '—'}</span>
        </Row>
      </Section>

      <Section title="上下文占用">
        {window1024 ? (
          <TokenBar segments={segments} total={window1024} legend height={6} />
        ) : (
          <TokenBar segments={segments} legend height={6} />
        )}
        <p className="text-2xs text-fg-subtle">
          已用 {formatTokens(used)}
          {window1024 ? ` / ${formatTokens(window1024)}（${Math.round((used / window1024) * 100)}%）` : ''}
          {live > 0 ? ` · 其中 ${formatTokens(live)} 正在流式估算` : ''}
          {context.source === 'host'
            ? ' · 宿主估算'
            : context.source === 'compaction'
              ? ' · 压缩后'
              : context.source === 'usage'
                ? ' · 最近一次请求'
                : ' · 累计'}
        </p>
        <Button
          variant="outline"
          size="xs"
          iconLeft={<Sparkles size={12} />}
          disabled={busy}
          onClick={() => void compact()}
        >
          压缩上下文
        </Button>
      </Section>

      <Section title="项目信任">
        <Switch
          checked={host?.projectTrusted ?? false}
          label="信任本项目"
          hint="未受信任时宿主的工具调用会被静态拦截"
          onChange={(checked) => void setTrust(checked)}
        />
      </Section>

      <Section title="会话操作">
        <div className="flex flex-wrap gap-1.5">
          <Button variant="ghost" size="xs" iconLeft={<FolderGit2 size={12} />} onClick={() => void newSession()}>
            新会话
          </Button>
          <Button variant="ghost" size="xs" iconLeft={<GitFork size={12} />} onClick={() => void forkSession()}>
            分叉
          </Button>
          <Button
            variant="ghost"
            size="xs"
            iconLeft={<Save size={12} />}
            onClick={() => void exportSession('markdown')}
          >
            导出 MD
          </Button>
          <Button
            variant="ghost"
            size="xs"
            iconLeft={<Save size={12} />}
            onClick={() => void exportSession('json')}
          >
            导出 JSON
          </Button>
        </div>
      </Section>
    </>
  )
}

/* ------------------------------------------------------------------ */
/* 文件：改动清单 + 预览                                                */
/* ------------------------------------------------------------------ */

/** 改动类型 → 首字母标记与配色（git 那套字母，用户认得）。 */
const STATUS_META: Record<FileChangeStatus, { letter: string; label: string; className: string }> =
  {
    added: { letter: 'A', label: '新增', className: 'text-success' },
    modified: { letter: 'M', label: '修改', className: 'text-accent' },
    deleted: { letter: 'D', label: '删除', className: 'text-danger' },
    renamed: { letter: 'R', label: '重命名', className: 'text-info' },
    typechange: { letter: 'T', label: '类型变化', className: 'text-warn' },
    conflicted: { letter: 'U', label: '冲突', className: 'text-danger' },
    untracked: { letter: '?', label: '未跟踪', className: 'text-fg-subtle' },
  }

interface TouchedFile {
  path: string
  count: number
  tools: string[]
  errors: number
  lastTs: number
}

function Stat({ additions, deletions }: { additions: number; deletions: number }) {
  if (!additions && !deletions) return null
  return (
    <span className="ml-auto flex shrink-0 items-center gap-1 font-mono text-[10.5px] tabular-nums">
      {additions ? <span className="text-success">+{additions}</span> : null}
      {deletions ? <span className="text-danger">−{deletions}</span> : null}
    </span>
  )
}

function splitDisplay(display: string): { dir: string; base: string } {
  const normalized = display.replace(/\\/g, '/')
  const cut = normalized.lastIndexOf('/')
  if (cut <= 0) return { dir: '', base: normalized }
  return { dir: normalized.slice(0, cut + 1), base: normalized.slice(cut + 1) }
}

function ChangeRow({ change, onOpen }: { change: FileChange; onOpen: () => void }) {
  const meta = STATUS_META[change.status] ?? STATUS_META.modified
  const { dir, base } = splitDisplay(change.display)
  return (
    <button
      type="button"
      onClick={onOpen}
      title={`${meta.label} · ${change.path}`}
      className="flex min-h-[34px] w-full items-center gap-2 rounded-md px-2 text-left text-fg-muted transition-colors hover:bg-interactive hover:text-fg"
    >
      <span className={cn('w-3 shrink-0 text-center font-mono text-[11px] font-medium', meta.className)}>
        {meta.letter}
      </span>
      {/* 目录从中间截断、文件名永远完整：右侧栏只有 260px，用户先要看到「是哪个文件」。 */}
      <span className="flex min-w-0 flex-1 items-baseline font-mono text-[11.5px]">
        {dir ? <span className="min-w-0 truncate text-fg-subtle">{dir}</span> : null}
        <span className="shrink-0">{base}</span>
      </span>
      {change.binary ? (
        <span className="shrink-0 text-[10.5px] text-fg-subtle">二进制</span>
      ) : (
        <Stat additions={change.additions} deletions={change.deletions} />
      )}
    </button>
  )
}

function TouchedRow({ file, onOpen }: { file: TouchedFile; onOpen: () => void }) {
  return (
    <button
      type="button"
      onClick={onOpen}
      title={file.path}
      className="flex min-h-[34px] w-full flex-col items-start justify-center gap-0.5 rounded-md px-2 text-left transition-colors hover:bg-interactive"
    >
      <span className="w-full truncate font-mono text-[11.5px] text-fg-muted">
        {shortPath(file.path, 2)}
      </span>
      <span className="flex items-center gap-1.5 text-[10.5px] text-fg-subtle">
        <span className="font-mono">{file.tools.join(' · ')}</span>
        <span className="opacity-40">·</span>
        <span>{file.count} 次</span>
        {file.errors ? (
          <>
            <span className="opacity-40">·</span>
            <span className="text-danger">{file.errors} 次失败</span>
          </>
        ) : null}
      </span>
    </button>
  )
}

/** 差异行：旧/新两个行号槽 + 内容，颜色按增删区分。 */
function DiffRow({ line }: { line: DiffLine }) {
  const tone =
    line.kind === 'add'
      ? 'bg-success/10 text-success'
      : line.kind === 'del'
        ? 'bg-danger/10 text-danger'
        : line.kind === 'hunk'
          ? 'bg-surface-2 text-fg-subtle'
          : line.kind === 'meta'
            ? 'text-fg-subtle'
            : 'text-fg-muted'
  return (
    <div className={cn('flex w-max min-w-full items-start', tone)}>
      <span className="w-10 shrink-0 select-none px-1.5 text-right font-mono text-[10px] leading-[18px] text-fg-subtle/70 tabular-nums">
        {line.oldNo ?? ''}
      </span>
      <span className="w-10 shrink-0 select-none px-1.5 text-right font-mono text-[10px] leading-[18px] text-fg-subtle/70 tabular-nums">
        {line.newNo ?? ''}
      </span>
      <span className="flex-1 whitespace-pre px-1.5 leading-[18px]">{line.text || ' '}</span>
    </div>
  )
}

function DiffBody({ parsed, path }: { parsed: ParsedDiff; path: string }) {
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

function PreviewPane() {
  const preview = useFiles((s) => s.preview)
  const setMode = useFiles((s) => s.setMode)
  const close = useFiles((s) => s.close)
  const parsed = useMemo(
    () => (preview?.diff?.diff ? parseUnifiedDiff(preview.diff.diff) : null),
    [preview?.diff?.diff],
  )

  if (!preview) return null
  const absolute = preview.diff?.absolute ?? preview.content?.absolute ?? preview.path
  const modeItems = [
    { value: 'diff', label: '差异' },
    { value: 'source', label: '原文' },
  ]
  const additions = preview.mode === 'diff' ? preview.diff?.additions : null
  const deletions = preview.mode === 'diff' ? preview.diff?.deletions : null

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-1 border-b border-line px-2 py-1.5">
        <Tooltip content="返回文件列表" side="bottom">
          <IconButton label="返回文件列表" variant="ghost" size="xs" onClick={close}>
            <ArrowLeft size={13} />
          </IconButton>
        </Tooltip>
        <span className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-fg" title={preview.path}>
          {shortPath(preview.path, 2)}
        </span>
        <Tabs
          value={preview.mode}
          onChange={(value) => void setMode(value as PreviewMode)}
          items={modeItems}
          size="sm"
          variant="pill"
        />
      </div>

      <div className="flex shrink-0 flex-wrap items-center gap-1.5 border-b border-line px-3 py-1.5">
        {preview.mode === 'diff' && additions != null ? (
          <span className="font-mono text-[10.5px] tabular-nums">
            <span className="text-success">+{additions}</span>{' '}
            <span className="text-danger">−{deletions ?? 0}</span>
          </span>
        ) : null}
        {preview.diff?.untracked ? <Chip size="xs" tone="neutral">未跟踪</Chip> : null}
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
              onClick={() => void setMode(preview.mode)}
            >
              <RefreshCw size={12} />
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
          {preview.mode === 'diff' ? (
            <Button variant="outline" size="xs" onClick={() => void setMode('source')}>
              看原文
            </Button>
          ) : null}
        </div>
      ) : null}

      {!preview.error && preview.mode === 'diff' && parsed ? (
        <DiffBody parsed={parsed} path={preview.path} />
      ) : null}
      {!preview.error && preview.mode === 'source' && preview.content && !preview.content.binary ? (
        <SourceBody
          text={preview.content.text}
          path={preview.path}
          truncated={Boolean(preview.content.truncated)}
        />
      ) : null}
      {!preview.error && preview.mode === 'source' && preview.content?.binary ? (
        <p className="px-3 py-3 text-2xs text-fg-subtle">二进制文件，不能当文本预览。</p>
      ) : null}
    </div>
  )
}

function FilesTab() {
  const timeline = useSession((s) => s.timeline)
  const host = useSession((s) => s.host)
  const toolCalls = timeline.totals.toolCalls
  const changes = useFiles((s) => s.changes)
  const loading = useFiles((s) => s.loading)
  const error = useFiles((s) => s.error)
  const preview = useFiles((s) => s.preview)
  const refresh = useFiles((s) => s.refresh)
  const open = useFiles((s) => s.open)

  // 打开页签、切换工作区、每次工具调用结束后都重新拉一次清单：
  // Agent 刚写完文件，右侧栏应当马上能看到那一行。
  useEffect(() => {
    void refresh()
  }, [refresh, host?.cwd, toolCalls])

  const touched = useMemo(() => {
    const map = new Map<string, TouchedFile>()
    for (const block of timeline.blocks) {
      if (block.kind !== 'tools') continue
      for (const call of block.calls) {
        const args = call.args ?? {}
        const raw =
          (typeof args.path === 'string' && args.path) ||
          (typeof args.file_path === 'string' && args.file_path) ||
          (typeof args.file === 'string' && args.file) ||
          ''
        if (!raw) continue
        const entry = map.get(raw) ?? {
          path: raw,
          count: 0,
          tools: [],
          errors: 0,
          lastTs: call.startedAt,
        }
        entry.count += 1
        if (!entry.tools.includes(call.name)) entry.tools.push(call.name)
        if (call.isError) entry.errors += 1
        entry.lastTs = Math.max(entry.lastTs, call.endedAt ?? call.startedAt)
        map.set(raw, entry)
      }
    }
    return [...map.values()].sort((a, b) => b.lastTs - a.lastTs)
  }, [timeline.blocks])

  if (preview) return <PreviewPane />

  const files = changes?.files ?? []

  return (
    <div className="flex flex-col">
      <div className="flex items-center gap-2 border-b border-line px-3 py-2">
        <h3 className="text-2xs font-medium tracking-wide text-fg-subtle uppercase">工作区改动</h3>
        {changes?.repo ? (
          <span className="font-mono text-[10.5px] text-fg-subtle">
            {files.length}
            {changes.truncated ? ` / ${changes.total}` : ''}
          </span>
        ) : null}
        {changes?.branch ? (
          <span className="truncate font-mono text-[10.5px] text-fg-subtle">{changes.branch}</span>
        ) : null}
        <Tooltip content="重新读取改动" side="bottom">
          <IconButton
            label="重新读取工作区改动"
            variant="ghost"
            size="xs"
            loading={loading}
            className="ml-auto"
            onClick={() => void refresh()}
          >
            <RefreshCw size={12} />
          </IconButton>
        </Tooltip>
      </div>

      {error ? (
        <p className="border-b border-line px-3 py-2 text-2xs text-fg-subtle">{error}</p>
      ) : null}

      {files.length === 0 && !error ? (
        <p className="px-3 py-3 text-2xs text-fg-subtle">
          {loading ? '读取中…' : '工作区没有未提交的改动。'}
        </p>
      ) : null}

      {files.length ? (
        <div className="flex flex-col gap-0.5 px-1.5 py-1.5">
          {files.map((change) => (
            <ChangeRow
              key={`${change.status}-${change.path}`}
              change={change}
              onOpen={() => void open(change.path)}
            />
          ))}
          {changes?.truncated ? (
            <p className="px-2 py-1 text-[10.5px] text-fg-subtle">
              只列出前 {files.length} 个（共 {changes.total} 个）。
            </p>
          ) : null}
        </div>
      ) : null}

      {touched.length ? (
        <>
          <div className="flex items-center gap-2 border-y border-line px-3 py-2">
            <h3 className="text-2xs font-medium tracking-wide text-fg-subtle uppercase">
              本轮涉及 {touched.length} 个文件
            </h3>
          </div>
          <div className="flex flex-col gap-0.5 px-1.5 py-1.5">
            {touched.map((file) => (
              <TouchedRow
                key={file.path}
                file={file}
                onOpen={() => void open(file.path, 'source')}
              />
            ))}
          </div>
        </>
      ) : null}

      {files.length === 0 && touched.length === 0 && !loading && !error ? (
        <EmptyState
          icon={<FileCode2 size={18} />}
          title="还没有文件活动"
          description="Agent 读写文件后，这里会列出工作区改动与本轮触碰过的路径，点一行就能看差异或原文。"
        />
      ) : null}
    </div>
  )
}

function UsageTab() {
  const timeline = useSession((s) => s.timeline)
  const host = useSession((s) => s.host)
  const turns = useMemo(
    () => timeline.blocks.filter((b): b is AssistantBlock => b.kind === 'assistant' && Boolean(b.usage)),
    [timeline.blocks],
  )
  const t = timeline.totals

  return (
    <>
      <Section title="累计用量">
        <TokenBar
          segments={[
            { label: '输入', value: t.input, className: 'bg-info' },
            { label: '缓存读', value: t.cacheRead, className: 'bg-accent' },
            { label: '输出', value: t.output, className: 'bg-success' },
            { label: '推理', value: t.reasoning, className: 'bg-think' },
          ]}
          legend
          height={6}
        />
        <dl className="grid grid-cols-2 gap-x-3 gap-y-1 pt-1 text-2xs">
          {[
            ['输入', formatTokens(t.input)],
            ['输出', formatTokens(t.output)],
            ['缓存读', formatTokens(t.cacheRead)],
            ['缓存写', formatTokens(t.cacheWrite)],
            ['推理', formatTokens(t.reasoning)],
            ['总计', formatTokens(t.totalTokens)],
            ['回合', String(t.turns)],
            ['工具调用', String(t.toolCalls)],
            ['花费', formatCost(t.cost)],
            ['模型', host?.model?.displayName ?? '—'],
          ].map(([label, value]) => (
            <div key={label} className="flex items-center justify-between gap-2">
              <dt className="text-fg-subtle">{label}</dt>
              <dd className="truncate font-mono tabular-nums text-fg-muted">{value}</dd>
            </div>
          ))}
        </dl>
      </Section>

      <Section title={`按回合（${turns.length}）`}>
        {turns.length === 0 ? (
          <p className="text-2xs text-fg-subtle">还没有完成的回合。</p>
        ) : (
          <div className="flex flex-col gap-1">
            {turns.map((block, index) => (
              <div key={block.id} className="flex items-center gap-2 text-2xs">
                <span className="w-6 shrink-0 font-mono text-fg-subtle">#{index + 1}</span>
                <span className="truncate font-mono text-fg-muted">
                  {block.model ?? host?.model?.displayName ?? '—'}
                </span>
                <span className="ml-auto shrink-0 font-mono tabular-nums text-fg-subtle">
                  ↑{formatTokens(block.usage?.input)} ↓{formatTokens(block.usage?.output)}
                </span>
                {block.usage?.cost ? (
                  <span className="shrink-0 font-mono tabular-nums text-fg-subtle">
                    {formatCost(block.usage.cost.total)}
                  </span>
                ) : null}
                {block.thinkingMs ? (
                  <span className="shrink-0 font-mono tabular-nums text-think">
                    {formatDuration(block.thinkingMs)}
                  </span>
                ) : null}
              </div>
            ))}
          </div>
        )}
      </Section>
    </>
  )
}

/* ------------------------------------------------------------------ */
/* Panel                                                               */
/* ------------------------------------------------------------------ */

export function Inspector({ className }: { className?: string }) {
  const tab = useUi((s) => s.inspectorTab)
  const setTab = useUi((s) => s.setInspectorTab)
  const toggleInspector = useUi((s) => s.toggleInspector)
  const refreshHost = useSession((s) => s.refreshHost)
  const [refreshing, setRefreshing] = useState(false)
  const timeline = useSession((s) => s.timeline)
  const previewing = useFiles((s) => Boolean(s.preview))

  const onRefresh = useCallback(() => {
    setRefreshing(true)
    void refreshHost().finally(() => setRefreshing(false))
  }, [refreshHost])

  return (
    <aside
      className={cn(
        'flex shrink-0 flex-col border-l border-line bg-surface transition-[width] duration-200',
        previewing ? 'w-[420px]' : 'w-[300px]',
        className,
      )}
      aria-label="检查器"
    >
      <header className="flex h-9 shrink-0 items-center gap-1 border-b border-line px-2">
        <Tabs
          value={tab}
          onChange={(value) => setTab(value as InspectorTab)}
          items={TAB_ITEMS}
          size="sm"
          variant="pill"
        />
        <div className="ml-auto flex items-center">
          <Tooltip content="重新加载宿主信息" side="bottom">
            <IconButton label="重新加载宿主信息" variant="ghost" size="xs" loading={refreshing} onClick={onRefresh}>
              <RefreshCw size={13} />
            </IconButton>
          </Tooltip>
          <Tooltip content="收起面板 (Ctrl+J)" side="bottom">
            <IconButton label="收起检查器" variant="ghost" size="xs" onClick={() => toggleInspector(false)}>
              <X size={13} />
            </IconButton>
          </Tooltip>
        </div>
      </header>

      <div className="scroll-quiet flex min-h-0 flex-1 flex-col overflow-y-auto">
        {tab === 'context' ? <ContextTab /> : null}
        {tab === 'files' ? <FilesTab /> : null}
        {tab === 'usage' ? <UsageTab /> : null}
      </div>

      <footer className="flex items-center gap-1.5 border-t border-line px-3 py-1.5 text-2xs text-fg-subtle">
        <span className="font-mono">{timeline.blocks.length} 个块</span>
        <span className="opacity-40">·</span>
        <span className="font-mono">{timeline.totals.turns} 回合</span>
      </footer>
    </aside>
  )
}
