/**
 * Dialog / ConfirmDialog — modal surfaces rendered through a portal.
 *
 * The panel is appended to `document.body`, so it escapes every stacking and
 * `overflow` context. While open it traps Tab focus, restores focus to the
 * previously active element on close, closes on Escape, locks body scroll, and
 * optionally closes on backdrop click (`closeOnBackdrop`). Portalling only
 * happens after mount, keeping the module import-safe without a DOM.
 */
import { useCallback, useEffect, useId, useRef, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { AlertTriangle, X } from 'lucide-react'
import { cn } from '@/lib/cn'
import { Button } from './Button'

export type DialogSize = 'sm' | 'md' | 'lg' | 'xl'

export interface DialogProps {
  open: boolean
  onClose: () => void
  title: ReactNode
  description?: ReactNode
  size?: DialogSize
  footer?: ReactNode
  children?: ReactNode
  /** Close when the backdrop is clicked. Defaults to true. */
  closeOnBackdrop?: boolean
  /** Close when Escape is pressed. Defaults to true. */
  closeOnEscape?: boolean
  /** Hide the header close button. */
  hideCloseButton?: boolean
  className?: string
}

const SIZE: Record<DialogSize, string> = {
  sm: 'w-[min(380px,92vw)]',
  md: 'w-[min(560px,92vw)]',
  lg: 'w-[min(760px,94vw)]',
  xl: 'w-[min(1040px,96vw)]',
}

const FOCUSABLE =
  'a[href],button:not([disabled]),textarea:not([disabled]),input:not([disabled]),select:not([disabled]),[tabindex]:not([tabindex="-1"])'

export function Dialog({
  open,
  onClose,
  title,
  description,
  size = 'md',
  footer,
  children,
  closeOnBackdrop = true,
  closeOnEscape = true,
  hideCloseButton = false,
  className,
}: DialogProps) {
  const panelRef = useRef<HTMLDivElement>(null)
  const restoreRef = useRef<HTMLElement | null>(null)
  const titleId = useId()
  const descId = useId()

  // Remember the previously focused element and enter the panel on open.
  useEffect(() => {
    if (!open) return
    restoreRef.current =
      typeof document !== 'undefined' && document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null
    const timer = window.setTimeout(() => {
      const panel = panelRef.current
      if (!panel) return
      const first = panel.querySelector<HTMLElement>(FOCUSABLE)
      ;(first ?? panel).focus()
    }, 0)
    return () => {
      window.clearTimeout(timer)
      restoreRef.current?.focus?.()
      restoreRef.current = null
    }
  }, [open])

  // Body scroll lock (only one dialog needs to win; the flag is reference-free).
  useEffect(() => {
    if (!open) return
    const previous = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = previous
    }
  }, [open])

  const onKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      if (event.key === 'Escape' && closeOnEscape) {
        event.stopPropagation()
        onClose()
        return
      }
      if (event.key !== 'Tab') return
      const panel = panelRef.current
      if (!panel) return
      const nodes = Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
        (node) => node.offsetParent !== null || node === document.activeElement,
      )
      if (nodes.length === 0) {
        event.preventDefault()
        panel.focus()
        return
      }
      const first = nodes[0]
      const last = nodes[nodes.length - 1]
      const active = document.activeElement
      if (event.shiftKey && (active === first || active === panel)) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && active === last) {
        event.preventDefault()
        first.focus()
      }
    },
    [closeOnEscape, onClose],
  )

  if (!open || typeof document === 'undefined') return null

  return createPortal(
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center p-6"
      onKeyDown={onKeyDown}
    >
      <div
        aria-hidden="true"
        onClick={closeOnBackdrop ? onClose : undefined}
        className={cn(
          'absolute inset-0 animate-fade bg-black/45 backdrop-blur-[3px]',
          closeOnBackdrop && 'cursor-pointer',
        )}
      />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description != null ? descId : undefined}
        tabIndex={-1}
        className={cn(
          'relative z-10 flex max-h-[88vh] animate-fade flex-col gap-5 overflow-hidden rounded-panel pb-6',
          'bg-overlay shadow-[0_0_0_0.5px_var(--color-line-strong),0_4px_12px_-4px_rgb(0_0_0/0.4),0_24px_60px_-24px_rgb(0_0_0/0.75)]',
          'focus-visible:outline-none',
          SIZE[size],
          className,
        )}
      >
        <header className="drag-region flex items-center gap-2 pt-[22px] pr-3.5 pb-3 pl-6">
          <div className="min-w-0 flex-1">
            <h2 id={titleId} className="truncate text-[16px] leading-6 font-medium text-fg">
              {title}
            </h2>
            {description != null && (
              <p id={descId} className="mt-1 text-[14px] leading-[22px] text-fg-muted">
                {description}
              </p>
            )}
          </div>
          {!hideCloseButton && (
            <button
              type="button"
              aria-label="关闭对话框"
              title="关闭 (Esc)"
              onClick={onClose}
              className={cn(
                'no-drag inline-flex size-7 shrink-0 items-center justify-center',
                'rounded-sm text-fg-muted transition-colors hover:bg-interactive hover:text-fg',
              )}
            >
              <X size={14} aria-hidden="true" />
            </button>
          )}
        </header>

        <div className="scroll-quiet min-h-0 flex-1 overflow-y-auto px-6 text-[14px] leading-[22px] text-fg">
          {children}
        </div>

        {footer != null && (
          <footer className="flex items-center justify-end gap-2 px-6">{footer}</footer>
        )}
      </div>
    </div>,
    document.body,
  )
}

/* ------------------------------------------------------------------ *
 * ConfirmDialog
 * ------------------------------------------------------------------ */

export interface ConfirmDialogProps {
  open: boolean
  title: ReactNode
  description?: ReactNode
  confirmLabel?: string
  cancelLabel?: string
  tone?: 'danger' | 'primary'
  onConfirm: () => void
  onCancel: () => void
  /** Rendered between the description and the action row. */
  children?: ReactNode
}

export function ConfirmDialog({
  open,
  title,
  description,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  tone = 'primary',
  onConfirm,
  onCancel,
  children,
}: ConfirmDialogProps) {
  return (
    <Dialog
      open={open}
      onClose={onCancel}
      title={
        <span className="flex items-center gap-2">
          {tone === 'danger' && (
            <AlertTriangle size={14} aria-hidden="true" className="shrink-0 text-danger" />
          )}
          {title}
        </span>
      }
      description={description}
      size="sm"
      footer={
        <>
          <Button size="sm" variant="ghost" onClick={onCancel}>
            {cancelLabel}
          </Button>
          <Button
            size="sm"
            variant={tone === 'danger' ? 'danger' : 'primary'}
            onClick={onConfirm}
          >
            {confirmLabel}
          </Button>
        </>
      }
    >
      {children}
    </Dialog>
  )
}
