/**
 * SegmentedControl — generic single-select switcher with a sliding highlight.
 *
 * Roving focus is enabled with `aria-pressed` buttons plus Arrow/Home/End
 * keyboard navigation. The highlight is a separate absolutely positioned layer
 * translated by percentage, so it animates without re-layout.
 */
import { useCallback, useRef, type ReactNode } from 'react'
import { cn } from '@/lib/cn'

export type SegmentedSize = 'xs' | 'sm' | 'md'

export interface SegmentedOption<T extends string> {
  value: T
  label: ReactNode
  icon?: ReactNode
  /** Native tooltip / accessible description for the segment. */
  hint?: string
}

export interface SegmentedControlProps<T extends string> {
  value: T
  options: ReadonlyArray<SegmentedOption<T>>
  onChange: (value: T) => void
  size?: SegmentedSize
  /** Stretch segments to fill the container width. */
  block?: boolean
  className?: string
  'aria-label'?: string
}

const SIZE: Record<SegmentedSize, string> = {
  xs: 'h-6 text-[11px]',
  sm: 'h-7 text-[12px]',
  md: 'h-8 text-[13px]',
}

const PAD: Record<SegmentedSize, string> = {
  xs: 'px-1.5',
  sm: 'px-2.5',
  md: 'px-3',
}

export function SegmentedControl<T extends string>({
  value,
  options,
  onChange,
  size = 'sm',
  block = false,
  className,
  'aria-label': ariaLabel,
}: SegmentedControlProps<T>) {
  const listRef = useRef<HTMLDivElement>(null)
  const count = options.length
  const activeIndex = Math.max(
    0,
    options.findIndex((option) => option.value === value),
  )

  /**
   * Move the roving focus AND commit the value, matching the radio-group
   * keyboard pattern: arrows both preview and apply the next segment.
   */
  const selectIndex = useCallback(
    (index: number) => {
      const wrapped = (index + count) % count
      const target = options[wrapped]
      if (!target) return
      const node = listRef.current?.querySelector<HTMLButtonElement>(
        `[data-segmented-value="${CSS.escape(target.value)}"]`,
      )
      node?.focus()
      if (target.value !== value) onChange(target.value)
    },
    [count, onChange, options, value],
  )

  const onKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      if (count === 0) return
      switch (event.key) {
        case 'ArrowRight':
        case 'ArrowDown':
          event.preventDefault()
          selectIndex(activeIndex + 1)
          break
        case 'ArrowLeft':
        case 'ArrowUp':
          event.preventDefault()
          selectIndex(activeIndex - 1)
          break
        case 'Home':
          event.preventDefault()
          selectIndex(0)
          break
        case 'End':
          event.preventDefault()
          selectIndex(count - 1)
          break
        default:
          break
      }
    },
    [activeIndex, count, selectIndex],
  )

  return (
    <div
      ref={listRef}
      role="group"
      aria-label={ariaLabel}
      onKeyDown={onKeyDown}
      className={cn(
        'relative inline-flex select-none items-center rounded-md border border-line bg-surface-2 p-0.5',
        block ? 'w-full' : 'w-auto',
        SIZE[size],
        className,
      )}
    >
      <span
        aria-hidden="true"
        className="pointer-events-none absolute top-0.5 bottom-0.5 left-0.5 rounded-sm bg-surface-3 shadow-card transition-transform duration-200 ease-out"
        style={{
          width: `calc((100% - 4px) / ${Math.max(count, 1)})`,
          transform: `translateX(${activeIndex * 100}%)`,
          opacity: count > 0 ? 1 : 0,
        }}
      />
      {options.map((option) => {
        const selected = option.value === value
        return (
          <button
            key={option.value}
            type="button"
            role="button"
            data-segmented-value={option.value}
            aria-pressed={selected}
            title={option.hint}
            tabIndex={selected ? 0 : -1}
            onClick={() => {
              if (option.value !== value) onChange(option.value)
            }}
            className={cn(
              'relative z-10 inline-flex items-center justify-center gap-1.5 rounded-sm font-medium',
              'transition-colors duration-150',
              block ? 'flex-1' : 'flex-none',
              PAD[size],
              selected ? 'text-fg' : 'text-fg-muted hover:text-fg',
            )}
          >
            {option.icon != null && (
              <span className="inline-flex shrink-0 items-center" aria-hidden="true">
                {option.icon}
              </span>
            )}
            <span className="truncate">{option.label}</span>
          </button>
        )
      })}
    </div>
  )
}
