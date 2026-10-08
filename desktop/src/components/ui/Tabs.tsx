/**
 * Tabs — controlled tab strip with optional counts and icons.
 *
 * `variant="line"` draws an underline indicator for pane headers;
 * `variant="pill"` renders a filled segment for floating toolbars. The tab
 * buttons follow the WAI-ARIA tabs pattern (roving `tabIndex`, Arrow keys,
 * Home/End) and announce themselves with `aria-pressed` for simple strips.
 */
import type { ReactNode } from 'react'
import { cn } from '@/lib/cn'

export type TabSize = 'sm' | 'md'
export type TabVariant = 'line' | 'pill'

export interface TabItem {
  value: string
  label: ReactNode
  /** Optional trailing counter, hidden when `undefined`. */
  count?: number
  icon?: ReactNode
  /** Native tooltip / accessible description. */
  hint?: string
}

export interface TabsProps {
  value: string
  onChange: (value: string) => void
  items: ReadonlyArray<TabItem>
  size?: TabSize
  variant?: TabVariant
  /** Stretch tabs to share the container width. */
  block?: boolean
  className?: string
  'aria-label'?: string
}

const SIZE: Record<TabSize, string> = {
  sm: 'h-7 text-[12px] px-2.5 gap-1.5',
  md: 'h-8 text-[13px] px-3 gap-2',
}

export function Tabs({
  value,
  onChange,
  items,
  size = 'sm',
  variant = 'line',
  block = false,
  className,
  'aria-label': ariaLabel,
}: TabsProps) {
  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (items.length === 0) return
    const index = items.findIndex((item) => item.value === value)
    const current = index < 0 ? 0 : index
    let next = current
    switch (event.key) {
      case 'ArrowRight':
      case 'ArrowDown':
        next = (current + 1) % items.length
        break
      case 'ArrowLeft':
      case 'ArrowUp':
        next = (current - 1 + items.length) % items.length
        break
      case 'Home':
        next = 0
        break
      case 'End':
        next = items.length - 1
        break
      default:
        return
    }
    event.preventDefault()
    const target = items[next]
    if (target && target.value !== value) onChange(target.value)
  }

  return (
    <div
      role="tablist"
      aria-label={ariaLabel}
      onKeyDown={onKeyDown}
      className={cn(
        'flex min-w-0 items-center',
        variant === 'line' ? 'gap-0.5 border-b border-line' : 'gap-1',
        block && 'w-full',
        className,
      )}
    >
      {items.map((item) => {
        const selected = item.value === value
        return (
          <button
            key={item.value}
            type="button"
            role="tab"
            aria-selected={selected}
            aria-pressed={selected}
            title={item.hint}
            tabIndex={selected ? 0 : -1}
            onClick={() => {
              if (!selected) onChange(item.value)
            }}
            className={cn(
              'relative inline-flex select-none items-center justify-center whitespace-nowrap font-medium',
              'transition-colors duration-150',
              block && 'flex-1',
              SIZE[size],
              variant === 'line'
                ? cn(
                    '-mb-px border-b-2',
                    selected
                      ? 'border-accent text-fg'
                      : 'border-transparent text-fg-muted hover:text-fg',
                  )
                : cn(
                    'rounded-md border',
                    selected
                      ? 'border-line bg-surface-3 text-fg shadow-card'
                      : 'border-transparent text-fg-muted hover:bg-surface-2 hover:text-fg',
                  ),
            )}
          >
            {item.icon != null && (
              <span className="inline-flex shrink-0 items-center" aria-hidden="true">
                {item.icon}
              </span>
            )}
            <span className="truncate">{item.label}</span>
            {item.count != null && (
              <span
                className={cn(
                  'inline-flex h-[16px] min-w-[16px] items-center justify-center rounded-full px-1 font-mono text-2xs tabular-nums',
                  selected ? 'bg-accent-soft text-accent' : 'bg-surface-3 text-fg-subtle',
                )}
              >
                {item.count}
              </span>
            )}
          </button>
        )
      })}
    </div>
  )
}
