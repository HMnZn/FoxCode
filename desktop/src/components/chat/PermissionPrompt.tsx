import { useMemo } from 'react'
import { AlertTriangle, FolderOpen, ShieldAlert, Terminal } from 'lucide-react'
import { Button, Chip } from '@/components/ui'
import { DiffView, parseUnifiedDiff } from '@/components/content/DiffView'
import { shortPath } from '@/lib/format'
import {
  PERMISSION_LABEL,
  type PermissionDecision,
  type PermissionRequest,
} from '@/types/protocol'
import { cn } from '@/lib/cn'

const REASON_LABEL: Record<PermissionRequest['reason'], string> = {
  'mode-insufficient': '当前权限模式不足',
  'outside-workspace': '目标路径在工作区之外',
  policy: '被策略拦截',
  'always-ask': '该工具始终需要确认',
}

export interface PermissionPromptProps {
  request: PermissionRequest
  onAnswer(decision: PermissionDecision, reason?: string): void
  busy?: boolean
  className?: string
}

/**
 * Inline approval card — the GUI half of the host's `before_tool_call` hook.
 *
 * The host hook may only *tighten* permissions, so approving here never grants
 * more than the tool declares; "本会话总是允许" is scoped by the host, not the UI.
 */
export function PermissionPrompt({ request, onAnswer, busy, className }: PermissionPromptProps) {
  const diff = useMemo(() => {
    if (request.preview?.kind !== 'diff' || !request.preview.diff) return undefined
    const files = parseUnifiedDiff(request.preview.diff)
    return files.length ? files : undefined
  }, [request.preview])

  return (
    <section
      role="alertdialog"
      aria-label={`授权 ${request.tool_name}`}
      className={cn(
        'overflow-hidden rounded-xl border border-warn/30 bg-warn-soft/40 shadow-elev-2',
        className,
      )}
    >
      <header className="flex items-center gap-2 border-b border-warn/20 bg-warn-soft/60 px-3 py-1.5">
        <ShieldAlert size={14} className="shrink-0 text-warn" />
        <span className="text-[12.5px] font-medium text-fg">需要授权</span>
        <span className="font-mono text-2xs text-fg-muted">{request.tool_name}</span>
        <Chip size="xs" tone="warn" className="ml-auto">
          {PERMISSION_LABEL[request.required]}
        </Chip>
      </header>

      <div className="flex flex-col gap-2 px-3 py-2">
        <p className="text-[12.5px] leading-5 text-fg">{request.summary}</p>

        <div className="flex flex-wrap items-center gap-1.5 text-2xs text-fg-muted">
          <Chip size="xs" tone="info">
            {REASON_LABEL[request.reason]}
          </Chip>
          <Chip size="xs">
            当前 {PERMISSION_LABEL[request.mode]}
          </Chip>
          <span className="inline-flex items-center gap-1 font-mono">
            <FolderOpen size={11} />
            {shortPath(request.cwd, 3)}
          </span>
        </div>

        {request.preview?.kind === 'command' && request.preview.command ? (
          <pre className="scroll-quiet max-h-40 overflow-auto rounded-md border border-line bg-surface-2 px-2.5 py-2 font-mono text-2xs leading-5 text-fg">
            <span className="mr-2 inline-flex items-center gap-1 text-fg-subtle">
              <Terminal size={11} />$
            </span>
            {request.preview.command}
          </pre>
        ) : null}

        {request.preview?.kind === 'path' && request.preview.paths?.length ? (
          <ul className="flex flex-col gap-0.5 rounded-md border border-line bg-surface-2 px-2.5 py-2 font-mono text-2xs text-fg-muted">
            {request.preview.paths.map((path) => (
              <li key={path} className="truncate">
                {path}
              </li>
            ))}
          </ul>
        ) : null}

        {diff ? (
          <div className="rounded-md border border-line bg-surface-2 p-1">
            <DiffView diff={diff} collapsible maxHeight={280} showLineNumbers />
          </div>
        ) : null}

        {request.path && request.preview?.kind !== 'path' ? (
          <p className="flex items-center gap-1 truncate font-mono text-2xs text-fg-subtle">
            <AlertTriangle size={11} className="shrink-0 text-warn" />
            {request.path}
          </p>
        ) : null}
      </div>

      <footer className="flex items-center justify-end gap-2 border-t border-warn/20 bg-surface/40 px-3 py-2">
        <Button variant="ghost" size="sm" disabled={busy} onClick={() => onAnswer('deny')}>
          拒绝
        </Button>
        <Button variant="secondary" size="sm" disabled={busy} onClick={() => onAnswer('allow-session')}>
          本会话总是允许
        </Button>
        <Button variant="primary" size="sm" disabled={busy} onClick={() => onAnswer('allow-once')}>
          允许一次
        </Button>
      </footer>
    </section>
  )
}
