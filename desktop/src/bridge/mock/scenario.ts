import type { PermissionPreview, ToolStatus } from '@/types/protocol'

/**
 * Scripted demo session used by `MockBridge`.
 *
 * The shape mirrors what the real Python host emits for a read-heavy
 * investigation task, including a parallel tool batch, a `before_tool_call`
 * approval round-trip, a compaction, and a context-overflow retry.
 */

export interface ScriptStep {
  /** Milliseconds to wait before this step fires. */
  delay: number
  text?: string
  thinking?: string
  tool?: {
    id: string
    name: string
    args: Record<string, unknown>
    /** Delay between start and end, and how long "running" lasts. */
    duration: number
    status: Exclude<ToolStatus, 'awaiting-approval'>
    result: string
    isError?: boolean
    /** Emit this many progressive updates while running. */
    updates?: number
    permission?: {
      required: 'read-only' | 'workspace-modify' | 'full-access'
      reason: 'mode-insufficient' | 'outside-workspace' | 'policy' | 'always-ask'
      summary: string
      preview?: PermissionPreview
    }
  }
  notice?: {
    tone: 'info' | 'success' | 'warn' | 'danger'
    title: string
    description?: string
  }
  usage?: {
    input: number
    output: number
    cacheRead: number
    cacheWrite: number
    cost: number
  }
  finish?: boolean
}

export const DEMO_PROMPT =
  '审查 runtime.py 里的并发约束：列出所有在前台操作运行时会被拒绝的调用，并检查 JSONL 会话存储的写入安全性，最后把结论写成一份 markdown 报告。'

/** Assistant text is chunked so the mock streams like a real token stream. */
export function chunkText(text: string, size = 3): string[] {
  const out: string[] = []
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size))
  return out
}

export const SCRIPT: ScriptStep[] = [
  {
    delay: 260,
    thinking:
      '用户要的是对 runtime.py 并发约束的审查。先把 AgentSessionRuntime 的公开方法读一遍，再定位 _ensure_available 的实现，这样能确定哪些调用会抛 RuntimeError。之后要检查 JsonlSessionStorage._save 的写入语义。\n',
  },
  {
    delay: 700,
    thinking:
      '关键点：_ensure_available 有三个分支——closed / switching / preparing。需要把每个公开方法用到的守卫条件列出来，而不是只描述守卫本身。',
  },
  {
    delay: 520,
    text: '我先把宿主运行时的公开接口读进来，确认并发守卫的确切位置。\n\n',
  },
  {
    delay: 280,
    tool: {
      id: 'call_read_runtime',
      name: 'read',
      args: { path: 'packages/fox_coding_agent/src/core/runtime.py', offset: 240, limit: 120 },
      duration: 900,
      status: 'success',
      result:
        'read 88 lines from runtime.py (L240-L327)\n\n  259  def subscribe(self, listener) -> Callable[[], None]:\n  267  @property\n  268  def state(self):\n  276  @property\n  277  def usage_totals(self):\n  280  @property\n  281  def permission_mode(self):\n  298  def select_model(self, reference: str) -> Model:\n  308  def set_thinking_level(self, level: str) -> None:\n  315  def _ensure_available(self) -> None:\n  316      if self._closed:\n  317          raise RuntimeError("Runtime is closed")\n  318      if self._switching:\n  319          raise RuntimeError(\n  320              "Runtime is switching or reloading; wait for it to finish"\n  321          )\n  322      if self._preparing:\n  323          raise RuntimeError(\n  324              "Runtime is preparing a request or running an extension command"\n  325          )',
    },
  },
  {
    delay: 240,
    text: '守卫实现确认。接着并行确认「调用点」和「存储写入」两条线索。\n\n',
  },
  {
    delay: 160,
    tool: {
      id: 'call_grep_guard',
      name: 'grep',
      args: { pattern: '_ensure_available\\(\\)', path: 'packages/fox_coding_agent/src' },
      duration: 1150,
      updates: 2,
      status: 'success',
      result:
        'packages/fox_coding_agent/src/core/runtime.py:340:        self._ensure_available()\npackages/fox_coding_agent/src/core/runtime.py:357:        self._ensure_available()\npackages/fox_coding_agent/src/core/runtime.py:368:        self._ensure_available()\npackages/fox_coding_agent/src/core/runtime.py:382:        self._ensure_available()\npackages/fox_coding_agent/src/core/runtime.py:455:        self._ensure_available()\npackages/fox_coding_agent/src/core/runtime.py:458:        self._ensure_available()\npackages/fox_coding_agent/src/core/runtime.py:463:        self._ensure_available()\npackages/fox_coding_agent/src/core/runtime.py:466:        self._ensure_available()\npackages/fox_coding_agent/src/core/runtime.py:498:        self._ensure_available()\npackages/fox_coding_agent/src/core/runtime.py:510:        self._ensure_available()\npackages/fox_coding_agent/src/core/runtime.py:514:        self._ensure_available()\n\n11 matches in 1 file',
    },
  },
  {
    delay: 40,
    tool: {
      id: 'call_grep_save',
      name: 'grep',
      args: { pattern: 'def _save|atomic|os\\.replace', path: 'packages/fox_coding_agent/src/core/session_manager.py' },
      duration: 1420,
      updates: 3,
      status: 'success',
      result:
        'packages/fox_coding_agent/src/core/session_manager.py:121:    def _save(self, entries: list[dict]) -> None:\npackages/fox_coding_agent/src/core/session_manager.py:126:        tmp = self._file.with_suffix(self._file.suffix + ".tmp")\npackages/fox_coding_agent/src/core/session_manager.py:137:        tmp.replace(self._file)\n\n3 matches in 1 file',
    },
  },
  {
    delay: 320,
    text:
      '两条线索都回来了。并行批次的 `tool_execution_start/update/end` 会交错，卡片必须按 `tool_call_id` 索引——这一点在实现里已经确认。\n\n',

  },
  {
    delay: 420,
    text: '为了给出准确的行号对照，我需要跑一次 `git log` 看 runtime.py 最近的改动；这条命令需要执行权限。\n\n',
  },
  {
    delay: 200,
    tool: {
      id: 'call_bash_git',
      name: 'bash',
      args: {
        command: 'git log --oneline -8 -- packages/fox_coding_agent/src/core/runtime.py',
        timeout: 120,
      },
      duration: 1600,
      status: 'success',
      permission: {
        required: 'full-access',
        reason: 'mode-insufficient',
        summary: '执行 shell 命令（full-access），当前模式为 workspace-modify',
        preview: {
          kind: 'command',
          command: 'git log --oneline -8 -- packages/fox_coding_agent/src/core/runtime.py',
        },
      },
      result:
        'a1f0c92 runtime: 收紧 switching 期间的守卫\n7d31b44 session: JSONL 原子重写\nc0e9a12 runtime: fork 与 reload 的事件顺序\n2b77d10 cli: --json 输出 session_start\n\n[exit 0]',
    },
  },
  {
    delay: 300,
    text: '记录一下已确认的结论，避免后面上下文被挤掉。\n\n',
  },
  {
    delay: 180,
    notice: {
      tone: 'info',
      title: '上下文压缩已开始',
      description: '历史 18 条消息 → 摘要 2 条，保留最近 6 条原文（compaction_start / compaction_end）',
    },
  },
  {
    delay: 260,
    notice: {
      tone: 'success',
      title: '上下文压缩完成',
      description: '压缩后上下文 61,240 → 18,904 tokens',
    },
  },
  {
    delay: 260,
    text: '现在把审查结论写成报告文件。\n\n',
  },
  {
    delay: 220,
    tool: {
      id: 'call_write_report',
      name: 'write',
      args: {
        path: '.foxcode/labs/runtime-concurrency-review.md',
        content:
          '# runtime.py 并发约束审查\n\n## 1. 会被拒绝的前台操作\n\n| 方法 | 守卫 | 拒绝条件 |\n| --- | --- | --- |\n| prompt | _ensure_available | closed / switching / preparing |\n| compact | _ensure_available | closed / switching / preparing |\n| select_model | _ensure_available | closed / switching / preparing |\n| set_thinking_level | _ensure_available | closed / switching / preparing |\n| switch_session | _ensure_available | closed / switching / preparing |\n| change_cwd | _ensure_available | closed / switching / preparing |\n| new_session | _ensure_available | closed / switching / preparing |\n| fork | _ensure_available | closed / switching / preparing |\n| reload | _ensure_available | closed / switching / preparing |\n| set_project_trust | _ensure_available | closed / switching / preparing |\n| set_permission_mode | _ensure_available | closed / switching / preparing |\n\n## 2. JSONL 写入安全性\n\n`JsonlSessionStorage._save` 每次 append 都整文件原子重写：`tmp.replace(self._file)`。\n单写者、无跨进程锁；并发 append 会互相覆盖。\n\n## 3. 宿主侧建议\n\n- UI 必须串行化上行命令（prompt / steer / follow_up 分开）。\n- 运行中插话走 steer()/follow_up()，不要重复调用 prompt()。\n- 会话切换是 abort + wait_for_idle，而不是并行开两个 Runtime。\n',
      },
      duration: 1900,
      updates: 3,
      status: 'success',
      result:
        'wrote 1,214 bytes to .foxcode/labs/runtime-concurrency-review.md\ncreated new file · 46 lines',
    },
  },
  {
    delay: 260,
    usage: { input: 61_240, output: 2_918, cacheRead: 48_112, cacheWrite: 0, cost: 0.0412 },
  },
  {
    delay: 200,
    text:
      '报告已写入 `.foxcode/labs/runtime-concurrency-review.md`。核心结论：\n\n' +
      '1. **同一时刻只允许一个前台操作**——`_ensure_available()` 在 11 个公开方法入口处调用，三种拒绝原因分别是 `Runtime is closed`、`switching or reloading`、`preparing a request`。\n' +
      '2. **`prompt()` 与 `steer()/follow_up()` 语义不同**——后者是同步入队，是运行中插话的正规路径。\n' +
      '3. **JSONL 存储是单写者**——`_save()` 每次 append 整文件原子重写，没有跨进程锁，所以宿主必须自己串行化写入。\n',
  },
  { delay: 120, finish: true },
]
