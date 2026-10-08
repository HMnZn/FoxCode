/** Notification state and timers, independent of the UI components. */
import type { ReactNode } from 'react'
import { create } from 'zustand'

export type ToastTone = 'info' | 'success' | 'warn' | 'danger'

export interface ToastAction {
  label: string
  run: () => void
}

export interface ToastInput {
  title: ReactNode
  description?: ReactNode
  tone?: ToastTone
  /** Auto-dismiss delay in ms; `0` keeps the toast until dismissed. Defaults to 4500. */
  duration?: number
  action?: ToastAction
}

export interface Toast extends ToastInput {
  id: string
}

/** Maximum number of concurrent toasts; pushing past it evicts the oldest. */
const MAX_VISIBLE = 4

interface ToastStore {
  toasts: Toast[]
  push: (input: ToastInput) => string
  dismiss: (id: string) => void
  clear: () => void
}

let toastId = 0
/** Pending auto-dismiss timers, keyed by toast id. */
const timers = new Map<string, ReturnType<typeof setTimeout>>()

function clearTimer(id: string): void {
  const handle = timers.get(id)
  if (handle != null) {
    clearTimeout(handle)
    timers.delete(id)
  }
}

export const useToasts = create<ToastStore>((set, get) => ({
  toasts: [],

  push: (input) => {
    toastId += 1
    const id = `toast_${Date.now().toString(36)}${toastId.toString(36)}`
    const toast: Toast = { ...input, id }

    set((state) => {
      const next = [...state.toasts, toast]
      while (next.length > MAX_VISIBLE) {
        const evicted = next.shift()
        if (evicted) clearTimer(evicted.id)
      }
      return { toasts: next }
    })

    const duration = input.duration ?? 4500
    if (duration > 0 && typeof window !== 'undefined') {
      clearTimer(id)
      timers.set(
        id,
        setTimeout(() => {
          timers.delete(id)
          get().dismiss(id)
        }, duration),
      )
    }

    return id
  },

  dismiss: (id) => {
    clearTimer(id)
    set((state) => ({ toasts: state.toasts.filter((toast) => toast.id !== id) }))
  },

  clear: () => {
    for (const id of timers.keys()) clearTimer(id)
    set({ toasts: [] })
  },
}))

/** Stop pending timers when the notification surface unmounts. */
export function clearToastTimers(): void {
  for (const id of timers.keys()) clearTimer(id)
}

/** Convenience wrappers so callers do not hand-write tone each time. */
export const toast = {
  info: (input: Omit<ToastInput, 'tone'>) => useToasts.getState().push({ ...input, tone: 'info' }),
  success: (input: Omit<ToastInput, 'tone'>) =>
    useToasts.getState().push({ ...input, tone: 'success' }),
  warn: (input: Omit<ToastInput, 'tone'>) => useToasts.getState().push({ ...input, tone: 'warn' }),
  danger: (input: Omit<ToastInput, 'tone'>) =>
    useToasts.getState().push({ ...input, tone: 'danger' }),
}
