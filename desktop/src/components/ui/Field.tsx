/**
 * Field primitives — `FieldLabel`, `TextInput`, and `TextArea`.
 *
 * `TextInput` renders an optional leading icon, an optional trailing icon or
 * clear button, and pipes the `size`/`invalid`/`mono` presentation flags into
 * a dense (24/28/32px) control. `TextArea` grows with its content via
 * `field-sizing: content` (already enabled globally) and falls back to a
 * `rows`-based height with a scroll cap when the browser lacks support.
 */
import {
  forwardRef,
  useCallback,
  useLayoutEffect,
  useRef,
  type InputHTMLAttributes,
  type ReactNode,
  type TextareaHTMLAttributes,
} from 'react'
import { X } from 'lucide-react'
import { cn } from '@/lib/cn'

export type FieldSize = 'xs' | 'sm' | 'md'

/* ------------------------------------------------------------------ *
 * FieldLabel
 * ------------------------------------------------------------------ */

export interface FieldLabelProps {
  children: ReactNode
  /** Short helper text rendered to the right of the label. */
  hint?: ReactNode
  /** Marks the field as required with an accent asterisk. */
  required?: boolean
  htmlFor?: string
  className?: string
}

export function FieldLabel({
  children,
  hint,
  required = false,
  htmlFor,
  className,
}: FieldLabelProps) {
  return (
    <div className={cn('flex items-baseline justify-between gap-2 pb-1', className)}>
      <label
        htmlFor={htmlFor}
        className="text-2xs font-medium uppercase tracking-wide text-fg-subtle"
      >
        {children}
        {required && (
          <span className="ml-0.5 text-accent" aria-hidden="true">
            *
          </span>
        )}
      </label>
      {hint != null && <span className="text-2xs text-fg-subtle">{hint}</span>}
    </div>
  )
}

/* ------------------------------------------------------------------ *
 * TextInput
 * ------------------------------------------------------------------ */

export interface TextInputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'size'> {
  size?: FieldSize
  iconLeft?: ReactNode
  iconRight?: ReactNode
  /** Marks the control with a danger border and `aria-invalid`. */
  invalid?: boolean
  /** Render the value in the monospace face. */
  mono?: boolean
  /**
   * When provided, a clear button appears while the field has a value; it calls
   * this handler instead of mutating state directly.
   */
  onClear?: () => void
  /** Classes for the outer wrapper (the input itself takes `className`). */
  wrapperClassName?: string
}

const INPUT_SIZE: Record<FieldSize, string> = {
  xs: 'h-6 text-[12px]',
  sm: 'h-7 text-[12px]',
  md: 'h-8 text-[13px]',
}

const ICON_BOX: Record<FieldSize, string> = {
  xs: 'w-6',
  sm: 'w-7',
  md: 'w-8',
}

const ICON_SIZE: Record<FieldSize, number> = { xs: 12, sm: 13, md: 14 }

export const TextInput = forwardRef<HTMLInputElement, TextInputProps>(function TextInput(
  {
    size = 'sm',
    iconLeft,
    iconRight,
    invalid = false,
    mono = false,
    onClear,
    className,
    wrapperClassName,
    disabled,
    value,
    ...rest
  },
  ref,
) {
  const hasValue =
    value != null && String(value).length > 0
  const showClear = onClear != null && hasValue && !disabled

  return (
    <div
      className={cn(
        'group relative inline-flex w-full items-center rounded-md border bg-surface-2',
        'transition-colors duration-150',
        invalid
          ? 'border-danger/60 focus-within:border-danger'
          : 'border-line focus-within:border-accent/60',
        disabled && 'pointer-events-none opacity-45',
        INPUT_SIZE[size],
        wrapperClassName,
      )}
    >
      {iconLeft != null && (
        <span
          aria-hidden="true"
          className={cn(
            'pointer-events-none inline-flex shrink-0 items-center justify-center text-fg-subtle',
            ICON_BOX[size],
          )}
        >
          {iconLeft}
        </span>
      )}
      <input
        ref={ref}
        value={value}
        disabled={disabled}
        aria-invalid={invalid || undefined}
        className={cn(
          'h-full min-w-0 flex-1 bg-transparent px-2 outline-none',
          'placeholder:text-fg-subtle',
          'focus-visible:outline-none',
          mono && 'font-mono',
          iconLeft != null && 'pl-0.5',
          (iconRight != null || showClear) && 'pr-0.5',
          className,
        )}
        {...rest}
      />
      {showClear ? (
        <button
          type="button"
          aria-label="Clear"
          tabIndex={-1}
          onClick={onClear}
          className={cn(
            'inline-flex shrink-0 items-center justify-center text-fg-subtle',
            'hover:text-fg transition-colors',
            ICON_BOX[size],
          )}
        >
          <X size={ICON_SIZE[size]} aria-hidden="true" />
        </button>
      ) : (
        iconRight != null && (
          <span
            aria-hidden="true"
            className={cn(
              'pointer-events-none inline-flex shrink-0 items-center justify-center text-fg-subtle',
              ICON_BOX[size],
            )}
          >
            {iconRight}
          </span>
        )
      )}
    </div>
  )
})

/* ------------------------------------------------------------------ *
 * TextArea
 * ------------------------------------------------------------------ */

export interface TextAreaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  /** Minimum visible rows; also the fallback height when `field-sizing` is unsupported. */
  minRows?: number
  /** Beyond this many rows the textarea scrolls instead of growing. */
  maxRows?: number
  invalid?: boolean
  mono?: boolean
  /** Classes for the outer wrapper (the textarea itself takes `className`). */
  wrapperClassName?: string
}

const LINE_HEIGHT = 20
const TEXTAREA_PAD = 12

export const TextArea = forwardRef<HTMLTextAreaElement, TextAreaProps>(function TextArea(
  {
    minRows = 3,
    maxRows = 12,
    invalid = false,
    mono = false,
    className,
    wrapperClassName,
    disabled,
    rows,
    onInput,
    ...rest
  },
  ref,
) {
  const innerRef = useRef<HTMLTextAreaElement | null>(null)

  const setRefs = useCallback(
    (node: HTMLTextAreaElement | null) => {
      innerRef.current = node
      if (typeof ref === 'function') ref(node)
      else if (ref) ref.current = node
    },
    [ref],
  )

  /**
   * Probed once per render (a cheap `CSS.supports` call). When the engine
   * understands `field-sizing: content` the textarea grows natively and the
   * inline height is left alone; otherwise we mirror `scrollHeight` on every
   * commit so typed input and programmatic value changes stay in sync.
   */
  const supportsFieldSizing =
    typeof CSS !== 'undefined' && typeof CSS.supports === 'function'
      ? CSS.supports('field-sizing', 'content')
      : false

  /** Fallback auto-grow for engines without `field-sizing: content`. */
  useLayoutEffect(() => {
    const node = innerRef.current
    if (!node || supportsFieldSizing) return
    node.style.height = 'auto'
    const max = maxRows * LINE_HEIGHT + TEXTAREA_PAD
    const next = Math.min(node.scrollHeight, max)
    node.style.height = `${next}px`
    node.style.overflowY = node.scrollHeight > max ? 'auto' : 'hidden'
  })

  return (
    <div
      className={cn(
        'relative flex w-full rounded-md border bg-surface-2 transition-colors duration-150',
        invalid
          ? 'border-danger/60 focus-within:border-danger'
          : 'border-line focus-within:border-accent/60',
        disabled && 'pointer-events-none opacity-45',
        wrapperClassName,
      )}
    >
      <textarea
        ref={setRefs}
        rows={rows ?? minRows}
        disabled={disabled}
        aria-invalid={invalid || undefined}
        onInput={onInput}
        className={cn(
          'min-h-0 w-full resize-none bg-transparent px-2 py-1.5 text-[12.5px] leading-5 outline-none',
          'placeholder:text-fg-subtle scroll-quiet',
          'focus-visible:outline-none',
          mono && 'font-mono',
          className,
        )}
        style={{ maxHeight: maxRows * LINE_HEIGHT + TEXTAREA_PAD }}
        {...rest}
      />
    </div>
  )
})
