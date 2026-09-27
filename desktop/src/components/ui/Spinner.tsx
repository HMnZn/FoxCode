/**
 * Spinner / ShimmerBar — busy indicators.
 *
 * `Spinner` is a compact rotating ring used inside buttons and inline status
 * rows. `ShimmerBar` is the skeleton line that reads as "content is streaming
 * in"; both honour the theme's motion tokens.
 */
import { Loader2 } from 'lucide-react'
import { cn } from '@/lib/cn'

export type SpinnerSize = 'xs' | 'sm' | 'md'
export type SpinnerTone = 'accent' | 'fg-muted' | 'fg-subtle' | 'info' | 'success'

export interface SpinnerProps {
  size?: SpinnerSize
  tone?: SpinnerTone
  /** Visually hidden label; defaults to "Loading". */
  label?: string
  className?: string
}

const SIZE: Record<SpinnerSize, number> = { xs: 12, sm: 14, md: 18 }

const TONE: Record<SpinnerTone, string> = {
  accent: 'text-accent',
  'fg-muted': 'text-fg-muted',
  'fg-subtle': 'text-fg-subtle',
  info: 'text-info',
  success: 'text-success',
}

export function Spinner({ size = 'sm', tone = 'accent', label = 'Loading', className }: SpinnerProps) {
  return (
    <span role="status" aria-label={label} className={cn('inline-flex shrink-0', className)}>
      <Loader2 size={SIZE[size]} aria-hidden="true" className={cn('animate-spin', TONE[tone])} />
    </span>
  )
}

export interface ShimmerBarProps {
  /** Any CSS width; defaults to `100%`. */
  width?: number | string
  className?: string
}

export function ShimmerBar({ width = '100%', className }: ShimmerBarProps) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        'block h-3 animate-shimmer rounded-sm',
        'bg-[linear-gradient(90deg,var(--color-surface-3)_20%,var(--color-line-strong)_40%,var(--color-surface-3)_60%)]',
        'bg-[length:220%_100%]',
        className,
      )}
      style={{ width }}
    />
  )
}
