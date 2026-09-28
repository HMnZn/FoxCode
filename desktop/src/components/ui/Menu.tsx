/**
 * Menu — trigger plus dropdown list, with compound item helpers.
 *
 * ```tsx
 * <Menu trigger={<>Actions <ChevronDown /></>}>
 *   <MenuLabel>Session</MenuLabel>
 *   <MenuItem label="Rename" shortcut="mod+R" onSelect={rename} />
 *   <MenuSeparator />
 *   <MenuItem label="Delete" tone="danger" onSelect={remove} />
 * </Menu>
 * ```
 *
 * The panel is portaled to `document.body` and positioned with `fixed` coordinates
 * measured from the trigger, so an `overflow: hidden` ancestor (a card, a table row,
 * the sidebar) cannot clip it. It flips to the other side of the trigger when the
 * preferred one has no room and is clamped to the viewport. Items are real
 * `role="menuitem"` divs driven by a roving tab index: Arrows/Home/End move the
 * highlight, Enter/Space activate, Escape, outside-click, or a selection closes.
 */
import {
  createContext,
  useContext,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import { createPortal } from 'react-dom'
import { cn } from '@/lib/cn'
import { detectPlatform } from './Kbd'

export type MenuAlign = 'start' | 'end'
export type MenuItemTone = 'default' | 'danger'

interface MenuContextValue {
  close: () => void
  /** Clears the keyboard highlight so hover feedback can take over. */
  clearHighlight: () => void
}

const MenuContext = createContext<MenuContextValue | null>(null)

function useMenuContext(component: string): MenuContextValue {
  const context = useContext(MenuContext)
  if (!context) throw new Error(`${component} must be rendered inside <Menu>`)
  return context
}

export interface MenuProps {
  /** Content of the trigger button. */
  trigger: ReactNode
  children: ReactNode
  align?: MenuAlign
  /** Which side of the trigger the panel opens on (default `bottom`). */
  placement?: 'top' | 'bottom'
  /** Accessible name for both the trigger and the menu list. */
  label?: string
  /** Classes applied to the trigger button. */
  triggerClassName?: string
  /** Classes applied to the popup panel. */
  className?: string
  disabled?: boolean
}

export function Menu({
  trigger,
  children,
  align = 'start',
  placement = 'bottom',
  label = 'Menu',
  triggerClassName,
  className,
  disabled = false,
}: MenuProps) {
  const [open, setOpen] = useState(false)
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)

  const close = useCallback(() => {
    setOpen(false)
  }, [])

  const clearHighlight = useCallback(() => {
    /* Keyboard focus already lives on the item; nothing to reset. */
  }, [])

  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: globalThis.PointerEvent) => {
      const target = event.target
      if (!(target instanceof Node)) return
      // 面板走了 portal，所以它是「外面」的 DOM 但仍然是「里面」的菜单。
      if (rootRef.current?.contains(target)) return
      if (panelRef.current?.contains(target)) return
      close()
    }
    document.addEventListener('pointerdown', onPointerDown, true)
    return () => document.removeEventListener('pointerdown', onPointerDown, true)
  }, [close, open])

  // Portal 出去的 fixed 面板得自己算坐标：量触发按钮与面板、放不下就翻面、夹在视口内，
  // 打开期间跟着滚动/缩放走。首帧先 `visibility: hidden`（layout effect 在绘制前跑完，
  // 所以不会闪一下 0,0）。
  useLayoutEffect(() => {
    if (!open) {
      setPos(null)
      return
    }
    const place = () => {
      const trigger = triggerRef.current
      const panel = panelRef.current
      if (!trigger || !panel) return
      const rect = trigger.getBoundingClientRect()
      const width = panel.offsetWidth
      const height = panel.offsetHeight
      const gap = 4
      const spaceBelow = window.innerHeight - rect.bottom - gap
      const spaceAbove = rect.top - gap
      let openUp = placement === 'top'
      if (openUp ? spaceAbove < height && spaceBelow > spaceAbove : spaceBelow < height && spaceAbove > spaceBelow) {
        openUp = !openUp
      }
      const rawTop = openUp ? rect.top - height - gap : rect.bottom + gap
      const rawLeft = align === 'end' ? rect.right - width : rect.left
      setPos({
        top: Math.min(Math.max(rawTop, 8), Math.max(8, window.innerHeight - height - 8)),
        left: Math.min(Math.max(rawLeft, 8), Math.max(8, window.innerWidth - width - 8)),
      })
    }
    place()
    window.addEventListener('resize', place)
    window.addEventListener('scroll', place, true)
    return () => {
      window.removeEventListener('resize', place)
      window.removeEventListener('scroll', place, true)
    }
  }, [align, children, open, placement])

  const itemNodes = () => {
    const panel = panelRef.current
    if (!panel) return [] as HTMLElement[]
    return Array.from(
      panel.querySelectorAll<HTMLElement>('[role="menuitem"]:not([aria-disabled="true"])'),
    )
  }

  const focusRelative = useCallback(
    (delta: number | 'first' | 'last') => {
      const nodes = itemNodes()
      if (nodes.length === 0) return
      const active = nodes.findIndex((node) => node === document.activeElement)
      let next: number
      if (delta === 'first') next = 0
      else if (delta === 'last') next = nodes.length - 1
      else if (active < 0) next = delta > 0 ? 0 : nodes.length - 1
      else next = (active + delta + nodes.length) % nodes.length
      nodes[next]?.focus()
    },
    [],
  )

  const onPanelKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault()
        focusRelative(1)
        break
      case 'ArrowUp':
        event.preventDefault()
        focusRelative(-1)
        break
      case 'Home':
        event.preventDefault()
        focusRelative('first')
        break
      case 'End':
        event.preventDefault()
        focusRelative('last')
        break
      case 'Escape':
        event.preventDefault()
        close()
        triggerRef.current?.focus()
        break
      case 'Tab':
        close()
        break
      default:
        break
    }
  }

  const onTriggerKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>) => {
    if (disabled) return
    if (event.key === 'ArrowDown' || event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      setOpen(true)
      window.setTimeout(() => focusRelative('first'), 0)
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault()
      setOpen(true)
      window.setTimeout(() => focusRelative('last'), 0)
    }
  }

  return (
    <div ref={rootRef} className="relative inline-flex">
      <button
        ref={triggerRef}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={label}
        disabled={disabled}
        onClick={() => (open ? close() : setOpen(true))}
        onKeyDown={onTriggerKeyDown}
        className={cn(
          'inline-flex h-7 select-none items-center gap-1.5 rounded-md border border-transparent px-2',
          'text-[12px] text-fg-muted transition-colors duration-150',
          'hover:bg-interactive hover:text-fg',
          'disabled:pointer-events-none disabled:opacity-40',
          triggerClassName,
        )}
      >
        {trigger}
      </button>

      {open &&
        createPortal(
          <div
            ref={panelRef}
            role="menu"
            aria-label={label}
            tabIndex={-1}
            onKeyDown={onPanelKeyDown}
            style={{
              top: pos?.top ?? 0,
              left: pos?.left ?? 0,
              visibility: pos ? 'visible' : 'hidden',
            }}
            className={cn(
              'fixed z-50 max-h-[60vh] min-w-[144px] max-w-[360px] animate-rise overflow-y-auto p-1 scroll-quiet',
              'surface-pop',
              className,
            )}
          >
            <MenuContext.Provider value={{ close, clearHighlight }}>
              {children}
            </MenuContext.Provider>
          </div>,
          document.body,
        )}
    </div>
  )
}

export interface MenuItemProps {
  label: ReactNode
  icon?: ReactNode
  /** Right-aligned secondary text (e.g. a file path or count). */
  hint?: ReactNode
  /** Shortcut spec resolved through the Kbd helpers, e.g. `"mod+shift+K"`. */
  shortcut?: string
  tone?: MenuItemTone
  disabled?: boolean
  selected?: boolean
  onSelect?: () => void
  className?: string
}

/** Renders a shortcut spec (`mod+shift+K`) as a compact key row. */
function ShortcutHint({ spec }: { spec: string }) {
  const parts = spec.split('+').map((part) => part.trim()).filter(Boolean)
  const isMac = detectPlatform() === 'mac'
  return (
    <span className="ml-4 inline-flex shrink-0 items-center gap-0.5" aria-hidden="true">
      {parts.map((part, index) => {
        const lower = part.toLowerCase()
        const text =
          lower === 'mod' || lower === 'cmd' || lower === 'meta' || lower === 'ctrl'
            ? isMac
              ? '⌘'
              : 'Ctrl'
            : lower === 'shift'
              ? isMac
                ? '⇧'
                : 'Shift'
              : lower === 'alt' || lower === 'option'
                ? isMac
                  ? '⌥'
                  : 'Alt'
                : part
        return (
          <kbd
            key={`${part}-${index}`}
            className="inline-flex h-[16px] min-w-[16px] items-center justify-center rounded-xs border border-line bg-surface-2 px-1 font-mono text-2xs text-fg-subtle"
          >
            {text}
          </kbd>
        )
      })}
    </span>
  )
}

export function MenuItem({
  label,
  icon,
  hint,
  shortcut,
  tone = 'default',
  disabled = false,
  selected = false,
  onSelect,
  className,
}: MenuItemProps) {
  const { close, clearHighlight } = useMenuContext('MenuItem')

  const activate = () => {
    if (disabled) return
    onSelect?.()
    close()
  }

  return (
    <div
      role="menuitem"
      tabIndex={-1}
      aria-disabled={disabled || undefined}
      aria-checked={selected || undefined}
      onMouseEnter={clearHighlight}
      onClick={activate}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          activate()
        }
      }}
      className={cn(
        'flex min-h-[34px] select-none items-center gap-1.5 rounded-md px-2 py-1.5 text-[13px] leading-5',
        'transition-colors duration-100',
        disabled
          ? 'pointer-events-none opacity-40'
          : tone === 'danger'
            ? 'cursor-pointer text-danger hover:bg-danger-soft focus:bg-danger-soft'
            : 'cursor-pointer text-fg hover:bg-interactive focus:bg-interactive',
        selected && tone !== 'danger' && 'bg-interactive',
        'focus-visible:outline-none',
        className,
      )}
    >
      {icon != null && (
        <span className="inline-flex w-3.5 shrink-0 items-center justify-center" aria-hidden="true">
          {icon}
        </span>
      )}
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {hint != null && <span className="shrink-0 text-2xs text-fg-subtle">{hint}</span>}
      {shortcut != null && <ShortcutHint spec={shortcut} />}
    </div>
  )
}

export function MenuSeparator() {
  return <div role="separator" className="mx-0.5 my-[3px] h-[0.5px] bg-line-strong" />
}

export function MenuLabel({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div
      role="presentation"
      className={cn('px-2 py-1.5 text-[11px] leading-[15px] text-fg-subtle', className)}
    >
      {children}
    </div>
  )
}
