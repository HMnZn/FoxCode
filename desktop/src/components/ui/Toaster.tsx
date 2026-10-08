/**
 * Toaster — global, zustand-backed notification stack.
 *
 * ```ts
 * useToasts.getState().push({ title: 'Saved', tone: 'success' })
 * ```
 *
 * Exactly one `<Toaster />` should be mounted near the app root. Toasts
 * auto-dismiss after `duration` (4500ms by default, `0` pins them), and the
 * store keeps at most four entries on screen. `push` returns the new
 * id so callers can `dismiss` it early.
 */
import { useEffect } from 'react'
import {
  AlertTriangle,
  CheckCircle2,
  Info,
  X,
  XCircle,
  type LucideIcon,
} from 'lucide-react'
import { cn } from '@/lib/cn'
import { Button } from './Button'
import { clearToastTimers, useToasts, type ToastTone } from '@/store/toastStore'

/* ------------------------------------------------------------------ *
 * Presentation
 * ------------------------------------------------------------------ */

interface ToneStyle {
  icon: LucideIcon
  border: string
  iconClass: string
}

const TONE: Record<ToastTone, ToneStyle> = {
  info: { icon: Info, border: 'border-l-info', iconClass: 'text-info' },
  success: { icon: CheckCircle2, border: 'border-l-success', iconClass: 'text-success' },
  warn: { icon: AlertTriangle, border: 'border-l-warn', iconClass: 'text-warn' },
  danger: { icon: XCircle, border: 'border-l-danger', iconClass: 'text-danger' },
}

export interface ToasterProps {
  className?: string
}

export function Toaster({ className }: ToasterProps) {
  const toasts = useToasts((state) => state.toasts)
  const dismiss = useToasts((state) => state.dismiss)

  // Drop any timers still pending when the stack unmounts.
  useEffect(
    () => () => {
      clearToastTimers()
    },
    [],
  )

  return (
    <div
      role="region"
      aria-label="Notifications"
      className={cn(
        // Anchored above the status bar at the bottom right: the top-right corner
        // belongs to the inspector tab strip, and toasts must not cover it.
        'pointer-events-none fixed right-3 bottom-10 z-[200] flex w-[320px] max-w-[calc(100vw-24px)] flex-col gap-2',
        className,
      )}
    >
      {toasts.map((item) => {
        const tone = TONE[item.tone ?? 'info']
        const Icon = tone.icon
        return (
          <div
            key={item.id}
            role="status"
            className={cn(
              'pointer-events-auto flex animate-slide-in items-start gap-2.5 rounded-lg border border-line border-l-2',
              'bg-overlay/95 px-3 py-2 backdrop-blur-[16px]',
              'shadow-[0_0_0_0.5px_var(--color-line),0_6px_20px_-6px_rgb(0_0_0/0.5)]',
              tone.border,
            )}
          >
            <Icon size={14} aria-hidden="true" className={cn('mt-0.5 shrink-0', tone.iconClass)} />
            <div className="flex min-w-0 flex-1 flex-col gap-0.5">
              <div className="truncate text-[12.5px] font-medium text-fg">{item.title}</div>
              {item.description != null && (
                <div className="text-[12px] leading-snug text-fg-muted">{item.description}</div>
              )}
              {item.action != null && (
                <div className="mt-1">
                  <Button
                    size="xs"
                    variant={item.tone === 'danger' || item.tone === 'warn' ? 'danger' : 'outline'}
                    onClick={() => {
                      item.action?.run()
                      dismiss(item.id)
                    }}
                  >
                    {item.action.label}
                  </Button>
                </div>
              )}
            </div>
            <button
              type="button"
              aria-label="Dismiss notification"
              onClick={() => dismiss(item.id)}
              className={cn(
                '-mt-0.5 -mr-1 inline-flex h-5 w-5 shrink-0 items-center justify-center',
                'rounded-sm text-fg-subtle transition-colors hover:bg-surface-2 hover:text-fg',
              )}
            >
              <X size={12} aria-hidden="true" />
            </button>
          </div>
        )
      })}
    </div>
  )
}
