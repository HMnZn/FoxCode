import { create } from 'zustand'

/**
 * Pinned sessions are a per-client view preference, like the recent-workspace
 * list: they only decide the order of the rows in the sidebar.
 *
 * That is why they live in `localStorage` instead of the host protocol. The host
 * has no notion of an "important" session, and `sessions.list` is capped at 50
 * entries — a pin cannot bring a stale session back over the wire anyway.
 */
const KEY = 'foxcode.pinned-sessions.v1'

/** Session ids, most recently pinned first. */
function load(): string[] {
  try {
    const raw = window.localStorage.getItem(KEY)
    if (!raw) return []
    const parsed: unknown = JSON.parse(raw)
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === 'string')
      : []
  } catch {
    return []
  }
}

function save(ids: string[]): void {
  try {
    window.localStorage.setItem(KEY, JSON.stringify(ids))
  } catch {
    /* storage disabled: the pins stay in-memory for this window */
  }
}

export interface PinStore {
  /** Session ids, most recently pinned first. */
  pinned: string[]
  isPinned(id: string): boolean
  /** Returns the pin state after the toggle, so the caller can describe it. */
  toggle(id: string): boolean
}

export const usePins = create<PinStore>((set, get) => ({
  pinned: load(),

  isPinned: (id) => get().pinned.includes(id),

  toggle: (id) => {
    const current = get().pinned
    // Pins never expire on their own: a session that is gone from the list
    // simply stops matching, and its id costs a few bytes until it is unpinned.
    const pinned = current.includes(id)
      ? current.filter((item) => item !== id)
      : [id, ...current]
    set({ pinned })
    save(pinned)
    return pinned.includes(id)
  },
}))

/**
 * Pinned rows first, in pin order (newest first); everything else keeps the
 * order the caller passed in — `sessions.list` already sorts by recency, and
 * re-sorting here would fight the host.
 */
export function pinnedFirst<T extends { id: string }>(items: T[], pinned: string[]): T[] {
  if (pinned.length === 0) return items
  const rank = new Map(pinned.map((id, index) => [id, index]))
  const top = items
    .filter((item) => rank.has(item.id))
    .sort((a, b) => (rank.get(a.id) ?? 0) - (rank.get(b.id) ?? 0))
  const rest = items.filter((item) => !rank.has(item.id))
  return [...top, ...rest]
}
