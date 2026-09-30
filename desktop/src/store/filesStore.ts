/**
 * 工作区文件状态：改动清单 + 每个打开文件各自的预览。
 *
 * 与 `sessionStore` 分开的理由：这块数据完全来自宿主的三个只读命令
 * （`files.changes` / `files.diff` / `files.read`），和会话时间线没有耦合；
 * 分开放也让文件面板在没有会话的情况下（工作区门之后、首个回合之前）直接工作。
 *
 * 预览按路径存放（`previews`）而不是只留一个 `preview`：右侧工作台里每个打开
 * 的文件都是一个标签，来回切标签不该重新取一次内容，也不该丢掉另一侧已经
 * 拿到的差异/原文。
 */
import { create } from 'zustand'
import { getBridge } from '@/bridge'
import type { FileContent, FileDiff, WorkspaceChanges } from '@/types/protocol'

const BRIDGE = getBridge()
let refreshQueued = false

/**
 * 预览的三种视角：差异、文件现在的样子（原文）、以及渲染结果。
 *
 * `render` 与 `source` 取的是同一份数据（`files.read`），分开只是因为 UI 上
 * 「看到渲染出来的样子」和「看到源码」是两个不同的诉求：图片只有渲染，
 * HTML/Markdown/SVG/JSON 既想渲染也想看原文。
 */
export type PreviewMode = 'diff' | 'source' | 'render'

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
  /** 打开过的文件预览，按会话内路径索引。 */
  previews: Record<string, FilePreview>

  refresh(): Promise<void>
  open(path: string, mode?: PreviewMode): Promise<void>
  setMode(path: string, mode: PreviewMode): Promise<void>
  load(path: string, mode: PreviewMode): Promise<void>
  close(path: string): void
  closeAll(): void
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
  previews: {},

  async refresh() {
    // 已经在拉就不再叠加请求：预览与回合结束会连着触发好几次。
    // 但要记住最后一次请求，否则工具结束与 agent_end 靠得太近时会永远漏掉最终状态。
    if (get().loading) {
      refreshQueued = true
      return
    }
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
    } finally {
      if (refreshQueued) {
        refreshQueued = false
        queueMicrotask(() => void get().refresh())
      }
    }
  },

  async open(path, mode = 'diff') {
    // 已经开着这个文件就只切标签：视角是用户自己选的，重复打开不该把它重置。
    if (get().previews[path]) return
    set((state) => ({
      previews: {
        ...state.previews,
        [path]: { path, mode, loading: true, error: null, diff: null, content: null },
      },
    }))
    await get().load(path, mode)
  },

  async setMode(path, mode) {
    const previous = get().previews[path]
    if (!previous) return
    // 保留另一侧已经取到的内容：来回切 差异/原文 不该再等一次请求。
    set((state) => ({
      previews: {
        ...state.previews,
        [path]: {
          path,
          mode,
          loading: true,
          error: null,
          diff: previous.diff,
          content: previous.content,
        },
      },
    }))
    await get().load(path, mode)
  },

  async load(path, mode) {
    const settled = () => {
      const current = get().previews[path]
      return Boolean(current) && current.mode === mode
    }
    const patch = (next: Partial<FilePreview>) =>
      set((state) => {
        const current = state.previews[path]
        if (!current) return state
        return { previews: { ...state.previews, [path]: { ...current, ...next } } }
      })
    try {
      if (mode === 'diff') {
        const diff = (await BRIDGE.send({
          method: 'files.diff',
          params: { path },
        })) as FileDiff
        if (!settled()) return
        patch({ loading: false, error: diff?.error ?? null, diff })
        return
      }
      const content = (await BRIDGE.send({
        method: 'files.read',
        params: { path },
      })) as FileContent
      if (!settled()) return
      // 宿主用 `error` 报告「图片太大不能内嵌」这类看得见的失败。
      patch({ loading: false, error: content?.error ?? null, content })
    } catch (error) {
      if (!settled()) return
      patch({ loading: false, error: messageOf(error), diff: null, content: null })
    }
  },

  close(path) {
    set((state) => {
      const previews = { ...state.previews }
      delete previews[path]
      return { previews }
    })
  },

  closeAll() {
    set({ previews: {} })
  },

  reset() {
    refreshQueued = false
    set({ changes: null, loading: false, error: null, fetchedAt: null, previews: {} })
  },
}))
