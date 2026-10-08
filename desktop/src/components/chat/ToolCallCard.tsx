import { useEffect, useMemo, useState } from 'react'
import {
  Ban,
  Check,
  CheckCircle2,
  ChevronRight,
  CircleStop,
  Copy,
  Loader2,
  ShieldAlert,
  ShieldCheck,
  Terminal,
  XCircle,
} from 'lucide-react'
import { Chip, IconButton, StatusDot, Tooltip } from '@/components/ui'
import { DiffView } from '@/components/content'
import ToolOutput from '@/components/content/ToolOutput'
import { KeyValueList } from '@/components/content/JsonViewer'
import { parseEditDiff, parseUnifiedDiff } from '@/lib/diff'
import type { ToolCallState } from '@/store/timeline'
import { TOOL_STATUS_LABEL, type ToolStatus } from '@/types/protocol'
import { formatDuration, formatTokens } from '@/lib/format'
import { toast } from '@/store/toastStore'
import { cn } from '@/lib/cn'

/* ------------------------------------------------------------------ */
/* Tool metadata                                                       */
/* ------------------------------------------------------------------ */

const NOUN: Array<[RegExp, string]> = [
  [/^read|read_file|readfile/i, '读取'],
  [/^write|write_file/i, '写入'],
  [/^edit|multiedit|str_replace|apply_patch|patch/i, '编辑'],
  [/^bash|shell|exec|run_command/i, '执行命令'],
  [/^powershell|pwsh/i, '执行脚本'],
  [/^grep|search|ripgrep|rg$/i, '搜索内容'],
  [/^glob|list_dir|ls$/i, '列出文件'],
  [/^web_fetch|fetch|http/i, '抓取网页'],
  [/^web_search/i, '联网搜索'],
  [/^todo/i, '更新任务'],
  [/^task|agent/i, '子任务'],
]

function toolNoun(name: string): string {
  for (const [re, label] of NOUN) if (re.test(name)) return label
  return name
}

/** The single line of context DSH shows next to the tool name. */
function summarize(call: ToolCallState): string {
  const args = call.args ?? {}
  const pick = (...keys: string[]): string | undefined => {
    for (const key of keys) {
      const value = args[key]
      if (typeof value === 'string' && value.trim()) return value.trim()
      if (Array.isArray(value) && value.length) return value.map(String).join(' ')
    }
    return undefined
  }
  const command = pick('command', 'cmd', 'script')
  const pattern = pick('pattern', 'query', 'regex')
  const path = pick('path', 'file_path', 'filepath', 'file', 'target', 'url')
  if (command) return command
  if (pattern) return path ? `${pattern} · ${path}` : pattern
  if (path) return path
  const first = Object.entries(args).find(([, v]) => typeof v === 'string' && v.trim())
  if (first) return String(first[1])
  const keys = Object.keys(args)
  return keys.length ? `{${keys.join(', ')}}` : ''
}

const ICON: Record<ToolStatus, { node: React.ReactNode; tone: string }> = {
  'awaiting-approval': { node: <ShieldAlert size={13} />, tone: 'text-warn' },
  approved: { node: <ShieldCheck size={13} />, tone: 'text-info' },
  running: { node: <Loader2 size={13} className="animate-spin" />, tone: 'text-accent' },
  success: { node: <CheckCircle2 size={13} />, tone: 'text-success' },
  error: { node: <XCircle size={13} />, tone: 'text-danger' },
  blocked: { node: <Ban size={13} />, tone: 'text-danger' },
  aborted: { node: <CircleStop size={13} />, tone: 'text-fg-subtle' },
}

const DECISION_LABEL: Record<string, string> = {
  'allow-once': '本次允许',
  'allow-session': '本会话允许',
  deny: '已拒绝',
}

/* ------------------------------------------------------------------ */
/* Card                                                                */
/* ------------------------------------------------------------------ */

export interface ToolCallCardProps {
  call: ToolCallState
  defaultExpanded?: boolean
}

export function ToolCallCard({ call, defaultExpanded }: ToolCallCardProps) {
  const attention = call.status === 'awaiting-approval' || call.status === 'error' || call.status === 'blocked'
  const [expanded, setExpanded] = useState(defaultExpanded ?? attention)
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    if (call.status !== 'running') return undefined
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [call.status])

  useEffect(() => {
    if (attention) setExpanded(true)
  }, [attention])

  const summary = useMemo(() => summarize(call), [call])
  const elapsed = (call.endedAt ?? (call.status === 'running' ? now : call.startedAt)) - call.startedAt
  const icon = ICON[call.status]

  const diff = useMemo(() => {
    const args = call.args ?? {}
    const oldText = typeof args.old_string === 'string' ? args.old_string : typeof args.oldText === 'string' ? args.oldText : undefined
    const newText = typeof args.new_string === 'string' ? args.new_string : typeof args.newText === 'string' ? args.newText : undefined
    const path = typeof args.path === 'string' ? args.path : typeof args.file_path === 'string' ? args.file_path : 'edit'
    if (oldText !== undefined && newText !== undefined) return parseEditDiff(oldText, newText, path)
    const raw = call.result ?? ''
    if (/^(diff --git|@@ |--- a\/)/m.test(raw)) {
      const files = parseUnifiedDiff(raw)
      if (files.length) return files
    }
    return undefined
  }, [call.args, call.result])

  const entries = useMemo(
    () =>
      Object.entries(call.args ?? {})
        .filter(([, value]) => value !== undefined && value !== null && value !== '')
        .map(([key, value]) => ({ key, value })),
    [call.args],
  )

  const copyResult = () => {
    const text = call.result ?? ''
    void navigator.clipboard?.writeText(text).then(
      () => toast.success({ title: '已复制输出', duration: 1400 }),
      () => toast.danger({ title: '复制失败' }),
    )
  }

  return (
    <div
      className={cn(
        'group rounded-md border border-transparent transition-colors',
        attention && 'border-warn/25 bg-warn-soft/40',
        call.status === 'error' && 'border-danger/25 bg-danger-soft/30',
        call.status === 'blocked' && 'border-danger/25 bg-danger-soft/20',
        !attention && 'hover:bg-surface-2/60',
      )}
    >
      <button
        type="button"
        aria-expanded={expanded}
        onClick={() => setExpanded((v) => !v)}
        className="flex h-6 w-full items-center gap-1.5 px-1.5 text-left"
      >
        <span className={cn('flex h-4 w-4 shrink-0 items-center justify-center', icon.tone)}>
          {icon.node}
        </span>
        <span className="shrink-0 text-[12.5px] font-medium text-fg">{toolNoun(call.name)}</span>
        {call.name !== toolNoun(call.name) ? (
          <span className="shrink-0 font-mono text-2xs text-fg-subtle">{call.name}</span>
        ) : null}
        {summary ? (
          <span className="min-w-0 flex-1 truncate font-mono text-2xs text-fg-muted">{summary}</span>
        ) : (
          <span className="min-w-0 flex-1" />
        )}
        {call.decision ? (
          <Chip size="xs" tone={call.decision === 'deny' ? 'danger' : 'info'}>
            {DECISION_LABEL[call.decision] ?? call.decision}
          </Chip>
        ) : null}
        {call.name === 'agent' && call.childContext ? (
          <span className="shrink-0 font-mono text-2xs tabular-nums text-info">
            子上下文 {formatTokens(call.childContext.contextTokens)}
          </span>
        ) : null}
        <span className="shrink-0 font-mono text-2xs tabular-nums text-fg-subtle">
          {elapsed > 400 ? formatDuration(elapsed) : ''}
        </span>
        <ChevronRight
          size={12}
          className={cn(
            'shrink-0 text-fg-subtle opacity-0 transition-transform group-hover:opacity-100',
            expanded && 'rotate-90 opacity-100',
          )}
        />
      </button>

      {expanded ? (
        <div className="flex flex-col gap-2 px-1.5 pt-1 pb-2 pl-[26px]">
          {call.status === 'awaiting-approval' ? (
            <p className="text-2xs text-warn">等待你在下方授权面板中确认后才会执行。</p>
          ) : null}

          {call.name === 'agent' && call.childContext ? (
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-sm bg-info-soft/50 px-2 py-1.5 text-2xs text-info">
              <span>隔离上下文 {formatTokens(call.childContext.contextTokens)}</span>
              <span>子输出 {formatTokens(call.childContext.outputTokens)}</span>
              {call.childContext.estimated ? <span className="text-fg-subtle">实时估算</span> : null}
            </div>
          ) : null}

          {call.updates.length > 0 ? (
            <ToolOutput
              stdout={call.updates.join('\n')}
              streaming={call.status === 'running'}
              maxHeight={220}
              language="text"
            />
          ) : null}

          {diff ? (
            <DiffView diff={diff} collapsible maxHeight={320} showLineNumbers />
          ) : null}

          {call.result && !diff ? (
            <ToolOutput
              stdout={call.isError ? '' : call.result}
              stderr={call.isError ? call.result : ''}
              exitCode={call.isError ? 1 : 0}
              maxHeight={340}
              streaming={call.status === 'running'}
            />
          ) : null}

          {entries.length ? (
            <details className="group/args">
              <summary className="cursor-pointer list-none text-2xs text-fg-subtle hover:text-fg-muted">
                参数 ({entries.length})
              </summary>
              <div className="mt-1 rounded-sm border border-line bg-surface-2/60 p-1.5">
                <KeyValueList entries={entries} size="sm" />
              </div>
            </details>
          ) : null}

          <div className="flex items-center gap-2">
            <StatusDot tone={call.status === 'success' ? 'success' : call.status === 'error' ? 'danger' : 'idle'} />
            <span className="text-2xs text-fg-subtle">{TOOL_STATUS_LABEL[call.status]}</span>
            <span className="ml-auto flex items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100">
              <Tooltip content="复制输出" side="top">
                <IconButton label="复制工具输出" variant="ghost" size="xs" disabled={!call.result} onClick={copyResult}>
                  <Copy size={12} />
                </IconButton>
              </Tooltip>
              <Tooltip content="复制调用参数 JSON" side="top">
                <IconButton
                  label="复制调用参数"
                  variant="ghost"
                  size="xs"
                  onClick={() =>
                    void navigator.clipboard?.writeText(JSON.stringify(call.args ?? {}, null, 2))
                  }
                >
                  <Terminal size={12} />
                </IconButton>
              </Tooltip>
              {call.status === 'success' ? <Check size={12} className="text-success" /> : null}
            </span>
          </div>
        </div>
      ) : null}
    </div>
  )
}
