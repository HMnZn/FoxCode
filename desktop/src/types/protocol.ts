/**
 * Wire protocol for the FoxCode desktop UI.
 *
 * This file mirrors — but does not import — the Python host schemas:
 *   packages/fox_ai/src/events.py            (stream events)
 *   packages/fox_ai/src/types.py             (content / usage / stop reasons)
 *   packages/fox_agent_core/src/types.py     (agent / turn / tool events)
 *   packages/fox_coding_agent/src/core/agent_session.py  (compaction, recovery)
 *   packages/fox_coding_agent/src/core/runtime.py        (lifecycle, mutators)
 *
 * Two deliberate differences from the host dataclasses:
 *   1. every envelope frame carries `seq` and `ts` (the host does not
 *      timestamp events, so the UI stamps them on arrival);
 *   2. only the *delta* of a stream event is transported, never the
 *      re-serialised partial message (the host deep-copies the whole
 *      partial per delta, which is O(n²) bytes over IPC).
 */

/* ------------------------------------------------------------------ */
/* Primitives                                                          */
/* ------------------------------------------------------------------ */

export const PROTOCOL_VERSION = 3 as const

export type PermissionMode = 'read-only' | 'workspace-modify' | 'full-access'
export type InteractionMode = 'auto' | 'default' | 'plan'
export type ExecutionMode = 'local' | 'sandbox'
export type EffectiveInteractionMode = 'default' | 'plan'
export type ThinkingLevel = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh'
export type StopReason = 'pending' | 'stop' | 'length' | 'toolUse' | 'error' | 'aborted'
export type StreamEndReason = 'stop' | 'length' | 'toolUse'
export type StreamErrorReason = 'aborted' | 'error'
export type ToolExecutionMode = 'parallel' | 'sequential'
export type ShutdownReason = 'reload' | 'switch' | 'fork' | 'close'
export type RecoveryKind = 'context_overflow_retry' | 'model_retry'

export const PERMISSION_MODES: PermissionMode[] = ['read-only', 'workspace-modify', 'full-access']
export const INTERACTION_MODES: InteractionMode[] = ['auto', 'default', 'plan']
export const EXECUTION_MODES: ExecutionMode[] = ['local', 'sandbox']
export const THINKING_LEVELS: ThinkingLevel[] = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh']

export const PERMISSION_LEVEL: Record<PermissionMode, number> = {
  'read-only': 0,
  'workspace-modify': 1,
  'full-access': 2,
}

export const PERMISSION_LABEL: Record<PermissionMode, string> = {
  'read-only': '只读',
  'workspace-modify': '工作区修改',
  'full-access': '完全访问',
}

export const PERMISSION_HINT: Record<PermissionMode, string> = {
  'read-only': '只能读取文件与搜索，任何写入/执行都会被拒绝',
  'workspace-modify': '可修改项目文件；本机 shell 与工作区外写入需要确认，沙盒 shell 可直接执行',
  'full-access': '可执行 shell 并写入任意路径（钩子仍可拦截）',
}

export const INTERACTION_LABEL: Record<InteractionMode, string> = {
  auto: '自动模式',
  default: '执行模式',
  plan: '计划模式',
}

export const EXECUTION_LABEL: Record<ExecutionMode, string> = {
  local: '本机执行',
  sandbox: '沙盒执行',
}

/* ------------------------------------------------------------------ */
/* Messages                                                            */
/* ------------------------------------------------------------------ */

export interface TextContent {
  type: 'text'
  text: string
}

export interface ThinkingContent {
  type: 'thinking'
  thinking: string
}

export interface ImageContent {
  type: 'image'
  /** Raw base64 bytes. The MIME is transported separately, matching fox_ai.ImageContent. */
  data: string
  mimeType: string
}

export interface ToolCallContent {
  type: 'toolCall'
  id: string
  name: string
  /** Validated against the tool's JSON schema by the host before dispatch. */
  arguments: Record<string, unknown>
  namespace?: string | null
}

export type Content = TextContent | ImageContent | ThinkingContent | ToolCallContent

export interface UsageCost {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  total: number
}

export interface Usage {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  reasoning?: number
  totalTokens: number
  cost: UsageCost
}

/** Live token accounting produced by the Python coding backend. */
export interface ContextUsageSnapshot {
  context_tokens: number
  output_tokens: number
  estimated: boolean
}

export const EMPTY_USAGE: Usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  reasoning: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
}

export interface UserMessage {
  role: 'user'
  content: Content[]
  timestamp?: number
}

export interface AssistantMessage {
  role: 'assistant'
  content: Content[]
  api?: string
  provider?: string
  model?: string
  responseModel?: string
  responseId?: string
  usage?: Usage
  stopReason?: StopReason
  errorMessage?: string | null
  timestamp?: number
}

export interface ToolResultMessage {
  role: 'toolResult'
  toolCallId: string
  toolName: string
  content: TextContent[]
  details?: Record<string, unknown> | null
  usage?: Usage
  isError: boolean
  timestamp?: number
}

export type Message = UserMessage | AssistantMessage | ToolResultMessage

/* ------------------------------------------------------------------ */
/* Fine-grained stream events (fox_ai)                                 */
/* ------------------------------------------------------------------ */

export type AssistantStreamEvent =
  | { type: 'start' }
  | { type: 'text_start'; content_index: number }
  | { type: 'text_delta'; content_index: number; delta: string }
  | { type: 'text_end'; content_index: number; content: string }
  | { type: 'thinking_start'; content_index: number }
  | { type: 'thinking_delta'; content_index: number; delta: string }
  | { type: 'thinking_end'; content_index: number; content: string }
  | { type: 'toolcall_start'; content_index: number; partial?: ToolCallContent | null }
  | { type: 'toolcall_delta'; content_index: number; delta: string; partial?: ToolCallContent | null }
  | { type: 'toolcall_end'; content_index: number; tool_call?: ToolCallContent | null }
  | { type: 'done'; reason: StreamEndReason }
  | { type: 'error'; reason: StreamErrorReason; message?: string | null }

/* ------------------------------------------------------------------ */
/* Host events (agent_core + coding-agent extras)                      */
/* ------------------------------------------------------------------ */

export type HostEvent =
  | { type: 'session_start'; session_file: string; cwd: string; permission: PermissionMode; execution?: ExecutionMode }
  | { type: 'session_shutdown'; reason: ShutdownReason }
  | { type: 'agent_start' }
  | { type: 'agent_end'; messages?: Message[] }
  | { type: 'turn_start' }
  | { type: 'turn_end'; message?: AssistantMessage; tool_results?: ToolResultMessage[] }
  | { type: 'message_start'; message?: Message }
  | {
      type: 'message_update'
      assistant_message_event: AssistantStreamEvent
      context_usage?: ContextUsageSnapshot
    }
  | { type: 'message_end'; message: Message }
  | {
      type: 'tool_execution_start'
      tool_call_id: string
      tool_name: string
      args: Record<string, unknown>
    }
  | {
      type: 'tool_execution_update'
      tool_call_id: string
      partial_result: unknown
      details?: Record<string, unknown>
    }
  | {
      type: 'tool_execution_end'
      tool_call_id: string
      tool_name: string
      result: unknown
      is_error: boolean
      details?: Record<string, unknown>
    }
  | { type: 'plan_decision'; tool_call_id: string; decision: PlanDecision }
  | { type: 'compaction_start'; automatic?: boolean; preTokens?: number }
  | {
      type: 'compaction_update'
      automatic?: boolean
      preTokens?: number
      summaryTokens?: number
    }
  | {
      type: 'compaction_end'
      automatic?: boolean
      /** 压缩前后的上下文占用（由 Python coding backend 计算）。 */
      preTokens?: number
      postTokens?: number
      summaryTokens?: number
      removedCount?: number
      retainedCount?: number
      summary?: string
      /** 演示宿主仍会发一行人类可读文本，作为降级显示。 */
      result?: unknown
    }
  | { type: 'compaction_error'; error?: string }
  | { type: 'context_overflow_retry'; attempt?: number; message?: string }
  | { type: 'model_retry'; attempt?: number; message?: string }
  | { type: 'error'; error: string }

/** Envelope actually shipped across the bridge. */
export type HostFrame = HostEvent & { seq: number; ts: number; v: typeof PROTOCOL_VERSION }

/* ------------------------------------------------------------------ */
/* Permission round-trip (host `before_tool_call` hook)                */
/* ------------------------------------------------------------------ */

export type PermissionDecision = 'allow-once' | 'allow-session' | 'deny'

export interface PermissionRequest {
  id: string
  ts: number
  tool_call_id: string
  tool_name: string
  args: Record<string, unknown>
  /** Permission the tool declares (`required_permission`), e.g. "full-access". */
  required: PermissionMode
  /** Current runtime mode at request time. */
  mode: PermissionMode
  cwd: string
  /** Why the static layer could not auto-approve. */
  reason: 'mode-insufficient' | 'outside-workspace' | 'policy' | 'always-ask'
  /** Path the tool would touch, when it declares `permission_paths`. */
  path?: string
  summary: string
  preview?: PermissionPreview
}

export interface PermissionPreview {
  kind: 'command' | 'diff' | 'path'
  /** For `command`: the exact shell string that will run. */
  command?: string
  /** For `diff`: unified diff hunks. */
  diff?: string
  /** For `path`: all affected paths. */
  paths?: string[]
}

export interface PermissionAnswer {
  id: string
  decision: PermissionDecision
  reason?: string
}

/* ------------------------------------------------------------------ */
/* Tool presentation                                                   */
/* ------------------------------------------------------------------ */

export type ToolStatus =
  | 'awaiting-approval'
  | 'approved'
  | 'running'
  | 'success'
  | 'error'
  | 'blocked'
  | 'aborted'

export const TOOL_STATUS_LABEL: Record<ToolStatus, string> = {
  'awaiting-approval': '等待授权',
  approved: '已授权',
  running: '执行中',
  success: '完成',
  error: '失败',
  blocked: '已拦截',
  aborted: '已中断',
}

/* ------------------------------------------------------------------ */
/* Host session metadata                                               */
/* ------------------------------------------------------------------ */

export interface ModelInfo {
  id: string
  provider: string
  displayName: string
  contextWindow?: number
  /** Registry value (`maxTokens` in models.json) — the model's own ceiling. */
  maxTokens?: number
  /**
   * The `max_tokens` actually sent with each request. Thinking and the answer
   * share it on providers whose thinking format is a body flag, so a long
   * thinking turn can exhaust it and truncate the reply. `undefined` means the
   * host did not report one (the provider's own default applies).
   */
  outputLimit?: number
  supportsThinking?: boolean
  supportsTools?: boolean
  costPerMTokIn?: number
  costPerMTokOut?: number
}

export interface SessionSummary {
  id: string
  file: string
  title: string
  cwd: string
  model?: string
  createdAt: number
  updatedAt: number
  messageCount: number
  totalTokens: number
  cost: number
  /** Present when the session is currently open in the runtime. */
  live?: boolean
  /** The session still has a model/tool run alive in a background runtime. */
  running?: boolean
}

export interface SkillInfo {
  name: string
  description: string
  source: string
  enabled: boolean
}

export interface CommandInfo {
  name: string
  description: string
  argumentHint?: string
}

/** 扩展从哪个作用域的 settings.json 生效（项目级有 `extensions` 键时它整体覆盖用户级）。 */
export type ExtensionScope = 'user' | 'project'

export interface ExtensionInfo {
  name: string
  path: string
  enabled: boolean
  hooks: string[]
  /** 配置里的原始 spec：`module:pkg.mod:setup` / `entrypoint:name` / 文件绝对路径。 */
  id?: string
  spec?: string
  kind?: 'module' | 'entrypoint' | 'file'
  /** 生效作用域（`enabled` 时）或将被写入的作用域（未启用时）。 */
  scope?: ExtensionScope
  /** 可发现来源：内置包 / 用户目录 / 项目目录。 */
  origin?: 'builtin' | 'user' | 'project'
  /** 另一个作用域也在列表里（被覆盖时才可能出现）。 */
  shadowed?: ExtensionScope[]
  description?: string
  /** 宿主的探测结论可用时为 true（文件扩展从不执行，所以恒为 false）。 */
  probed?: boolean
  tools?: string[]
  commands?: string[]
  services?: string[]
  contextTransforms?: string[]
  error?: string
}

export interface HostInfo {
  transport: 'mock' | 'sidecar'
  hostVersion: string
  protocolVersion: typeof PROTOCOL_VERSION
  cwd: string
  sessionFile: string
  permissionMode: PermissionMode
  executionMode: ExecutionMode
  sandbox: {
    backend: 'bubblewrap' | 'sandbox-exec' | 'file-policy' | string
    shell: boolean
    networkIsolated: boolean
    detail: string
  }
  interactionMode: InteractionMode
  effectiveInteractionMode: EffectiveInteractionMode
  thinkingLevel: ThinkingLevel
  model: ModelInfo
  availableModels: ModelInfo[]
  skills: SkillInfo[]
  commands: CommandInfo[]
  extensions: ExtensionInfo[]
  /** 可发现但当前没生效的扩展（`extensions.set` 可以打开它们）。 */
  availableExtensions?: ExtensionInfo[]
  projectTrusted: boolean
  /** True when a Python `fox serve` sidecar is reachable. */
  sidecarConnected: boolean
  /** 当前上下文占用的后端估算（sidecar 只转发）。 */
  contextTokens?: number
  /**
   * 宿主侧「还有一轮在跑」的权威答案。
   *
   * 前端只能从帧推断运行状态，可一旦结束帧丢了（或这一轮在模型请求里静默卡住），
   * 界面就永远停在「生成中」。所以每次 `host.info` 都带上这个标志，让前端能对账自救。
   */
  busy?: boolean
  /** 宿主最近发出一帧的时间（epoch 毫秒），用来判断「真的没输出了」。 */
  lastFrameAt?: number
  sidecarError?: string
  paths?: {
    user: Record<string, string>
    project: Record<string, string>
  }
}

export interface PromptImage {
  name: string
  mimeType: string
  /** Raw base64, without a data: URL prefix. */
  data: string
  size: number
}

export interface SubmittedPlan {
  summary: string
  steps: string[]
  files?: string[]
  risks?: string[]
  verification?: string[]
}

export type PlanDecision = 'accepted' | 'rejected'

export interface UsageTotals {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  reasoning: number
  totalTokens: number
  cost: number
  turns: number
  toolCalls: number
}

export const EMPTY_TOTALS: UsageTotals = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  reasoning: 0,
  totalTokens: 0,
  cost: 0,
  turns: 0,
  toolCalls: 0,
}

/* ------------------------------------------------------------------ */
/* Commands (UI -> host)                                               */
/* ------------------------------------------------------------------ */

export interface PromptOptions {
  /** Sent through `steer()` instead of `prompt()` when the runtime is busy. */
  queueAs?: 'prompt' | 'steer' | 'follow_up'
  attachments?: PromptImage[]
}

/** 工作区里一个文件的改动类型（宿主按 git 状态码归一后给的字面量）。 */
export type FileChangeStatus =
  | 'modified'
  | 'added'
  | 'deleted'
  | 'renamed'
  | 'typechange'
  | 'conflicted'
  | 'untracked'

/** 改动清单里的一行。`path` 是仓库相对路径（git 说法），`display` 是给人看的。 */
export interface FileChange {
  path: string
  display: string
  status: FileChangeStatus
  additions: number
  deletions: number
  binary: boolean
  staged: boolean
  untracked: boolean
  /** 太大/读不出来，行数不可信。 */
  oversized?: boolean
}

/** `files.changes` 的结果：git 视角的工作区改动清单。 */
export interface WorkspaceChanges {
  cwd: string
  repo: boolean
  root?: string | null
  branch?: string | null
  files: FileChange[]
  /** Files changed since this host opened the workspace (also available in non-git folders). */
  sessionFiles?: FileChange[]
  total: number
  truncated: boolean
  error?: string | null
}

/** 右侧工作区浏览器中的一项。 */
export interface WorkspaceEntry {
  name: string
  path: string
  type: 'file' | 'directory'
  size: number
}

/** `files.list` 的结果：当前目录的一层内容。 */
export interface WorkspaceDirectory {
  cwd: string
  path: string
  entries: WorkspaceEntry[]
  truncated: boolean
}

/** `files.diff` 的结果：单个文件的统一差异。 */
export interface FileDiff {
  path: string
  absolute?: string
  diff: string
  binary: boolean
  untracked: boolean
  truncated: boolean
  additions: number | null
  deletions: number | null
  error?: string | null
}

/** `files.read` 的结果：预览面板要的文件内容。 */
export interface FileContent {
  path: string
  absolute?: string
  text: string
  truncated: boolean
  binary: boolean
  size: number
  lines?: number
  /**
   * `text`（可当文本看）/ `binary`（只能报事实）/ `image`（宿主已经把 base64 放进
   * `data`，可以直接 `<img>`）。
   */
  kind?: 'text' | 'binary' | 'image'
  /** 图片的 MIME（宿主按后缀给出），只有 `kind === 'image'` 时才有。 */
  mime?: string | null
  /** 图片的 base64 内容；超过宿主上限时为 null，原因在 `error`。 */
  data?: string | null
  error?: string | null
}

export type HostCommand =
  | { method: 'host.info' }
  | { method: 'sessions.list' }
  | { method: 'sessions.open'; params: { id: string } }
  | { method: 'sessions.new' }
  | { method: 'sessions.delete'; params: { id: string } }
  | { method: 'sessions.rename'; params: { id: string; title: string } }
  | { method: 'sessions.fork'; params: { fromId?: string } }
  | { method: 'session.export'; params: { format: 'json' | 'markdown'; path: string } }
  | { method: 'prompt'; params: { message: string; options?: PromptOptions } }
  | {
      method: 'steer'
      params: { message: string; attachments?: PromptImage[]; promoteFollowUps?: boolean; interrupt?: boolean }
    }
  | { method: 'follow_up'; params: { message: string; attachments?: PromptImage[] } }
  | { method: 'abort' }
  | { method: 'compact' }
  | { method: 'run_command'; params: { name: string; arguments?: string } }
  | { method: 'invoke_skill'; params: { name: string; instructions?: string } }
  | { method: 'model.select'; params: { reference: string } }
  | { method: 'thinking.set'; params: { level: ThinkingLevel } }
  | { method: 'permission.set'; params: { mode: PermissionMode } }
  | { method: 'interaction.set'; params: { mode: InteractionMode } }
  | { method: 'execution.set'; params: { mode: ExecutionMode } }
  | { method: 'plan.answer'; params: { id: string; decision: 'accept' | 'reject' } }
  | { method: 'trust.set'; params: { trusted: boolean } }
  | { method: 'cwd.change'; params: { cwd: string } }
  | { method: 'permission.answer'; params: PermissionAnswer }
  | { method: 'extensions.set'; params: { id: string; enabled: boolean; scope?: ExtensionScope } }
  | { method: 'files.list'; params?: { path?: string; limit?: number } }
  | { method: 'files.changes'; params?: { limit?: number } }
  | { method: 'files.diff'; params: { path: string; context?: number } }
  | { method: 'files.read'; params: { path: string; maxBytes?: number } }
  | { method: 'reload' }

export type HostCommandMethod = HostCommand['method']
