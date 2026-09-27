/**
 * Select — dependency-free custom dropdown.
 *
 * The popup is absolutely positioned inside a `relative` wrapper (no portal), so
 * it can be clipped by an `overflow: hidden` ancestor; keep selects out of
 * scroll-clipped headers or render them inside the scrolling pane. Supports
 * grouped options, an inline type-to-filter box once the list exceeds
 * `filterThreshold` items, Up/Down/Home/End/Enter/Escape keys, outside-click
 * dismissal, and a `Check` marker on the selected row.
 */
import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from 'react'
import { Check, ChevronDown, Search } from 'lucide-react'
import { cn } from '@/lib/cn'

export type SelectSize = 'xs' | 'sm' | 'md'

export interface SelectOption<T extends string> {
  value: T
  label: string
  /** Secondary text shown right-aligned in the popup row. */
  hint?: string
  icon?: ReactNode
  /** Options sharing a group name are rendered under a common heading. */
  group?: string
}

export interface SelectProps<T extends string> {
  value: T | null
  options: ReadonlyArray<SelectOption<T>>
  onChange: (value: T) => void
  placeholder?: string
  size?: SelectSize
  align?: 'start' | 'end'
  /** Replaces the trigger label entirely. */
  renderValue?: (option: SelectOption<T> | null) => ReactNode
  /** Show the filter box when the option count exceeds this. Defaults to 8. */
  filterThreshold?: number
  disabled?: boolean
  className?: string
  /** Extra classes for the popup panel. */
  popupClassName?: string
  'aria-label'?: string
}

const TRIGGER_SIZE: Record<SelectSize, string> = {
  xs: 'h-6 text-[12px] rounded-sm',
  sm: 'h-7 text-[12px] rounded-md',
  md: 'h-8 text-[13px] rounded-md',
}

const ICON_SIZE: Record<SelectSize, number> = { xs: 11, sm: 12, md: 13 }

export function Select<T extends string>({
  value,
  options,
  onChange,
  placeholder = 'Select…',
  size = 'sm',
  align = 'start',
  renderValue,
  filterThreshold = 8,
  disabled = false,
  className,
  popupClassName,
  'aria-label': ariaLabel,
}: SelectProps<T>) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [highlight, setHighlight] = useState(0)
  const rootRef = useRef<HTMLDivElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const filterRef = useRef<HTMLInputElement>(null)
  const listId = useId()

  const selected = useMemo(
    () => options.find((option) => option.value === value) ?? null,
    [options, value],
  )

  const filterable = options.length > filterThreshold

  const filtered = useMemo(() => {
    if (!filterable || query.trim() === '') return options
    const needle = query.trim().toLowerCase()
    return options.filter(
      (option) =>
        option.label.toLowerCase().includes(needle) ||
        option.value.toLowerCase().includes(needle) ||
        (option.group ?? '').toLowerCase().includes(needle),
    )
  }, [filterable, options, query])

  const grouped = useMemo(() => {
    const buckets: Array<{ group: string | null; items: SelectOption<T>[] }> = []
    for (const option of filtered) {
      const name = option.group ?? null
      const last = buckets[buckets.length - 1]
      if (last && last.group === name) last.items.push(option)
      else buckets.push({ group: name, items: [option] })
    }
    return buckets
  }, [filtered])

  const close = useCallback(() => {
    setOpen(false)
    setQuery('')
  }, [])

  const openMenu = useCallback(() => {
    if (disabled) return
    setOpen(true)
    setQuery('')
    const index = options.findIndex((option) => option.value === value)
    setHighlight(index >= 0 ? index : 0)
  }, [disabled, options, value])

  // Outside click dismissal.
  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: globalThis.PointerEvent) => {
      const root = rootRef.current
      if (root && event.target instanceof Node && !root.contains(event.target)) close()
    }
    document.addEventListener('pointerdown', onPointerDown, true)
    return () => document.removeEventListener('pointerdown', onPointerDown, true)
  }, [close, open])

  // Focus the filter box as soon as the popup opens.
  useEffect(() => {
    if (open && filterable) filterRef.current?.focus()
  }, [filterable, open])

  // Keep the highlighted row inside the scroll viewport.
  useEffect(() => {
    if (!open) return
    const node = listRef.current?.querySelector<HTMLElement>('[data-active="true"]')
    node?.scrollIntoView({ block: 'nearest' })
  }, [highlight, open, filtered])

  const commit = useCallback(
    (option: SelectOption<T>) => {
      onChange(option.value)
      close()
    },
    [close, onChange],
  )

  const onTriggerKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (disabled) return
    if (!open && (event.key === 'ArrowDown' || event.key === 'Enter' || event.key === ' ')) {
      event.preventDefault()
      openMenu()
      return
    }
    if (!open) return
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault()
        setHighlight((index) => Math.min(index + 1, Math.max(filtered.length - 1, 0)))
        break
      case 'ArrowUp':
        event.preventDefault()
        setHighlight((index) => Math.max(index - 1, 0))
        break
      case 'Home':
        event.preventDefault()
        setHighlight(0)
        break
      case 'End':
        event.preventDefault()
        setHighlight(Math.max(filtered.length - 1, 0))
        break
      case 'Enter': {
        event.preventDefault()
        const option = filtered[highlight]
        if (option) commit(option)
        break
      }
      case 'Escape':
        event.preventDefault()
        close()
        break
      case 'Tab':
        close()
        break
      default:
        break
    }
  }

  const triggerLabel = renderValue ? (
    renderValue(selected)
  ) : selected ? (
    <span className="flex min-w-0 items-center gap-1.5">
      {selected.icon != null && (
        <span className="inline-flex shrink-0 items-center text-fg-muted" aria-hidden="true">
          {selected.icon}
        </span>
      )}
      <span className="truncate">{selected.label}</span>
    </span>
  ) : (
    <span className="truncate text-fg-subtle">{placeholder}</span>
  )

  return (
    <div ref={rootRef} className={cn('relative inline-flex w-full', className)}>
      <button
        type="button"
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-label={ariaLabel}
        onClick={() => (open ? close() : openMenu())}
        onKeyDown={onTriggerKeyDown}
        className={cn(
          'inline-flex w-full select-none items-center justify-between gap-2 border bg-surface-2 px-2',
          'text-left text-fg transition-colors duration-150',
          open ? 'border-accent/60' : 'border-line hover:border-line-strong',
          'disabled:pointer-events-none disabled:opacity-45',
          TRIGGER_SIZE[size],
        )}
      >
        <span className="flex min-w-0 flex-1 items-center">{triggerLabel}</span>
        <ChevronDown
          aria-hidden="true"
          size={ICON_SIZE[size]}
          className={cn(
            'shrink-0 text-fg-subtle transition-transform duration-200',
            open && 'rotate-180',
          )}
        />
      </button>

      {open && (
        <div
          className={cn(
            'absolute top-full z-50 mt-1 min-w-full animate-rise overflow-hidden rounded-md',
            'border border-line bg-overlay shadow-pop',
            align === 'end' ? 'right-0' : 'left-0',
            popupClassName,
          )}
        >
          {filterable && (
            <div className="flex items-center gap-1.5 border-b border-line px-2 py-1.5">
              <Search size={12} aria-hidden="true" className="shrink-0 text-fg-subtle" />
              <input
                ref={filterRef}
                value={query}
                onChange={(event) => {
                  setQuery(event.target.value)
                  setHighlight(0)
                }}
                onKeyDown={(event) => {
                  // Inline filter owns Enter so a typed query can be committed
                  // without arrowing into the (filtered) list first.
                  if (event.key !== 'Enter') return
                  const option = filtered[highlight]
                  if (!option) return
                  event.preventDefault()
                  event.stopPropagation()
                  commit(option)
                }}
                placeholder="Filter…"
                aria-label="Filter options"
                className="min-w-0 flex-1 bg-transparent text-[12px] outline-none placeholder:text-fg-subtle focus-visible:outline-none"
              />
            </div>
          )}

          <div
            ref={listRef}
            id={listId}
            role="listbox"
            aria-label={ariaLabel}
            tabIndex={-1}
            className="scroll-quiet max-h-[280px] overflow-y-auto p-1"
          >
            {filtered.length === 0 && (
              <div className="px-2 py-3 text-center text-[12px] text-fg-subtle">No matches</div>
            )}
            {grouped.map((bucket, bucketIndex) => (
              <div key={bucket.group ?? `__ungrouped-${bucketIndex}`}>
                {bucket.group != null && (
                  <div className="px-2 pt-2 pb-1 text-2xs uppercase tracking-wide text-fg-subtle">
                    {bucket.group}
                  </div>
                )}
                {bucket.items.map((option) => {
                  const flatIndex = filtered.indexOf(option)
                  const isSelected = option.value === value
                  const isActive = flatIndex === highlight
                  return (
                    <div
                      key={option.value}
                      role="option"
                      aria-selected={isSelected}
                      data-active={isActive}
                      onPointerEnter={() => setHighlight(flatIndex)}
                      onClick={() => commit(option)}
                      className={cn(
                        'flex cursor-pointer select-none items-center gap-2 rounded-sm px-2 py-1 text-[12px]',
                        'transition-colors duration-100',
                        isActive ? 'bg-surface-3 text-fg' : 'text-fg-muted hover:bg-surface-2',
                      )}
                    >
                      <span className="inline-flex w-3.5 shrink-0 items-center justify-center text-accent">
                        {isSelected && <Check size={12} aria-hidden="true" />}
                      </span>
                      {option.icon != null && (
                        <span
                          className="inline-flex shrink-0 items-center text-fg-subtle"
                          aria-hidden="true"
                        >
                          {option.icon}
                        </span>
                      )}
                      <span className="min-w-0 flex-1 truncate">{option.label}</span>
                      {option.hint != null && (
                        <span className="shrink-0 text-2xs text-fg-subtle">{option.hint}</span>
                      )}
                    </div>
                  )
                })}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
