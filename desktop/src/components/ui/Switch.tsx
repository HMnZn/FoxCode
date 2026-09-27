/**
 * Switch — accessible on/off toggle.
 *
 * Implemented as `role="switch"` on a real `<button>` so Space/Enter activation
 * comes for free. The track is 36×20px with a 16px knob (the DSH desktop
 * geometry); an optional label + hint row renders beside it for settings
 * surfaces.
 */
import { useId, type ReactNode } from 'react'
import { cn } from '@/lib/cn'

export interface SwitchProps {
  checked: boolean
  onChange: (checked: boolean) => void
  label?: ReactNode
  /** Secondary line shown under the label. */
  hint?: ReactNode
  disabled?: boolean
  className?: string
  /** Optional id override when wiring an external `<label htmlFor>`. */
  id?: string
}

export function Switch({
  checked,
  onChange,
  label,
  hint,
  disabled = false,
  className,
  id,
}: SwitchProps) {
  const autoId = useId()
  const switchId = id ?? `switch-${autoId}`

  const control = (
    <button
      id={switchId}
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cn(
        'relative inline-flex h-5 w-9 shrink-0 items-center rounded-full p-[2px]',
        'transition-colors duration-150 ease-[cubic-bezier(0.4,0,0.2,1)]',
        'disabled:cursor-not-allowed disabled:opacity-50',
        checked ? 'bg-accent' : 'bg-line-strong',
      )}
    >
      <span
        aria-hidden="true"
        className={cn(
          'pointer-events-none inline-block size-4 rounded-full bg-white shadow-[0_1px_2px_rgb(0_0_0/0.35)]',
          'transition-transform duration-[120ms] ease-[cubic-bezier(0.4,0,0.2,1)]',
          checked ? 'translate-x-4' : 'translate-x-0',
        )}
      />
    </button>
  )

  if (label == null && hint == null) {
    return <span className={cn('inline-flex', className)}>{control}</span>
  }

  return (
    <div className={cn('flex items-start gap-2.5', className)}>
      {control}
      <span className="flex min-w-0 flex-col leading-tight">
        {label != null && (
          <span
            className={cn(
              'cursor-pointer text-[12px] text-fg',
              disabled && 'cursor-not-allowed text-fg-subtle',
            )}
            onClick={() => {
              if (!disabled) onChange(!checked)
            }}
          >
            {label}
          </span>
        )}
        {hint != null && <span className="text-2xs text-fg-subtle">{hint}</span>}
      </span>
    </div>
  )
}
