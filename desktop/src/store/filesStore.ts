/**
 * 工作区文件状态：右侧栏「文件」页签的改动清单 + 预览。
 *
 * 与 `sessionStore` 分开的理由：这块数据完全来自宿主的三个只读命令
 * （`files.changes` / `files.diff` / `files.read`），和会话时间线没有耦合；
 * 分开放也让「文件」页签在没有会话的情况下（工作区门之后、首个回合之前）
 * 直接工作。
 */
import { create } from 'zustand'
import { getBridge } from '@/bridge'
import type { FileContent, FileDiff, WorkspaceChanges } from '@/types/protocol'

const BRIDGE = getBridge()

/** 预览的两种视角：差异（默认）与文件现在的样子。 */
export type PreviewMode = 'diff' | 'source'

export interface FilePreview {
  path: string
  mode: PreviewMode
  loading: boolean
  error: string | null
  diff: FileDiff | null
  content: FileContent | null
}

interface FilesState {
  changes: WorkspaceChanges | null
  loading: boolean
  error: string | null
  /** 上次拉取清单的时间（UI 用来显示「刚刚 / 1 分钟前」）。 */
  fetchedAt: number | null
  preview: FilePreview | null

  refresh(): Promise<void>
  open(path: string, mode?: PreviewMode): Promise<void>
  setMode(mode: PreviewMode, forPath?: string): Promise<void>
  load(path: string, mode: PreviewMode): Promise<void>
  close(): void
  reset(): void
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export const useFiles = create<FilesState>((set, get) => ({
  changes: null,
  loading: false,
  error: null,
  fetchedAt: null,
  preview: null,

  async refresh() {
    // 已经在拉就不再叠加请求：预览与回合结束会连着触发好几次。
    if (get().loading) return
    set({ loading: true })
    try {
      const payload = (await BRIDGE.send({ method: 'files.changes' })) as WorkspaceChanges
      set({
        changes: payload,
        error: payload?.error ?? null,
        loading: false,
        fetchedAt: Date.now(),
      })
    } catch (error) {
      set({ error: messageOf(error), loading: false })
    }
  },

  async open(path, mode = 'diff') {
    const current = get().preview
    // 再点一次同一个文件的同一个视角 = 收起预览（列表那行本身就是开关）。
    if (current && current.path === path && current.mode === mode && !current.loading) {
      set({ preview: null })
      return
    }
    set({ preview: { path, mode, loading: true, error: null, diff: null, content: null } })
    await get().load(path, mode)
  },

  async setMode(mode, forPath) {
    const target = forPath ?? get().preview?.path
    if (!target) return
    const previous = get().preview
    // 保留另一侧已经取到的内容：来回切 差异/原文 不该再等一次请求。
    set({
      preview: {
        path: target,
        mode,
        loading: true,
        error: null,
        diff: previous?.diff ?? null,
        content: previous?.content ?? null,
      },
    })
    await get().load(target, mode)
  },

  async load(path, mode) {
    const settled = () => {
      const current = get().preview
      return current && current.path === path && current.mode === mode
    }
    try {
      if (mode === 'diff') {
        const diff = (await BRIDGE.send({
          method: 'files.diff',
          params: { path },
        })) as FileDiff
        if (!settled()) return
        set({
          preview: {
            path,
            mode,
            loading: false,
            error: diff?.error ?? null,
            diff,
            content: get().preview?.content ?? null,
          },
        })
        return
      }
      const content = (await BRIDGE.send({
        method: 'files.read',
        params: { path },
      })) as FileContent
      if (!settled()) return
      set({
        preview: {
          path,
          mode,
          loading: false,
          error: null,
          diff: get().preview?.diff ?? null,
          content,
        },
      })
    } catch (error) {
      if (!settled()) return
      set({
        preview: { path, mode, loading: false, error: messageOf(error), diff: null, content: null },
      })
    }
  },

  close() {
    set({ preview: null })
  },

  reset() {
    set({ changes: null, loading: false, error: null, fetchedAt: null, preview: null })
  },
}))
