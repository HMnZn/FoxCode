import { useEffect, useRef, useState } from 'react'
import { Zap, X } from 'lucide-react'
import { IconButton, Tooltip } from '@/components/ui'
import { useSession } from '@/store/sessionStore'
import { cn } from '@/lib/cn'

export interface QueuedMessagesProps {
  className?: string
}

/**
 * 排队小框（输入框上方那一行）。
 *
 * 运行中点发送不会打断这一轮，而是把消息放到这里；等这一轮结束后由
 * `sessionStore.drainQueue()` 逐条作为新一轮发出去。每个小框都能：
 * 点文字改写、点右侧闪电**立即插队**（中断当前任务先发它）、点 × 丢掉。
 */
export function QueuedMessages({ className }: QueuedMessagesProps) {
  const queue = useSession((s) => s.queue)
  const updateQueued = useSession((s) => s.updateQueued)
  const dropQueued = useSession((s) => s.dropQueued)
  const steerQueued = useSession((s) => s.steerQueued)
  const [editing, setEditing] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const field = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    if (!editing) return
    const node = field.current
    if (!node) return
    node.focus()
    node.setSelectionRange(node.value.length, node.value.length)
  }, [editing])

  // 正在编辑的那条被发出去 / 被删掉之后要退出编辑态，否则小框会停在残缺状态。
  useEffect(() => {
    if (editing && !queue.some((item) => item.id === editing)) setEditing(null)
  }, [editing, queue])

  if (queue.length === 0) return null

  const commit = () => {
    if (editing) updateQueued(editing, draft)
    setEditing(null)
  }

  return (
    <div
      className={cn('flex flex-col gap-1 px-2.5 pt-2 pb-1.5', className)}
      aria-label="排队消息"
    >
      <span className="px-0.5 text-2xs text-fg-subtle">
        排队 {queue.length} 条 · 这一轮结束后自动发送，点 ⚡ 立即插队
      </span>
      {queue.map((item) => (
        <div
          key={item.id}
          className="flex items-center gap-1 rounded-md bg-surface-3/70 px-2 py-1"
        >
          {editing === item.id ? (
            <textarea
              ref={field}
              rows={1}
              spellCheck={false}
              value={draft}
              aria-label="修改排队消息"
              onChange={(event) => setDraft(event.target.value)}
              onBlur={commit}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.shiftKey) {
                  event.preventDefault()
                  commit()
                  return
                }
                if (event.key === 'Escape') {
                  event.preventDefault()
                  setEditing(null)
                }
              }}
              className="scroll-quiet min-w-0 flex-1 resize-none bg-transparent text-[12.5px] leading-5 text-fg outline-none"
            />
          ) : (
            <button
              type="button"
              title="点击修改这条排队消息"
              aria-label={`修改排队消息：${item.text || `图片 ${item.attachments?.length ?? 0} 张`}`}
              onClick={() => {
                setDraft(item.text)
                setEditing(item.id)
              }}
              className="min-w-0 flex-1 truncate text-left text-[12.5px] leading-5 text-fg-muted hover:text-fg"
            >
              {item.text || `图片 ${item.attachments?.length ?? 0} 张`}
            </button>
          )}

          <Tooltip content="立即插队：中断当前任务，先发这条" side="top">
            <IconButton
              label="立即插队"
              variant="soft"
              size="sm"
              className="size-6 shrink-0 rounded-full text-warn"
              onClick={() => void steerQueued(item.id)}
            >
              <Zap size={12} />
            </IconButton>
          </Tooltip>
          <Tooltip content="从队列里删掉" side="top">
            <IconButton
              label="删除排队消息"
              variant="ghost"
              size="sm"
              className="size-6 shrink-0 rounded-full"
              onClick={() => dropQueued(item.id)}
            >
              <X size={12} />
            </IconButton>
          </Tooltip>
        </div>
      ))}
    </div>
  )
}
