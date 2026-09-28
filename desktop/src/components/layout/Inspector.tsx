/**
 * Inspector — 窗口右侧的工作台：一条标签栏 + 标签自己的内容。
 *
 * 标签有四种（见 `railStore`）：开始、文件（工作区浏览）、每个打开的文件、
 * 终端。终端原先钉在会话区底部，现在也是这里的一个标签 —— 看文件、翻改动、
 * 跑命令本来就是并行的三件事，占同一块地方会让每一件都变窄。
 *
 * 所有标签都保持挂载（不活跃的用 `hidden` 藏起来）：来回切换不该丢掉「文件」
 * 标签里正停在哪个目录，也不该让终端重画一遍回看。
 */
import { Compass, FileCode2, FolderOpen, FolderTree, SquareTerminal, X } from 'lucide-react'
import { IconButton, Tooltip } from '@/components/ui'
import { TerminalTab } from '@/components/layout/TerminalPanel'
import { FileTab } from '@/components/workspace/FilePreview'
import { FilesTab } from '@/components/workspace/FilesTab'
import { basename, shortPath } from '@/lib/format'
import { HOME_TAB, useRail, type RailTab } from '@/store/railStore'
import { useSession } from '@/store/sessionStore'
import { useTerminal } from '@/store/terminalStore'
import { useUi } from '@/store/uiStore'
import { cn } from '@/lib/cn'

/** 标签上的名字：文件名、shell 名，或固定的「开始 / 文件」。 */
function tabLabel(tab: RailTab, shell: string | null): string {
  if (tab.kind === 'home') return '开始'
  if (tab.kind === 'files') return '文件'
  if (tab.kind === 'terminal') return shell ? basename(shell) : '终端'
  return tab.path ? basename(tab.path) : '文件'
}

function tabIcon(tab: RailTab) {
  if (tab.kind === 'home') return <Compass size={12} />
  if (tab.kind === 'files') return <FolderTree size={12} />
  if (tab.kind === 'terminal') return <SquareTerminal size={12} />
  return <FileCode2 size={12} />
}

function RailTabs() {
  const tabs = useRail((s) => s.tabs)
  const activeId = useRail((s) => s.activeId)
  const activate = useRail((s) => s.activate)
  const close = useRail((s) => s.close)
  const toggleInspector = useUi((s) => s.toggleInspector)
  const shell = useTerminal((s) => s.shell)

  return (
    <div className="scroll-quiet flex h-10 shrink-0 items-center gap-0.5 overflow-x-auto border-b border-line px-1.5">
      {tabs.map((tab) => {
        const label = tabLabel(tab, shell)
        const active = tab.id === activeId
        return (
          <div
            key={tab.id}
            className={cn(
              'group flex h-7 shrink-0 items-center rounded-md',
              active ? 'bg-interactive text-fg' : 'text-fg-muted hover:bg-surface-2',
            )}
          >
            <button
              type="button"
              onClick={() => activate(tab.id)}
              aria-label={`切换到 ${label}`}
              title={tab.path ?? label}
              className="flex h-full min-w-0 items-center gap-1.5 rounded-md pr-1 pl-2 text-[11.5px]"
            >
              <span className={cn('shrink-0', active ? 'text-info' : 'text-fg-caption')}>
                {tabIcon(tab)}
              </span>
              <span className="max-w-[128px] truncate">{label}</span>
            </button>
            {tab.id === HOME_TAB.id ? null : (
              <button
                type="button"
                aria-label={`关闭 ${label}`}
                title={`关闭 ${label}`}
                onClick={() => close(tab.id)}
                className={cn(
                  'grid h-full shrink-0 place-items-center rounded-md pr-1.5 pl-0.5 text-fg-caption hover:text-fg',
                  active ? 'opacity-80 hover:opacity-100' : 'opacity-50 group-hover:opacity-90',
                )}
              >
                <X size={11} />
              </button>
            )}
          </div>
        )
      })}
      <Tooltip content="收起面板 (Ctrl+J)" side="bottom">
        <IconButton
          label="收起检查器"
          variant="ghost"
          size="xs"
          className="ml-auto"
          onClick={() => toggleInspector(false)}
        >
          <X size={13} />
        </IconButton>
      </Tooltip>
    </div>
  )
}

/** 开始：空手时该做什么 —— 参考设计里的两张卡片。 */
function HomeTab() {
  const host = useSession((s) => s.host)
  const openFiles = useRail((s) => s.openFiles)
  const openTerminal = useRail((s) => s.openTerminal)

  const card =
    'flex w-full items-center gap-3 rounded-lg border border-line-strong bg-surface px-3 py-2.5 text-left hover:bg-surface-2'

  return (
    <div className="scroll-quiet flex min-h-0 flex-1 flex-col items-center justify-center gap-5 overflow-y-auto px-5">
      <span className="grid size-11 shrink-0 place-items-center rounded-full border border-line bg-surface">
        <Compass size={20} className="text-fg-subtle" />
      </span>
      <div className="flex w-full max-w-[300px] flex-col gap-2">
        <button type="button" onClick={openFiles} className={card}>
          <span className="grid size-8 shrink-0 place-items-center rounded-md bg-warn-soft text-warn">
            <FolderOpen size={16} />
          </span>
          <span className="min-w-0">
            <span className="block text-[13px] font-medium text-fg">工作区文件</span>
            <span className="block text-[10.5px] text-fg-caption">浏览会话工作区的文件</span>
          </span>
          <span className="ml-auto shrink-0 text-[10px] text-fg-caption">Ctrl + Alt + P</span>
        </button>
        <button type="button" onClick={() => openTerminal()} className={card}>
          <span className="grid size-8 shrink-0 place-items-center rounded-md bg-info-soft text-info">
            <SquareTerminal size={16} />
          </span>
          <span className="min-w-0">
            <span className="block text-[13px] font-medium text-fg">新建终端</span>
            <span className="block text-[10.5px] text-fg-caption">在会话工作区运行命令</span>
          </span>
          <span className="ml-auto shrink-0 text-[10px] text-fg-caption">Ctrl + `</span>
        </button>
      </div>
      <p className="max-w-[300px] truncate font-mono text-[10.5px] text-fg-subtle" title={host?.cwd}>
        {host?.cwd ? shortPath(host.cwd, 40) : '未连接工作区'}
      </p>
    </div>
  )
}

export function Inspector({ className }: { className?: string }) {
  const tabs = useRail((s) => s.tabs)
  const activeId = useRail((s) => s.activeId)
  const active = tabs.find((tab) => tab.id === activeId) ?? tabs[0] ?? HOME_TAB
  // 文件和终端是要读的东西，给宽一点；开始与文件列表是导航，窄一点就够。
  const wide = active.kind === 'file' || active.kind === 'terminal'

  return (
    <aside
      className={cn(
        'flex shrink-0 flex-col border-l border-line bg-canvas transition-[width] duration-200',
        wide ? 'w-[520px]' : 'w-[360px]',
        className,
      )}
      aria-label="工作区面板"
    >
      <RailTabs />
      <div className="flex min-h-0 flex-1 flex-col">
        {tabs.map((tab) => {
          const hidden = tab.id !== activeId
          return (
            <div
              key={tab.id}
              role="tabpanel"
              className={cn(
                'flex min-h-0 flex-1 flex-col',
                tab.kind === 'home' || tab.kind === 'files' ? 'scroll-quiet overflow-y-auto' : null,
                hidden && 'hidden',
              )}
            >
              {tab.kind === 'home' ? <HomeTab /> : null}
              {tab.kind === 'files' ? <FilesTab /> : null}
              {tab.kind === 'file' && tab.path ? <FileTab path={tab.path} /> : null}
              {tab.kind === 'terminal' ? <TerminalTab /> : null}
            </div>
          )
        })}
      </div>
    </aside>
  )
}
