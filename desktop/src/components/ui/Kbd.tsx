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

export interface KbdComboProps {
  /** Chord members in order, e.g. `['mod', 'shift', 'K']`. */
  keys: string[]
  platform?: KbdPlatform
  size?: KbdSize
  className?: string
  /** Hide the `+` separators and let caps sit flush. */
  compact?: boolean
}

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

const ALIASES: Record<string, string> = {
  escape: 'Esc',
  esc: 'Esc',
  arrowup: '↑',
  arrowdown: '↓',
  arrowleft: '←',
  arrowright: '→',
  enter: '⏎',
  return: '⏎',
  backspace: '⌫',
  delete: 'Del',
  tab: 'Tab',
  space: 'Space',
  up: '↑',
  down: '↓',
  left: '←',
  right: '→',
}

export function KbdCombo({
  keys,
  platform,
  size = 'xs',
  className,
  compact = false,
}: KbdComboProps) {
  const resolved =
    platform ?? detectPlatform()
  const isMac = resolved === 'mac'

  return (
    <span className={cn('inline-flex items-center gap-1', compact && 'gap-0.5', className)}>
      {keys.map((raw, index) => {
        const lower = raw.toLowerCase()
        let text = raw
        if (lower === 'mod' || lower === 'cmd' || lower === 'meta' || lower === 'ctrl') {
          text = isMac ? '⌘' : 'Ctrl'
        } else if (lower === 'alt' || lower === 'option' || lower === 'opt') {
          text = isMac ? '⌥' : 'Alt'
        } else if (lower === 'shift') {
          text = isMac ? '⇧' : 'Shift'
        } else if (lower in ALIASES) {
          text = ALIASES[lower] ?? raw
        }
        return (
          <span key={`${raw}-${index}`} className="inline-flex items-center gap-1">
            {index > 0 && !compact && (
              <span className="text-2xs text-fg-subtle" aria-hidden="true">
                +
              </span>
            )}
            <Kbd size={size}>{text}</Kbd>
          </span>
        )
      })}
    </span>
  )
}
