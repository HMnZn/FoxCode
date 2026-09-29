import { useCallback, useRef } from 'react'
import { cn } from '@/lib/cn'

export interface SplitterProps {
  /** 无障碍名字，例如「调整侧栏宽度」。 */
  label: string
  /** 每次指针移动的横向增量（向右为正）。调用方自己决定加还是减。 */
  onResize(deltaX: number): void
  /** 双击时回到默认宽度。 */
  onReset?(): void
  className?: string
}

/**
 * 分栏手柄。
 *
 * 只负责把指针位移换算成 `deltaX` 交出去（左栏往右拖是变宽、右栏往左拖是变宽，
 * 这点只有调用方知道），宽度本身的约束在 `uiStore` 里 —— 中列永远留着能读的宽度。
 * 用 pointer capture 而不是 window 监听：拖动中指针滑出窗口也不会丢事件。
 */
export function Splitter({ label, onResize, onReset, className }: SplitterProps) {
  const last = useRef<number | null>(null)
  const handle = useRef<HTMLDivElement>(null)

  const down = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return
    event.preventDefault()
    last.current = event.clientX
    // 捕获指针，拖动中滑出窗口也不丢事件。合成的 pointer 事件没有活动指针，
    // 这时 `setPointerCapture` 会抛 NotFoundError —— 拖动本身照样能用。
    try {
      event.currentTarget.setPointerCapture(event.pointerId)
    } catch {
      /* 没有可捕获的指针：拖动依然跟手，只是滑出面板就停 */
    }
  }, [])

  const move = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (last.current === null) return
      const delta = event.clientX - last.current
      last.current = event.clientX
      if (delta) onResize(delta)
    },
    [onResize],
  )

  const up = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    last.current = null
    try {
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId)
      }
    } catch {
      /* 从未捕获成功，没什么可释放的 */
    }
  }, [])

  return (
    <div
      ref={handle}
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      title={`${label}（双击复位）`}
      tabIndex={0}
      onPointerDown={down}
      onPointerMove={move}
      onPointerUp={up}
      onPointerCancel={up}
      onDoubleClick={() => onReset?.()}
      onKeyDown={(event) => {
        if (event.key === 'ArrowLeft') {
          event.preventDefault()
          onResize(-16)
        }
        if (event.key === 'ArrowRight') {
          event.preventDefault()
          onResize(16)
        }
      }}
      className={cn(
        'group relative z-10 w-[5px] shrink-0 cursor-col-resize touch-none select-none',
        className,
      )}
    >
      <span className="absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-transparent transition-colors group-hover:bg-accent/50 group-focus-visible:bg-accent" />
    </div>
  )
}
