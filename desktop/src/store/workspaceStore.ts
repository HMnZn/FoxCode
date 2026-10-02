import { create } from 'zustand'
import { getBridge } from '@/bridge'
import { basename, shortPath } from '@/lib/format'
import { useRail } from '@/store/railStore'
import { useSession } from '@/store/sessionStore'
import { toast } from '@/store/toastStore'

/**
 * The workspace is the folder the agent is rooted in: `cwd.change` on the host,
 * `sessions/*` underneath it, and the anchor for trust and permission checks.
 *
 * Unlike the theme, it cannot be defaulted — silently rooting the agent in
 * whatever directory the shell happened to start in is exactly the surprise this
 * store exists to remove. So `current` starts as `null` and the shell renders
 * the picker until the user has chosen once; the choice is then remembered.
 */
const KEY = 'foxcode.workspace.v1'
const MAX_RECENT = 8

interface Persisted {
  current: string | null
  recent: string[]
  /** User-chosen display names, keyed by normalized path. */
  aliases: Record<string, string>
  /** Paths the user removed from the sidebar list; the folders on disk are untouched. */
  hidden: string[]
}

function load(): Persisted {
  const fallback: Persisted = { current: null, recent: [], aliases: {}, hidden: [] }
  try {
    const raw = window.localStorage.getItem(KEY)
    if (!raw) return fallback
    const parsed = JSON.parse(raw) as Partial<Persisted>
    const aliases: Record<string, string> = {}
    if (parsed.aliases && typeof parsed.aliases === 'object') {
      for (const [key, value] of Object.entries(parsed.aliases)) {
        if (typeof value === 'string' && value.trim()) aliases[normalizedKey(key)] = value
      }
    }
    return {
      current: typeof parsed.current === 'string' ? parsed.current : null,
      recent: Array.isArray(parsed.recent)
        ? parsed.recent.filter((item): item is string => typeof item === 'string')
        : [],
      aliases,
      hidden: Array.isArray(parsed.hidden)
        ? parsed.hidden.filter((item): item is string => typeof item === 'string')
        : [],
    }
  } catch {
    return fallback
  }
}

function save(state: Persisted): void {
  try {
    window.localStorage.setItem(
      KEY,
      JSON.stringify({
        current: state.current,
        recent: state.recent,
        aliases: state.aliases,
        hidden: state.hidden,
      }),
    )
  } catch {
    /* storage disabled: the choice stays in-memory */
  }
}

/** Trailing separators are noise; Windows paths also compare case-insensitively. */
export function samePath(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false
  // Electron's folder picker commonly returns `C:\\work\\repo`, while host.info
  // may serialize the same Windows path as `C:/work/repo` (or the other way
  // around). Treat separators as syntax, not identity: a false mismatch here
  // sends cwd.change, and changing cwd intentionally replaces/aborts the active
  // runtime.
  const windows = /^[a-zA-Z]:[\\/]/.test(a) || /^[a-zA-Z]:[\\/]/.test(b)
  const trim = (value: string) =>
    (windows ? value.replace(/\\/g, '/') : value).replace(/\/+$/, '')
  const left = trim(a)
  const right = trim(b)
  if (left === right) return true
  return windows && left.toLowerCase() === right.toLowerCase()
}

/**
 * Normalized key for the per-path side tables (aliases, hidden list).
 *
 * `samePath` compares two paths; these tables need to look one up on its own, so
 * the same normalization is applied to a single path. Without it an alias saved
 * for `C:\\work\\repo` would be invisible to the `C:/work/repo` that host.info
 * reports, and the row would silently fall back to the folder name.
 */
function normalizedKey(path: string): string {
  const windows = /^[a-zA-Z]:[\\/]/.test(path)
  const value = (windows ? path.replace(/\\/g, '/') : path).replace(/\/+$/, '')
  return windows ? value.toLowerCase() : value
}

export interface WorkspaceStore {
  /** `null` until the user has chosen a workspace at least once. */
  current: string | null
  recent: string[]
  /** Display names the user assigned, keyed by `normalizedKey(path)`. */
  aliases: Record<string, string>
  /** Paths removed from the sidebar; the folders themselves are never touched. */
  hidden: string[]
  /** Path currently being applied to the host, or `null` when idle. */
  applying: string | null
  /** The path already pushed to the host, so a remount does not re-send it. */
  syncedFor: string | null
  /** Path the host refused; the UI shows a "未生效" hint with a retry action. */
  failedFor: string | null
  /** Host cwd at the time of that failure, so a repeated attempt is not spammed. */
  failedHostCwd: string | null
  /** Message from the last failed switch, shown next to the hint. */
  lastError: string | null

  /** Native folder dialog (the mock host answers with its own cwd). */
  pick(): Promise<void>
  open(path: string): Promise<void>
  /** Adopt a workspace already activated by opening one of its sessions. */
  adopt(path: string): void
  forget(path: string): void
  /** Rename a workspace in the list only; an empty name restores the folder name. */
  rename(path: string, alias: string): void
  /** Drop a workspace from the list (and hide it until it is opened again). */
  hide(path: string): void
  /** Push the remembered workspace to the host once it is known. */
  syncHost(): Promise<void>
  /** Try the last failed path again (user-initiated, never automatic). */
  retry(): Promise<void>
  /** Forget the current choice and show the picker again. */
  reset(): void
}

export const useWorkspace = create<WorkspaceStore>((set, get) => {
  /** Persist the durable half of the store — everything `load()` can restore. */
  const persist = (patch: Partial<Persisted> = {}) => {
    const { current, recent, aliases, hidden } = get()
    save({ current, recent, aliases, hidden, ...patch })
  }

  const remember = (path: string) => {
    const existing = get().recent
    // Workspace rows are navigation, not an MRU list.  Re-selecting one must
    // not make the folder jump to the top of the sidebar.
    const recent = existing.some((item) => samePath(item, path))
      ? existing
      : [...existing, path].slice(-MAX_RECENT)
    // Choosing a folder again is an explicit statement that it belongs in the
    // list, so it stops being hidden. `open()` is the only way back in, and it
    // is what calls this; without this line a removed workspace is gone for
    // good and the picker looks broken.
    const hidden = get().hidden.filter((item) => !samePath(item, path))
    set({ current: path, recent, hidden })
    persist({ current: path, recent, hidden })
  }

  const applyPath = async (path: string, announce: boolean): Promise<void> => {
    const target = path.replace(/[\\/]+$/, '')
    if (!target) return
    set({ applying: target, lastError: null })
    try {
      await useSession.getState().changeCwd(target)
      // Only now is the host actually rooted here; `changeCwd` also refreshes
      // `host`, so the chips pick the real cwd up on their own.
      set({ syncedFor: target, failedFor: null, failedHostCwd: null, lastError: null })
      // Everything the workbench shows is relative to the old root: drop the
      // open file tabs (and the stale previews / shells behind them) so the
      // 文件 tab starts from the new folder instead of a path that no longer
      // means the same thing.
      useRail.getState().reset()
      if (announce) {
        toast.success({ title: '工作区已切换', description: shortPath(target, 56) })
      }
    } catch (error) {
      // Remembering the choice is still right (the next launch gets another
      // chance), but the failure must stay visible: swallowing it left the UI
      // claiming one workspace while the host ran in another, with no way back
      // short of a reload.
      const message = error instanceof Error ? error.message : String(error)
      set({
        syncedFor: null,
        failedFor: target,
        failedHostCwd: useSession.getState().host?.cwd ?? null,
        lastError: message,
      })
      toast.danger({
        title: '切换工作区失败',
        description: `${message}（宿主仍停在原目录，可在设置页重试）`,
      })
    } finally {
      remember(target)
      set({ applying: null })
    }
  }

  return {
    ...load(),
    applying: null,
    syncedFor: null,
    failedFor: null,
    failedHostCwd: null,
    lastError: null,

    pick: async () => {
      const picked = await getBridge().pickDirectory()
      if (!picked) return
      await get().open(picked)
    },

    open: async (path) => {
      const session = useSession.getState()
      const busy = ['streaming', 'awaiting-approval', 'compacting'].includes(
        session.timeline.status,
      )
      let backgroundBusy = session.sessions.some((item) => item.running)
      // `agent_end` reaches the renderer just before the host clears its
      // runtime marker. A sessions refresh at that instant can therefore leave
      // a stale `running: true` row. Recheck the authoritative list when that
      // cached bit is the only reason a user action would be refused.
      if (!busy && backgroundBusy && session.host?.cwd && !samePath(session.host.cwd, path)) {
        await session.refreshSessions()
        backgroundBusy = useSession.getState().sessions.some((item) => item.running)
      }
      if ((busy || backgroundBusy) && session.host?.cwd && !samePath(session.host.cwd, path)) {
        remember(path.replace(/[\\/]+$/, ''))
        toast.info({
          title: '工作区已加入左侧列表',
          description: '当前会话仍在后台运行；结束后再点击工作区即可切换。',
        })
        return
      }
      await applyPath(path, true)
    },

    adopt: (path) => {
      const target = path.replace(/[\\/]+$/, '')
      if (!target) return
      remember(target)
      set({
        syncedFor: target,
        failedFor: null,
        failedHostCwd: null,
        lastError: null,
      })
    },

    forget: (path) => {
      const recent = get().recent.filter((item) => !samePath(item, path))
      set({ recent })
      persist({ recent })
    },

    rename: (path, alias) => {
      const key = normalizedKey(path)
      const clean = alias.trim().replace(/\s+/g, ' ')
      const aliases = { ...get().aliases }
      // An empty alias is how the UI undoes a rename, so the folder name returns.
      if (clean) aliases[key] = clean
      else delete aliases[key]
      set({ aliases })
      persist({ aliases })
    },

    hide: (path) => {
      // The host is rooted in the current workspace, so hiding it would leave
      // the sidebar without a row for the runtime that is actually running.
      if (samePath(get().current, path)) {
        toast.info({
          title: '当前工作区不能移除',
          description: '先切到别的工作区，再把它从列表里去掉。',
        })
        return
      }
      const hidden = get().hidden.some((item) => samePath(item, path))
        ? get().hidden
        : [...get().hidden, path]
      const recent = get().recent.filter((item) => !samePath(item, path))
      set({ hidden, recent })
      persist({ hidden, recent })
      toast.success({
        title: '已从工作区列表移除',
        description: '磁盘上的文件夹没有被动过，重新打开即可恢复。',
      })
    },

    syncHost: async () => {
      const { current, applying, syncedFor, failedFor, failedHostCwd } = get()
      const host = useSession.getState().host
      if (!current || !host) return
      // host.info updates can render App again while the first cwd.change is
      // still awaiting its follow-up refreshes. Never start a second runtime
      // replacement for the same remembered workspace in that window.
      if (applying && samePath(applying, current)) return
      if (samePath(host.cwd, current)) {
        set({ syncedFor: current, failedFor: null, failedHostCwd: null, lastError: null })
        return
      }
      // Once per remembered path: if the host keeps a different cwd (busy
      // runtime, missing folder) we surface one toast instead of retrying.
      if (samePath(syncedFor, current)) return
      // The failure is retried only when the host moved on (or the user asks
      // for it), otherwise every host refresh would replay `cwd.change` and
      // re-raise the same toast.
      if (samePath(failedFor, current) && (failedHostCwd ?? '') === (host.cwd ?? '')) return
      await applyPath(current, false)
    },

    retry: async () => {
      const { failedFor, current } = get()
      const target = failedFor ?? current
      if (!target) return
      await applyPath(target, true)
    },

    reset: () => {
      set({
        current: null,
        syncedFor: null,
        failedFor: null,
        failedHostCwd: null,
        lastError: null,
      })
      persist({ current: null })
    },
  }
})

/** Folder name for a workspace path, used by chips and menu items. */
export function workspaceName(path: string | null | undefined): string {
  if (!path) return '未选择工作区'
  return basename(path) || path
}

/**
 * The user's display name for a path, or `''` when it has none. An empty string
 * (not the folder name) is what a rename dialog wants as its starting value:
 * confirming it unchanged then means "no alias" rather than storing the folder
 * name as one.
 */
export function workspaceAlias(path: string | null | undefined, aliases: Record<string, string>): string {
  if (!path) return ''
  return aliases[normalizedKey(path)] ?? ''
}

/**
 * Name shown for a workspace row: the user's alias when there is one, otherwise
 * the folder name. The path stays the identity everywhere else (cwd.change,
 * session ownership), so a rename can never point the host at another folder.
 */
export function workspaceLabel(
  path: string | null | undefined,
  aliases: Record<string, string>,
): string {
  if (!path) return '未选择工作区'
  return workspaceAlias(path, aliases) || workspaceName(path)
}
