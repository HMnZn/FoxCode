/**
 * Chip / StatusDot — compact metadata pills for the dense IDE chrome.
 *
 * `Chip` renders a static `<span>` unless `onClick` is supplied, in which case
 * it becomes a real `<button>` with hover affordances. `StatusDot` is the tiny
 * colored indicator used in status bars and list rows, with an optional soft
 * pulse for "running" states.
 */
import type { ButtonHTMLAttributes, ReactNode } from 'react'
import { cn } from '@/lib/cn'

export type ChipTone =
  | 'neutral'
  | 'accent'
  | 'success'
  | 'warn'
  | 'danger'
  | 'info'
  | 'think'

export type ChipSize = 'xs' | 'sm'

export interface ChipProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'> {
  tone?: ChipTone
  size?: ChipSize
  /** Optional leading glyph — an icon component or any small node. */
  icon?: ReactNode
  /** Present turns the chip into a `<button>`; absent renders a `<span>`. */
  onClick?: ButtonHTMLAttributes<HTMLButtonElement>['onClick']
  /** Render the label in the monospace face (ids, counts, model names). */
  mono?: boolean
  children?: ReactNode
}

const TONE: Record<ChipTone, string> = {
  neutral: 'bg-surface-3 text-fg-muted',
  accent: 'bg-accent-soft text-accent',
  success: 'bg-success-soft text-success',
  warn: 'bg-warn-soft text-warn',
  danger: 'bg-danger-soft text-danger',
  info: 'bg-info-soft text-info',
  think: 'bg-think-soft text-think',
}

// DSH tag geometry: one capsule size (11px/17px, 1px vertical padding, 999px
// radius) with only the palette varying, so a tag reads the same everywhere.
const SIZE: Record<ChipSize, string> = {
  xs: 'px-1.5 py-px text-[11px] leading-[17px] rounded-full',
  sm: 'px-2 py-px text-[11px] leading-[17px] rounded-full',
}

const ICON_SIZE: Record<ChipSize, number> = { xs: 10, sm: 11 }

export function Chip({
  tone = 'neutral',
  size = 'xs',
  icon,
  onClick,
  mono = false,
  className,
  children,
  type = 'button',
  ...rest
}: ChipProps) {
  const classes = cn(
    'inline-flex max-w-full select-none items-center gap-1 border-0 font-medium',
    'align-middle whitespace-nowrap [corner-shape:round]',
    SIZE[size],
    TONE[tone],
    mono && 'font-mono tabular-nums',
    onClick && 'cursor-pointer transition-colors duration-150 hover:brightness-125',
    className,
  )

  const iconCls = 'inline-flex shrink-0 items-center justify-center'
  const body = (
    <>
      {icon != null && (
        <span className={cn(iconCls, 'opacity-90')} aria-hidden="true">
          {icon}
        </span>
      )}
      {children != null && <span className="truncate">{children}</span>}
    </>
  )

  if (onClick) {
    return (
      <button type={type} onClick={onClick} className={classes} {...rest}>
        {body}
      </button>
    )
  }

  return <span className={classes}>{body}</span>
}

export type StatusDotTone =
  | 'idle'
  | 'accent'
  | 'success'
  | 'warn'
  | 'danger'
  | 'info'
  | 'think'
  | 'neutral'

export interface StatusDotProps {
  tone?: StatusDotTone
  /** Soft breathing animation — use for live/running states. */
  pulse?: boolean
  /** Extra classes for positioning (e.g. `absolute -top-0.5`). */
  className?: string
  /** Optional accessible description; when omitted the dot is decorative. */
  label?: string
}

const DOT_TONE: Record<StatusDotTone, string> = {
  idle: 'bg-fg-subtle',
  neutral: 'bg-fg-subtle',
  accent: 'bg-accent',
  success: 'bg-success',
  warn: 'bg-warn',
  danger: 'bg-danger',
  info: 'bg-info',
  think: 'bg-think',
}

export function StatusDot({ tone = 'idle', pulse = false, className, label }: StatusDotProps) {
  return (
    <span
      role={label ? 'img' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      className={cn(
        'inline-block h-1.5 w-1.5 shrink-0 rounded-full',
        DOT_TONE[tone],
        pulse && 'animate-pulse-soft',
        className,
      )}
    />
  )
}

/** Shared icon size for chips so callers do not guess pixel values. */
export const chipIconSize = ICON_SIZE
