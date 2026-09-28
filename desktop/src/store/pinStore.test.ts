import { beforeEach, describe, expect, it, vi } from 'vitest'
import { pinnedFirst, usePins } from '@/store/pinStore'

/**
 * Pins are the one piece of session state the host knows nothing about.
 *
 * These cases fix the contract the sidebar relies on: newest pin wins the top
 * row, a second click unpins, the list survives a relaunch, and a pin whose
 * session is gone never invents a row.
 */
const KEY = 'foxcode.pinned-sessions.v1'

describe('pinStore', () => {
  beforeEach(() => {
    window.localStorage.clear()
    usePins.setState({ pinned: [] })
  })

  it('pins newest first and persists the order', () => {
    expect(usePins.getState().toggle('a')).toBe(true)
    expect(usePins.getState().toggle('b')).toBe(true)

    expect(usePins.getState().pinned).toEqual(['b', 'a'])
    expect(usePins.getState().isPinned('a')).toBe(true)
    expect(JSON.parse(window.localStorage.getItem(KEY) ?? 'null')).toEqual(['b', 'a'])
  })

  it('unpins on the second toggle', () => {
    usePins.getState().toggle('a')

    expect(usePins.getState().toggle('a')).toBe(false)
    expect(usePins.getState().pinned).toEqual([])
    expect(JSON.parse(window.localStorage.getItem(KEY) ?? 'null')).toEqual([])
  })

  it('reads back only the ids it wrote', async () => {
    window.localStorage.setItem(KEY, JSON.stringify(['x', 7, null, 'y']))
    vi.resetModules()
    const reloaded = await import('@/store/pinStore')

    expect(reloaded.usePins.getState().pinned).toEqual(['x', 'y'])
  })

  it('starts empty when the stored payload is not a list', async () => {
    window.localStorage.setItem(KEY, JSON.stringify({ pinned: ['x'] }))
    vi.resetModules()
    const reloaded = await import('@/store/pinStore')

    expect(reloaded.usePins.getState().pinned).toEqual([])
  })

  it('orders pinned rows by pin order and leaves the rest untouched', () => {
    const items = [{ id: 'a' }, { id: 'b' }, { id: 'c' }]

    // No pins is the hot path: the caller's array comes back as-is.
    expect(pinnedFirst(items, [])).toBe(items)
    expect(pinnedFirst(items, ['c', 'a']).map((item) => item.id)).toEqual(['c', 'a', 'b'])
  })

  it('drops pins whose session is no longer listed', () => {
    const items = [{ id: 'a' }, { id: 'b' }]

    expect(pinnedFirst(items, ['ghost']).map((item) => item.id)).toEqual(['a', 'b'])
  })
})
