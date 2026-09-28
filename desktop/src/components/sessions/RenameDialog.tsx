/**
 * RenameDialog — 一个输入框 + 保存/取消，会话名和工作区别名共用。
 *
 * 会话标题的事实来源是会话文件头的 `_meta._label`（`sessions.rename`），工作区
 * 别名只是侧栏的显示偏好（localStorage），两者都不改磁盘上的目录名或文件名，所以
 * 对话框只负责收集一个字符串，落库交给调用方。
 *
 * `allowEmpty` 是给工作区用的：清空别名 = 回到文件夹名，而空标题的会话没有意义。
 */
import { useEffect, useId, useRef, useState } from 'react'
import { Button, Dialog, FieldLabel, TextInput } from '@/components/ui'

export interface RenameDialogProps {
  open: boolean
  title: string
  /** 一行说明，讲清楚「改的只是显示名」。 */
  description?: string
  /** 输入框上方的字段名，例如「会话名称」。 */
  label: string
  /** 打开时的初值；每次打开都会重置，上一次的草稿不会粘住。 */
  initialValue: string
  placeholder?: string
  maxLength?: number
  /** 允许提交空值（工作区用它恢复文件夹名）。 */
  allowEmpty?: boolean
  /** `allowEmpty` 时的补充说明。 */
  emptyHint?: string
  confirmLabel?: string
  onCancel: () => void
  /** 收到的是 trim 过的值。 */
  onConfirm: (value: string) => void
}

export function RenameDialog({
  open,
  title,
  description,
  label,
  initialValue,
  placeholder,
  maxLength,
  allowEmpty = false,
  emptyHint,
  confirmLabel = '保存',
  onCancel,
  onConfirm,
}: RenameDialogProps) {
  const [value, setValue] = useState(initialValue)
  const inputRef = useRef<HTMLInputElement>(null)
  const inputId = useId()

  useEffect(() => {
    if (!open) return
    setValue(initialValue)
    // Dialog 自己会把焦点交给面板里的第一个可聚焦元素（标题栏的关闭按钮），
    // 这里排队到它之后再抢回来，让用户一打开就能打字。
    const timer = window.setTimeout(() => {
      inputRef.current?.focus()
      // 只选中已有内容：空值上 `select()` 会把占位符也刷成选中高亮（Chromium）。
      if (inputRef.current?.value) inputRef.current.select()
    }, 0)
    return () => window.clearTimeout(timer)
  }, [initialValue, open])

  const clean = value.trim()
  const canConfirm = clean.length > 0 || allowEmpty

  const submit = () => {
    if (!canConfirm) return
    onConfirm(clean)
  }

  return (
    <Dialog
      open={open}
      onClose={onCancel}
      title={title}
      description={description}
      size="sm"
      footer={
        <>
          <Button size="sm" variant="ghost" onClick={onCancel}>
            取消
          </Button>
          <Button size="sm" variant="primary" disabled={!canConfirm} onClick={submit}>
            {confirmLabel}
          </Button>
        </>
      }
    >
      <div className="pb-1">
        <FieldLabel htmlFor={inputId}>{label}</FieldLabel>
        <TextInput
          id={inputId}
          ref={inputRef}
          value={value}
          placeholder={placeholder}
          maxLength={maxLength}
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault()
              submit()
            }
          }}
        />
        {allowEmpty && emptyHint ? (
          <p className="pt-1.5 text-2xs text-fg-subtle">{emptyHint}</p>
        ) : null}
      </div>
    </Dialog>
  )
}
