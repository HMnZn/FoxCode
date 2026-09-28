import { useEffect, useState } from 'react'
import { Command, Maximize2, Minus, Moon, PanelLeft, PanelRight, Sun, X } from 'lucide-react'
import { IconButton, StatusDot, Tooltip } from '@/components/ui'
import { useSession } from '@/store/sessionStore'
import { useUi } from '@/store/uiStore'
import { cn } from '@/lib/cn'

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
        'drag-region relative flex h-10 shrink-0 items-center bg-surface pl-3',
        isMac && 'pl-[76px]',
      )}
    >
      <Tooltip content={sidebarCollapsed ? '展开侧栏 (Ctrl+B)' : '收起侧栏 (Ctrl+B)'} side="bottom">
        <IconButton label="切换侧栏" variant="ghost" size="sm" onClick={() => toggleSidebar()}>
          <PanelLeft size={15} />
        </IconButton>
      </Tooltip>

      <span className="pointer-events-none ml-3 truncate text-[12px] text-fg-caption">
        FoxCode Desktop
      </span>

      <div className="no-drag ml-auto flex h-full items-center gap-1">
        <Tooltip
          content={`${TRANSPORT_LABEL[transport.state] ?? transport.state}${host ? ` · ${host.transport === 'mock' ? '演示宿主' : 'fox serve'}` : ''}${transport.detail ? `：${transport.detail}` : ''}`}
          side="bottom"
        >
          <span
            className="mr-1 inline-flex h-7 items-center gap-1.5 rounded-sm px-2 text-[11px] text-fg-subtle hover:bg-interactive hover:text-fg"
            aria-label="宿主连接状态"
          >
            <StatusDot tone={dotTone} pulse={busy} />
            <span className="hidden lg:inline">{TRANSPORT_LABEL[transport.state] ?? transport.state}</span>
          </span>
        </Tooltip>

        <Tooltip content="命令面板 (Ctrl+K)" side="bottom">
          <IconButton label="打开命令面板" variant="ghost" size="sm" onClick={() => setPaletteOpen(true)}>
            <Command size={14} />
          </IconButton>
        </Tooltip>

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
          <div className="ml-1 flex h-full items-center">
            <button
              type="button"
              aria-label="最小化"
              onClick={() => void bridge.window.minimize()}
              className="grid h-full w-11 place-items-center text-fg-muted transition-colors hover:bg-interactive hover:text-fg"
            >
              <Minus size={13} />
            </button>
            <button
              type="button"
              aria-label={maximized ? '还原' : '最大化'}
              onClick={() => void bridge.window.toggleMaximize()}
              className="grid h-full w-11 place-items-center text-fg-muted transition-colors hover:bg-interactive hover:text-fg"
            >
              <Maximize2 size={12} />
            </button>
            <button
              type="button"
              aria-label="关闭"
              onClick={() => void bridge.window.close()}
              className="grid h-full w-11 place-items-center text-fg-muted transition-colors hover:bg-danger hover:text-white"
            >
              <X size={14} />
            </button>
          </div>
        ) : null}
      </div>
    </header>
  )
}
