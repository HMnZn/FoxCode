import { useEffect, useState } from 'react'
import { Command, Maximize2, Minus, Moon, PanelLeft, PanelRight, Sun, X } from 'lucide-react'
import { Chip, IconButton, Kbd, StatusDot, Tooltip } from '@/components/ui'
import { basename, shortPath } from '@/lib/format'
import { useSession } from '@/store/sessionStore'
import { useUi } from '@/store/uiStore'
import { cn } from '@/lib/cn'

const TRANSPORT_TONE: Record<string, 'success' | 'warn' | 'danger' | 'neutral'> = {
  ready: 'success',
  connecting: 'warn',
  degraded: 'warn',
  offline: 'danger',
}

const TRANSPORT_LABEL: Record<string, string> = {
  ready: '已连接',
  connecting: '连接中',
  degraded: '降级',
  offline: '已断开',
}

/**
 * Window strip.
 *
 * DSH paints this strip with the sidebar fill and treats it as the drag region;
 * the workbench below it rounds its first content column instead of drawing a
 * border, so the strip never needs a divider of its own.
 */
export function TitleBar() {
  const bridge = useSession((s) => s.bridge)
  const transport = useSession((s) => s.transport)
  const host = useSession((s) => s.host)
  const status = useSession((s) => s.timeline.status)
  const theme = useUi((s) => s.theme)
  const toggleTheme = useUi((s) => s.toggleTheme)
  const sidebarCollapsed = useUi((s) => s.sidebarCollapsed)
  const toggleSidebar = useUi((s) => s.toggleSidebar)
  const inspectorOpen = useUi((s) => s.inspectorOpen)
  const toggleInspector = useUi((s) => s.toggleInspector)
  const setPaletteOpen = useUi((s) => s.setPaletteOpen)
  const [maximized, setMaximized] = useState(false)

  useEffect(() => {
    if (!bridge.window.onMaximizeChange) return undefined
    return bridge.window.onMaximizeChange(setMaximized)
  }, [bridge])

  const isMac = bridge.platform === 'darwin'
  const busy =
    status === 'streaming' || status === 'awaiting-approval' || status === 'compacting'
  const dotTone: 'success' | 'warn' | 'danger' | 'idle' =
    status === 'error' ? 'danger' : busy ? 'warn' : 'success'

  return (
    <header
      className={cn(
        'drag-region relative flex h-10 shrink-0 items-center gap-2 bg-surface px-2',
        isMac && 'pl-[76px]',
      )}
    >
      <Tooltip content={sidebarCollapsed ? '展开侧栏 (Ctrl+B)' : '收起侧栏 (Ctrl+B)'} side="bottom">
        <IconButton label="切换侧栏" variant="ghost" size="sm" onClick={() => toggleSidebar()}>
          <PanelLeft size={15} />
        </IconButton>
      </Tooltip>

      <span className="h-4 w-px shrink-0 bg-line" aria-hidden="true" />

      <div className="no-drag flex min-w-0 items-center gap-2">
        <span className="truncate text-[13px] text-fg" title={host?.sessionFile}>
          {host?.sessionFile ? basename(host.sessionFile).replace(/\.jsonl$/, '') : '新会话'}
        </span>
        <Tooltip content={host?.cwd ?? '未知工作区'} side="bottom">
          <span className="hidden max-w-[280px] truncate font-mono text-[11px] text-fg-caption lg:inline">
            {host?.cwd ? shortPath(host.cwd, 48) : '—'}
          </span>
        </Tooltip>
      </div>

      <div className="no-drag ml-auto flex items-center gap-1.5">
        <Tooltip content={transport.detail ?? '宿主连接状态'} side="bottom">
          <Chip
            size="sm"
            tone={TRANSPORT_TONE[transport.state] ?? 'neutral'}
            icon={<StatusDot tone={dotTone} pulse={busy} />}
          >
            {TRANSPORT_LABEL[transport.state] ?? transport.state}
            {host ? ` · ${host.transport === 'mock' ? '演示宿主' : 'fox serve'}` : ''}
          </Chip>
        </Tooltip>

        <button
          type="button"
          onClick={() => setPaletteOpen(true)}
          className="flex h-7 items-center gap-2 rounded-md border border-line bg-surface-2 px-2 text-[12px] text-fg-muted transition-colors hover:bg-interactive hover:text-fg"
        >
          <Command size={12} />
          <span className="hidden sm:inline">命令</span>
          <Kbd>Ctrl</Kbd>
          <Kbd>K</Kbd>
        </button>

        <Tooltip
          content={inspectorOpen ? '收起右侧面板 (Ctrl+J)' : '展开右侧面板 (Ctrl+J)'}
          side="bottom"
        >
          <IconButton
            label="切换右侧面板"
            variant="ghost"
            size="sm"
            className={cn(inspectorOpen && 'bg-interactive text-fg')}
            onClick={() => toggleInspector()}
          >
            <PanelRight size={15} />
          </IconButton>
        </Tooltip>

        <Tooltip content={theme === 'dark' ? '切换到浅色' : '切换到深色'} side="bottom">
          <IconButton label="切换主题" variant="ghost" size="sm" onClick={toggleTheme}>
            {theme === 'dark' ? <Sun size={15} /> : <Moon size={15} />}
          </IconButton>
        </Tooltip>

        {!isMac ? (
          <div className="ml-1 flex items-center">
            <button
              type="button"
              aria-label="最小化"
              onClick={() => void bridge.window.minimize()}
              className="grid h-10 w-11 place-items-center text-fg-muted transition-colors hover:bg-interactive hover:text-fg"
            >
              <Minus size={13} />
            </button>
            <button
              type="button"
              aria-label={maximized ? '还原' : '最大化'}
              onClick={() => void bridge.window.toggleMaximize()}
              className="grid h-10 w-11 place-items-center text-fg-muted transition-colors hover:bg-interactive hover:text-fg"
            >
              <Maximize2 size={12} />
            </button>
            <button
              type="button"
              aria-label="关闭"
              onClick={() => void bridge.window.close()}
              className="grid h-10 w-11 place-items-center text-fg-muted transition-colors hover:bg-danger hover:text-white"
            >
              <X size={14} />
            </button>
          </div>
        ) : null}
      </div>
    </header>
  )
}
