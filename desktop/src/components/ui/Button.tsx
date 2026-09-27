/**
 * Button — the base action control for FoxCode Studio.
 *
 * Geometry follows the DSH control scale exactly: `md` is 36px tall on a 12px
 * radius (14px/22px), `sm` is 28px on an 8px radius (12px/18px), and the
 * horizontal padding is 14px / 10px. Styling is expressed purely with the
 * design-token utilities declared in `src/styles/globals.css`; the focus ring
 * comes from the global `:focus-visible` rule, so no local outline override is
 * applied. Passing `loading` swaps the leading slot for a spinning `Loader2` and
 * hard-disables the control while preserving its measured width.
 */
import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react'
import { Loader2 } from 'lucide-react'
import { cn } from '@/lib/cn'

export type ButtonVariant =
  | 'primary'
  | 'secondary'
  | 'ghost'
  | 'outline'
  | 'danger'
  | 'subtle'

export type ButtonSize = 'xs' | 'sm' | 'md'

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant
  size?: ButtonSize
  /** Show a spinner in the leading slot and disable the button. */
  loading?: boolean
  iconLeft?: ReactNode
  iconRight?: ReactNode
  /** Stretch to the full width of the parent. */
  block?: boolean
}

const VARIANT: Record<ButtonVariant, string> = {
  primary: 'btn-primary',
  // DSH outlined action: transparent fill with the l3 hairline.
  secondary:
    'bg-transparent text-fg border-[0.5px] border-line-heavy hover:bg-interactive active:bg-interactive-strong',
  ghost:
    'bg-transparent text-fg-muted border-0 hover:bg-interactive hover:text-fg active:bg-interactive-strong',
  outline:
    'bg-transparent text-fg border-[0.5px] border-line-heavy hover:bg-interactive hover:border-accent active:bg-interactive-strong',
  danger:
    'bg-danger-soft text-danger border-0 hover:bg-danger hover:text-canvas active:bg-danger',
  subtle:
    'bg-interactive text-fg-muted border-0 hover:bg-interactive-strong hover:text-fg active:bg-interactive-strong',
}

const SIZE: Record<ButtonSize, string> = {
  xs: 'h-6 gap-1 rounded-sm px-2 text-[12px] leading-[18px]',
  sm: 'h-7 gap-1 rounded-sm px-2.5 text-[12px] leading-[18px]',
  md: 'h-9 gap-1 rounded-md px-3.5 text-[14px] leading-[22px]',
}

const ICON_SIZE: Record<ButtonSize, number> = { xs: 12, sm: 14, md: 15 }

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  {
    variant = 'secondary',
    size = 'sm',
    loading = false,
    iconLeft,
    iconRight,
    block = false,
    disabled,
    className,
    children,
    type = 'button',
    ...rest
  },
  ref,
) {
  const leading = loading ? (
    <Loader2
      aria-hidden="true"
      className="animate-spin shrink-0"
      size={ICON_SIZE[size]}
    />
  ) : (
    iconLeft
  )

  return (
    <button
      ref={ref}
      type={type}
      disabled={disabled ?? loading}
      aria-busy={loading || undefined}
      className={cn(
        'inline-flex select-none items-center justify-center whitespace-nowrap font-normal',
        'transition-[color,background-color,border-color,box-shadow,filter] duration-150 ease-[cubic-bezier(0.4,0,0.2,1)]',
        'disabled:pointer-events-none disabled:opacity-40',
        SIZE[size],
        VARIANT[variant],
        block && 'w-full',
        className,
      )}
      {...rest}
    >
      {leading != null && (
        <span className="inline-flex shrink-0 items-center justify-center" aria-hidden="true">
          {leading}
        </span>
      )}
      {children != null && <span className="truncate">{children}</span>}
      {iconRight != null && (
        <span className="inline-flex shrink-0 items-center justify-center" aria-hidden="true">
          {iconRight}
        </span>
      )}
    </button>
  )
})
