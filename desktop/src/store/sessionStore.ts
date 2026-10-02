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
  applyPlanDecision,
  markStalled,
  type TimelineState,
} from '@/store/timeline'
import { toast, useToasts } from '@/store/toastStore'
import { useFiles } from '@/store/filesStore'
import type {
  ExtensionScope,
  ExecutionMode,
  HostCommand,
  HostInfo,
  InteractionMode,
  PermissionDecision,
  PermissionMode,
  PlanDecision,
  PromptImage,
  SessionSummary,
  ThinkingLevel,
} from '@/types/protocol'

export interface QueuedMessage {
  id: string
  text: string
  attachments?: PromptImage[]
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
  prompt(text: string, attachments?: PromptImage[]): Promise<void>
  startRun(text: string, attachments?: PromptImage[]): Promise<boolean>
  steer(text: string, promoteFollowUps?: boolean, attachments?: PromptImage[]): Promise<void>
  followUp(text: string, attachments?: PromptImage[]): Promise<void>
  updateQueued(id: string, text: string): void
  steerQueued(id: string): Promise<void>
  drainQueue(): Promise<void>
  reconcile(): Promise<void>
  abort(): Promise<void>
  compact(): Promise<void>
  answerPermission(id: string, decision: PermissionDecision, reason?: string): Promise<void>
  setPermissionMode(mode: PermissionMode): Promise<void>
  setInteractionMode(mode: InteractionMode): Promise<void>
  setExecutionMode(mode: ExecutionMode): Promise<void>
  implementPlan(): Promise<void>
  answerPlan(id: string, decision: 'accept' | 'reject'): Promise<void>
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
  invokeSkill(name: string, instructions: string): Promise<void>
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

/**
 * 刚被 `drainQueue()` 摘出队列、正在发的那一条。
 *
 * 宿主接受请求之后仍然可能在**帧**里回一句「已经在跑」——那时 `startRun` 早就成功返回了，
 * 界面没有任何异常可抓。留着这条引用，收到那种错误帧就把它放回队首，而不是让用户的消息
 * 消失在一个红色气泡里。
 */
let lastDrained: QueuedMessage | null = null

/** 宿主/运行时「已经在跑另一轮了」的提示（`RuntimeError: Harness is already processing. ...`）。 */
function isAlreadyProcessingError(text: string | undefined): boolean {
  return !!text && /already processing|已经在处理|正在处理中/i.test(text)
}

/**
 * 把那条**没被执行**的用户气泡撤掉（`drainQueue()` 发早了才会用到）。
 *
 * 从后往前找最后一条同文本、且不是排队/插话标记的用户块：那正是 `startRun()` 刚加进去的。
 */
function dropUnsentUserBlock(timeline: TimelineState, text: string): TimelineState {
  let index = -1
  for (let i = timeline.blocks.length - 1; i >= 0; i -= 1) {
    const block = timeline.blocks[i]
    if (block.kind === 'user' && block.queued === undefined && block.text === text) {
      index = i
      break
    }
  }
  if (index < 0) return timeline
  return { ...timeline, blocks: timeline.blocks.filter((_, i) => i !== index) }
}

/** 宿主在「没有正在运行的一轮」时拒绝插话的提示（见 `fox_serve/host.py::_require_running`）。 */
function isIdleHostError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return message.includes('没有正在运行的一轮')
}

export function isBusyStatus(status: TimelineState['status']): boolean {
  return BUSY_STATUSES.has(status)
}

export function isBusy(timeline: TimelineState): boolean {
  return isBusyStatus(timeline.status)
}

function describe(command: HostCommand): string {
  return command.method
}

function normalizedSessionPath(value: string | null | undefined): string {
  return (value ?? '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
}

/**
 * The wire protocol spells commands as `/compact`, while every renderer
 * consumer adds the slash when displaying or parsing one. Normalize at every
 * bridge boundary: queue draining and reconciliation also refresh host info,
 * so doing this only in `refreshHost()` lets a background poll silently break
 * slash commands after the first queued message.
 */
function normalizeHost(host: HostInfo): HostInfo {
  return {
    ...host,
    commands: host.commands.map((command) => ({
      ...command,
      name: command.name.replace(/^\//, ''),
    })),
  }
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
        // The renderer often mounts while the Python child is still importing.
        // Its eager host.info then fails once; the authoritative ready event is
        // the retry signal.  Without this, the bridge works but the whole UI
        // remains stuck on "offline" until a full reload or manual action.
        if (status.state === 'ready' && previous !== 'ready') {
          void Promise.allSettled([get().refreshHost(), get().refreshSessions()])
        }
      })

      BRIDGE.onFrame((frame) => {
        // 刚刚放出去的那条撞上了「已经在跑」：这是我们自己发早了（界面状态慢半拍），
        // 不是一次真实失败。**不要**把这帧当错误画出来 —— 把那条消息收回队列、
        // 撤掉它的用户气泡，等宿主真空闲再发（见 `lastDrained`）。
        if (frame.type === 'error' && isAlreadyProcessingError(frame.error) && lastDrained) {
          const entry = lastDrained
          lastDrained = null
          set((state) =>
            state.queue.some((item) => item.id === entry.id)
              ? state
              : {
                  queue: [entry, ...state.queue],
                  timeline: dropUnsentUserBlock(state.timeline, entry.text),
                },
          )
          toast.info({
            title: '这条消息还在排队',
            description: '宿主刚才还在跑上一轮，等它空下来再发',
          })
          return
        }
        const timeline = applyFrame(useSession.getState().timeline, frame)
        set({ timeline })
        syncPermissionToasts(timeline.permissions.map((request) => request.id))
        if (frame.type === 'agent_end') {
          void get().refreshHost()
          // Session rows carry their own `running` bit. Keeping a stale true
          // value until the next polling tick can wrongly block an immediate
          // workspace switch after a run finishes.
          void get().refreshSessions()
          void useFiles.getState().refresh()
        }
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
        const host = normalizeHost(await BRIDGE.info())
        /*
          `fox serve` 的命令名带前导斜杠（`/new`），而界面各处（补全、命令面板、技能页）
          都是「自己补一个斜杠」来显示的：不在这里归一化，真实宿主下会显示成 `//new`，
          并且手敲的 `/new` 匹配不上命令表、被当成普通提问发出去。
        */
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

    prompt: async (text, attachments = []) => {
      const trimmed = text.trim()
      if (!trimmed && attachments.length === 0) return
      if (isBusy(get().timeline)) {
        await get().followUp(trimmed, attachments)
        return
      }
      await get().startRun(trimmed, attachments)
    },

    startRun: async (text, attachments = []) => {
      const trimmed = text.trim()
      if (!trimmed && attachments.length === 0) return false
      idleStrikes = 0
      const startedAt = Date.now()
      set((state) => ({
        timeline: {
          ...state.timeline,
          blocks: [
            ...state.timeline.blocks,
            { kind: 'user', id: uid('user'), ts: Date.now(), text: trimmed, images: attachments },
          ],
          status: 'streaming',
          activity: '已提交，等待宿主响应',
          lastError: undefined,
          stalled: false,
        },
      }))
      try {
        await get().send({
          method: 'prompt',
          params: { message: trimmed, options: { attachments } },
        })
        await get().refreshHost()
        return true
      } catch {
        // 这一轮可能根本没发出去（桥断了 / 宿主拒绝）。对账也走同一座桥，桥断了
        // 它同样叫不醒界面 —— 所以这里必须自己收尾，否则又是「生成中就没有后续」。
        // 只有当**这一轮一帧都没来过**才敢这么判：帧来了说明宿主其实收到了。
        const timeline = get().timeline
        if ((timeline.lastFrameAt ?? 0) >= startedAt) return true
        set((state) => ({
          timeline: {
            ...state.timeline,
            status: state.timeline.status === 'streaming' ? 'idle' : state.timeline.status,
            activity: '空闲',
            stalled: false,
          },
        }))
        return false
      }
    },

    steer: async (text, promoteFollowUps = false, attachments = []) => {
      const trimmed = text.trim()
      if (!trimmed && attachments.length === 0) return
      idleStrikes = 0
      const at = Date.now()
      const blockId = uid('user')
      // 插队**不进** `queue`：那个数组现在就是输入框上方那排小框，插队是立刻发出去的，
      // 在框里出现一下再消失只会闪一下。失败与否都看 timeline 里那条「插话中」。
      set((state) => ({
        timeline: {
          ...state.timeline,
          blocks: [
            ...state.timeline.blocks.map((block) =>
              promoteFollowUps && block.kind === 'user' && block.queued === 'follow_up'
                ? { ...block, queued: 'steer' as const }
                : block,
            ),
            { kind: 'user', id: blockId, ts: at, text: trimmed, images: attachments, queued: 'steer' },
          ],
          activity: promoteFollowUps ? '正在插话发送全部排队消息' : '已插话，等待模型接收',
        },
      }))
      try {
        await get().send({
          method: 'steer',
          params: {
            message: trimmed,
            ...(attachments.length ? { attachments } : {}),
            promoteFollowUps,
            interrupt: promoteFollowUps,
          },
        })
      } catch (error) {
        if (!isIdleHostError(error)) {
          // 其它失败（离线、宿主报错）已经由 `send` 弹了 toast：**保留**用户那条消息，
          // 免得输入凭空消失。
          return
        }
        // 宿主说没有在跑的一轮：插话永远不会被消费（这正是「插入也不回去」）。
        // 撤回这条插队记录，当成一轮新消息发出去 —— 用户的期待是「我说了，它就该回」。
        set((state) => ({
          timeline: {
            ...state.timeline,
            blocks: state.timeline.blocks.filter((block) => block.id !== blockId),
          },
        }))
        toast.info({
          title: '本轮已经结束，改为直接发送',
          description: '宿主没有在跑的一轮时，插话不会被消费',
        })
        await get().startRun(trimmed, attachments)
      }
    },

    /**
     * 排队：只放在本机的队列里（输入框上方那些小框），不碰宿主。
     *
     * 之前这里直接发 `follow_up` 给宿主 —— 消息一进宿主的队列就改不了了，而排队
     * 小框要能改、能删、能提前插队。所以现在**本机排队**，等这一轮结束由
     * `drainQueue()` 逐条作为新一轮 prompt 发出去（正好就是「这个任务完成后接着
     * 下一个任务」）。插队仍然走 `steer`（宿主侧中断当前请求后消费 steering 队列）。
     */
    followUp: async (text, attachments = []) => {
      const trimmed = text.trim()
      if (!trimmed && attachments.length === 0) return
      idleStrikes = 0
      const entry: QueuedMessage = {
        id: uid('queue'),
        text: trimmed,
        attachments,
        mode: 'follow_up',
        at: Date.now(),
      }
      set((state) => ({
        queue: [...state.queue, entry],
        timeline: { ...state.timeline, activity: '已加入排队' },
      }))
    },

    updateQueued: (id, text) => {
      const trimmed = text.trim()
      if (!trimmed) return
      set((state) => ({
        queue: state.queue.map((item) => (item.id === id ? { ...item, text: trimmed } : item)),
      }))
    },

    steerQueued: async (id) => {
      const entry = get().queue.find((item) => item.id === id)
      if (!entry) return
      set((state) => ({ queue: state.queue.filter((item) => item.id !== id) }))
      await get().steer(entry.text, true, entry.attachments)
    },

    /**
     * 一轮结束后把队首那条发出去。
     *
     * 一次只放一条：多条一起 `prompt` 会被宿主当成一轮里的同一句话，而用户要的是
     * 「接着下一个任务」。发失败（宿主其实还没空）时放回队首，等下一次空闲重试。
     *
     * **发之前必须问宿主忙不忙**：界面自己的状态会慢半拍（带工具的一轮中间也有
     * `turn_end`），真机上就是这样把排队消息发早了 —— 宿主回
     * `RuntimeError: Harness is already processing. Use steer() or follow_up(...)`，
     * 而请求本身是成功的（错误是**帧**不是请求异常），那条消息于是既没被执行、也
     * 从队列里消失了。宿主说忙就什么都别动，等下一个空闲窗口。
     */
    drainQueue: async () => {
      if (isBusy(get().timeline)) return
      const entry = get().queue[0]
      if (!entry) return
      try {
        const host = normalizeHost(await BRIDGE.info())
        set({ host })
        if (host.busy !== false) return
      } catch {
        return // 连不上宿主就先不发，等下一次空闲窗口
      }
      if (isBusy(get().timeline)) return
      // 期间可能被删/被插队/被改写：以此刻队列里的那一条为准。
      const fresh = get().queue.find((item) => item.id === entry.id)
      if (!fresh) return
      set((state) => ({ queue: state.queue.filter((item) => item.id !== fresh.id) }))
      lastDrained = fresh
      const sent = await get().startRun(fresh.text, fresh.attachments)
      lastDrained = null
      if (!sent) set((state) => ({ queue: [fresh, ...state.queue] }))
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
        host = normalizeHost(await BRIDGE.info())
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

    setInteractionMode: async (mode) => {
      await get().send({ method: 'interaction.set', params: { mode } })
      await get().refreshHost()
      toast.info({ title: `已切换到 ${mode === 'plan' ? '计划' : mode === 'default' ? '执行' : '自动'}模式` })
    },

    setExecutionMode: async (mode) => {
      await get().send({ method: 'execution.set', params: { mode } })
      await get().refreshHost()
      const host = get().host
      if (mode === 'sandbox' && host && !host.sandbox.shell) {
        toast.warn({
          title: '已启用文件沙盒',
          description: '当前系统缺少原生进程沙盒，shell 工具将被禁用。',
        })
      } else {
        toast.info({ title: mode === 'sandbox' ? '已切换到沙盒执行' : '已切换到本机执行' })
      }
    },

    implementPlan: async () => {
      if (isBusy(get().timeline)) return
      // Auto mode can route the explicit implementation request itself; keep
      // the user's automatic preference. Manual Plan mode must be left first.
      if (get().host?.interactionMode === 'plan') {
        await get().setInteractionMode('default')
      }
      await get().prompt('请按照上一条计划开始实施。')
    },

    answerPlan: async (id, decision) => {
      const resolved: PlanDecision = decision === 'accept' ? 'accepted' : 'rejected'
      set((state) => ({ timeline: applyPlanDecision(state.timeline, id, resolved) }))
      try {
        await get().send({ method: 'plan.answer', params: { id, decision } })
        if (decision === 'accept') await get().refreshHost()
      } catch (error) {
        set((state) => ({
          timeline: {
            ...state.timeline,
            blocks: state.timeline.blocks.map((block) =>
              block.kind === 'plan' && block.toolCallId === id
                ? { ...block, decision: undefined }
                : block,
            ),
          },
        }))
        fail(error, '提交计划选择')
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

    invokeSkill: async (name, instructions) => {
      try {
        await get().send({ method: 'invoke_skill', params: { name, instructions } })
      } catch (error) {
        fail(error, `调用技能 ${name}`)
        throw error
      }
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
