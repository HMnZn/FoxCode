/**
 * SessionMenu — 会话行的「…」菜单：置顶、重命名、分叉、永久删除。
 *
 * 侧栏和「历史会话」页共用同一个组件，行为必须一致：
 * - 置顶是每客户端的显示偏好（`usePins`，localStorage）；
 * - 重命名走 `sessions.rename`，标题事实来源是会话文件头的 `_meta._label`；
 * - 分叉前先把目标会话切到前台，因为宿主的 `sessions.fork` 只作用于当前 runtime；
 * - 删除是不可撤销的，所以走 ConfirmDialog；正在运行的会话先禁用（宿主还在写这个
 *   文件）。正在**使用**的会话不在此列：`deleteSession` 会先新建一个会话再删。
 */
import { useState, type ReactNode } from 'react'
import { GitFork, MoreHorizontal, Pencil, Pin, PinOff, Trash2 } from 'lucide-react'
import { ConfirmDialog, Menu, MenuItem, MenuSeparator } from '@/components/ui'
import { RenameDialog } from '@/components/sessions/RenameDialog'
import { basename } from '@/lib/format'
import { usePins } from '@/store/pinStore'
import { useSession } from '@/store/sessionStore'
import { toast } from '@/store/toastStore'
import type { SessionSummary } from '@/types/protocol'

/** 与 `fox_serve.sessions.MAX_LABEL_LENGTH` 一致：宿主会截断，输入框先挡住。 */
export const MAX_TITLE_LENGTH = 120

export interface SessionMenuProps {
  session: SessionSummary
  /** 当前活动会话；删除它之前宿主会被要求先开一个新会话。 */
  live?: boolean
  align?: 'start' | 'end'
  placement?: 'top' | 'bottom'
  /** 触发按钮的内容，默认「…」图标。 */
  trigger?: ReactNode
  /** 面板的类名。 */
  className?: string
  /** 触发按钮的类名（用来做成 hover 才出现的小按钮）。 */
  triggerClassName?: string
  label?: string
}

export function SessionMenu({
  session,
  live = false,
  align = 'end',
  placement = 'bottom',
  trigger,
  className,
  triggerClassName,
  label,
}: SessionMenuProps) {
  const renameSession = useSession((state) => state.renameSession)
  const forkSession = useSession((state) => state.forkSession)
  const deleteSession = useSession((state) => state.deleteSession)
  const pinned = usePins((state) => state.pinned.includes(session.id))
  const togglePin = usePins((state) => state.toggle)
  const [renaming, setRenaming] = useState(false)
  const [pendingDelete, setPendingDelete] = useState(false)

  const title = session.title || '未命名会话'
  // store 已经 toast 过失败原因，这里吞掉 rethrow，避免控制台里的未处理拒绝。
  const settle = (promise: Promise<void>) => void promise.catch(() => {})

  return (
    <>
      <Menu
        label={label ?? `会话操作 ${title}`}
        align={align}
        placement={placement}
        className={className}
        triggerClassName={triggerClassName}
        trigger={trigger ?? <MoreHorizontal size={14} aria-hidden="true" />}
      >
        <MenuItem
          icon={pinned ? <PinOff size={13} aria-hidden="true" /> : <Pin size={13} aria-hidden="true" />}
          label={pinned ? '取消置顶' : '置顶会话'}
          onSelect={() => {
            const next = togglePin(session.id)
            toast.success({
              title: next ? '已置顶会话' : '已取消置顶',
              description: title,
            })
          }}
        />
        <MenuItem
          icon={<Pencil size={13} aria-hidden="true" />}
          label="重命名"
          onSelect={() => setRenaming(true)}
        />
        <MenuItem
          icon={<GitFork size={13} aria-hidden="true" />}
          label="分叉会话"
          onSelect={() => settle(forkSession(session.id))}
        />
        <MenuSeparator />
        <MenuItem
          tone="danger"
          icon={<Trash2 size={13} aria-hidden="true" />}
          label="永久删除会话"
          disabled={session.running === true}
          hint={session.running === true ? '运行中' : undefined}
          onSelect={() => setPendingDelete(true)}
        />
      </Menu>

      <RenameDialog
        open={renaming}
        title="重命名会话"
        description="只改列表里的标题，会话文件和历史记录保持不变。"
        label="会话名称"
        initialValue={session.title}
        maxLength={MAX_TITLE_LENGTH}
        onCancel={() => setRenaming(false)}
        onConfirm={(value) => {
          setRenaming(false)
          settle(renameSession(session.id, value))
        }}
      />

      <ConfirmDialog
        open={pendingDelete}
        tone="danger"
        title="永久删除这个会话？"
        description={[
          `将从磁盘删除 ${basename(session.file)}，此操作不可撤销。`,
          live ? '这是当前会话，会先新建一个会话再删除它。' : '',
        ]
          .filter(Boolean)
          .join(' ')}
        confirmLabel="永久删除"
        cancelLabel="取消"
        onCancel={() => setPendingDelete(false)}
        onConfirm={() => {
          setPendingDelete(false)
          settle(deleteSession(session.id))
        }}
      />
    </>
  )
}
