/**
 * WorkspaceMenu — 工作区行的「…」菜单：新建对话、重命名、从列表移除。
 *
 * 工作区的身份是路径，不是名字：重命名只写一个显示别名（`useWorkspace.rename`），
 * 「删除」只把这一行移出侧栏并记进隐藏名单（`useWorkspace.hide`），磁盘上的文件夹
 * 不会被碰。宿主正踩在脚下的工作区不能移除，否则侧栏就没有当前 runtime 那一行了。
 */
import { useState } from 'react'
import { MessageSquarePlus, MoreHorizontal, Pencil, Trash2 } from 'lucide-react'
import { ConfirmDialog, Menu, MenuItem, MenuSeparator } from '@/components/ui'
import { RenameDialog } from '@/components/sessions/RenameDialog'
import { cn } from '@/lib/cn'
import { useWorkspace, workspaceAlias, workspaceName } from '@/store/workspaceStore'

/** 别名只影响侧栏的行宽（不落盘到宿主），所以比会话标题更保守。 */
export const MAX_ALIAS_LENGTH = 60

export interface WorkspaceMenuProps {
  path: string
  /** 宿主当前所在的工作区：不能移除，新建对话就走本地新会话。 */
  active?: boolean
  /** 「新建对话」交给侧栏决定：同工作区开新会话，别的先切过去。 */
  onNewConversation: () => void
  align?: 'start' | 'end'
  placement?: 'top' | 'bottom'
  className?: string
  triggerClassName?: string
  label?: string
}

export function WorkspaceMenu({
  path,
  active = false,
  onNewConversation,
  align = 'end',
  placement = 'bottom',
  className,
  triggerClassName,
  label,
}: WorkspaceMenuProps) {
  const renameWorkspace = useWorkspace((state) => state.rename)
  const hideWorkspace = useWorkspace((state) => state.hide)
  const aliases = useWorkspace((state) => state.aliases)
  const [renaming, setRenaming] = useState(false)
  const [pendingHide, setPendingHide] = useState(false)

  const name = workspaceName(path)
  const alias = workspaceAlias(path, aliases)

  return (
    <>
      <Menu
        label={label ?? `工作区操作 ${name}`}
        align={align}
        placement={placement}
        className={cn('min-w-[176px]', className)}
        triggerClassName={triggerClassName}
        trigger={<MoreHorizontal size={13} aria-hidden="true" />}
      >
        <MenuItem
          icon={<MessageSquarePlus size={13} aria-hidden="true" />}
          label="新建对话"
          hint={active ? undefined : '切换过去'}
          onSelect={onNewConversation}
        />
        <MenuItem
          icon={<Pencil size={13} aria-hidden="true" />}
          label="重命名"
          onSelect={() => setRenaming(true)}
        />
        <MenuSeparator />
        <MenuItem
          tone="danger"
          icon={<Trash2 size={13} aria-hidden="true" />}
          label="从列表移除"
          disabled={active}
          hint={active ? '当前工作区' : undefined}
          onSelect={() => setPendingHide(true)}
        />
      </Menu>

      <RenameDialog
        open={renaming}
        title="重命名工作区"
        description="只改左侧列表里显示的名字，路径和磁盘上的文件夹都不变。"
        label="工作区名称"
        initialValue={alias}
        placeholder={name}
        maxLength={MAX_ALIAS_LENGTH}
        allowEmpty
        emptyHint={`留空则显示文件夹名「${name}」。`}
        onCancel={() => setRenaming(false)}
        onConfirm={(value) => {
          setRenaming(false)
          renameWorkspace(path, value)
        }}
      />

      <ConfirmDialog
        open={pendingHide}
        tone="danger"
        title="从工作区列表移除？"
        description={`只移出左侧列表，磁盘上的 ${path} 不会被删除；重新打开这个文件夹即可恢复。`}
        confirmLabel="移除"
        cancelLabel="取消"
        onCancel={() => setPendingHide(false)}
        onConfirm={() => {
          setPendingHide(false)
          hideWorkspace(path)
        }}
      />
    </>
  )
}
