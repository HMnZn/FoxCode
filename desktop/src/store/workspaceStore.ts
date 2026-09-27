import { create } from 'zustand'
import { getBridge } from '@/bridge'
import { basename, shortPath } from '@/lib/format'
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
}

function load(): Persisted {
  const fallback: Persisted = { current: null, recent: [] }
  try {
    const raw = window.localStorage.getItem(KEY)
    if (!raw) return fallback
    const parsed = JSON.parse(raw) as Partial<Persisted>
    return {
      current: typeof parsed.current === 'string' ? parsed.current : null,
      recent: Array.isArray(parsed.recent)
        ? parsed.recent.filter((item): item is string => typeof item === 'string')
        : [],
    }
  } catch {
    return fallback
  }
}

function save(state: Persisted): void {
  try {
    window.localStorage.setItem(KEY, JSON.stringify(state))
  } catch {
    /* storage disabled: the choice stays in-memory */
  }
}

/** Trailing separators are noise; Windows paths also compare case-insensitively. */
export function samePath(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false
  const trim = (value: string) => value.replace(/[\\/]+$/, '')
  const left = trim(a)
  const right = trim(b)
  if (left === right) return true
  const windows = /^[a-zA-Z]:[\\/]/.test(left) || left.includes('\\')
  return windows && left.toLowerCase() === right.toLowerCase()
}

export interface WorkspaceStore {
  /** `null` until the user has chosen a workspace at least once. */
  current: string | null
  recent: string[]
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
  forget(path: string): void
  /** Push the remembered workspace to the host once it is known. */
  syncHost(): Promise<void>
  /** Try the last failed path again (user-initiated, never automatic). */
  retry(): Promise<void>
  /** Forget the current choice and show the picker again. */
  reset(): void
}

export const useWorkspace = create<WorkspaceStore>((set, get) => {
  const remember = (path: string) => {
    const recent = [path, ...get().recent.filter((item) => !samePath(item, path))].slice(0, MAX_RECENT)
    set({ current: path, recent })
    save({ current: path, recent })
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
      await applyPath(path, true)
    },

    forget: (path) => {
      const recent = get().recent.filter((item) => !samePath(item, path))
      set({ recent })
      save({ current: get().current, recent })
    },

    syncHost: async () => {
      const { current, syncedFor, failedFor, failedHostCwd } = get()
      const host = useSession.getState().host
      if (!current || !host) return
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
      save({ current: null, recent: get().recent })
    },
  }
})

/** Folder name for a workspace path, used by chips and menu items. */
export function workspaceName(path: string | null | undefined): string {
  if (!path) return '未选择工作区'
  return basename(path) || path
}
