import { create } from 'zustand'
import { getBridge } from '@/bridge'
import type { FoxBridge, TransportStatus } from '@/bridge/types'
import { uid } from '@/lib/format'
import {
  EMPTY_TIMELINE,
  applyFrame,
  applyHostContext,
  applyHostIdle,
  applyPermissionDecision,
  applyPermissionRequest,
  markStalled,
  type TimelineState,
} from '@/store/timeline'
import { toast, useToasts } from '@/store/toastStore'
import type {
  ExtensionScope,
  HostCommand,
  HostInfo,
  PermissionDecision,
  PermissionMode,
  SessionSummary,
  ThinkingLevel,
} from '@/types/protocol'

export interface QueuedMessage {
  id: string
  text: string
  mode: 'steer' | 'follow_up'
  at: number
}

/**
 * Pinned "需要你的授权" toasts, keyed by permission request id.
 *
 * The toast store mints its own toast ids, so a request id alone cannot dismiss
 * the toast — and `duration: 0` makes it sticky. Every path that resolves a
 * request (answer, host side-effect, session switch) funnels through
 * `syncPermissionToasts` so no toast is ever left behind.
 */
const permissionToasts = new Map<string, string>()

function syncPermissionToasts(pendingIds: readonly string[]): void {
  const alive = new Set(pendingIds)
  for (const [requestId, toastId] of permissionToasts) {
    if (alive.has(requestId)) continue
    useToasts.getState().dismiss(toastId)
    permissionToasts.delete(requestId)
  }
}

export interface SessionStore {
  bridge: FoxBridge
  ready: boolean
  host: HostInfo | null
  transport: TransportStatus
  timeline: TimelineState
  sessions: SessionSummary[]
  queue: QueuedMessage[]
  busyCount: number

  init(): Promise<void>
  refreshHost(): Promise<void>
  refreshSessions(): Promise<void>
  send(command: HostCommand, opts?: { silent?: boolean }): Promise<unknown>
  prompt(text: string): Promise<void>
  startRun(text: string): Promise<void>
  steer(text: string): Promise<void>
  followUp(text: string): Promise<void>
  reconcile(): Promise<void>
  abort(): Promise<void>
  compact(): Promise<void>
  answerPermission(id: string, decision: PermissionDecision, reason?: string): Promise<void>
  setPermissionMode(mode: PermissionMode): Promise<void>
  setThinking(level: ThinkingLevel): Promise<void>
  selectModel(reference: string): Promise<void>
  setTrust(trusted: boolean): Promise<void>
  changeCwd(cwd: string): Promise<void>
  openSession(id: string): Promise<void>
  newSession(): Promise<void>
  renameSession(id: string, title: string): Promise<void>
  forkSession(fromId?: string): Promise<void>
  deleteSession(id: string): Promise<void>
  setExtension(id: string, enabled: boolean, scope?: ExtensionScope): Promise<void>
  runCommand(name: string, args?: string): Promise<void>
  invokeSkill(name: string): Promise<void>
  exportSession(format: 'json' | 'markdown'): Promise<void>
  clearTimeline(): void
  dropQueued(id: string): void
}

const BRIDGE = getBridge()

/** Statuses where the runtime refuses a second foreground operation. */
const BUSY_STATUSES = new Set(['streaming', 'awaiting-approval', 'compacting'])

/**
 * 多久没有新帧就提示「可能卡住」。
 *
 * 45 秒是刻意的宽松值：模型在长思考里本来就可能几十秒不吐字（思考内容也是以
 * `thinking_delta` 流回来的，所以真在思考就不会静默），误报比不报更烦人。
 */
const STALL_AFTER_MS = 45_000

/**
 * 宿主连续两次（间隔一次对账轮询）说自己没有在跑的一轮，才解除「生成中」。
 *
 * 只数一次是不够的：刚回车的那一瞬间宿主可能还没收到 prompt（`busy` 仍是 false），
 * 单次判断会把刚开始的一轮当成丢帧。
 */
const IDLE_STRIKES_TO_UNLOCK = 2

/**
 * 宿主说自己空闲、而且**它自己**也至少安静了这么久，才真的解锁。
 *
 * `busy` 在「这一轮抛错后紧跟重试」的窗口里会短暂变回 false：那一轮还在跑，
 * 急着解锁反而会把正在流的内容判成中断。
 */
const IDLE_SETTLE_MS = 8_000

let idleStrikes = 0

/** 宿主在「没有正在运行的一轮」时拒绝插话的提示（见 `fox_serve/host.py::_require_running`）。 */
function isIdleHostError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return message.includes('没有正在运行的一轮')
}

export function isBusy(timeline: TimelineState): boolean {
  return BUSY_STATUSES.has(timeline.status)
}

function describe(command: HostCommand): string {
  return command.method
}

function normalizedSessionPath(value: string | null | undefined): string {
  return (value ?? '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
}

export const useSession = create<SessionStore>((set, get) => {
  const fail = (error: unknown, context: string) => {
    const message = error instanceof Error ? error.message : String(error)
    toast.danger({ title: `${context} 失败`, description: message })
  }

  return {
    bridge: BRIDGE,
    ready: false,
    host: null,
    transport: { state: 'connecting', since: Date.now() },
    timeline: EMPTY_TIMELINE,
    sessions: [],
    queue: [],
    busyCount: 0,

    init: async () => {
      if (get().ready) return
      set({ ready: true })

      BRIDGE.onTransport((status) => {
        const previous = get().transport.state
        set({ transport: status })
        if (status.state === 'offline' && previous !== 'offline') {
          toast.danger({
            title: '与 Python 宿主的连接已断开',
            description: status.detail ?? '请检查 fox serve 是否需要重启',
            duration: 0,
          })
        }
        if (status.state === 'ready' && previous === 'degraded') {
          toast.success({ title: '宿主连接已恢复' })
        }
      })

      BRIDGE.onFrame((frame) => {
        const timeline = applyFrame(useSession.getState().timeline, frame)
        set({ timeline })
        syncPermissionToasts(timeline.permissions.map((request) => request.id))
      })

      BRIDGE.onPermission((request) => {
        set((state) => ({ timeline: applyPermissionRequest(state.timeline, request) }))
        permissionToasts.set(
          request.id,
          toast.warn({
            title: '需要你的授权',
            description: request.summary,
            duration: 0,
          }),
        )
      })

      await get().refreshHost()
      await get().refreshSessions()
    },

    refreshHost: async () => {
      try {
        const host = await BRIDGE.info()
        set((state) => ({
          host,
          // 用宿主估算的上下文占用补齐（新会话/刚打开的会话没有 usage 可依据）。
          timeline: applyHostContext(
            state.timeline,
            host.contextTokens,
            host.model?.contextWindow,
          ),
          // `host.info` having answered is itself proof the sidecar is up, and the
          // one-shot transport event may have fired before this store subscribed.
          transport:
            host.transport === 'mock'
              ? { state: 'ready', detail: '内置模拟宿主', since: Date.now() }
              : host.sidecarConnected
                ? { state: 'ready', detail: '已连接 fox serve', since: state.transport.since }
                : state.transport,
        }))
      } catch (error) {
        fail(error, '读取宿主信息')
      }
    },

    refreshSessions: async () => {
      try {
        const sessions = await BRIDGE.sessions()
        set({ sessions })
      } catch (error) {
        fail(error, '读取会话列表')
      }
    },

    send: async (command, opts) => {
      set((state) => ({ busyCount: state.busyCount + 1 }))
      try {
        return await BRIDGE.send(command)
      } catch (error) {
        if (!opts?.silent) fail(error, describe(command))
        throw error
      } finally {
        set((state) => ({ busyCount: Math.max(0, state.busyCount - 1) }))
      }
    },

    prompt: async (text) => {
      const trimmed = text.trim()
      if (!trimmed) return
      if (isBusy(get().timeline)) {
        await get().steer(trimmed)
        return
      }
      await get().startRun(trimmed)
    },

    startRun: async (text) => {
      const trimmed = text.trim()
      if (!trimmed) return
      idleStrikes = 0
      const startedAt = Date.now()
      set((state) => ({
        timeline: {
          ...state.timeline,
          blocks: [
            ...state.timeline.blocks,
            { kind: 'user', id: uid('user'), ts: Date.now(), text: trimmed },
          ],
          status: 'streaming',
          activity: '已提交，等待宿主响应',
          lastError: undefined,
          stalled: false,
        },
      }))
      try {
        await get().send({ method: 'prompt', params: { message: trimmed } })
      } catch {
        // 这一轮可能根本没发出去（桥断了 / 宿主拒绝）。对账也走同一座桥，桥断了
        // 它同样叫不醒界面 —— 所以这里必须自己收尾，否则又是「生成中就没有后续」。
        // 只有当**这一轮一帧都没来过**才敢这么判：帧来了说明宿主其实收到了。
        const timeline = get().timeline
        if ((timeline.lastFrameAt ?? 0) >= startedAt) return
        set((state) => ({
          timeline: {
            ...state.timeline,
            status: state.timeline.status === 'streaming' ? 'idle' : state.timeline.status,
            activity: '空闲',
            stalled: false,
          },
        }))
      }
    },

    steer: async (text) => {
      const trimmed = text.trim()
      if (!trimmed) return
      idleStrikes = 0
      const entry: QueuedMessage = { id: uid('queue'), text: trimmed, mode: 'steer', at: Date.now() }
      const blockId = uid('user')
      set((state) => ({
        queue: [...state.queue, entry],
        timeline: {
          ...state.timeline,
          blocks: [
            ...state.timeline.blocks,
            { kind: 'user', id: blockId, ts: entry.at, text: trimmed, queued: 'steer' },
          ],
          activity: '已插话，等待模型接收',
        },
      }))
      try {
        await get().send({ method: 'steer', params: { message: trimmed } })
      } catch (error) {
        if (!isIdleHostError(error)) {
          // 其它失败（离线、宿主报错）已经由 `send` 弹了 toast：把排队标记撤掉，
          // 但**保留**用户那条消息，免得输入凭空消失。
          set((state) => ({ queue: state.queue.filter((item) => item.id !== entry.id) }))
          return
        }
        // 宿主说没有在跑的一轮：插话永远不会被消费（这正是「插入也不回去」）。
        // 撤回这条插队记录，当成一轮新消息发出去 —— 用户的期待是「我说了，它就该回」。
        set((state) => ({
          queue: state.queue.filter((item) => item.id !== entry.id),
          timeline: {
            ...state.timeline,
            blocks: state.timeline.blocks.filter((block) => block.id !== blockId),
          },
        }))
        toast.info({
          title: '本轮已经结束，改为直接发送',
          description: '宿主没有在跑的一轮时，插话不会被消费',
        })
        await get().startRun(trimmed)
        return
      }
      set((state) => ({ queue: state.queue.filter((item) => item.id !== entry.id) }))
    },

    followUp: async (text) => {
      const trimmed = text.trim()
      if (!trimmed) return
      idleStrikes = 0
      const entry: QueuedMessage = {
        id: uid('queue'),
        text: trimmed,
        mode: 'follow_up',
        at: Date.now(),
      }
      const blockId = uid('user')
      set((state) => ({
        queue: [...state.queue, entry],
        timeline: {
          ...state.timeline,
          blocks: [
            ...state.timeline.blocks,
            { kind: 'user', id: blockId, ts: entry.at, text: trimmed, queued: 'follow_up' },
          ],
          activity: '已加入排队',
        },
      }))
      try {
        await get().send({ method: 'follow_up', params: { message: trimmed } })
      } catch (error) {
        if (!isIdleHostError(error)) {
          set((state) => ({ queue: state.queue.filter((item) => item.id !== entry.id) }))
          return
        }
        set((state) => ({
          queue: state.queue.filter((item) => item.id !== entry.id),
          timeline: {
            ...state.timeline,
            blocks: state.timeline.blocks.filter((block) => block.id !== blockId),
          },
        }))
        toast.info({
          title: '本轮已经结束，改为直接发送',
          description: '宿主没有在跑的一轮时，排队消息不会被消费',
        })
        await get().startRun(trimmed)
        return
      }
      set((state) => ({ queue: state.queue.filter((item) => item.id !== entry.id) }))
    },

    reconcile: async () => {
      const timeline = get().timeline
      if (!isBusy(timeline)) {
        idleStrikes = 0
        return
      }
      // 1) 卡死提示：宿主心跳/本地时间都在这里，只有这里能判断「多久没动静了」。
      const silentFor = Date.now() - (timeline.lastFrameAt ?? Date.now())
      if (timeline.status === 'streaming' && silentFor > STALL_AFTER_MS) {
        set((state) => ({
          timeline: markStalled(
            state.timeline,
            `已 ${Math.round(silentFor / 1000)} 秒没有新输出，本轮可能卡住`,
          ),
        }))
      }
      // 2) 对账：界面锁着但宿主没有在跑的一轮 → 结束帧丢了，必须自己解锁。
      let host: HostInfo
      try {
        host = await BRIDGE.info()
      } catch {
        return // 连接问题由 transport 事件负责提示，这里不要重复报错
      }
      set({ host })
      const current = useSession.getState().timeline
      if (!isBusy(current)) {
        idleStrikes = 0
        return
      }
      if (host.busy !== false) {
        idleStrikes = 0
        return
      }
      // 宿主自己也安静了才敢解锁：`busy` 在「出错后紧跟重试」的窗口里会短暂变回
      // false，而那一轮其实还在跑。用宿主上报的 lastFrameAt 而不是本地时间戳，
      // 免得把「帧在路上」误当成「没有帧」。
      const hostSilentFor = host.lastFrameAt ? Date.now() - host.lastFrameAt : silentFor
      if (hostSilentFor < IDLE_SETTLE_MS) {
        idleStrikes = 0
        return
      }
      idleStrikes += 1
      if (idleStrikes < IDLE_STRIKES_TO_UNLOCK) return
      idleStrikes = 0
      set((state) => ({
        timeline: applyHostIdle(
          state.timeline,
          '宿主已空闲，但界面还在等这一轮：结束帧可能丢了（或被中止后没有回执），已解除锁定。',
        ),
      }))
      toast.warn({
        title: '已解除「生成中」锁定',
        description: '宿主报告本轮已结束，但没有收到结束帧',
      })
    },

    abort: async () => {
      idleStrikes = 0
      // Give immediate feedback.  Previously this only changed *after* the
      // host reply, so a congested pipe made the button look completely dead.
      set((state) => ({
        timeline: { ...state.timeline, activity: '正在中止…', stalled: false },
      }))
      try {
        await get().send({ method: 'abort' }, { silent: true })
      } catch (error) {
        set((state) => ({
          timeline: { ...state.timeline, activity: '中止请求未确认', stalled: true },
        }))
        fail(error, '中止运行')
      }
    },

    compact: async () => {
      await get().send({ method: 'compact' })
    },

    answerPermission: async (id, decision, reason) => {
      const timeline = applyPermissionDecision(useSession.getState().timeline, id, decision)
      set({ timeline })
      // The request is locally resolved, so its pinned toast goes away immediately
      // rather than waiting for the host to confirm.
      syncPermissionToasts(timeline.permissions.map((request) => request.id))
      try {
        await get().send({
          method: 'permission.answer',
          params: { id, decision, reason },
        })
      } catch (error) {
        fail(error, '提交授权结果')
      }
    },

    setPermissionMode: async (mode) => {
      await get().send({ method: 'permission.set', params: { mode } })
      await get().refreshHost()
      if (mode === 'full-access') {
        toast.warn({ title: '已切换到完全访问', description: '宿主钩子仍可拦截危险调用' })
      } else {
        toast.info({ title: `权限模式已切换为 ${mode}` })
      }
    },

    setThinking: async (level) => {
      await get().send({ method: 'thinking.set', params: { level } })
      set((state) =>
        state.host ? { host: { ...state.host, thinkingLevel: level } } : {},
      )
    },

    selectModel: async (reference) => {
      await get().send({ method: 'model.select', params: { reference } })
      await get().refreshHost()
    },

    setTrust: async (trusted) => {
      await get().send({ method: 'trust.set', params: { trusted } })
      await get().refreshHost()
    },

    changeCwd: async (cwd) => {
      await get().send({ method: 'cwd.change', params: { cwd } })
      await get().refreshHost()
      await get().refreshSessions()
    },

    openSession: async (id) => {
      const state = get()
      const selected = state.sessions.find((session) => session.id === id || session.file === id)
      const hostFile = normalizedSessionPath(state.host?.sessionFile)
      const selectedFile = normalizedSessionPath(selected?.file ?? id)
      // Reopening the active row used to reach runtime.switch_session(), whose
      // replacement semantics abort the current run. Clicking the current
      // conversation is navigation, not a request to restart its backend.
      const current = selected?.live === true || (hostFile !== '' && selectedFile === hostFile)
      if (current) return
      await get().send({ method: 'sessions.open', params: { id } })
      // 宿主已经把「当前会话」换成打开的这条，标题栏/检查器/上下文占用都读
      // host.info，所以必须重新拉一次，否则页面还在显示上一条会话的文件名。
      await get().refreshHost()
      await get().refreshSessions()
    },

    newSession: async () => {
      await get().send({ method: 'sessions.new' })
      await get().refreshHost()
      await get().refreshSessions()
    },

    renameSession: async (id, title) => {
      const clean = title.trim()
      try {
        // 标题的事实来源是会话文件头部的 `_meta._label`（见 fox_serve/sessions.py），
        // 所以改名必须落到宿主，不能只改本地列表 —— 否则刷新一次就变回去了。
        await get().send({ method: 'sessions.rename', params: { id, title: clean } })
        await get().refreshSessions()
      } catch (error) {
        fail(error, '重命名会话')
        throw error
      }
    },

    forkSession: async (fromId) => {
      try {
        // 宿主的 `sessions.fork` 只作用于**当前** runtime，所以对列表里别的会话
        // 分叉 = 先切过去再 fork。切不过去（正在跑、cwd 不同）时直接抛出，让调用方
        // 看到失败而不是静默复制了另一条会话。
        if (fromId) {
          const target = get().sessions.find((session) => session.id === fromId || session.file === fromId)
          if (!target) throw new Error(`找不到会话：${fromId}`)
          if (target.live !== true) await get().openSession(target.id)
        }
        await get().send({ method: 'sessions.fork', params: {} })
        await get().refreshHost()
        await get().refreshSessions()
        toast.success({ title: '已创建分支会话' })
      } catch (error) {
        fail(error, '分叉会话')
        throw error
      }
    },

    deleteSession: async (id) => {
      try {
        // 宿主按设计拒绝删除「正在使用的会话」（`不能删除当前正在使用的会话`）。
        // 用户点删除的意思是「这条不要再出现了」，所以先切到一个新会话再删 —— 否则
        // 界面弹一句拒绝、列表还在、`json` 也还在，看起来就是「删了但文件没删」。
        const live = get().sessions.find((session) => session.id === id)?.live === true
        if (live) {
          await get().send({ method: 'sessions.new' })
          await get().refreshHost()
        }
        await get().send({ method: 'sessions.delete', params: { id } })
        set((state) => ({ sessions: state.sessions.filter((session) => session.id !== id) }))
        toast.success({ title: '会话已删除' })
        await get().refreshSessions()
      } catch (error) {
        fail(error, '删除会话')
        throw error
      }
    },

    setExtension: async (id, enabled, scope) => {
      try {
        await get().send({ method: 'extensions.set', params: { id, enabled, scope } })
        // 宿主会重载扩展并重新发 session_start，所以这里必须重新拉一次 host.info。
        await get().refreshHost()
        toast.success({
          title: enabled ? '扩展已启用' : '扩展已关闭',
          description: enabled ? '已写入扩展配置并热重载' : '已从扩展配置中移除',
        })
      } catch (error) {
        fail(error, enabled ? '启用扩展' : '关闭扩展')
        throw error
      }
    },

    runCommand: async (name, args) => {
      await get().send({ method: 'run_command', params: { name, arguments: args } })
      await get().refreshHost()
    },

    invokeSkill: async (name) => {
      await get().send({ method: 'invoke_skill', params: { name } })
    },

    exportSession: async (format) => {
      const file = get().host?.sessionFile ?? ''
      await get().send({ method: 'session.export', params: { format, path: file } })
      toast.success({ title: '会话已导出', description: file })
    },

    clearTimeline: () => {
      // A pinned approval toast from the previous session must not survive it.
      syncPermissionToasts([])
      set({ timeline: EMPTY_TIMELINE, queue: [] })
    },
    dropQueued: (id) => set((state) => ({ queue: state.queue.filter((q) => q.id !== id) })),
  }
})
