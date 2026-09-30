import type {
  FoxBridge,
  TransportStatus,
  WindowControls,
} from '@/bridge/types'
import { branchLabel, uid } from '@/lib/format'
import { nativeShell } from '@/bridge/native'
import { terminalDriver, type TerminalDriver } from '@/bridge/terminal'
import type {
  AssistantStreamEvent,
  HostCommand,
  HostEvent,
  HostFrame,
  HostInfo,
  ModelInfo,
  PermissionDecision,
  PermissionRequest,
  PromptImage,
  SessionSummary,
  SkillInfo,
  CommandInfo,
  ExtensionInfo,
  FileChange,
  FileContent,
  FileDiff,
  WorkspaceChanges,
  WorkspaceDirectory,
} from '@/types/protocol'
import { PROTOCOL_VERSION } from '@/types/protocol'
import { DEMO_PROMPT, SCRIPT, chunkText } from './scenario'

/** 演示宿主里能当图片渲染的后缀（与宿主的 `IMAGE_MIMES` 同一套）。 */
const DEMO_IMAGE_MIMES: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  ico: 'image/x-icon',
  avif: 'image/avif',
}

/** 演示宿主里「不是图片但也没法当文本看」的后缀。 */
const BINARY_EXTENSIONS = new Set(['pdf', 'zip', 'gz', 'tar', 'exe', 'dll', 'woff', 'woff2', 'ttf'])

/** 一张真的 1200×800 工作台示意图 PNG（5059 字节，base64 内嵌，省得演示模式去读磁盘）。 */
const DEMO_PNG_BASE64 = [
  'iVBORw0KGgoAAAANSUhEUgAABLAAAAMgCAIAAAC8ggxVAAATiklEQVR42u3XvQmAMBRGUcfQLoiIWIoDWDhGCkdxdDsHEH9i',
  'cuD0wgvycavQjgAAABSocgIAAABBCAAAgCAEAABAEAIAACAIAQAAEIQAAAAIQgAAAAQhAAAAghAAAABBCAAAgCAEAABAEAIA',
  'ACAIAQAAEIQAAAAIQgAAAAQhAAAAghAAAABBCAAAgCAEAABAEAIAACAIAQAAEIQAAAAIQgAAAAQhAACAIAQAAEAQAgAAIAgB',
  'AAAQhAAAAAhCAAAABCEAAACCEAAAAEEIAACAIAQAAEAQAgAAIAgBAAAQhAAAAAhCAAAABCEAAACCEAAAAEEIAACAIAQAAEAQ',
  'AgAAIAgBAAAQhAAAAAhCAAAABCEAAACCEAAAQBC6AgAAgCAEAABAEAIAACAIAQAAEIQAAAAIQgAAAAQhAAAAghAAAABBCAAA',
  'gCAEAABAEAIAACAIAQAAEIQAAAAIQgAAAAQhAAAAghAAAIDbg7BuAgAAAAUShAAAAIIQAAAAQQgAAIAgBAAAQBACAAAgCAEA',
  'ABCEAAAACEIAAAAEIQAAAIIQAAAAQQgAAIAgBAAAQBACAAAgCAEAABCEAAAACEIAAAAEIQAAAIIQAAAAQQgAAIAgBAAAQBAC',
  'AAAgCAEAABCEAAAACEIAAABBCAAAgCAEAABAEAIAACAIAQAAEIQAAAAIQgAAAAQhAAAAghAAAABBCAAAgCAEAABAEAIAACAI',
  'AQAAEIQAAAAIQgAAAAQhAAAAfw3CuO2QFL89AAAIQgQhAAAIQkGIIAQAAEEoCBGEAAAgCAUhghAAAAShIEQQAgCAIBSECEIA',
  'ABCEghBBCAAAglAQIggBAEAQCkIEIQAACEJBiCAEAABBCIIQAAAEIQhCAAAQhCAIAQBAEIIgBAAAQQiCEAAABCEIQgAAEIQg',
  'CAEAQBCCIAQAAEEIghAAAAQhCEIAABCEIAgBAEAQgiAEAABBCIIQAADeDEIAAAAEIQAAAIIQAAAAQQgAAIAgBAAAQBACAAAg',
  'CAEAABCEAAAACEIAAAAEIQAAAIIQAAAAQQgAAIAgBAAAQBACAAAgCAEAAAQhAAAAghAAAABBCAAAgCAEAABAEAIAACAIAQAA',
  'EIQAAAAIQgAAAAQhAAAAJQfhskYAOJleABCEAAhCAEAQAiAIAQBBCIAgBAAEIQCCEAAQhAAIQgBAEAIgCAEAQQiAIAQABCEA',
  'ghAAEIQACEIAQBACIAgBAEEIgCAEAAQhAIIQABCEAAhCABCEAAAACEIAAAAEIQAAAIIQAAAAQQgAAIAgBAAAQBACAAAgCAEA',
  'ABCEAAAACEIAAAAEIQAAAIIQAACAfINwWSNA9swJACAIBSEgCAEABKEgBAQhAIAgBBCEAACCEEAQAgAIQgBBCAAgCAEEIQCA',
  'IAQQhAAAghBAEAIACEIAQQgAIAgBBCEAgCAEEIQAAIIQQBACAAhCAEEIAJBGEAIAACAIAQAAEIQAAAAIQgAAAAQhAAAAghAA',
  'AABBCAAAgCAEAABAEAIAACAIAQAAEIQAAAAIQgAAAAQhAAAAghAAAABBCAAAIAgBAAAQhAAAAAhCAAAABCEAAACCEAAAAEEI',
  'AACAIAQAAEAQAgAAIAgBAAAQhAAAAAhCAAAABCEAAACCEAAAAEEIAACAIAQAAEAQAgAAIAgBAAAQhAAAAAhCAAAABCEAAACC',
  'EAAAAEEIAACAIAQAAEAQAgAACEIAAAAE4Z36YQYAAOACQQgAACAIBSEAAIAgFIQAAACCUBACAAAIQkEIAAAgCAUhAACAIBSE',
  'AAAAglAQAgAACEJBCAAAIAgFIQAAgCAUhAAAAIJQEAIAAAhCQQgAACAIBSEAAIAgFIQAAACCUBACAAAIQkEIAAAgCAUhAACA',
  'IAQAAEAQAgAAIAgBAAAQhAAAAAhCAAAABCEAAIAgFIQAAACCUBACAAAIQkEIAAAgCAUhAACAIBSEAAAAglAQAgAACEJBCAAA',
  'IAgFIQAAgCAUhAAAAIJQEAIAAAhCQQgAACAIBSEAAIAgFIQAAACCUBACAAAIQkEIAAAgCAUhAACAIBSEAAAAgtATAgAACEIA',
  'AAAEIQAAAIIQAAAAQQgAAIAgBAAAEISCEAAAQBAKQgAAAEEoCAEAAAShIAQAABCEghAAAEAQCkIAAABBKAgBAAAEoSAEAAAQ',
  'hIIQAABAEApCAAAAQSgIAQAABKEgBAAAEISCEAAAQBAKQgAAAEEoCAEAAAShIAQAABCEghAAAEAQCkIAAABBCAAAgCAEAABA',
  'EAIAACAIAQAAEIQAAAAIQgAAAEEoCAEAAAShIAQAABCEghAAAEAQCkIAAABBKAgBAAAEoSAEAAAQhIIQAABAEApCAAAAQSgI',
  'AQAABKEgBAAAEISCEAAAQBAKQgAAAEEoCAEAAAShIAQAABCEghAAAEAQCkIAAABBKAgBAAAEoVcEAAAQhAAAAAhCAAAABCEA',
  'AACCEAAAAEEIAAAgCAUhAACAIBSEAAAAglAQAgAACEJBCAAAIAgFIQAAgCAUhAAAAIJQEAIAAAhCQQgAACAIBSEAAIAgFIQA',
  'AACCUBACAAAIQkEIAAAgCAUhAACAIBSEAAAAglAQAgAACEJBCAAAIAgFIQAAgCAUhAAAAIIQAAAAQQgAAIAgBAAAQBACAAAg',
  'CAEAABCEAAAAglAQAgAACEJBCAAAIAgFIQAAgCAUhAAAAIJQEAIAAAhCQQgAACAIBSEAAIAgFIQAAACCUBACAAAIQkEIAAAg',
  'CAUhAACAIBSEAAAAglAQAgAACEJBCAAAIAgFIQAAgCAUhAAAAIJQEAIAAAhCrwgAACAIAQAAEIQAAAAIQgAAAAQhAAAAghAA',
  'AEAQCkIAAABBKAgBAAAEoSAEAAAQhIIQAABAEApCAAAAQSgIAQAABKEgBAAAEISCEAAAQBAKQgAAAEEoCAEAAAShIAQAABCE',
  'ghAAAEAQCkIAAABBKAgBAAAEoSAEAAAQhIIQAABAEApCAAAAQSgIAQAABCEAAACCEAAAAEEIAACAIAQAAEAQAgAAIAgBAAAE',
  'oSAEAAAQhIIQAABAEApCAAAAQSgIAQAABKEgBAAAEISCEAAAQBAKQgAAAEEoCAEAAAShIAQAABCEghAAAEAQCkIAAABBKAgB',
  'AAAEoSAEAAAQhIIQAABAEApCAAAAQSgIAQAABKEgBAAAEIQAAAAIQgAAAAQhAAAAghAAAABBCAAAgCAEAAAQhIIQAABAEApC',
  'AAAAQSgIAQAABKEgBAAAEISCEAAAQBAKQgAAAEEoCAEAAAShIAQAABCEghAAAEAQCkIAAABBKAgBAAAEoSAEAAAQhIIQAABA',
  'EApCAAAAQSgIAQAABKEgBAAAEISCEAAAQBAKQgAAAEEIAACAIAQAAEAQAgAAIAgBAAAQhAAAAAhCAAAAQSgIAQAABKEgBAAA',
  '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',
  '3eR/+1jhVQAAAABJRU5ErkJggg==',
].join('')

/** 演示内容的兜底（不是已知类型时给一段带注释的假代码，高亮照样能看）。 */
function demoText(extension: string, path: string, name: string): string {
  if (extension === 'html' || extension === 'htm') {
    return [
      '<!doctype html>',
      '<html lang="zh">',
      '  <head>',
      '    <meta charset="utf-8" />',
      '    <title>演示页面</title>',
      '    <style>',
      '      body { margin: 0; font-family: system-ui, sans-serif; background: #0b1020; color: #e8ecf8; }',
      '      .card { margin: 24px; padding: 20px 22px; border-radius: 14px; background: linear-gradient(135deg,#20306b,#4a1f7a); }',
      '      h1 { margin: 0 0 8px; font-size: 20px; }',
      '      p { margin: 0; color: #b9c2e0; font-size: 13px; }',
      '    </style>',
      '  </head>',
      '  <body>',
      '    <div class="card">',
      '      <h1>这段 HTML 是渲染出来的</h1>',
      '      <p>右侧栏用 sandbox="" 的 iframe 显示它：样式生效，脚本不执行。</p>',
      '    </div>',
      '    <!-- 1200×220 的横幅：故意比面板宽，用来看「适应窗口」有没有把页面收进来。 -->',
      '    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1200 220" width="1200" height="220" style="display:block;margin:0 24px">',
      '      <defs>',
      '        <linearGradient id="banner" x1="0" y1="0" x2="1" y2="0">',
      '          <stop offset="0" stop-color="#2f6fed" />',
      '          <stop offset="1" stop-color="#8b5cf6" />',
      '        </linearGradient>',
      '      </defs>',
      '      <rect width="1200" height="220" rx="16" fill="url(#banner)" />',
      '      <text x="48" y="124" font-family="system-ui" font-size="56" fill="#ffffff">1200px 宽的横幅</text>',
      '    </svg>',
      '  </body>',
      '</html>',
    ].join('\n')
  }
  if (extension === 'svg') {
    return [
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 240 120" width="240" height="120">',
      '  <defs>',
      '    <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">',
      '      <stop offset="0" stop-color="#2f6fed" />',
      '      <stop offset="1" stop-color="#8b5cf6" />',
      '    </linearGradient>',
      '  </defs>',
      '  <rect width="240" height="120" rx="12" fill="url(#g)" />',
      '  <circle cx="60" cy="60" r="26" fill="#ffffff" fill-opacity="0.85" />',
      '  <text x="104" y="66" font-family="system-ui" font-size="16" fill="#ffffff">SVG 预览</text>',
      '</svg>',
    ].join('\n')
  }
  if (extension === 'md' || extension === 'markdown') {
    return [
      '# 演示 Markdown',
      '',
      '右侧栏把它当文档渲染，而不是当代码看。',
      '',
      '- 列表、**粗体**、`行内代码` 都走正文那套渲染器',
      '- 切到「原文」就是源码',
      '',
      '```ts',
      "export const name = 'demo'",
      '```',
    ].join('\n')
  }
  if (extension === 'json') {
    return JSON.stringify(
      {
        name: 'foxcode-desktop',
        version: '0.1.0',
        private: true,
        scripts: { dev: 'vite', build: 'tsc -b && vite build', test: 'vitest run' },
        dependencies: { react: '^19.2.0', 'react-dom': '^19.2.0', zustand: '^5.0.2' },
        workspaces: ['packages/fox_ai', 'packages/fox_agent_core'],
      },
      null,
      2,
    )
  }
  return [
    `// ${path}`,
    '// 演示宿主：真实内容由 fox_serve 的 files.read 提供。',
    '',
    `export const name = '${name}'`,
    'export function demo(): number {',
    '  return 42',
    '}',
  ].join('\n')
}

const MODELS: ModelInfo[] = [
  {
    id: 'deepseek-v4-flash',
    provider: 'deepseek',
    displayName: 'DeepSeek V4 Flash',
    contextWindow: 262_144,
    maxTokens: 384_000,
    outputLimit: 8_192,
    supportsThinking: true,
    supportsTools: true,
    costPerMTokIn: 0.28,
    costPerMTokOut: 1.1,
  },
  {
    id: 'deepseek-v4-pro',
    provider: 'deepseek',
    displayName: 'DeepSeek V4 Pro',
    contextWindow: 1_000_000,
    maxTokens: 384_000,
    outputLimit: 65_536,
    supportsThinking: true,
    supportsTools: true,
    costPerMTokIn: 1.1,
    costPerMTokOut: 4.4,
  },
  {
    id: 'claude-sonnet-4-6',
    provider: 'anthropic',
    displayName: 'Claude Sonnet 4.6',
    contextWindow: 200_000,
    maxTokens: 64_000,
    supportsThinking: true,
    supportsTools: true,
    costPerMTokIn: 3,
    costPerMTokOut: 15,
  },
  {
    id: 'gpt-5.2-codex',
    provider: 'openai',
    displayName: 'GPT-5.2 Codex',
    contextWindow: 400_000,
    maxTokens: 128_000,
    supportsThinking: false,
    supportsTools: true,
    costPerMTokIn: 1.25,
    costPerMTokOut: 10,
  },
]

const SKILLS: SkillInfo[] = [
  { name: 'code-review', description: '按仓库约定审查改动，输出可执行的修复清单', source: 'user', enabled: true },
  { name: 'pr-description', description: '根据 diff 生成 PR 描述与验证步骤', source: 'user', enabled: true },
  { name: 'test-triage', description: '定位失败用例并给出最小复现', source: 'project', enabled: false },
  { name: 'architecture-note', description: '为一次改动写架构说明（ARCHITECTURE_GUIDE 风格）', source: 'project', enabled: true },
]

// 名字不带前导斜杠（界面显示时自己补一个），与 `fox_serve/host.py` 的 BUILTIN_COMMANDS 一一对应。
const COMMANDS: CommandInfo[] = [
  { name: 'new', description: '新建会话' },
  { name: 'resume', description: '打开一个已有会话文件', argumentHint: 'FILE' },
  { name: 'fork', description: '从当前节点分叉出新会话', argumentHint: '[ENTRY_ID]' },
  { name: 'cwd', description: '切换工作目录', argumentHint: 'DIR' },
  { name: 'reload', description: '重新加载设置、技能与扩展' },
  { name: 'trust', description: '信任当前项目' },
  { name: 'untrust', description: '取消信任当前项目' },
  { name: 'permission', description: '切换权限档位', argumentHint: 'MODE' },
  { name: 'mode', description: '切换自动、执行或计划模式', argumentHint: '[auto|default|plan]' },
  { name: 'sandbox', description: '切换本机或沙盒执行环境', argumentHint: '[local|sandbox]' },
  { name: 'compact', description: '压缩当前会话上下文' },
  { name: 'usage', description: '查看累计用量' },
  { name: 'export', description: '导出会话', argumentHint: 'FILE' },
  { name: 'tools', description: '列出当前可用工具' },
  { name: 'model', description: '切换模型', argumentHint: '[REFERENCE]' },
  { name: 'thinking', description: '设置推理强度', argumentHint: '[LEVEL]' },
  { name: 'skill', description: '调用技能', argumentHint: 'NAME [ARGS]' },
  { name: 'prompt', description: '调用提示词模板', argumentHint: 'NAME [ARGS]' },
]

/** 演示用的「已启用」扩展：形状与 `fox serve` 的 `host.info.extensions` 一致。 */
const EXTENSIONS: ExtensionInfo[] = [
  {
    id: 'module:fox_coding_agent.src.extensions.memory:setup',
    spec: 'module:fox_coding_agent.src.extensions.memory:setup',
    name: 'memory',
    kind: 'module',
    origin: 'builtin',
    path: 'packages\\fox_coding_agent\\src\\extensions\\memory',
    scope: 'project',
    enabled: true,
    hooks: ['session_start'],
    description: 'Built-in policy-aware long-term memory extension.',
    probed: true,
    tools: ['memory_remember', 'memory_recall', 'memory_forget'],
    commands: ['memory'],
    services: ['memory.store'],
    contextTransforms: ['memory.recall'],
  },
  {
    id: 'module:fox_coding_agent.src.extensions.subagent:setup',
    spec: 'module:fox_coding_agent.src.extensions.subagent:setup',
    name: 'subagent',
    kind: 'module',
    origin: 'builtin',
    path: 'packages\\fox_coding_agent\\src\\extensions\\subagent',
    scope: 'project',
    enabled: true,
    hooks: ['session_shutdown', 'session_start'],
    description: 'Isolated, capability-scoped sub-agent extension.',
    probed: true,
    tools: ['agent'],
    commands: ['agents'],
    services: ['subagent.manager'],
    contextTransforms: [],
  },
]

/** 演示用的「可加载」扩展：宿主发现得到，但还没写进 settings.json。 */
const AVAILABLE_EXTENSIONS: ExtensionInfo[] = [
  {
    id: 'module:fox_coding_agent.src.extensions.skill_evolution:setup',
    spec: 'module:fox_coding_agent.src.extensions.skill_evolution:setup',
    name: 'skill_evolution',
    kind: 'module',
    origin: 'builtin',
    path: 'packages\\fox_coding_agent\\src\\extensions\\skill_evolution',
    scope: 'project',
    enabled: false,
    hooks: ['agent_end', 'before_prompt', 'session_start'],
    description: 'Staged, auditable self-evolving skills extension with real evaluation support.',
    probed: true,
    tools: ['skill_evolution'],
    commands: ['skill-evolution'],
    services: ['skill-evolution.manager'],
    contextTransforms: ['skill-evolution.staged-candidate'],
  },
  {
    id: 'module:fox_coding_agent.src.extensions.mcp:setup',
    spec: 'module:fox_coding_agent.src.extensions.mcp:setup',
    name: 'mcp',
    kind: 'module',
    origin: 'builtin',
    path: 'packages\\fox_coding_agent\\src\\extensions\\mcp',
    scope: 'project',
    enabled: false,
    hooks: ['session_shutdown', 'session_start'],
    description: 'MCP stdio client extension with dynamic AgentTool proxies.',
    probed: true,
    tools: [],
    commands: ['mcp'],
    services: ['mcp.manager'],
    contextTransforms: [],
  },
  {
    id: 'C:\\Users\\Qin\\.foxcode\\extensions\\guard_shell.py',
    spec: 'C:\\Users\\Qin\\.foxcode\\extensions\\guard_shell.py',
    name: 'guard_shell',
    kind: 'file',
    origin: 'user',
    path: 'C:\\Users\\Qin\\.foxcode\\extensions\\guard_shell.py',
    scope: 'project',
    enabled: false,
    hooks: [],
    description: '拦截危险 shell 命令（只读 docstring 探测，不执行）。',
    probed: false,
    tools: [],
    commands: [],
    services: [],
    contextTransforms: [],
  },
]

const CWD = 'C:\\Users\\Qin\\Desktop\\coding_agent\\FoxCode'
const SESSION_FILE = `${CWD}\\.foxcode\\sessions\\2026-02-14T09-31-07Z.jsonl`

interface DemoSessionSeed extends SessionSummary {
  replay?: { role: 'user' | 'assistant'; text: string }[]
}

const DEMO_SESSIONS: DemoSessionSeed[] = [
  {
    id: 'live',
    file: SESSION_FILE,
    title: 'runtime.py 并发约束审查',
    cwd: CWD,
    model: 'deepseek-v4-flash',
    createdAt: Date.now() - 26 * 60_000,
    updatedAt: Date.now() - 60_000,
    messageCount: 18,
    totalTokens: 74_312,
    cost: 0.0612,
    live: true,
  },
  {
    id: 's-2',
    file: `${CWD}\\.foxcode\\sessions\\2026-02-13T21-04-55Z.jsonl`,
    title: '为 EventStream 增加事件时间戳',
    cwd: CWD,
    model: 'deepseek-v4-pro',
    createdAt: Date.now() - 15 * 3_600_000,
    updatedAt: Date.now() - 14 * 3_600_000,
    messageCount: 46,
    totalTokens: 218_004,
    cost: 0.4188,
    replay: [
      { role: 'user', text: 'EventStream 现在只转发 delta，前端拿不到时间。帮我在事件里带上时间戳，并补一个测试。' },
      {
        role: 'assistant',
        text:
          '接入点有三个：`fox_ai/src/event_stream.py` 的产出端、`agent_loop.py` 的转发端、以及 `runtime.py` 的事件出口。\n\n' +
          '我倾向于**只在宿主出口打时间戳**：`_json_value` 序列化层加 `ts`，避免动到 pydantic 模型（它们的 `extra="forbid"` 会让回灌校验失败）。',
      },
    ],
  },
  {
    id: 's-3',
    file: `${CWD}\\.foxcode\\sessions\\2026-02-11T08-12-30Z.jsonl`,
    title: '检查 workspace-modify 下的越界写入拦截',
    cwd: `${CWD}\\packages\\fox_coding_agent`,
    model: 'claude-sonnet-4-6',
    createdAt: Date.now() - 3 * 86_400_000,
    updatedAt: Date.now() - 3 * 86_400_000 + 1_800_000,
    messageCount: 27,
    totalTokens: 121_500,
    cost: 0.734,
    replay: [
      { role: 'user', text: 'workpsace-write 模式下写到仓库外会怎样？给我确切的报错文本。' },
      {
        role: 'assistant',
        text:
          '会被静态检查拦下，报错是：\n\n```\nTool \'write\' cannot modify outside the workspace in workspace-modify mode: <candidate>\n```\n\n注意钩子只能进一步收紧——所以「临时批准一次越界写」在 workspace-modify 下做不到，UI 必须显式抬高 `permission_mode`。',
      },
    ],
  },
]

/**
 * Fully in-renderer host implementation. It reproduces the observable
 * behaviour of `AgentSessionRuntime` (single foreground operation, blocking
 * approval hook, interleaved parallel tool batches, compaction, abort) so the
 * UI can be developed and demoed without a Python sidecar.
 */
export class MockHost implements FoxBridge {
  readonly kind = 'mock' as const
  readonly platform = 'win32'
  /**
   * 终端不依赖 sidecar：演示模式里照样用主进程的真 shell（`window.foxcode` 存在时），
   * 只有在纯浏览器/jsdom 里才退化成脚本化的演示终端。
   */
  readonly terminal: TerminalDriver = terminalDriver()
  readonly window: WindowControls = {
    minimize: () => {},
    toggleMaximize: () => {},
    close: () => {},
    onMaximizeChange: () => () => {},
  }

  private seq = 0
  private frameListeners = new Set<(frame: HostFrame) => void>()
  private permissionListeners = new Set<(request: PermissionRequest) => void>()
  private transportListeners = new Set<(status: TransportStatus) => void>()

  private generation = 0
  private running = false
  private busy = false
  /** 最近一次发帧的时间：和真实宿主一样暴露给前端做「卡住」判断。 */
  private lastFrameAt = Date.now()
  private seeds = new Map<string, DemoSessionSeed>(
    DEMO_SESSIONS.map((s) => [s.id, { ...s }]),
  )
  private currentSessionId = 'live'
  private pendingPermissions = new Map<string, (decision: PermissionDecision) => void>()
  private extensions: ExtensionInfo[] = EXTENSIONS.map((item) => ({ ...item }))
  private availableExtensions: ExtensionInfo[] = AVAILABLE_EXTENSIONS.map((item) => ({ ...item }))

  private state = {
    cwd: CWD,
    sessionFile: SESSION_FILE,
    model: MODELS[0],
    thinking: 'medium' as HostInfo['thinkingLevel'],
    permission: 'workspace-modify' as HostInfo['permissionMode'],
    execution: 'local' as HostInfo['executionMode'],
    interaction: 'auto' as HostInfo['interactionMode'],
    effectiveInteraction: 'default' as HostInfo['effectiveInteractionMode'],
    trusted: true,
  }

  /* ----------------------------- transport ----------------------------- */

  private emit(event: HostEvent): void {
    this.seq += 1
    this.lastFrameAt = Date.now()
    const frame = { ...event, seq: this.seq, ts: Date.now(), v: PROTOCOL_VERSION } as HostFrame
    for (const listener of [...this.frameListeners]) listener(frame)
  }

  private emitStream(event: AssistantStreamEvent): void {
    this.emit({
      type: 'message_update',
      assistant_message_event: event,
    })
  }

  onFrame(cb: (frame: HostFrame) => void): () => void {
    this.frameListeners.add(cb)
    return () => this.frameListeners.delete(cb)
  }

  onPermission(cb: (request: PermissionRequest) => void): () => void {
    this.permissionListeners.add(cb)
    return () => this.permissionListeners.delete(cb)
  }

  onTransport(cb: (status: TransportStatus) => void): () => void {
    this.transportListeners.add(cb)
    return () => this.transportListeners.delete(cb)
  }

  async info(): Promise<HostInfo> {
    return {
      transport: 'mock',
      hostVersion: '0.1.0-demo',
      protocolVersion: PROTOCOL_VERSION,
      cwd: this.state.cwd,
      sessionFile: this.state.sessionFile,
      permissionMode: this.state.permission,
      executionMode: this.state.execution,
      sandbox: {
        backend: 'file-policy',
        shell: false,
        networkIsolated: false,
        detail: '演示宿主不执行真实 shell。',
      },
      interactionMode: this.state.interaction,
      effectiveInteractionMode: this.state.effectiveInteraction,
      thinkingLevel: this.state.thinking,
      model: this.state.model,
      availableModels: MODELS,
      skills: SKILLS,
      commands: COMMANDS,
      extensions: this.extensions,
      availableExtensions: this.availableExtensions,
      projectTrusted: this.state.trusted,
      contextTokens: 18_000,
      sidecarConnected: false,
      paths: {
        user: { root: 'C:\\Users\\Qin\\.foxcode' },
        project: { root: this.state.cwd, artifacts: `${this.state.cwd}\\.foxcode\\artifacts` },
      },
      // 演示宿主也要给这两个字段：前端的「生成中自愈」逻辑靠它对账，
      // 少一个字段就会在演示模式下退化（mock 里 running 就是脚本还在跑）。
      busy: this.running || this.busy,
      lastFrameAt: this.lastFrameAt,
      sidecarError: '演示模式：未连接 Python `fox serve` sidecar，事件由渲染进程内置模拟器生成。',
    }
  }

  async sessions(): Promise<SessionSummary[]> {
    return [...this.seeds.values()]
      .map(({ replay: _replay, ...summary }) => ({
        ...summary,
        live: summary.id === this.currentSessionId,
      }))
      .sort((a, b) => b.updatedAt - a.updatedAt)
  }

  async pickDirectory(): Promise<string | null> {
    return CWD
  }

  async openExternal(url: string): Promise<void> {
    if (typeof window !== 'undefined') window.open(url, '_blank', 'noreferrer')
  }

  /**
   * 演示宿主没有 sidecar，但「在文件管理器里显示」是 Electron 主进程的事 —— 外壳在
   * 就把这活转给它，不在（浏览器里跑 vite dev）才回 false。
   */
  async reveal(path: string): Promise<boolean> {
    const shell = nativeShell()
    if (!shell) return false
    return shell.revealPath(path)
  }

  async openTerminal(path: string): Promise<boolean> {
    const shell = nativeShell()
    if (!shell) return false
    return shell.openTerminal(path)
  }

  themeFlash(): void {}

  /* --------------------- workspace files (demo data) -------------------- */

  /**
   * 演示宿主的「工作区改动」。
   *
   * 真实宿主会去问 git（`fox_serve/workspace_files.py`），这里只准备一份固定清单，
   * 让右侧栏的「文件」页签在没有 sidecar 时也有东西可看：四种状态、二进制、
   * 未跟踪各来一条。
   */
  private demoChanges(): WorkspaceChanges {
    const cwd = this.state.cwd
    const files: FileChange[] = [
      {
        path: 'desktop/src/components/layout/Inspector.tsx',
        display: 'desktop/src/components/layout/Inspector.tsx',
        status: 'modified',
        additions: 128,
        deletions: 24,
        binary: false,
        staged: false,
        untracked: false,
      },
      {
        path: 'desktop/src/store/filesStore.ts',
        display: 'desktop/src/store/filesStore.ts',
        status: 'added',
        additions: 140,
        deletions: 0,
        binary: false,
        staged: true,
        untracked: false,
      },
      {
        path: 'fox_serve/workspace_files.py',
        display: 'fox_serve/workspace_files.py',
        status: 'untracked',
        additions: 412,
        deletions: 0,
        binary: false,
        staged: false,
        untracked: true,
      },
      {
        path: 'desktop/artifacts/dsh-workbench-dark.png',
        display: 'desktop/artifacts/dsh-workbench-dark.png',
        status: 'added',
        additions: 0,
        deletions: 0,
        binary: true,
        staged: false,
        untracked: true,
      },
      {
        path: 'docs/handbook.pdf',
        display: 'docs/handbook.pdf',
        status: 'modified',
        additions: 0,
        deletions: 0,
        binary: true,
        staged: false,
        untracked: false,
      },
    ]
    return {
      cwd,
      repo: true,
      root: cwd,
      branch: 'main',
      files,
      total: files.length,
      truncated: false,
      error: null,
    }
  }

  private demoDirectory(path = ''): WorkspaceDirectory {
    const root = [
      { name: 'desktop', path: 'desktop', type: 'directory' as const, size: 0 },
      { name: 'fox_serve', path: 'fox_serve', type: 'directory' as const, size: 0 },
      { name: 'packages', path: 'packages', type: 'directory' as const, size: 0 },
      { name: 'README.md', path: 'README.md', type: 'file' as const, size: 4210 },
      // 演示模式没有真实宿主，这四行让「渲染」页签有东西可看。
      { name: 'poster.svg', path: 'poster.svg', type: 'file' as const, size: 620 },
      { name: 'report.html', path: 'report.html', type: 'file' as const, size: 980 },
      { name: 'preview.png', path: 'preview.png', type: 'file' as const, size: 5059 },
      { name: 'main.py', path: 'main.py', type: 'file' as const, size: 860 },
    ]
    const nested = [
      { name: 'src', path: `${path}/src`, type: 'directory' as const, size: 0 },
      { name: 'package.json', path: `${path}/package.json`, type: 'file' as const, size: 1250 },
    ]
    return {
      cwd: this.state.cwd,
      path,
      entries: path ? nested : root,
      truncated: false,
    }
  }

  /** 演示用的统一差异（两段 hunk，够看出行号与增删配色）。 */
  private demoDiff(path: string): FileDiff {
    if (/\.(png|jpg|jpeg|gif|webp|pdf|ico)$/i.test(path)) {
      return {
        path,
        diff: '',
        binary: true,
        untracked: false,
        truncated: false,
        additions: null,
        deletions: null,
        error: '二进制文件，无法预览差异',
      }
    }
    const diff = [
      `diff --git a/${path} b/${path}`,
      'index 8f3a1c2..4d9b7e1 100644',
      `--- a/${path}`,
      `+++ b/${path}`,
      '@@ -204,8 +204,14 @@ function FilesTab() {',
      '   const timeline = useSession((s) => s.timeline)',
      '   const changes = useFiles((s) => s.changes)',
      '-  const files = useMemo(() => collect(timeline.blocks), [timeline.blocks])',
      '-  if (files.length === 0) return <EmptyState />',
      '+  // 打开页签、每次工具调用结束后都重新拉一次清单',
      '+  useEffect(() => {',
      '+    void refresh()',
      '+  }, [refresh, toolCalls])',
      '+',
      '+  if (files.length === 0) return <EmptyState icon={<FileCode2 size={18} />} />',
      '   return <div>{files.length}</div>',
      ' }',
      '@@ -320,6 +326,7 @@ function UsageTab() {',
      '   const turns = useMemo(() => completed(timeline.blocks), [timeline.blocks])',
      '+  // 累计用量与按回合列表在同一个页签',
      '   return <dl>{turns.length}</dl>',
      ' }',
    ].join('\n')
    return {
      path,
      absolute: `${this.state.cwd}\\${path.split('/').join('\\')}`,
      diff,
      binary: false,
      untracked: /workspace_files|filesStore/.test(path),
      truncated: false,
      additions: 9,
      deletions: 3,
      error: null,
    }
  }

  /**
   * 演示用的文件内容。
   *
   * 按扩展名分别给一份「像那么回事」的内容，右侧栏的三种渲染（图片 / HTML / 文档）
   * 在没有真实宿主的演示模式下才有东西可看：图片用一张内嵌的 1200×800 工作台示意图 PNG，
   * SVG 与 HTML 是文本、直接内联，Markdown 与 JSON 各给一小段。
   */
  private demoFile(path: string): FileContent {
    const name = path.split('/').pop() ?? path
    const absolute = `${this.state.cwd}\\${path.split('/').join('\\')}`
    const extension = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1).toLowerCase() : ''
    const image = DEMO_IMAGE_MIMES[extension]
    if (image) {
      return {
        path,
        absolute,
        text: '',
        truncated: false,
        binary: false,
        size: DEMO_PNG_BASE64.length * 0.75,
        lines: 0,
        kind: 'image',
        mime: image,
        data: DEMO_PNG_BASE64,
        error: null,
      }
    }
    const text = demoText(extension, path, name)
    const binary = BINARY_EXTENSIONS.has(extension)
    return {
      path,
      absolute,
      text: binary ? '' : text,
      truncated: false,
      binary,
      size: binary ? 84_512 : text.length,
      lines: binary ? 0 : text.split('\n').length,
      kind: binary ? 'binary' : 'text',
      mime: null,
      data: null,
    }
  }

  /* ------------------------------ commands ----------------------------- */

  async send(command: HostCommand): Promise<unknown> {
    switch (command.method) {
      case 'host.info':
        return this.info()
      case 'sessions.list':
        return this.sessions()
      case 'sessions.open':
        return this.openSession(command.params.id)
      case 'sessions.new':
        return this.newSession()
      case 'sessions.fork':
        return this.forkSession()
      case 'sessions.delete':
        return this.deleteSession(command.params.id)
      case 'sessions.rename':
        return this.renameSession(command.params.id, command.params.title)
      case 'extensions.set':
        return this.setExtension(command.params.id, command.params.enabled)
      case 'session.export':
        return { path: command.params.path }
      case 'prompt':
        return this.prompt(command.params.message, command.params.options?.attachments)
      case 'steer':
        return this.enqueue(command.params.message, 'steer')
      case 'follow_up':
        return this.enqueue(command.params.message, 'follow_up')
      case 'abort':
        this.abort()
        return null
      case 'compact':
        return this.compact()
      case 'run_command':
        return this.runCommand(command.params.name, command.params.arguments ?? '')
      case 'invoke_skill':
        return this.invokeSkill(command.params.name, command.params.instructions ?? '')
      case 'model.select': {
        const model = MODELS.find((m) => m.id === command.params.reference)
        if (!model) throw new Error(`Unknown model: ${command.params.reference}`)
        this.state.model = model
        this.emit({
          type: 'message_end',
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: `模型已切换为 \`${model.displayName}\`。` }],
            stopReason: 'stop',
          },
        })
        return model
      }
      case 'thinking.set':
        this.state.thinking = command.params.level
        return null
      case 'permission.set':
        this.state.permission = command.params.mode
        return null
      case 'interaction.set':
        this.ensureIdle()
        this.state.interaction = command.params.mode
        this.state.effectiveInteraction = command.params.mode === 'plan' ? 'plan' : 'default'
        return null
      case 'execution.set':
        this.ensureIdle()
        this.state.execution = command.params.mode
        return null
      case 'plan.answer':
        this.emit({
          type: 'plan_decision',
          tool_call_id: command.params.id,
          decision: command.params.decision === 'accept' ? 'accepted' : 'rejected',
        })
        if (command.params.decision === 'accept') {
          if (this.state.interaction === 'plan') this.state.interaction = 'default'
          this.state.effectiveInteraction = 'default'
          void this.prompt('用户已批准上一条结构化计划。现在开始实施。')
        }
        return null
      case 'trust.set':
        this.state.trusted = command.params.trusted
        this.emit({
          type: 'session_start',
          session_file: this.state.sessionFile,
          cwd: this.state.cwd,
          permission: this.state.permission,
        })
        return null
      case 'cwd.change':
        this.state.cwd = command.params.cwd
        return null
      case 'files.list':
        return this.demoDirectory(command.params?.path ?? '')
      case 'files.changes':
        return this.demoChanges()
      case 'files.diff':
        return this.demoDiff(command.params.path)
      case 'files.read':
        return this.demoFile(command.params.path)
      case 'permission.answer': {
        const resolver = this.pendingPermissions.get(command.params.id)
        if (resolver) {
          this.pendingPermissions.delete(command.params.id)
          resolver(command.params.decision)
        }
        return null
      }
      case 'reload':
        this.emit({
          type: 'message_end',
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: '已重新加载设置、技能与扩展（6 条命令、4 个技能、2 个扩展）。' }],
            stopReason: 'stop',
          },
        })
        return null
      default:
        throw new Error(`Unsupported command: ${JSON.stringify(command)}`)
    }
  }

  /* --------------------------- session handling ------------------------ */

  private async openSession(id: string): Promise<SessionSummary | null> {
    const seed = this.seeds.get(id)
    if (!seed) throw new Error(`Session not found: ${id}`)
    this.stopRun('switch', 'switch')
    this.currentSessionId = id
    this.state.sessionFile = seed.file
    this.state.cwd = seed.cwd
    this.seq = 0
    this.emit({
      type: 'session_start',
      session_file: seed.file,
      cwd: seed.cwd,
      permission: this.state.permission,
    })
    for (const entry of seed.replay ?? []) {
      if (entry.role === 'user') {
        this.emit({ type: 'message_end', message: { role: 'user', content: [{ type: 'text', text: entry.text }] } })
      } else {
        this.emit({
          type: 'message_end',
          message: { role: 'assistant', content: [{ type: 'text', text: entry.text }], stopReason: 'stop' },
        })
      }
      await this.sleep(90)
    }
    return seed
  }

  private newSession(): SessionSummary {
    this.stopRun('close', 'close')
    const id = uid('session')
    const seed: DemoSessionSeed = {
      id,
      file: `${CWD}\\.foxcode\\sessions\\${new Date().toISOString().replace(/[:.]/g, '-')}.jsonl`,
      title: '新会话',
      cwd: this.state.cwd,
      model: this.state.model.id,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      messageCount: 0,
      totalTokens: 0,
      cost: 0,
      live: true,
    }
    this.seeds.set(id, seed)
    this.currentSessionId = id
    this.state.sessionFile = seed.file
    this.seq = 0
    this.emit({
      type: 'session_start',
      session_file: seed.file,
      cwd: seed.cwd,
      permission: this.state.permission,
    })
    const { replay: _replay, ...summary } = seed
    return summary
  }

  private async forkSession(): Promise<SessionSummary> {
    // `newSession()` 会把当前会话换成新的，所以先留住分叉源的名字。
    const source = this.currentSessionId ? this.seeds.get(this.currentSessionId) : undefined
    const created = this.newSession()
    const title = branchLabel(source?.title ?? created.title)
    const seed = this.seeds.get(created.id)
    if (seed) seed.title = title
    const forked: SessionSummary = { ...created, title }
    return forked
  }

  /**
   * 测试辅助：把扩展的两个列表恢复到初始状态。
   *
   * 演示宿主是渲染进程里的单例（store 在模块加载时就抓住了它），所以测试之间
   * 会有状态残留；这个方法让每个用例从同一份扩展配置出发。
   */
  resetExtensions(): void {
    this.extensions = EXTENSIONS.map((item) => ({ ...item }))
    this.availableExtensions = AVAILABLE_EXTENSIONS.map((item) => ({ ...item }))
  }

  /**
   * 启用/关闭一个扩展：与真实宿主一致，条目在两个列表之间搬动。
   * 「已启用」= 写在 settings.json 的 `extensions` 里，所以这里也顺便广播一次
   * `session_start`（真实宿主的 reload 会重建扩展并重新发这个帧）。
   */
  private setExtension(
    id: string,
    enabled: boolean,
  ): { id: string; enabled: boolean; extensions: ExtensionInfo[]; availableExtensions: ExtensionInfo[] } {
    const matches = (item: ExtensionInfo) =>
      item.id === id || item.name === id || item.spec === id
    const target = enabled ? this.extensions : this.availableExtensions
    const source = enabled ? this.availableExtensions : this.extensions
    if (target.some(matches)) {
      // 已经处于目标状态：真实宿主返回 updatedScopes: [] 且不重载。
      return {
        id,
        enabled,
        extensions: this.extensions,
        availableExtensions: this.availableExtensions,
      }
    }
    const index = source.findIndex(matches)
    if (index < 0) throw new Error(`找不到扩展：${id}`)
    const [item] = source.splice(index, 1)
    target.push({ ...item, enabled })
    this.emit({
      type: 'session_start',
      session_file: this.state.sessionFile,
      cwd: this.state.cwd,
      permission: this.state.permission,
    })
    return {
      id,
      enabled,
      extensions: this.extensions,
      availableExtensions: this.availableExtensions,
    }
  }

  /** 删除一个历史会话（当前活动会话拒绝删除，与真实宿主一致）。 */
  private deleteSession(id: string): { id: string; file: string } {
    const seed = this.seeds.get(id)
    if (!seed) throw new Error(`找不到会话：${id}`)
    if (id === this.currentSessionId) {
      throw new Error('不能删除当前正在使用的会话，请先新建或切换到别的会话')
    }
    this.seeds.delete(id)
    return { id, file: seed.file }
  }

  private renameSession(id: string, title: string): SessionSummary {
    const seed = this.seeds.get(id)
    if (!seed) throw new Error(`找不到会话：${id}`)
    const label = title.trim()
    if (!label) throw new Error('sessions.rename 需要一个标题')
    seed.title = label
    seed.updatedAt = Date.now()
    const { replay: _replay, ...summary } = seed
    return summary
  }

  /* ------------------------------- runtime ----------------------------- */

  private get currentSession(): DemoSessionSeed | undefined {
    return this.seeds.get(this.currentSessionId)
  }

  private touchSession(): void {
    const s = this.currentSession
    if (s) s.updatedAt = Date.now()
  }

  private stopRun(type: 'switch' | 'close', reason: 'switch' | 'close' | 'reload' | 'fork'): void {
    this.generation += 1
    this.running = false
    this.busy = false
    for (const [, resolve] of this.pendingPermissions) resolve('deny')
    this.pendingPermissions.clear()
    this.emit({ type: 'session_shutdown', reason })
    if (type === 'close') return
    void reason
  }

  /** Mirrors `RuntimeError("Runtime is preparing a request or running an extension command")`. */
  private ensureIdle(): void {
    if (this.busy) {
      throw new Error(
        'Runtime is preparing a request or running an extension command',
      )
    }
  }

  private async prompt(message: string, attachments: PromptImage[] = []): Promise<void> {
    this.ensureIdle()
    if (this.state.interaction === 'auto') {
      const planning = /(?:规划|计划|设计思路|设计方案|技术方案|架构方案|\bplan(?:ning)?\b|\bproposal\b)/i.test(message)
      const implementing = /(?:开始|直接)?\s*(?:实施|执行|实现|修复|修改|新增|添加|删除|重构|完成)|\b(?:implement|execute|fix|modify|edit|add|remove|refactor|build)\b/i.test(message)
      this.state.effectiveInteraction = planning && !implementing ? 'plan' : 'default'
    }
    const generation = ++this.generation
    this.busy = true
    this.running = true
    const session = this.currentSession
    if (session && session.messageCount === 0) {
      session.title = message.slice(0, 28) + (message.length > 28 ? '…' : '')
    }
    if (session) session.messageCount += 1

    this.emit({ type: 'agent_start' })
    this.emit({ type: 'turn_start' })
    this.emit({
      type: 'message_end',
      message: {
        role: 'user',
        content: [
          ...(message ? [{ type: 'text' as const, text: message }] : []),
          ...attachments.map((image) => ({
            type: 'image' as const, data: image.data, mimeType: image.mimeType,
          })),
        ],
      },
    })

    if (this.state.effectiveInteraction === 'plan') {
      const toolId = `mock-plan-${generation}`
      this.emit({
        type: 'tool_execution_start', tool_call_id: toolId, tool_name: 'submit_plan', args: {},
      })
      this.emit({
        type: 'tool_execution_end',
        tool_call_id: toolId,
        tool_name: 'submit_plan',
        result: '结构化实施计划已提交。',
        is_error: false,
        details: {
          kind: 'plan',
          plan: {
            summary: '先确认改动边界，再按顺序实施并验证。',
            steps: ['检查相关模块与现有测试', '完成最小范围实现', '运行聚焦测试并检查回归'],
            files: ['相关实现文件', '对应测试文件'],
            risks: ['保持现有行为兼容'],
            verification: ['类型检查', '聚焦单元测试'],
          },
        },
      })
      this.emit({ type: 'turn_end' })
      this.emit({ type: 'agent_end', messages: [] })
      this.busy = false
      this.running = false
      this.touchSession()
      return
    }

    const toolCalls: { id: string; name: string; arguments: Record<string, unknown> }[] = []

    try {
      for (const step of SCRIPT) {
        if (generation !== this.generation) return
        await this.sleep(step.delay)
        if (generation !== this.generation) return

        if (step.thinking) await this.streamThinking(step.thinking, generation)
        if (step.text) await this.streamText(step.text, generation)
        if (step.notice) {
          this.emit({
            type: step.notice.tone === 'success' ? 'compaction_end' : 'compaction_start',
            result: step.notice.description,
          })
        }
        if (step.tool) {
          const toolId = step.tool.id
          toolCalls.push({ id: toolId, name: step.tool.name, arguments: step.tool.args })

          if (step.tool.permission) {
            const approved = await this.requestPermission({
              toolId,
              name: step.tool.name,
              args: step.tool.args,
              permission: step.tool.permission,
              generation,
            })
            if (generation !== this.generation) return
            if (!approved) {
              this.emit({
                type: 'tool_execution_end',
                tool_call_id: toolId,
                tool_name: step.tool.name,
                result: '工具调用被用户拒绝，未执行。',
                is_error: true,
              })
              continue
            }
          }

          this.emit({
            type: 'tool_execution_start',
            tool_call_id: toolId,
            tool_name: step.tool.name,
            args: step.tool.args,
          })
          const updates = step.tool.updates ?? 0
          for (let i = 1; i <= updates; i += 1) {
            await this.sleep(step.tool.duration / (updates + 1))
            if (generation !== this.generation) return
            this.emit({
              type: 'tool_execution_update',
              tool_call_id: toolId,
              partial_result: `${Math.round((i / (updates + 1)) * 100)}% · ${step.tool.name} 输出中…`,
            })
          }
          await this.sleep(
            updates > 0 ? step.tool.duration / (updates + 1) : step.tool.duration,
          )
          if (generation !== this.generation) return
          this.emit({
            type: 'tool_execution_end',
            tool_call_id: toolId,
            tool_name: step.tool.name,
            result: step.tool.result,
            is_error: Boolean(step.tool.isError),
          })
          const s = this.currentSession
          if (s) s.messageCount += 1
        }
        if (step.usage) {
          const s = this.currentSession
          if (s) {
            s.totalTokens += step.usage.input + step.usage.output
            s.cost += step.usage.cost
          }
        }
        if (step.finish) break
      }

      if (generation !== this.generation) return
      this.emit({ type: 'turn_end' })
      this.emit({ type: 'agent_end', messages: [] })
      this.touchSession()
    } finally {
      if (generation === this.generation) {
        this.busy = false
        this.running = false
      }
    }
  }

  private async streamThinking(text: string, generation: number): Promise<void> {
    this.emit({ type: 'message_start' })
    this.emitStream({ type: 'thinking_start', content_index: 0 })
    for (const chunk of chunkText(text, 2)) {
      if (generation !== this.generation) return
      this.emitStream({ type: 'thinking_delta', content_index: 0, delta: chunk })
      await this.sleep(9)
    }
    this.emitStream({ type: 'thinking_end', content_index: 0, content: text })
    this.emitStream({ type: 'done', reason: 'stop' })
  }

  private async streamText(text: string, generation: number): Promise<void> {
    this.emit({ type: 'message_start' })
    this.emitStream({ type: 'start' })
    this.emitStream({ type: 'text_start', content_index: 0 })
    for (const chunk of chunkText(text, 3)) {
      if (generation !== this.generation) return
      this.emitStream({ type: 'text_delta', content_index: 0, delta: chunk })
      await this.sleep(14)
    }
    this.emitStream({ type: 'text_end', content_index: 0, content: text })
    this.emitStream({ type: 'done', reason: 'stop' })
    this.emit({
      type: 'message_end',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text }],
        model: this.state.model.id,
        provider: this.state.model.provider,
        stopReason: 'stop',
        usage: {
          input: 12_480 + Math.round(Math.random() * 900),
          output: Math.round(text.length / 3),
          cacheRead: 11_120,
          cacheWrite: 0,
          reasoning: 0,
          totalTokens: 12_480 + Math.round(text.length / 3),
          cost: {
            input: 0.0035,
            output: 0.0012,
            cacheRead: 0.0007,
            cacheWrite: 0,
            total: 0.0054,
          },
        },
      },
    })
    this.touchSession()
  }

  private requestPermission(input: {
    toolId: string
    name: string
    args: Record<string, unknown>
    permission: NonNullable<NonNullable<(typeof SCRIPT)[number]['tool']>['permission']>
    generation: number
  }): Promise<boolean> {
    const id = uid('perm')
    const request: PermissionRequest = {
      id,
      ts: Date.now(),
      tool_call_id: input.toolId,
      tool_name: input.name,
      args: input.args,
      required: input.permission.required,
      mode: this.state.permission,
      cwd: this.state.cwd,
      reason: input.permission.reason,
      summary: input.permission.summary,
      preview: input.permission.preview,
    }
    return new Promise<boolean>((resolve) => {
      const timeout = setTimeout(() => {
        this.pendingPermissions.delete(id)
        resolve(false)
      }, 120_000)
      this.pendingPermissions.set(id, (decision) => {
        clearTimeout(timeout)
        resolve(decision !== 'deny')
      })
      for (const listener of [...this.permissionListeners]) listener(request)
      void input.generation
    })
  }

  private abort(): void {
    if (!this.running) return
    this.generation += 1
    this.running = false
    this.busy = false
    for (const [, resolve] of this.pendingPermissions) resolve('deny')
    this.pendingPermissions.clear()
    this.emit({ type: 'turn_end' })
    this.emit({ type: 'agent_end', messages: [] })
  }

  private async enqueue(message: string, kind: 'steer' | 'follow_up'): Promise<void> {
    // 真实宿主在「没有在跑的一轮」时会拒绝插话（`fox_serve/host.py::_require_running`），
    // 因为那样的消息永远不会被消费。演示宿主必须一样，前端才会走「改成直接发送」那条路。
    if (!this.running) {
      throw new Error(`当前没有正在运行的一轮，${kind} 不会被消费；请直接发送这条消息`)
    }
    this.emit({
      type: 'message_end',
      message: {
        role: 'user',
        content: [
          {
            type: 'text',
            text: message,
          },
        ],
        timestamp: Date.now(),
      },
    })
    void kind
    const s = this.currentSession
    if (s) s.messageCount += 1
  }

  private async compact(): Promise<void> {
    this.ensureIdle()
    const generation = ++this.generation
    this.busy = true
    this.emit({ type: 'compaction_start' })
    await this.sleep(1200)
    if (generation !== this.generation) return
    // 结构化数字（真实宿主 fox_serve 也发这些字段）：前端据此回退上下文占用。
    this.emit({
      type: 'compaction_end',
      automatic: false,
      preTokens: 74_312,
      postTokens: 19_880,
      removedCount: 42,
      retainedCount: 6,
      summary: '把早期的工具输出与中间推理压缩成摘要，保留最近 6 条原文。',
    })
    this.busy = false
  }

  private async runCommand(name: string, args: string): Promise<unknown> {
    if (name === 'compact') {
      await this.compact()
      return 'compacted'
    }
    if (name === 'permission') {
      const mode = args.trim() as HostInfo['permissionMode']
      if (['read-only', 'workspace-modify', 'full-access'].includes(mode)) this.state.permission = mode
      return this.state.permission
    }
    if (name === 'mode') {
      const mode = args.trim() as HostInfo['interactionMode']
      if (['auto', 'default', 'plan'].includes(mode)) {
        this.state.interaction = mode
        this.state.effectiveInteraction = mode === 'plan' ? 'plan' : 'default'
      }
      return this.state.interaction
    }
    if (name === 'sandbox') {
      const mode = args.trim() as HostInfo['executionMode']
      if (['local', 'sandbox'].includes(mode)) this.state.execution = mode
      return this.state.execution
    }
    if (name === 'trust') {
      this.state.trusted = args.trim() !== 'off'
      return this.state.trusted
    }
    if (name === 'export') {
      return { path: `${CWD}\\.foxcode\\exports\\session.${args.trim() === 'markdown' ? 'md' : 'json'}` }
    }
    if (name === 'fork') {
      return this.forkSession()
    }
    if (name === 'reload') {
      return this.send({ method: 'reload' })
    }
    return `command ${name} ${args}`.trim()
  }

  private async invokeSkill(name: string, instructions: string): Promise<unknown> {
    if (!instructions.trim()) throw new Error('调用技能前需要填写任务说明')
    this.emit({
      type: 'message_end',
      message: { role: 'user', content: [{ type: 'text', text: instructions }] },
    })
    this.emit({
      type: 'message_end',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: `已使用技能 \`${name}\` 完成任务。` }],
        stopReason: 'stop',
      },
    })
    return name
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms))
  }
}

export const MOCK_DEMO_PROMPT = DEMO_PROMPT
