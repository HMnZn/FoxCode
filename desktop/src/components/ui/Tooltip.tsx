/**
 * Tooltip — dependency-free, portal-free hover/focus hint.
 *
 * The bubble is absolutely positioned inside a `relative inline-flex` wrapper,
 * so it is clipped by any ancestor with `overflow: hidden`; prefer it for
 * chrome toolbars and keep long-form content out of it. It opens after `delay`
 * on pointer hover or keyboard focus, and closes on pointer leave, blur, or
 * Escape. Timing state is only ever touched inside effects/handlers, so the
 * component is safe to import in a non-DOM environment.
 */
import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { cn } from '@/lib/cn'

export type TooltipSide = 'top' | 'bottom' | 'left' | 'right'

export interface TooltipProps {
  content: ReactNode
  side?: TooltipSide
  /** Open delay in milliseconds. Defaults to 320. */
  delay?: number
  /** Wrapper class — use for layout placement, not bubble styling. */
  className?: string
  /** Bubble class — width, alignment, and any overrides. */
  contentClassName?: string
  /** Skip rendering entirely (e.g. when the anchor already has a title). */
  disabled?: boolean
  children: ReactNode
}

const SIDE_WRAP: Record<TooltipSide, string> = {
  top: 'bottom-full left-1/2 -translate-x-1/2 mb-1.5',
  bottom: 'top-full left-1/2 -translate-x-1/2 mt-1.5',
  left: 'right-full top-1/2 -translate-y-1/2 mr-1.5',
  right: 'left-full top-1/2 -translate-y-1/2 ml-1.5',
}

export function Tooltip({
  content,
  side = 'top',
  delay = 320,
  className,
  contentClassName,
  disabled = false,
  children,
}: TooltipProps) {
  const [open, setOpen] = useState(false)
  const timer = useRef<number | null>(null)
  const id = useId()

  const cancel = useCallback(() => {
    if (timer.current !== null) {
      window.clearTimeout(timer.current)
      timer.current = null
    }
  }, [])

  const show = useCallback(() => {
    if (disabled) return
    cancel()
    timer.current = window.setTimeout(() => setOpen(true), Math.max(0, delay))
  }, [cancel, delay, disabled])

  const hide = useCallback(() => {
    cancel()
    setOpen(false)
  }, [cancel])

  useEffect(() => cancel, [cancel])
  useEffect(() => {
    if (disabled) hide()
  }, [disabled, hide])

  return (
    <span
      className={cn('relative inline-flex', className)}
      onPointerEnter={show}
      onPointerLeave={hide}
      onPointerDown={hide}
      onFocus={show}
      onBlur={hide}
      onKeyDown={(event) => {
        if (event.key === 'Escape') hide()
      }}
      aria-describedby={open ? id : undefined}
    >
      {children}
      {open && !disabled && (
        <span
          id={id}
          role="tooltip"
          className={cn(
            'pointer-events-none absolute z-50 w-max max-w-[50vw] animate-fade',
            'rounded-sm bg-tooltip px-[7px] py-[3px] text-[13px] leading-5 text-tooltip-fg',
            'shadow-pop',
            SIDE_WRAP[side],
            contentClassName,
          )}
        >
          {content}
        </span>
      )}
    </span>
  )
}
