/**
 * 「文件」标签：工作区目录浏览 + 工作区改动。
 *
 * 点一行不会在这里就地打开预览 —— 每个文件都开成右侧工作台自己的标签
 * （见 `railStore.openFile`），这样浏览、看文件、跑命令三件事可以同时在。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import {
  ChevronLeft,
  FileCode2,
  File as FileIcon,
  Folder,
  FolderOpen,
  RefreshCw,
} from 'lucide-react'
import { EmptyState, IconButton, Tooltip } from '@/components/ui'
import { getBridge } from '@/bridge'
import { preferredMode } from '@/lib/preview'
import { basename } from '@/lib/format'
import { useFiles } from '@/store/filesStore'
import { useRail } from '@/store/railStore'
import { useSession } from '@/store/sessionStore'
import type {
  FileChange,
  FileChangeStatus,
  WorkspaceDirectory,
} from '@/types/protocol'
import { cn } from '@/lib/cn'
import { Splitter } from '@/components/layout/Splitter'

const DEFAULT_TREE_PERCENT = 45
const MIN_TREE_PERCENT = 20
const MAX_TREE_PERCENT = 75

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

export function FilesTab() {
  const timeline = useSession((s) => s.timeline)
  const host = useSession((s) => s.host)
  const toolCalls = timeline.totals.toolCalls
  const runStatus = timeline.status
  const changes = useFiles((s) => s.changes)
  const loading = useFiles((s) => s.loading)
  const error = useFiles((s) => s.error)
  const refresh = useFiles((s) => s.refresh)
  const openFile = useRail((s) => s.openFile)
  const [directoryPath, setDirectoryPath] = useState('')
  const [directory, setDirectory] = useState<WorkspaceDirectory | null>(null)
  const [directoryLoading, setDirectoryLoading] = useState(false)
  const [directoryError, setDirectoryError] = useState<string | null>(null)
  const [treePercent, setTreePercent] = useState(DEFAULT_TREE_PERCENT)
  const panelRef = useRef<HTMLDivElement>(null)

  const loadDirectory = useCallback(async (path: string) => {
    setDirectoryLoading(true)
    setDirectoryError(null)
    try {
      const result = (await getBridge().send({
        method: 'files.list',
        params: { path },
      })) as WorkspaceDirectory
      setDirectory(result)
    } catch (reason) {
      setDirectoryError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setDirectoryLoading(false)
    }
  }, [])

  // 打开面板、切换工作区、每次工具调用结束后都重新拉一次清单：
  // Agent 刚写完文件，右侧栏应当马上能看到那一行。
  useEffect(() => {
    void refresh()
  }, [refresh, host?.cwd, toolCalls, runStatus])

  useEffect(() => {
    setDirectoryPath('')
  }, [host?.cwd])

  useEffect(() => {
    void loadDirectory(directoryPath)
  }, [directoryPath, host?.cwd, loadDirectory, toolCalls])

  const files = changes?.files ?? []

  const resizeTree = useCallback((delta: number) => {
    // clientHeight is zero in jsdom and during the first hidden-tab layout;
    // the fallback still makes keyboard resizing deterministic.
    const panelHeight = panelRef.current?.clientHeight || 600
    setTreePercent((current) =>
      Math.min(MAX_TREE_PERCENT, Math.max(MIN_TREE_PERCENT, current + (delta / panelHeight) * 100)),
    )
  }, [])

  return (
    <div ref={panelRef} className="flex h-full min-h-0 flex-1 flex-col overflow-hidden">
      <section
        aria-label="工作区文件树"
        className="flex min-h-[112px] shrink-0 flex-col overflow-hidden"
        style={{ flexBasis: `${treePercent}%` }}
      >
        <div className="flex shrink-0 items-center gap-1 border-b border-line px-2 py-1.5">
          {directoryPath ? (
            <IconButton
              label="返回上级目录"
              variant="ghost"
              size="xs"
              onClick={() => {
                const parts = directoryPath.replace(/\\/g, '/').split('/').filter(Boolean)
                parts.pop()
                setDirectoryPath(parts.join('/'))
              }}
            >
              <ChevronLeft size={13} />
            </IconButton>
          ) : (
            <FolderOpen size={13} className="mx-1 text-info" />
          )}
          <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-fg-muted">
            {directoryPath || basename(host?.cwd ?? '') || '工作区'}
          </span>
          <Tooltip content="刷新目录" side="bottom">
            <IconButton
              label="刷新目录"
              variant="ghost"
              size="xs"
              loading={directoryLoading}
              onClick={() => void loadDirectory(directoryPath)}
            >
              <RefreshCw size={12} />
            </IconButton>
          </Tooltip>
        </div>

        {directoryError ? (
          <p className="shrink-0 border-b border-line px-3 py-2 text-2xs text-danger">{directoryError}</p>
        ) : null}

        <div className="min-h-0 flex-1 overflow-y-auto px-1.5 py-1.5">
          {directory?.entries.map((entry) => (
            <button
              key={`${entry.type}-${entry.path}`}
              type="button"
              title={entry.path}
              onClick={() => {
                if (entry.type === 'directory') setDirectoryPath(entry.path)
                else openFile(entry.path, preferredMode(entry.path, 'source'))
              }}
              className="flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-[12px] text-fg-muted hover:bg-interactive hover:text-fg"
            >
              {entry.type === 'directory' ? (
                <Folder size={14} className="shrink-0 text-info" />
              ) : (
                <FileIcon size={14} className="shrink-0 text-fg-caption" />
              )}
              <span className="min-w-0 flex-1 truncate">{entry.name}</span>
            </button>
          ))}
          {!directoryLoading && directory?.entries.length === 0 ? (
            <p className="px-2 py-2 text-2xs text-fg-caption">空目录</p>
          ) : null}
          {directory?.truncated ? (
            <p className="px-2 py-1 text-[10.5px] text-fg-caption">目录内容过多，只显示前 500 项。</p>
          ) : null}
        </div>
      </section>

      <Splitter
        label="调整文件树与工作区改动高度"
        orientation="horizontal"
        onResize={resizeTree}
        onReset={() => setTreePercent(DEFAULT_TREE_PERCENT)}
      />

      <section aria-label="工作区改动列表" className="flex min-h-[112px] flex-1 flex-col overflow-hidden">
        <div className="flex shrink-0 items-center gap-2 border-y border-line px-3 py-2">
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

        <div className="min-h-0 flex-1 overflow-y-auto">
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
                  onOpen={() => openFile(change.path, preferredMode(change.path, 'diff'))}
                />
              ))}
              {changes?.truncated ? (
                <p className="px-2 py-1 text-[10.5px] text-fg-subtle">
                  只列出前 {files.length} 个（共 {changes.total} 个）。
                </p>
              ) : null}
            </div>
          ) : null}

          {files.length === 0 && !loading && !error ? (
            <EmptyState
              compact
              icon={<FileCode2 size={18} />}
              title="还没有文件改动"
              description="Agent 修改文件后，这里会列出真实工作区差异；读取文件或执行 ls 不会被误算成编辑。"
            />
          ) : null}
        </div>
      </section>
    </div>
  )
}
