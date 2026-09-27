/**
 * ProgressBar / TokenBar — completion and token-composition meters.
 *
 * `ProgressBar` is a plain 0–1 determinate bar with an optional inline label and
 * percentage readout. `TokenBar` is the stacked composition bar used in the
 * context inspector to visualise prompt / cache / output token segments; each
 * segment carries its own `className`, so callers control coloring with token
 * utilities such as `bg-accent` or `bg-info`.
 */
import type { ReactNode } from 'react'
import { cn } from '@/lib/cn'
import { clamp, formatTokens } from '@/lib/format'

export type ProgressTone = 'accent' | 'success' | 'warn' | 'danger' | 'info' | 'think'
export type ProgressSize = 'xs' | 'sm' | 'md'

export interface ProgressBarProps {
  /** Completion ratio in the 0–1 range; clamped defensively. */
  value: number
  tone?: ProgressTone
  size?: ProgressSize
  /** Inline label rendered above the track. */
  label?: string
  /** Show the rounded percentage on the right of the label row. */
  showValue?: boolean
  /** CSS width for the bar; defaults to `100%`. */
  width?: number | string
  className?: string
  /** Rendered inside the label row, right-aligned. */
  trailing?: ReactNode
}

const HEIGHT: Record<ProgressSize, string> = {
  xs: 'h-[3px]',
  sm: 'h-1',
  md: 'h-1.5',
}

const TONE: Record<ProgressTone, string> = {
  accent: 'bg-accent',
  success: 'bg-success',
  warn: 'bg-warn',
  danger: 'bg-danger',
  info: 'bg-info',
  think: 'bg-think',
}

export function ProgressBar({
  value,
  tone = 'accent',
  size = 'sm',
  label,
  showValue = false,
  width = '100%',
  className,
  trailing,
}: ProgressBarProps) {
  const ratio = clamp(Number.isFinite(value) ? value : 0, 0, 1)
  const percent = Math.round(ratio * 100)

  return (
    <div className={cn('flex min-w-0 flex-col gap-1', className)} style={{ width }}>
      {(label != null || showValue || trailing != null) && (
        <div className="flex items-baseline justify-between gap-2">
          {label != null && (
            <span className="truncate text-2xs uppercase tracking-wide text-fg-subtle">
              {label}
            </span>
          )}
          <span className="ml-auto flex items-center gap-2">
            {trailing}
            {showValue && (
              <span className="font-mono text-2xs tabular-nums text-fg-muted">{percent}%</span>
            )}
          </span>
        </div>
      )}
      <div
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent}
        aria-label={label ?? 'Progress'}
        className={cn(
          'w-full overflow-hidden rounded-full bg-surface-3',
          HEIGHT[size],
        )}
      >
        <div
          className={cn('h-full rounded-full transition-[width] duration-300 ease-out', TONE[tone])}
          style={{ width: `${percent}%` }}
        />
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------ *
 * TokenBar
 * ------------------------------------------------------------------ */

export interface TokenSegment {
  label: string
  /** Absolute token count for this segment. */
  value: number
  /** Fill color utility, e.g. `"bg-accent"` or `"bg-info-soft"`. */
  className: string
}

export interface TokenBarProps {
  segments: ReadonlyArray<TokenSegment>
  /**
   * Denominator for the segment widths. Defaults to the sum of all segment
   * values, so pass the model context window when unused headroom matters.
   */
  total?: number
  height?: number
  /** Render a legend row of label + formatted token counts. */
  legend?: boolean
  className?: string
}

export function TokenBar({
  segments,
  total,
  height = 6,
  legend = false,
  className,
}: TokenBarProps) {
  const sum = segments.reduce((accumulator, segment) => accumulator + Math.max(0, segment.value), 0)
  const denominator = total != null && total > 0 ? total : sum
  const safeDenominator = denominator > 0 ? denominator : 1
  const ratio = sum / safeDenominator

  return (
    <div className={cn('flex min-w-0 flex-col gap-1.5', className)}>
      <div
        role="img"
        aria-label={segments
          .map((segment) => `${segment.label} ${formatTokens(segment.value)}`)
          .join(', ')}
        className="flex w-full overflow-hidden rounded-full bg-surface-3"
        style={{ height }}
      >
        {segments.map((segment, index) => {
          const share = Math.max(0, segment.value) / safeDenominator
          if (share <= 0) return null
          return (
            <div
              key={`${segment.label}-${index}`}
              title={`${segment.label} · ${formatTokens(segment.value)}`}
              className={cn('h-full transition-[width] duration-300 ease-out', segment.className)}
              style={{ width: `${share * 100}%` }}
            />
          )
        })}
        {ratio < 1 && <div className="h-full flex-1 bg-transparent" aria-hidden="true" />}
      </div>

      {legend && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          {segments.map((segment, index) => (
            <span
              key={`legend-${segment.label}-${index}`}
              className="inline-flex items-center gap-1.5 text-2xs text-fg-muted"
            >
              <span
                aria-hidden="true"
                className={cn('inline-block h-2 w-2 shrink-0 rounded-xs', segment.className)}
              />
              <span className="text-fg-subtle">{segment.label}</span>
              <span className="font-mono tabular-nums text-fg">
                {formatTokens(segment.value)}
              </span>
            </span>
          ))}
          {total != null && total > sum && (
            <span className="inline-flex items-center gap-1.5 text-2xs text-fg-subtle">
              <span
                aria-hidden="true"
                className="inline-block h-2 w-2 shrink-0 rounded-xs bg-surface-3"
              />
              {'free '}
              <span className="font-mono tabular-nums">{formatTokens(total - sum)}</span>
            </span>
          )}
        </div>
      )}
    </div>
  )
}
