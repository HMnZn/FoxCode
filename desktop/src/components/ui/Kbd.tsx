/**
 * Kbd / KbdCombo — keyboard-shortcut affordances.
 *
 * `Kbd` renders one physical key cap. `KbdCombo` joins a chord with `+`
 * separators and resolves the abstract `mod` token to `⌘` or `Ctrl` using a
 * platform guess that is safe in non-browser (SSR / test) environments.
 */
import type { ReactNode } from 'react'
import { cn } from '@/lib/cn'

export type KbdSize = 'xs' | 'sm'

export interface KbdProps {
  children: ReactNode
  size?: KbdSize
  className?: string
  /** Render the cap in a muted style, e.g. for rarely used chords. */
  muted?: boolean
}

const SIZE: Record<KbdSize, string> = {
  xs: 'h-[16px] min-w-[16px] px-1 text-2xs rounded-xs',
  sm: 'h-[20px] min-w-[20px] px-1.5 text-[11px] rounded-sm',
}

export function Kbd({ children, size = 'xs', className, muted = false }: KbdProps) {
  return (
    <kbd
      className={cn(
        'inline-flex select-none items-center justify-center border font-mono uppercase leading-none',
        SIZE[size],
        muted
          ? 'border-line/70 bg-transparent text-fg-subtle'
          : 'border-line bg-surface-2 text-fg-muted shadow-card',
        className,
      )}
    >
      {children}
    </kbd>
  )
}

export type KbdPlatform = 'mac' | 'win' | 'linux' | 'unknown'

/** Best-effort platform detection that never touches `navigator` during SSR. */
export function detectPlatform(): KbdPlatform {
  if (typeof navigator === 'undefined') return 'unknown'
  const probe =
    typeof navigator.userAgent === 'string'
      ? navigator.userAgent
      : typeof (navigator as { platform?: unknown }).platform === 'string'
        ? String((navigator as { platform?: unknown }).platform)
        : ''
  if (!probe) return 'unknown'
  if (/mac|iphone|ipad|ipod/i.test(probe)) return 'mac'
  if (/win/i.test(probe)) return 'win'
  if (/linux|x11|android/i.test(probe)) return 'linux'
  return 'unknown'
}
