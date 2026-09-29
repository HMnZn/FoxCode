import { formatTokens, uid } from '@/lib/format'
import type {
  AssistantMessage,
  HostFrame,
  Message,
  PermissionDecision,
  PermissionRequest,
  ToolStatus,
  Usage,
} from '@/types/protocol'
import { EMPTY_TOTALS, type UsageTotals } from '@/types/protocol'

/* ------------------------------------------------------------------ */
/* Timeline model                                                      */
/* ------------------------------------------------------------------ */

export interface UserBlock {
  kind: 'user'
  id: string
  ts: number
  text: string
  queued?: 'steer' | 'follow_up'
}

export interface AssistantBlock {
  kind: 'assistant'
  id: string
  ts: number
  text: string
  thinking: string
  thinkingStreaming: boolean
  textStreaming: boolean
  startedAt: number
  thinkingMs?: number
  usage?: Usage
  model?: string
  stopReason?: string
  error?: string
}

export interface ToolCallState {
  id: string
  name: string
  args: Record<string, unknown>
  status: ToolStatus
  startedAt: number
  endedAt?: number
  /** Progressive `tool_execution_update.partial_result` lines. */
  updates: string[]
  result?: string
  isError?: boolean
  /** Live context occupied by an isolated child agent running in this tool call. */
  childContext?: {
    contextTokens: number
    outputTokens: number
    estimated: boolean
  }
  permissionId?: string
  decision?: PermissionDecision
}

export interface ToolsBlock {
  kind: 'tools'
  id: string
  ts: number
  calls: ToolCallState[]
}

export interface NoticeBlock {
  kind: 'notice'
  id: string
  ts: number
  tone: 'info' | 'success' | 'warn' | 'danger'
  title: string
  description?: string
}

export type Block = UserBlock | AssistantBlock | ToolsBlock | NoticeBlock

export type RunStatus =
  | 'idle'
  | 'streaming'
  | 'awaiting-approval'
  | 'compacting'
  | 'error'
  | 'closed'

/**
 * 当前**上下文占用**（不是累计用量）。
 *
 * 累计 `totals` 只增不减，所以压缩之后用它算「已用」是错的；这里单独跟踪一个
 * 会下降的数字：优先取最近一轮 assistant 消息的 `usage.totalTokens`
 * （fox_ai 里 `total_tokens = input + output + cache_read + cache_write`，
 * `input` 已扣掉缓存），压缩帧给出前后数字时以压缩后的为准。
 */
export interface ContextUsage {
  used: number
  input: number
  cacheRead: number
  cacheWrite: number
  output: number
  /** 上下文窗口大小；未知时为 0，UI 用默认值兜底。 */
  limit: number
  source: 'none' | 'usage' | 'compaction' | 'host'
  /**
   * 当前运行中的隔离子 agent 上下文。它不属于父 agent 的模型上下文，
   * 状态栏会单独标注，子 agent 结束后归零。
   *
   * token 估算由 Python coding backend 负责，前端不再重复分词/按字符计数。
   */
  live?: number
  updatedAt?: number
}

export const EMPTY_CONTEXT: ContextUsage = {
  used: 0,
  input: 0,
  cacheRead: 0,
  cacheWrite: 0,
  output: 0,
  limit: 0,
  source: 'none',
  live: 0,
}

export interface TimelineState {
  blocks: Block[]
  status: RunStatus
  /** Truncated description of the current activity, shown in the status bar. */
  activity: string
  totals: UsageTotals
  /** 当前上下文占用（压缩后会下降）。 */
  context: ContextUsage
  permissions: PermissionRequest[]
  decisions: Record<string, PermissionDecision>
  /**
   * 正在流式累积的 assistant 块 id。
   *
   * 以前靠 `lastAssistant()` 从尾部找 assistant 块，工具批次之后它会找到**工具之前**
   * 那条块，于是下一轮的文字被并回上一轮（工具卡反而跑到了文字后面）。改用这个指针：
   * 只有它指向的块（且其后没有工具批次）才会继续吃 delta。
   */
  streaming?: string
  lastError?: string
  /** 最近收到一帧的时间。**没有帧**才是卡死的唯一可靠信号（见 `sessionStore.reconcile`）。 */
  lastFrameAt?: number
  /** 长时间没有任何帧：界面上要明确显示「可能卡住了」并给出中止入口。 */
  stalled?: boolean
}

export const EMPTY_TIMELINE: TimelineState = {
  blocks: [],
  status: 'idle',
  activity: '空闲',
  totals: EMPTY_TOTALS,
  context: EMPTY_CONTEXT,
  permissions: [],
  decisions: {},
}

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

/**
 * 取「当前正在流式输出」的 assistant 块，没有就新建一个。
 *
 * 注意工具批次之后**不**复用旧块：即使宿主没发 `message_start`，工具卡后面的文字
 * 也必须落到新块里。
 */
function streamingAssistant(
  state: TimelineState,
  ts: number,
): { state: TimelineState; block: AssistantBlock } {
  const index = state.streaming
    ? state.blocks.findIndex((block) => block.kind === 'assistant' && block.id === state.streaming)
    : -1
  const toolsAfter = index >= 0 && state.blocks.slice(index + 1).some((block) => block.kind === 'tools')
  if (index >= 0 && !toolsAfter) {
    return { state, block: state.blocks[index] as AssistantBlock }
  }

  const block: AssistantBlock = {
    kind: 'assistant',
    id: uid('asst'),
    ts,
    text: '',
    thinking: '',
    thinkingStreaming: false,
    textStreaming: false,
    startedAt: ts,
  }
  return { state: { ...state, blocks: [...state.blocks, block], streaming: block.id }, block }
}

/** 最近一轮 usage 就是该轮结束时的上下文占用。 */
function contextFromUsage(usage: Usage, limit: number, ts: number): ContextUsage {
  return {
    used: usage.totalTokens ?? 0,
    input: usage.input,
    cacheRead: usage.cacheRead,
    cacheWrite: usage.cacheWrite,
    output: usage.output,
    limit,
    source: 'usage',
    // 权威数字到手 → 「实时估算」归零，否则进度条会在 used 与 used+live 之间反复横跳。
    live: 0,
    updatedAt: ts,
  }
}

/** 压缩后：整体占用换成压缩后的估值，各分项按比例缩一下（分项只是展示用）。 */
function contextFromCompaction(
  context: ContextUsage,
  post: number | undefined,
  pre: number | undefined,
  ts: number,
): ContextUsage {
  if (typeof post !== 'number') return context
  const scale = typeof pre === 'number' && pre > 0 ? post / pre : 1
  return {
    used: post,
    input: Math.round(context.input * scale),
    cacheRead: Math.round(context.cacheRead * scale),
    cacheWrite: Math.round(context.cacheWrite * scale),
    output: context.output,
    limit: context.limit,
    source: 'compaction',
    live: 0,
    updatedAt: ts,
  }
}

/** 压缩事件的展示文案（老宿主只给一行字符串时降级显示）。 */
function compactionText(frame: {
  preTokens?: number
  postTokens?: number
  removedCount?: number
  retainedCount?: number
  summary?: string
  result?: unknown
}): string | undefined {
  const parts: string[] = []
  if (typeof frame.preTokens === 'number' && typeof frame.postTokens === 'number') {
    parts.push(`上下文 ${formatTokens(frame.preTokens)} → ${formatTokens(frame.postTokens)} tokens`)
  } else if (typeof frame.preTokens === 'number') {
    parts.push(`压缩前 ${formatTokens(frame.preTokens)} tokens`)
  } else if (typeof frame.postTokens === 'number') {
    parts.push(`压缩后 ${formatTokens(frame.postTokens)} tokens`)
  }
  if (typeof frame.removedCount === 'number') parts.push(`移除 ${frame.removedCount} 条`)
  if (typeof frame.retainedCount === 'number') parts.push(`保留 ${frame.retainedCount} 条原文`)
  if (typeof frame.summary === 'string' && frame.summary.trim()) {
    parts.push(frame.summary.trim().slice(0, 400))
  }
  if (typeof frame.result === 'string' && frame.result.trim()) parts.push(frame.result.trim())
  return parts.length > 0 ? parts.join(' · ') : undefined
}

/** Apply the Python backend's live estimate; the renderer never counts text. */
function contextFromBackend(
  context: ContextUsage,
  snapshot: { context_tokens: number; output_tokens: number },
  ts: number,
): ContextUsage {
  return {
    ...context,
    used: Math.max(0, snapshot.context_tokens),
    output: Math.max(0, snapshot.output_tokens),
    source: 'host',
    live: 0,
    updatedAt: ts,
  }
}

/**
 * 用后端通过 `host.info.contextTokens` 返回的估算**补上**上下文占用。
 *
 * 只在还没有更权威的数字时生效：已经拿过最近一次请求的 usage 或压缩事件时，后端的粗估
 * （按字符数除以 4 得出的量级）不应该反过来盖掉它 —— 那会让进度条看起来在自己的数字上跳。
 */
export function applyHostContext(
  state: TimelineState,
  used: number | undefined,
  limit?: number,
): TimelineState {
  if (typeof used !== 'number' || used <= 0) {
    return typeof limit === 'number' && limit > 0
      ? { ...state, context: { ...state.context, limit } }
      : state
  }
  if (state.context.source !== 'none' && state.context.used > 0) {
    return typeof limit === 'number' && limit > 0
      ? { ...state, context: { ...state.context, limit } }
      : state
  }
  return {
    ...state,
    context: {
      ...state.context,
      used,
      limit: limit ?? state.context.limit,
      source: 'host',
      updatedAt: Date.now(),
    },
  }
}

function replaceBlock(blocks: Block[], id: string, patch: Partial<AssistantBlock>): Block[] {
  return blocks.map((block) =>
    block.kind === 'assistant' && block.id === id ? { ...block, ...patch } : block,
  )
}

function patchTool(
  blocks: Block[],
  toolCallId: string,
  patch: Partial<ToolCallState>,
): Block[] {
  return blocks.map((block) => {
    if (block.kind !== 'tools') return block
    if (!block.calls.some((call) => call.id === toolCallId)) return block
    return {
      ...block,
      calls: block.calls.map((call) => (call.id === toolCallId ? { ...call, ...patch } : call)),
    }
  })
}

function findTool(blocks: Block[], toolCallId: string): ToolCallState | undefined {
  for (const block of blocks) {
    if (block.kind !== 'tools') continue
    const call = block.calls.find((c) => c.id === toolCallId)
    if (call) return call
  }
  return undefined
}

function activeChildContextTokens(blocks: Block[]): number {
  return blocks.reduce((total, block) => {
    if (block.kind !== 'tools') return total
    return total + block.calls.reduce((sum, call) => {
      if (call.status !== 'running' && call.status !== 'approved') return sum
      return sum + (call.childContext?.contextTokens ?? 0)
    }, 0)
  }, 0)
}

function childContextFromDetails(details: Record<string, unknown> | undefined) {
  const value = details?.context_usage
  if (!value || typeof value !== 'object') return undefined
  const usage = value as Record<string, unknown>
  if (typeof usage.context_tokens !== 'number') return undefined
  return {
    contextTokens: Math.max(0, usage.context_tokens),
    outputTokens: typeof usage.output_tokens === 'number' ? Math.max(0, usage.output_tokens) : 0,
    estimated: usage.estimated !== false,
  }
}

function usageToTotals(totals: UsageTotals, usage: Usage | undefined, toolCalls = 0): UsageTotals {
  if (!usage && toolCalls === 0) return totals
  return {
    input: totals.input + (usage?.input ?? 0),
    output: totals.output + (usage?.output ?? 0),
    cacheRead: totals.cacheRead + (usage?.cacheRead ?? 0),
    cacheWrite: totals.cacheWrite + (usage?.cacheWrite ?? 0),
    reasoning: totals.reasoning + (usage?.reasoning ?? 0),
    totalTokens: totals.totalTokens + (usage?.totalTokens ?? 0),
    cost: totals.cost + (usage?.cost?.total ?? 0),
    turns: totals.turns + (usage ? 1 : 0),
    toolCalls: totals.toolCalls + toolCalls,
  }
}

function messageText(message: Message): string {
  if (message.role === 'user') {
    return message.content
      .map((part) => (part.type === 'text' ? part.text : ''))
      .join('')
      .trim()
  }
  if (message.role === 'assistant') {
    return message.content
      .map((part) => (part.type === 'text' ? part.text : ''))
      .join('')
  }
  return message.content.map((part) => part.text).join('\n')
}

/* ------------------------------------------------------------------ */
/* Reducer                                                             */
/* ------------------------------------------------------------------ */

/**
 * Fold one host frame into the timeline.
 *
 * Ordering rules that the host forces on us:
 *  - parallel tool batches (asyncio.TaskGroup) interleave start/update/end,
 *    so tool state is always keyed by `tool_call_id`;
 *  - an aborted run still emits `message_end` *and* `turn_end`/`agent_end`,
 *    so finalisation must be idempotent.
 */
export function applyFrame(state: TimelineState, frame: HostFrame): TimelineState {
  // 每一帧都是「还活着」的证据：心跳时间戳与「卡住」标记统一在这里更新，免得每个
  // 分支都要记一次（漏掉一个分支就会误报卡死）。
  return { ...foldFrame(state, frame), lastFrameAt: frame.ts, stalled: false }
}

/** 真正的折叠逻辑（`applyFrame` 只负责在结果上盖心跳标记）。 */
function foldFrame(state: TimelineState, frame: HostFrame): TimelineState {
  const ts = frame.ts

  switch (frame.type) {
    case 'session_start':
      return {
        ...EMPTY_TIMELINE,
        blocks: [
          {
            kind: 'notice',
            id: uid('notice'),
            ts,
            tone: 'info',
            title: '会话已打开',
            description: `${frame.cwd} · 权限模式 ${frame.permission} · ${frame.session_file}`,
          },
        ],
        activity: '空闲',
      }

    case 'session_shutdown':
      return {
        ...state,
        status: frame.reason === 'close' ? 'closed' : 'idle',
        activity: `会话已关闭（${frame.reason}）`,
      }

    case 'agent_start':
      return { ...state, status: 'streaming', activity: '模型生成中', lastError: undefined }

    case 'agent_end': {
      const blocks = state.blocks.map((block) =>
        block.kind === 'assistant' && (block.textStreaming || block.thinkingStreaming)
          ? { ...block, textStreaming: false, thinkingStreaming: false }
          : block,
      )
      return { ...state, status: 'idle', activity: '空闲', blocks, streaming: undefined }
    }

    case 'turn_start':
      return {
        ...state,
        status: 'streaming',
        activity: '新一轮开始',
        totals: { ...state.totals, turns: state.totals.turns },
      }

    case 'turn_end': {
      const blocks = state.blocks.map((block) =>
        block.kind === 'assistant' && (block.textStreaming || block.thinkingStreaming)
          ? { ...block, textStreaming: false, thinkingStreaming: false }
          : block,
      )
      const hasPendingPermission = state.permissions.length > 0
      // 一轮结束 ≠ 整轮结束：带工具的一轮之后宿主马上还要跑下一轮（`agent_loop.py` 每个工具批次之间
      // 都发 `turn_end`，只有整轮跑完才发 `agent_end`）。这里以前写 `idle`，界面就在工具执行期间
      // 中途解锁，排队的消息被当成新 `prompt` 发出去，宿主回
      // `RuntimeError: Harness is already processing. Use steer() or follow_up(...)` —— 那条消息
      // 既没被执行，也从队列里消失了。所以这里只收掉「流式中」标记，状态交给 `agent_end`/`error`。
      return {
        ...state,
        blocks,
        status: hasPendingPermission
          ? 'awaiting-approval'
          : state.status === 'idle'
            ? 'idle'
            : 'streaming',
        activity: hasPendingPermission ? '等待授权' : '工具执行中',
      }
    }

    case 'message_start': {
      // 一条新消息开始 → 清掉「当前流式块」指针，下一条 delta 会开新块。
      if (frame.message?.role === 'assistant' && state.streaming) {
        return { ...state, streaming: undefined }
      }
      return state
    }

    case 'message_update': {
      const event = frame.assistant_message_event
      const backendContext = frame.context_usage
        ? contextFromBackend(state.context, frame.context_usage, ts)
        : state.context
      switch (event.type) {
        case 'toolcall_start':
        case 'toolcall_delta':
        case 'toolcall_end':
          return {
            ...state,
            activity: event.type === 'toolcall_end' ? '工具参数已就绪' : '正在生成工具参数…',
            context: backendContext,
          }
        case 'thinking_start':
        case 'text_start': {
          const { state: next, block } = streamingAssistant(state, ts)
          return {
            ...next,
            status: 'streaming',
            activity: event.type === 'thinking_start' ? '思考中' : '生成回答中',
            blocks: replaceBlock(next.blocks, block.id, {
              thinkingStreaming: event.type === 'thinking_start',
              textStreaming: event.type === 'text_start',
            }),
            context: backendContext,
          }
        }
        case 'thinking_delta': {
          const { state: next, block } = streamingAssistant(state, ts)
          const thinking = block.thinking + event.delta
          return {
            ...next,
            blocks: replaceBlock(next.blocks, block.id, {
              thinking,
              thinkingStreaming: true,
            }),
            activity: '思考中',
            context: backendContext,
          }
        }
        case 'text_delta': {
          const { state: next, block } = streamingAssistant(state, ts)
          const text = block.text + event.delta
          return {
            ...next,
            blocks: replaceBlock(next.blocks, block.id, {
              text,
              textStreaming: true,
              thinkingStreaming: false,
              thinkingMs: block.thinkingMs ?? (block.thinking ? ts - block.startedAt : undefined),
            }),
            activity: '生成回答中',
            context: backendContext,
          }
        }
        case 'text_end':
        case 'thinking_end': {
          const { state: next, block } = streamingAssistant(state, ts)
          return {
            ...next,
            blocks: replaceBlock(next.blocks, block.id, {
              textStreaming: false,
              thinkingStreaming: false,
            }),
            context: backendContext,
          }
        }
        case 'error':
          if (
            event.reason === 'aborted' &&
            state.blocks.some(
              (block) => block.kind === 'user' && block.queued === 'steer',
            )
          ) {
            return {
              ...state,
              status: 'streaming',
              activity: '正在处理插话',
              blocks: state.blocks.map((block) =>
                block.kind === 'assistant' && (block.textStreaming || block.thinkingStreaming)
                  ? { ...block, textStreaming: false, thinkingStreaming: false }
                  : block,
              ),
            }
          }
          return {
            ...state,
            status: 'error',
            lastError: event.message ?? event.reason,
            activity: event.reason === 'aborted' ? '已中止' : '生成失败',
            blocks: [
              ...state.blocks,
              {
                kind: 'notice',
                id: uid('notice'),
                ts,
                tone: event.reason === 'aborted' ? 'warn' : 'danger',
                title: event.reason === 'aborted' ? '已中止当前生成' : '模型返回错误',
                description: event.message ?? undefined,
              },
            ],
          }
        default:
          return state
      }
    }

    case 'message_end': {
      const message = frame.message
      if (message.role === 'user') {
        const text = messageText(message)
        const queuedIndex = state.blocks.findIndex(
          (block) => block.kind === 'user' && block.queued && block.text === text,
        )
        if (queuedIndex >= 0) {
          return {
            ...state,
            blocks: state.blocks.map((block, index) =>
              index === queuedIndex && block.kind === 'user'
                ? { ...block, queued: undefined }
                : block,
            ),
          }
        }
        const last = state.blocks[state.blocks.length - 1]
        if (last && last.kind === 'user' && last.text === text) return state
        return {
          ...state,
          blocks: [...state.blocks, { kind: 'user', id: uid('user'), ts, text }],
        }
      }
      if (message.role === 'assistant') {
        const text = messageText(message)
        const existing = state.streaming
          ? state.blocks.find(
              (block): block is AssistantBlock =>
                block.kind === 'assistant' && block.id === state.streaming,
            )
          : undefined
        const totals = usageToTotals(state.totals, message.usage)
        const context = message.usage
          ? contextFromUsage(message.usage, state.context.limit, ts)
          : state.context
        if (existing) {
          const settled: AssistantBlock = {
            ...existing,
            text: existing.text || text,
            textStreaming: false,
            thinkingStreaming: false,
            usage: message.usage ?? existing.usage,
            model: message.model ?? existing.model,
            stopReason: message.stopReason ?? existing.stopReason,
            error: message.stopReason === 'aborted'
              ? undefined
              : message.errorMessage ?? existing.error,
          }
          return {
            ...state,
            blocks: replaceBlock(state.blocks, existing.id, settled),
            totals,
            context,
            streaming: undefined,
            activity: '空闲',
          }
        }
        const block: AssistantBlock = {
          kind: 'assistant',
          id: uid('asst'),
          ts,
          text,
          thinking: '',
          thinkingStreaming: false,
          textStreaming: false,
          startedAt: ts,
          usage: message.usage,
          model: message.model,
          stopReason: message.stopReason,
          error: message.stopReason === 'aborted' ? undefined : message.errorMessage ?? undefined,
        }
        return {
          ...state,
          blocks: [...state.blocks, block],
          totals,
          context,
          streaming: undefined,
        }
      }
      // toolResult
      const childContext = childContextFromDetails(message.details ?? undefined)
      const patch: Partial<ToolCallState> = {
        result: messageText(message),
        isError: message.isError,
        status: message.isError ? 'error' : 'success',
        endedAt: ts,
        ...(childContext ? { childContext } : {}),
      }
      return { ...state, blocks: patchTool(state.blocks, message.toolCallId, patch) }
    }

    case 'tool_execution_start': {
      const existing = findTool(state.blocks, frame.tool_call_id)
      if (existing) {
        return {
          ...state,
          status: 'streaming',
          activity: `${frame.tool_name} 执行中`,
          blocks: patchTool(state.blocks, frame.tool_call_id, { status: 'running' }),
        }
      }
      // A fresh batch: any streaming assistant text belongs before the tools.
      const blocks = state.blocks.map((block) =>
        block.kind === 'assistant' && block.textStreaming
          ? { ...block, textStreaming: false }
          : block,
      )
      const pendingPermission = state.permissions.find((p) => p.tool_call_id === frame.tool_call_id)
      const call: ToolCallState = {
        id: frame.tool_call_id,
        name: frame.tool_name,
        args: frame.args ?? {},
        status: 'running',
        startedAt: ts,
        updates: [],
        permissionId: pendingPermission?.id,
        decision: pendingPermission ? state.decisions[pendingPermission.id] : undefined,
      }
      const last = blocks[blocks.length - 1]
      if (last && last.kind === 'tools') {
        const merged: ToolsBlock = { ...last, calls: [...last.calls, call] }
        return {
          ...state,
          blocks: [...blocks.slice(0, -1), merged],
          status: 'streaming',
          activity: `${frame.tool_name} 执行中`,
        }
      }
      return {
        ...state,
        blocks: [...blocks, { kind: 'tools', id: uid('tools'), ts, calls: [call] }],
        status: 'streaming',
        activity: `${frame.tool_name} 执行中`,
        totals: { ...state.totals, toolCalls: state.totals.toolCalls + 1 },
      }
    }

    case 'tool_execution_update': {
      const existing = findTool(state.blocks, frame.tool_call_id)
      if (!existing) return state
      const line =
        typeof frame.partial_result === 'string'
          ? frame.partial_result
          : JSON.stringify(frame.partial_result)
      const childContext = childContextFromDetails(frame.details)
      const updates = existing.updates.at(-1) === line
        ? existing.updates
        : [...existing.updates, line]
      const blocks = patchTool(state.blocks, frame.tool_call_id, {
        updates,
        ...(childContext ? { childContext } : {}),
      })
      return {
        ...state,
        blocks,
        context: childContext
          ? { ...state.context, live: activeChildContextTokens(blocks), updatedAt: ts }
          : state.context,
      }
    }

    case 'tool_execution_end': {
      const existing = findTool(state.blocks, frame.tool_call_id)
      const denied = existing?.decision === 'deny'
      const result =
        typeof frame.result === 'string' ? frame.result : safeStringify(frame.result)
      const status: ToolStatus = denied ? 'blocked' : frame.is_error ? 'error' : 'success'
      const childContext = childContextFromDetails(frame.details)
      const blocks = patchTool(state.blocks, frame.tool_call_id, {
        status,
        result,
        isError: frame.is_error,
        endedAt: ts,
        ...(childContext ? { childContext } : {}),
      })
      return {
        ...state,
        activity: '空闲',
        blocks,
        context: { ...state.context, live: activeChildContextTokens(blocks), updatedAt: ts },
        totals:
          existing && existing.status !== 'success' && status === 'success'
            ? state.totals
            : state.totals,
      }
    }

    case 'compaction_start':
      return {
        ...state,
        status: 'compacting',
        activity: '压缩上下文中',
        context:
          typeof frame.preTokens === 'number'
            ? { ...state.context, used: frame.preTokens, live: 0, source: 'host', updatedAt: ts }
            : state.context,
        blocks: [
          ...state.blocks,
          {
            kind: 'notice',
            id: uid('notice'),
            ts,
            tone: 'info',
            title: '上下文压缩已开始',
            description: '历史消息将被摘要替换，最近若干条原文保留',
          },
        ],
      }

    case 'compaction_update':
      return {
        ...state,
        status: 'compacting',
        activity:
          typeof frame.summaryTokens === 'number'
            ? `压缩上下文中 · 摘要 ${formatTokens(frame.summaryTokens)} tokens`
            : '压缩上下文中',
      }

    case 'compaction_end': {
      const context = contextFromCompaction(
        state.context,
        typeof frame.postTokens === 'number' ? frame.postTokens : undefined,
        typeof frame.preTokens === 'number' ? frame.preTokens : undefined,
        ts,
      )
      return {
        ...state,
        status: 'idle',
        activity: '空闲',
        context,
        blocks: [
          ...state.blocks,
          {
            kind: 'notice',
            id: uid('notice'),
            ts,
            tone: 'success',
            title: '上下文压缩完成',
            description: compactionText(frame),
          },
        ],
      }
    }

    case 'compaction_error':
      return {
        ...state,
        status: 'error',
        blocks: [
          ...state.blocks,
          {
            kind: 'notice',
            id: uid('notice'),
            ts,
            tone: 'danger',
            title: '上下文压缩失败',
            description: frame.error,
          },
        ],
      }

    case 'context_overflow_retry':
    case 'model_retry':
      return {
        ...state,
        activity: frame.type === 'model_retry' ? '模型重试中' : '上下文溢出，重试中',
        blocks: [
          ...state.blocks,
          {
            kind: 'notice',
            id: uid('notice'),
            ts,
            tone: 'warn',
            title: frame.type === 'model_retry' ? '模型调用重试' : '上下文溢出自动重试',
            description: frame.message ?? (frame.attempt ? `第 ${frame.attempt} 次` : undefined),
          },
        ],
      }

    case 'error':
      return {
        ...state,
        status: 'error',
        lastError: frame.error,
        blocks: [
          ...state.blocks,
          {
            kind: 'notice',
            id: uid('notice'),
            ts,
            tone: 'danger',
            title: '宿主返回错误',
            description: frame.error,
          },
        ],
      }

    default:
      return state
  }
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

/**
 * 宿主报告「当前没有在跑的一轮」时，把界面从「生成中」解开。
 *
 * 结束帧丢一次就足以让界面永远停在「生成中」（用户只能重启应用），所以对账以宿主的
 * `host.info.busy` 为准；但这里**不静默**改状态 —— 追加一条说明，用户能看懂发生了什么。
 */
export function applyHostIdle(
  state: TimelineState,
  reason: string,
  ts = Date.now(),
): TimelineState {
  const blocks = state.blocks.map((block) =>
    block.kind === 'assistant' && (block.textStreaming || block.thinkingStreaming)
      ? { ...block, textStreaming: false, thinkingStreaming: false }
      : block,
  )
  return {
    ...state,
    blocks: [
      ...blocks,
      {
        kind: 'notice',
        id: uid('notice'),
        ts,
        tone: 'warn',
        title: '已自动解锁',
        description: reason,
      },
    ],
    status: 'idle',
    activity: '空闲',
    streaming: undefined,
    stalled: false,
  }
}

/**
 * 标记「很久没有新帧了」。
 *
 * 只改文案与 `stalled`：真正的判断（多久算久）在 `sessionStore.reconcile`，因为只有
 * 那里同时知道宿主心跳与本地时间。
 */
export function markStalled(state: TimelineState, message: string): TimelineState {
  if (state.stalled === true && state.activity === message) return state
  return { ...state, stalled: true, activity: message }
}

/** Attach an incoming permission request to its tool card. */
export function applyPermissionRequest(
  state: TimelineState,
  request: PermissionRequest,
): TimelineState {
  const existing = findTool(state.blocks, request.tool_call_id)
  if (existing) {
    return {
      ...state,
      status: 'awaiting-approval',
      activity: '等待授权',
      permissions: [...state.permissions, request],
      blocks: patchTool(state.blocks, request.tool_call_id, {
        status: 'awaiting-approval',
        permissionId: request.id,
      }),
    }
  }
  const call: ToolCallState = {
    id: request.tool_call_id,
    name: request.tool_name,
    args: request.args,
    status: 'awaiting-approval',
    startedAt: request.ts,
    updates: [],
    permissionId: request.id,
  }
  const last = state.blocks[state.blocks.length - 1]
  const blocks: Block[] =
    last && last.kind === 'tools'
      ? [...state.blocks.slice(0, -1), { ...last, calls: [...last.calls, call] }]
      : [...state.blocks, { kind: 'tools', id: uid('tools'), ts: request.ts, calls: [call] }]
  return {
    ...state,
    blocks,
    status: 'awaiting-approval',
    activity: '等待授权',
    permissions: [...state.permissions, request],
  }
}

export function applyPermissionDecision(
  state: TimelineState,
  id: string,
  decision: PermissionDecision,
): TimelineState {
  const request = state.permissions.find((p) => p.id === id)
  return {
    ...state,
    permissions: state.permissions.filter((p) => p.id !== id),
    decisions: { ...state.decisions, [id]: decision },
    status: state.permissions.length > 1 ? 'awaiting-approval' : request ? 'streaming' : state.status,
    activity: decision === 'deny' ? '已拒绝，继续生成' : '已授权，执行中',
    blocks: request
      ? patchTool(state.blocks, request.tool_call_id, {
          status: decision === 'deny' ? 'blocked' : 'approved',
          decision,
        })
      : state.blocks,
  }
}

export function assistantUsageTotal(block: AssistantBlock): Usage | undefined {
  return block.usage
}

export function timelineMessageCount(blocks: Block[]): number {
  return blocks.filter((b) => b.kind === 'user' || b.kind === 'assistant').length
}

export type { AssistantMessage }
