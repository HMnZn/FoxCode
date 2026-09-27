import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { useSession } from '@/store/sessionStore'
import { samePath, useWorkspace, workspaceName } from '@/store/workspaceStore'
import type { HostInfo } from '@/types/protocol'

/**
 * The workspace is the one choice the shell refuses to make for the user.
 *
 * These cases pin the contract the picker relies on: a path is normalised before
 * it reaches the host, a failed switch is still remembered (so a relaunch can
 * retry), the recents list is a case-insensitive LRU, and `syncHost` pushes the
 * remembered folder exactly once.
 */
const ROOT = 'C:\\Users\\Qin\\Desktop\\coding_agent\\FoxCode'
const OTHER = 'D:\\work\\demo'
const KEY = 'foxcode.workspace.v1'

const originalChangeCwd = useSession.getState().changeCwd
let calls: string[] = []

function hostAt(cwd: string): HostInfo {
  return { cwd } as unknown as HostInfo
}

function persisted(): { current: string | null; recent: string[] } {
  return JSON.parse(window.localStorage.getItem(KEY) ?? '{}')
}

describe('workspaceStore', () => {
  beforeEach(() => {
    calls = []
    window.localStorage.clear()
    useSession.setState({
      host: null,
      changeCwd: async (cwd: string) => {
        calls.push(cwd)
      },
    })
    useWorkspace.setState({
      current: null,
      recent: [],
      applying: null,
      syncedFor: null,
      failedFor: null,
      failedHostCwd: null,
      lastError: null,
    })
  })

  afterEach(() => {
    useSession.setState({ changeCwd: originalChangeCwd, host: null })
    useWorkspace.setState({
      current: null,
      recent: [],
      applying: null,
      syncedFor: null,
      failedFor: null,
      failedHostCwd: null,
      lastError: null,
    })
  })

  it('normalises paths when comparing them', () => {
    expect(samePath(ROOT, `${ROOT}\\`)).toBe(true)
    expect(samePath(ROOT.toLowerCase(), ROOT)).toBe(true)
    expect(samePath('/w/foxcode', '/w/foxcode/')).toBe(true)
    expect(samePath('/w/foxcode', '/w/other')).toBe(false)
    expect(samePath(null, ROOT)).toBe(false)
    expect(samePath(undefined, undefined)).toBe(false)
  })

  it('names a workspace by its last segment', () => {
    expect(workspaceName(ROOT)).toBe('FoxCode')
    expect(workspaceName('/w/foxcode/')).toBe('foxcode')
    expect(workspaceName(null)).toBe('未选择工作区')
  })

  it('applies a workspace to the host and remembers it', async () => {
    await useWorkspace.getState().open(`${ROOT}\\`)

    expect(calls).toEqual([ROOT])
    const state = useWorkspace.getState()
    expect(state.current).toBe(ROOT)
    expect(state.recent).toEqual([ROOT])
    expect(state.applying).toBeNull()
    expect(persisted()).toEqual({ current: ROOT, recent: [ROOT] })
  })

  it('remembers a workspace even when the host refuses it', async () => {
    useSession.setState({
      changeCwd: async () => {
        throw new Error('Runtime is switching or reloading')
      },
    })

    await useWorkspace.getState().open(OTHER)

    const state = useWorkspace.getState()
    expect(state.current).toBe(OTHER)
    expect(state.recent).toEqual([OTHER])
    expect(state.applying).toBeNull()
    expect(persisted().current).toBe(OTHER)
  })

  it('records a refused switch instead of pretending it took effect', async () => {
    useSession.setState({
      host: hostAt(ROOT),
      changeCwd: async () => {
        throw new Error('工作区不可写：无法创建 D:\\work\\demo\\.foxcode')
      },
    })

    await useWorkspace.getState().open(OTHER)

    const state = useWorkspace.getState()
    expect(state.syncedFor).toBeNull()
    expect(state.failedFor).toBe(OTHER)
    expect(state.failedHostCwd).toBe(ROOT)
    expect(state.lastError).toContain('工作区不可写')
  })

  it('retries the refused path on demand and clears the hint', async () => {
    useSession.setState({
      host: hostAt(ROOT),
      changeCwd: async () => {
        throw new Error('宿主运行时尚未就绪或已关闭')
      },
    })
    await useWorkspace.getState().open(OTHER)
    expect(useWorkspace.getState().failedFor).toBe(OTHER)

    // The runtime recovers; the user presses 重试切换.
    useSession.setState({
      changeCwd: async (cwd: string) => {
        calls.push(cwd)
      },
    })
    await useWorkspace.getState().retry()

    expect(calls).toEqual([OTHER])
    const state = useWorkspace.getState()
    expect(state.failedFor).toBeNull()
    expect(state.failedHostCwd).toBeNull()
    expect(state.lastError).toBeNull()
    expect(state.syncedFor).toBe(OTHER)
  })

  it('does not replay a refused switch on every host refresh', async () => {
    useSession.setState({
      host: hostAt(ROOT),
      changeCwd: async () => {
        throw new Error('Runtime is switching or reloading')
      },
    })
    useWorkspace.setState({ current: OTHER, syncedFor: null })
    await useWorkspace.getState().syncHost()
    expect(useWorkspace.getState().failedFor).toBe(OTHER)

    calls = []
    // Same host, same failure: the effect reruns but must stay quiet.
    await useWorkspace.getState().syncHost()
    await useWorkspace.getState().syncHost()
    expect(calls).toEqual([])

    // The host moved on by itself, so a retry is worth one more attempt.
    useSession.setState({ host: hostAt('D:\\somewhere-else') })
    useSession.setState({
      changeCwd: async (cwd: string) => {
        calls.push(cwd)
      },
    })
    await useWorkspace.getState().syncHost()
    expect(calls).toEqual([OTHER])
  })

  it('keeps eight recents, newest first, deduped case-insensitively', async () => {
    for (let index = 0; index < 10; index += 1) {
      await useWorkspace.getState().open(`C:\\w\\p${index}`)
    }

    let state = useWorkspace.getState()
    expect(state.recent).toHaveLength(8)
    expect(state.recent[0]).toBe('C:\\w\\p9')
    expect(state.recent).not.toContain('C:\\w\\p0')

    await useWorkspace.getState().open('c:\\w\\p5')
    state = useWorkspace.getState()
    expect(state.recent.filter((path) => samePath(path, 'C:\\w\\p5'))).toHaveLength(1)
    expect(state.recent[0]).toBe('c:\\w\\p5')
  })

  it('pushes the remembered workspace to the host exactly once', async () => {
    useWorkspace.setState({ current: OTHER, syncedFor: null })

    // The host is already there: nothing to send, but the pairing is recorded.
    useSession.setState({ host: hostAt(OTHER) })
    await useWorkspace.getState().syncHost()
    expect(calls).toEqual([])
    expect(useWorkspace.getState().syncedFor).toBe(OTHER)

    // A fresh launch on a host that sits elsewhere pushes the choice once.
    useSession.setState({ host: hostAt(ROOT) })
    useWorkspace.setState({ syncedFor: null })
    await useWorkspace.getState().syncHost()
    expect(calls).toEqual([OTHER])

    // Still diverging (busy runtime, missing folder): no retry storm.
    calls = []
    await useWorkspace.getState().syncHost()
    expect(calls).toEqual([])
  })

  it('does nothing before a workspace is chosen', async () => {
    useSession.setState({ host: hostAt(ROOT) })
    await useWorkspace.getState().syncHost()
    expect(calls).toEqual([])
  })

  it('forgets and resets without touching the rest of the list', async () => {
    await useWorkspace.getState().open(ROOT)
    await useWorkspace.getState().open(OTHER)

    useWorkspace.getState().forget(ROOT)
    expect(useWorkspace.getState().recent).toEqual([OTHER])
    expect(persisted().recent).toEqual([OTHER])

    useWorkspace.getState().reset()
    expect(useWorkspace.getState().current).toBeNull()
    expect(useWorkspace.getState().recent).toEqual([OTHER])
    expect(persisted()).toEqual({ current: null, recent: [OTHER] })
  })
})
