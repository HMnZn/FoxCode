/**
 * IconButton — square, icon-only action control.
 *
 * Requires a `label`, which is applied as both `aria-label` and `title` so the
 * control stays reachable for screen readers and hover tooltips. Square sizing
 * mirrors `Button` (24 / 28 / 32px) and `active` renders a persistent pressed
 * state for toggles such as the sidebar or inspector switches.
 */
import { forwardRef, type ButtonHTMLAttributes } from 'react'
import { Loader2 } from 'lucide-react'
import { cn } from '@/lib/cn'

export type IconButtonVariant = 'ghost' | 'soft' | 'outline' | 'danger'
export type IconButtonSize = 'xs' | 'sm' | 'md'

export interface IconButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'title'> {
  /** Accessible name; also used as the native tooltip text. */
  label: string
  size?: IconButtonSize
  variant?: IconButtonVariant
  /** Persistent pressed/toggled styling; also sets `aria-pressed`. */
  active?: boolean
  loading?: boolean
}

const VARIANT: Record<IconButtonVariant, string> = {
  ghost: 'bg-transparent text-fg-muted border-0 hover:bg-interactive hover:text-fg',
  soft: 'bg-interactive text-fg-muted border-0 hover:bg-interactive-strong hover:text-fg',
  outline:
    'bg-transparent text-fg-muted border-[0.5px] border-line hover:bg-interactive hover:text-fg',
  danger:
    'bg-transparent text-fg-subtle border-0 hover:bg-danger-soft hover:text-danger',
}

const ACTIVE: Record<IconButtonVariant, string> = {
  ghost: 'bg-interactive text-fg',
  soft: 'bg-interactive-strong text-fg',
  outline: 'border-line-heavy bg-interactive text-fg',
  danger: 'bg-danger-soft text-danger',
}

const SIZE: Record<IconButtonSize, string> = {
  xs: 'h-6 w-6 rounded-sm',
  sm: 'h-7 w-7 rounded-sm',
  md: 'h-9 w-9 rounded-md',
}

const ICON_SIZE: Record<IconButtonSize, number> = { xs: 12, sm: 14, md: 15 }

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  {
    label,
    size = 'sm',
    variant = 'ghost',
    active = false,
    loading = false,
    disabled,
    className,
    children,
    type = 'button',
    ...rest
  },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      aria-label={label}
      title={label}
      aria-pressed={active || undefined}
      aria-busy={loading || undefined}
      disabled={disabled ?? loading}
      className={cn(
        'inline-flex shrink-0 select-none items-center justify-center',
        'transition-colors duration-150 ease-out',
        'disabled:pointer-events-none disabled:opacity-45',
        SIZE[size],
        VARIANT[variant],
        active && !disabled && ACTIVE[variant],
        className,
      )}
      {...rest}
    >
      {loading ? (
        <Loader2 aria-hidden="true" className="animate-spin" size={ICON_SIZE[size]} />
      ) : (
        children
      )}
    </button>
  )
})
