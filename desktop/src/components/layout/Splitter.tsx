import { useCallback, useRef } from 'react'
import { cn } from '@/lib/cn'

export interface SplitterProps {
  /** 无障碍名字，例如「调整侧栏宽度」。 */
  label: string
  /** 分隔线方向；竖线调整宽度，横线调整高度。 */
  orientation?: 'vertical' | 'horizontal'
  /** 每次指针移动的增量（竖线向右、横线向下为正）。 */
  onResize(delta: number): void
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
export function Splitter({
  label,
  orientation = 'vertical',
  onResize,
  onReset,
  className,
}: SplitterProps) {
  const last = useRef<number | null>(null)
  const handle = useRef<HTMLDivElement>(null)

  const down = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return
    event.preventDefault()
    last.current = orientation === 'vertical' ? event.clientX : event.clientY
    // 捕获指针，拖动中滑出窗口也不丢事件。合成的 pointer 事件没有活动指针，
    // 这时 `setPointerCapture` 会抛 NotFoundError —— 拖动本身照样能用。
    try {
      event.currentTarget.setPointerCapture(event.pointerId)
    } catch {
      /* 没有可捕获的指针：拖动依然跟手，只是滑出面板就停 */
    }
  }, [orientation])

  const move = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (last.current === null) return
      const current = orientation === 'vertical' ? event.clientX : event.clientY
      const delta = current - last.current
      last.current = current
      if (delta) onResize(delta)
    },
    [onResize, orientation],
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
      aria-orientation={orientation}
      aria-label={label}
      title={`${label}（双击复位）`}
      tabIndex={0}
      onPointerDown={down}
      onPointerMove={move}
      onPointerUp={up}
      onPointerCancel={up}
      onDoubleClick={() => onReset?.()}
      onKeyDown={(event) => {
        if (orientation === 'vertical' && event.key === 'ArrowLeft') {
          event.preventDefault()
          onResize(-16)
        }
        if (orientation === 'vertical' && event.key === 'ArrowRight') {
          event.preventDefault()
          onResize(16)
        }
        if (orientation === 'horizontal' && event.key === 'ArrowUp') {
          event.preventDefault()
          onResize(-16)
        }
        if (orientation === 'horizontal' && event.key === 'ArrowDown') {
          event.preventDefault()
          onResize(16)
        }
      }}
      className={cn(
        'group relative z-10 shrink-0 touch-none select-none',
        orientation === 'vertical'
          ? 'h-full w-[5px] cursor-col-resize'
          : 'h-[7px] w-full cursor-row-resize',
        className,
      )}
    >
      <span
        className={cn(
          'absolute bg-line-strong transition-colors group-hover:bg-accent/60 group-focus-visible:bg-accent',
          orientation === 'vertical'
            ? 'inset-y-0 left-1/2 w-px -translate-x-1/2'
            : 'inset-x-0 top-1/2 h-px -translate-y-1/2',
        )}
      />
    </div>
  )
}
