import { Clock, FolderOpen, FolderPlus, X } from 'lucide-react'
import { Button, Chip, IconButton, Tooltip } from '@/components/ui'
import { FoxMascot } from '@/components/brand/Fox'
import { shortPath } from '@/lib/format'
import { useSession } from '@/store/sessionStore'
import { useWorkspace } from '@/store/workspaceStore'

/**
 * First-run gate: nothing else is reachable until a folder is chosen.
 *
 * The picker deliberately offers the host's own cwd as a one-click option — it
 * is what a headless `fox serve` would have used anyway, so making the user
 * find that path in a dialog would be busywork.
 */
export function WorkspacePicker() {
  const recent = useWorkspace((s) => s.recent)
  const applying = useWorkspace((s) => s.applying)
  const pick = useWorkspace((s) => s.pick)
  const open = useWorkspace((s) => s.open)
  const forget = useWorkspace((s) => s.forget)
  const host = useSession((s) => s.host)

  const hostCwd = host?.cwd ?? ''
  const busy = applying !== null

  return (
    <div className="flex min-h-0 flex-1 items-center justify-center overflow-y-auto px-6 py-10">
      <div className="w-full max-w-[600px]">
        <div className="mb-7 flex flex-col items-center text-center">
          <div className="relative mb-5">
            <div
              aria-hidden="true"
              className="absolute inset-0 -z-10 scale-[1.9] rounded-full bg-fox-glow blur-2xl"
            />
            <FoxMascot size={104} label="FoxCode 灵狐" />
          </div>
          <h1 className="text-[20px] leading-[28px] font-medium text-fg">选择一个工作区</h1>
          <p className="mt-2 max-w-[470px] text-[13.5px] leading-relaxed text-fg-muted">
            工作区是模型的根目录：读写、搜索、会话记录与信任判定都以它为准，
            <span className="font-mono">fox serve</span> 也会把它当作进程的工作目录。
          </p>
        </div>

        <div className="surface-card p-4">
          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="primary"
              size="md"
              iconLeft={<FolderOpen size={15} />}
              disabled={busy}
              onClick={() => void pick()}
            >
              选择文件夹…
            </Button>

            {hostCwd ? (
              <Tooltip content={hostCwd} side="top">
                <Button
                  variant="secondary"
                  size="md"
                  iconLeft={<FolderPlus size={15} />}
                  disabled={busy}
                  onClick={() => void open(hostCwd)}
                >
                  使用当前目录 · {shortPath(hostCwd, 28)}
                </Button>
              </Tooltip>
            ) : null}

            {busy ? (
              <Chip size="sm" tone="info">
                正在应用 {shortPath(applying ?? '', 32)}…
              </Chip>
            ) : null}
          </div>

          <div className="mt-4 border-t border-line pt-3">
            <div className="mb-2 flex items-center gap-1.5 text-[11.5px] text-fg-subtle">
              <Clock size={12} aria-hidden="true" />
              最近工作区
            </div>

            {recent.length === 0 ? (
              <p className="px-1 py-2 text-[12.5px] text-fg-subtle">
                还没有记录。选过的文件夹会出现在这里，下次一点就能回到同一个工作区。
              </p>
            ) : (
              <ul className="flex flex-col gap-1">
                {recent.map((path) => (
                  <li key={path} className="group flex items-center gap-1">
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => void open(path)}
                      className="flex min-w-0 flex-1 items-center gap-2 rounded-sm px-2 py-1.5 text-left hover:bg-surface-2 disabled:opacity-50"
                    >
                      <FolderOpen size={14} aria-hidden="true" className="shrink-0 text-accent" />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-[13px] text-fg">{path}</span>
                      </span>
                    </button>
                    <Tooltip content="从最近列表移除" side="top">
                      <IconButton
                        label={`从最近工作区移除 ${path}`}
                        variant="ghost"
                        size="xs"
                        className="opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100"
                        onClick={() => forget(path)}
                      >
                        <X size={13} />
                      </IconButton>
                    </Tooltip>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>

        <p className="mt-4 text-center text-[12px] leading-relaxed text-fg-subtle">
          选定后可以随时在输入框下方的工作区菜单、命令面板或设置页切换工作区。
        </p>
      </div>
    </div>
  )
}
