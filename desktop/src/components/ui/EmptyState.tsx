/**
 * EmptyState — placeholder for zero-data panes.
 *
 * Renders an icon, title, optional description, and an action slot centered in
 * the available space. `compact` drops the vertical padding for small panes
 * such as a sidebar section or a popover body.
 */
import type { ReactNode } from 'react'
import { cn } from '@/lib/cn'

export interface EmptyStateProps {
  icon?: ReactNode
  /** Brand illustration (the fox) rendered instead of the icon tile. */
  mascot?: ReactNode
  title: ReactNode
  description?: ReactNode
  /** Primary call to action — usually a `<Button>`. */
  action?: ReactNode
  compact?: boolean
  className?: string
}

export function EmptyState({
  icon,
  mascot,
  title,
  description,
  action,
  compact = false,
  className,
}: EmptyStateProps) {
  return (
    <div
      className={cn(
        'flex h-full w-full flex-col items-center justify-center text-center',
        compact ? 'gap-1.5 px-3 py-4' : 'gap-2.5 px-6 py-10',
        className,
      )}
    >
      {mascot != null ? (
        <div className="relative mb-0.5 grid place-items-center">
          <span
            className="pointer-events-none absolute size-24 rounded-full bg-fox-glow blur-2xl"
            aria-hidden="true"
          />
          <div className="relative animate-rise">{mascot}</div>
        </div>
      ) : icon != null ? (
        <div
          aria-hidden="true"
          className={cn(
            'inline-flex items-center justify-center rounded-lg border border-line bg-surface-2 text-fg-subtle',
            compact ? 'h-8 w-8' : 'h-11 w-11',
          )}
        >
          {icon}
        </div>
      ) : null}
      <div className="flex flex-col gap-0.5">
        <div className={cn('font-medium text-fg', compact ? 'text-[12px]' : 'text-[14px]')}>
          {title}
        </div>
        {description != null && (
          <div
            className={cn(
              'mx-auto max-w-[400px] text-fg-subtle',
              compact ? 'text-2xs' : 'text-[12px] leading-relaxed',
            )}
          >
            {description}
          </div>
        )}
      </div>
      {action != null && <div className="mt-1 flex items-center gap-2">{action}</div>}
    </div>
  )
}
