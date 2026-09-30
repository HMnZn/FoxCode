/**
 * SettingsPage — 会话 / 模型 / 权限 / 外观与宿主信息的集中配置。
 *
 * 页面本身不保存状态：每一处开关都直接调用 sessionStore 的对应动作，由宿主
 * 应用后回传权威状态（`refreshHost`），因此界面永远是宿主状态的投影。
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import {
  AlertTriangle,
  Bot,
  Check,
  Cpu,
  Download,
  FolderOpen,
  FolderTree,
  Info,
  KeyRound,
  RefreshCw,
  Scissors,
  ShieldAlert,
  ShieldCheck,
  Sparkles,
  ServerCog,
  SlidersHorizontal,
} from 'lucide-react'
import { Button, Chip, SegmentedControl, Select, Switch, toast } from '@/components/ui'
import { useSession } from '@/store/sessionStore'
import { useWorkspace, samePath, workspaceName } from '@/store/workspaceStore'
import { applyTheme, useUi } from '@/store/uiStore'
import { formatClock, formatTokens, shortPath } from '@/lib/format'
import { cn } from '@/lib/cn'
import { SettingsControlPlane } from '@/components/settings/SettingsControlPlane'
import {
  PERMISSION_HINT,
  PERMISSION_LABEL,
  PERMISSION_MODES,
  EXECUTION_LABEL,
  EXECUTION_MODES,
  THINKING_LEVELS,
  type PermissionMode,
  type ExecutionMode,
  type ThinkingLevel,
} from '@/types/protocol'

const THINKING_LABEL: Record<ThinkingLevel, string> = {
  off: '关闭',
  minimal: '极少',
  low: '低',
  medium: '中',
  high: '高',
  xhigh: '极高',
}

const THEME_OPTIONS: ReadonlyArray<{ value: 'dark' | 'light'; label: string }> = [
  { value: 'dark', label: '深色' },
  { value: 'light', label: '浅色' },
]

type SectionId = 'session' | 'model' | 'runtime-defaults' | 'providers' | 'mcp' | 'subagents' | 'execution' | 'permission' | 'appearance' | 'demo'

const SECTION_NAV: ReadonlyArray<{ id: SectionId; label: string; icon: typeof Cpu }> = [
  { id: 'session', label: '会话', icon: FolderOpen },
  { id: 'model', label: '模型', icon: Cpu },
  { id: 'runtime-defaults', label: '运行默认值', icon: SlidersHorizontal },
  { id: 'providers', label: '模型供应商', icon: KeyRound },
  { id: 'mcp', label: 'MCP', icon: ServerCog },
  { id: 'subagents', label: 'Subagents', icon: Bot },
  { id: 'execution', label: '执行环境', icon: ShieldCheck },
  { id: 'permission', label: '权限', icon: ShieldAlert },
  { id: 'appearance', label: '外观', icon: Sparkles },
  { id: 'demo', label: '演示宿主', icon: Info },
]

export function SettingsPage() {
  const host = useSession((state) => state.host)
  const bridge = useSession((state) => state.bridge)
  const setTrust = useSession((state) => state.setTrust)
  const exportSession = useSession((state) => state.exportSession)
  const compact = useSession((state) => state.compact)
  const selectModel = useSession((state) => state.selectModel)
  const setThinking = useSession((state) => state.setThinking)
  const setPermissionMode = useSession((state) => state.setPermissionMode)
  const setExecutionMode = useSession((state) => state.setExecutionMode)

  const recentWorkspaces = useWorkspace((state) => state.recent)
  const applying = useWorkspace((state) => state.applying)
  const pickWorkspace = useWorkspace((state) => state.pick)
  const openWorkspace = useWorkspace((state) => state.open)
  const failedWorkspace = useWorkspace((state) => state.failedFor)
  const workspaceError = useWorkspace((state) => state.lastError)
  const retryWorkspace = useWorkspace((state) => state.retry)

  const theme = useUi((state) => state.theme)
  const setTheme = useUi((state) => state.setTheme)

  const [picking, setPicking] = useState(false)

  const scrollRef = useRef<HTMLDivElement | null>(null)
  const showDemo = host?.transport === 'mock'
  const nav = useMemo(() => SECTION_NAV.filter((item) => item.id !== 'demo' || showDemo), [showDemo])
  const [active, setActive] = useState<SectionId>('session')
  const sectionKey = nav.map((item) => item.id).join(',')

  /**
   * Scroll-spy for the section rail. Guarded because jsdom has no
   * IntersectionObserver (see `vitest.setup.ts`) and the page must still mount.
   */
  useEffect(() => {
    const root = scrollRef.current
    if (!root || typeof IntersectionObserver === 'undefined') return
    const targets = Array.from(root.querySelectorAll<HTMLElement>('[data-section]'))
    if (targets.length === 0) return
    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries.filter((entry) => entry.isIntersecting)
        if (visible.length === 0) return
        const first = visible.reduce((a, b) => (a.boundingClientRect.top <= b.boundingClientRect.top ? a : b))
        const id = first.target.getAttribute('data-section') as SectionId | null
        if (id) setActive(id)
      },
      { root, rootMargin: '-10% 0px -70% 0px' },
    )
    for (const target of targets) observer.observe(target)
    return () => observer.disconnect()
  }, [sectionKey])

  const goTo = (id: SectionId) => {
    setActive(id)
    document.getElementById(`settings-${id}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }

  const modelOptions = (host?.availableModels ?? []).map((model) => ({
    value: model.id,
    label: model.displayName,
    hint:
      model.contextWindow != null
        ? `${model.provider} · ${formatTokens(model.contextWindow)}`
        : model.provider,
  }))

  const onPickDirectory = () => {
    setPicking(true)
    void pickWorkspace().finally(() => setPicking(false))
  }

  const onReload = () => {
    void bridge
      .send({ method: 'reload' })
      .then(() => toast.success({ title: '已请求重新加载运行时' }))
      .catch((error: unknown) => {
        toast.danger({
          title: '重新加载失败',
          description: error instanceof Error ? error.message : String(error),
        })
      })
  }

  const onThemeChange = (next: 'dark' | 'light') => {
    setTheme(next)
    applyTheme(next)
  }

  return (
    <div ref={scrollRef} className="scroll-quiet flex h-full flex-col overflow-y-auto bg-canvas">
      <div className="mx-auto flex w-full max-w-[960px] flex-col gap-6 px-8 py-9 lg:px-12">
        <header className="flex flex-wrap items-center gap-2">
          <h1 className="text-[26px] leading-8 font-medium tracking-[-0.02em] text-fg">设置</h1>
          <Chip size="sm" mono>
            {host?.transport ?? '未连接'}
          </Chip>
        </header>

        <div className="grid gap-8 min-[880px]:grid-cols-[172px_minmax(0,1fr)]">
          <nav aria-label="设置分节" className="hidden min-[880px]:block">
            <div className="sticky top-0 flex flex-col gap-0.5">
              {nav.map((item) => {
                const Icon = item.icon
                const current = active === item.id
                return (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => goTo(item.id)}
                    aria-current={current ? 'true' : undefined}
                    className={cn(
                      'relative flex min-h-9 items-center gap-2 rounded-md px-2.5 text-left text-[12.5px] transition-colors',
                      current
                        ? 'bg-surface-2 font-medium text-fg'
                        : 'text-fg-muted hover:bg-surface-2/60 hover:text-fg',
                    )}
                  >
                    {current ? (
                      <span
                        aria-hidden="true"
                        className="absolute top-1/2 left-0 h-4 w-[2.5px] -translate-y-1/2 rounded-full bg-accent"
                      />
                    ) : null}
                    <Icon size={13} aria-hidden="true" className="shrink-0 opacity-80" />
                    <span className="truncate">{item.label}</span>
                  </button>
                )
              })}
            </div>
          </nav>

          <div className="flex min-w-0 flex-col gap-6">
            <Section id="session" title="会话" hint="工作目录、落盘文件与会话级操作">
          <Row label="当前工作目录" hint="模型的相对路径、读写范围与信任判定都以它为基准">
            <span className="font-mono text-xs text-fg-muted">
              {host?.cwd ? shortPath(host.cwd) : '—'}
            </span>
            <Button
              variant="outline"
              size="sm"
              iconLeft={<FolderOpen size={13} aria-hidden="true" />}
              loading={picking || applying !== null}
              onClick={() => onPickDirectory()}
            >
              更换工作区
            </Button>
          </Row>

          {failedWorkspace ? (
            <Row label="工作区未生效" hint="宿主拒绝了这次切换：它仍停在上面那个目录">
              <div className="flex max-w-[520px] flex-col items-end gap-1.5">
                <span className="font-mono text-xs text-warn">{shortPath(failedWorkspace, 48)}</span>
                {workspaceError ? (
                  <span className="max-w-[460px] text-right text-2xs text-fg-subtle">
                    {workspaceError}
                  </span>
                ) : null}
                <Button
                  variant="outline"
                  size="sm"
                  loading={applying !== null}
                  onClick={() => void retryWorkspace()}
                >
                  重试切换
                </Button>
              </div>
            </Row>
          ) : null}

          {recentWorkspaces.length > 0 ? (
            <Row label="最近工作区" hint="换过的文件夹会记在这里，点击即可切回">
              <div className="flex max-w-[520px] flex-wrap items-center justify-end gap-1.5">
                {recentWorkspaces.map((path) => {
                  const active = samePath(host?.cwd, path)
                  return (
                    <button
                      key={path}
                      type="button"
                      disabled={active || applying !== null}
                      title={path}
                      onClick={() => void openWorkspace(path)}
                      className={cn(
                        'flex max-w-[240px] items-center gap-1.5 rounded-md px-2 py-1 text-[12px] transition-colors',
                        active
                          ? 'bg-accent-soft text-accent'
                          : 'bg-surface-2 text-fg-muted hover:bg-surface-3 hover:text-fg',
                        applying !== null && 'opacity-60',
                      )}
                    >
                      <FolderTree size={12} aria-hidden="true" className="shrink-0" />
                      <span className="truncate">{workspaceName(path)}</span>
                      <span className="shrink-0 font-mono text-2xs opacity-70">
                        {shortPath(path, 22)}
                      </span>
                    </button>
                  )
                })}
              </div>
            </Row>
          ) : null}

          <Row label="会话文件" hint="当前会话以 JSONL 追加写入；文件即会话本身">
            <span className="max-w-[420px] select-all truncate font-mono text-xs text-fg-muted" title={host?.sessionFile ?? ''}>
              {host?.sessionFile || '（尚未创建）'}
            </span>
          </Row>

          <Row label="项目信任" hint="未信任时，写入与执行类工具会被直接拒绝">
            <Switch
              checked={host?.projectTrusted ?? false}
              onChange={(next) => void setTrust(next)}
              disabled={!host}
              label={host?.projectTrusted ? '已信任' : '未信任'}
            />
          </Row>

          <Row label="导出会话" hint="导出的是当前会话文件中已落盘的全部消息">
            <Button
              variant="secondary"
              size="sm"
              iconLeft={<Download size={13} aria-hidden="true" />}
              onClick={() => void exportSession('json')}
            >
              导出 JSON
            </Button>
            <Button
              variant="secondary"
              size="sm"
              iconLeft={<Download size={13} aria-hidden="true" />}
              onClick={() => void exportSession('markdown')}
            >
              导出 Markdown
            </Button>
          </Row>

          <Row label="压缩上下文" hint="由宿主总结较早的消息，释放窗口占用；用量累计不会被重置">
            <Button
              variant="outline"
              size="sm"
              iconLeft={<Scissors size={13} aria-hidden="true" />}
              onClick={() => void compact()}
            >
              压缩上下文
            </Button>
          </Row>

          <Row label="运行时" hint="重新载入宿主进程的配置与技能，界面状态随后刷新">
            <Button
              variant="outline"
              size="sm"
              iconLeft={<RefreshCw size={13} aria-hidden="true" />}
              onClick={onReload}
            >
              重新加载运行时
            </Button>
          </Row>
        </Section>

        <Section id="model" title="模型" hint="模型与推理强度都由宿主执行，切换后立即生效">
          <Row label="模型" hint="上下文窗口决定单次请求可容纳的历史长度">
            <div className="w-[320px]">
              <Select
                value={host?.model.id ?? null}
                options={modelOptions}
                onChange={(id) => void selectModel(id)}
                size="sm"
                placeholder={modelOptions.length === 0 ? '宿主未提供模型列表' : '选择模型'}
                disabled={modelOptions.length === 0}
                aria-label="选择模型"
              />
            </div>
          </Row>

          <Row label="推理强度" hint="越高越倾向深度思考，同时消耗更多输出 tokens">
            <SegmentedControl
              value={host?.thinkingLevel ?? 'medium'}
              options={THINKING_LEVELS.map((level) => ({ value: level, label: THINKING_LABEL[level] }))}
              onChange={setThinking}
              size="sm"
              aria-label="推理强度"
            />
          </Row>
        </Section>

        <SettingsControlPlane />

        <Section
          id="execution"
          title="执行环境"
          hint="权限决定能做什么；执行环境决定代码在什么边界内运行"
        >
          <div className="grid gap-2 md:grid-cols-2">
            {EXECUTION_MODES.map((mode) => (
              <ExecutionCard
                key={mode}
                mode={mode}
                current={host?.executionMode}
                shellAvailable={host?.sandbox.shell ?? false}
                backend={host?.sandbox.backend}
                onSelect={() => void setExecutionMode(mode)}
              />
            ))}
          </div>
          {host?.executionMode === 'sandbox' ? (
            <div className="flex items-start gap-2 rounded-lg border border-success/40 bg-success-soft p-3 text-2xs text-success">
              <ShieldCheck size={13} className="mt-px shrink-0" aria-hidden="true" />
              <span>
                文件工具被限制在项目目录内；测试、日志和临时文件写入{' '}
                <span className="font-mono">.foxcode/artifacts/</span>。
                {host.sandbox.shell
                  ? ` shell 由 ${host.sandbox.backend} 隔离，并关闭网络。`
                  : ' 当前系统没有可用的原生进程沙盒，因此 shell 工具被禁用。'}
              </span>
            </div>
          ) : null}
          <Row label="用户配置根目录" hint="设置、模型、凭据、MCP、技能、扩展与会话">
            <span className="max-w-[480px] truncate font-mono text-2xs text-fg-muted">
              {host?.paths?.user.root ?? '—'}
            </span>
          </Row>
          <Row label="项目产物目录" hint="测试报告、覆盖率、截图、日志与临时文件">
            <span className="max-w-[480px] truncate font-mono text-2xs text-fg-muted">
              {host?.paths?.project.artifacts ?? '.foxcode/artifacts'}
            </span>
          </Row>
        </Section>

        <Section id="permission" title="权限" hint="这里只调整运行时的权限档位，最终仍由粒度更细的检查决定">
          <div className="grid gap-2 md:grid-cols-3">
            {PERMISSION_MODES.map((mode) => (
              <PermissionCard
                key={mode}
                mode={mode}
                current={host?.permissionMode}
                onSelect={() => void setPermissionMode(mode)}
              />
            ))}
          </div>
          <p className="text-2xs leading-relaxed text-fg-subtle">
            这些卡片只能提高或降低运行时的权限档位；即便选择「完全访问」，宿主的{' '}
            <span className="font-mono">before_tool_call</span> 钩子与静态检查仍可拒绝单次工具调用。
          </p>
          {host?.permissionMode === 'full-access' && (
            <div className="flex items-start gap-2 rounded-lg border border-warn/40 bg-warn-soft p-3 text-2xs text-warn">
              <AlertTriangle size={13} className="mt-px shrink-0" aria-hidden="true" />
              <span>
                当前处于「完全访问」：模型可以执行 shell 命令并写入任意路径。仅在信任的仓库与可复现的环境中保持该档位。
              </span>
            </div>
          )}
        </Section>

        <Section id="appearance" title="外观" hint="主题仅影响界面渲染，不影响宿主行为">
          <Row label="主题" hint="跟随系统请使用窗口左上角的快速切换">
            <SegmentedControl
              value={theme}
              options={THEME_OPTIONS}
              onChange={onThemeChange}
              size="sm"
              aria-label="界面主题"
            />
          </Row>
        </Section>

        {host?.transport === 'mock' && (
          <Section id="demo" title="演示宿主" hint="未连接 fox serve 边车进程">
            <div className="flex items-start gap-2 rounded-lg border border-info/40 bg-info-soft p-3 text-2xs leading-relaxed text-info">
              <Info size={13} className="mt-px shrink-0" aria-hidden="true" />
              <span>
                当前没有 <span className="font-mono">fox serve</span> 边车进程，界面正驱动内置演示宿主：
                会话、技能、扩展与用量均来自本地模拟数据，不会真正读写磁盘或执行命令。
              </span>
            </div>
            <Row label="宿主版本" hint="演示宿主随桌面端一起构建">
              <span className="font-mono text-xs text-fg-muted">{host.hostVersion}</span>
            </Row>
            <Row label="协议版本" hint="宿主与界面之间的 JSON-RPC 协议版本">
              <span className="font-mono text-xs text-fg-muted">v{host.protocolVersion}</span>
            </Row>
          </Section>
        )}

            <footer className="flex flex-wrap items-center gap-2 border-t border-line pt-3 text-2xs text-fg-subtle">
              <Cpu size={12} aria-hidden="true" />
              <span>
                协议版本 <span className="font-mono tabular-nums text-fg-muted">v{host?.protocolVersion ?? '—'}</span>
              </span>
              <span aria-hidden="true">·</span>
              <span>
                宿主版本 <span className="font-mono text-fg-muted">{host?.hostVersion ?? '—'}</span>
              </span>
              <span aria-hidden="true">·</span>
              <Chip size="xs" tone={host?.transport === 'sidecar' ? 'success' : 'info'}>
                {host?.transport ?? '未连接'}
              </Chip>
              <span className="ml-auto">
                设置已保存于本地存储，最后访问 {formatClock(Date.now())}
              </span>
            </footer>
          </div>
        </div>
      </div>
    </div>
  )
}

function Section({
  id,
  title,
  hint,
  children,
}: {
  id: SectionId
  title: string
  hint?: string
  children: ReactNode
}) {
  return (
    <section id={`settings-${id}`} data-section={id} className="scroll-mt-4 flex flex-col gap-3">
      <div className="flex flex-wrap items-baseline gap-2">
        <h2 className="text-xs font-semibold tracking-wide text-fg">{title}</h2>
        {hint && <span className="text-2xs text-fg-subtle">{hint}</span>}
      </div>
      <div className="surface-card flex flex-col gap-3 p-4">{children}</div>
    </section>
  )
}

function Row({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-line pb-3 last:border-b-0 last:pb-0">
      <div className="min-w-[170px]">
        <div className="text-xs text-fg">{label}</div>
        {hint && <div className="mt-0.5 text-2xs leading-relaxed text-fg-subtle">{hint}</div>}
      </div>
      <div className="ml-auto flex flex-wrap items-center justify-end gap-2">{children}</div>
    </div>
  )
}

function PermissionCard({
  mode,
  current,
  onSelect,
}: {
  mode: PermissionMode
  current: PermissionMode | undefined
  onSelect: () => void
}) {
  const active = current === mode
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={active}
      className={[
        'flex flex-col gap-1.5 rounded-lg border p-3 text-left transition-colors',
        active
          ? 'border-accent bg-accent-soft'
          : 'border-line bg-surface-2 hover:border-line-strong hover:bg-surface-3',
      ].join(' ')}
    >
      <span className="flex items-center gap-2">
        <span className={`text-xs font-medium ${active ? 'text-accent' : 'text-fg'}`}>
          {PERMISSION_LABEL[mode]}
        </span>
        {mode === 'full-access' && <ShieldAlert size={12} className="text-warn" aria-hidden="true" />}
        {active && <Check size={12} className="ml-auto text-accent" aria-hidden="true" />}
      </span>
      <span className="text-2xs leading-relaxed text-fg-subtle">{PERMISSION_HINT[mode]}</span>
      <span className="mt-1 font-mono text-2xs text-fg-subtle">{mode}</span>
    </button>
  )
}

function ExecutionCard({
  mode,
  current,
  shellAvailable,
  backend,
  onSelect,
}: {
  mode: ExecutionMode
  current: ExecutionMode | undefined
  shellAvailable: boolean
  backend?: string
  onSelect: () => void
}) {
  const active = current === mode
  const hint = mode === 'local'
    ? '直接使用宿主文件系统和网络，实际能力仍受权限档位控制'
    : shellAvailable
      ? `项目目录内写入、网络隔离；shell 后端：${backend}`
      : '文件工具严格限制在项目内；缺少原生后端时禁用 shell'
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={active}
      className={[
        'flex flex-col gap-1.5 rounded-lg border p-3 text-left transition-colors',
        active
          ? 'border-accent bg-accent-soft'
          : 'border-line bg-surface-2 hover:border-line-strong hover:bg-surface-3',
      ].join(' ')}
    >
      <span className="flex items-center gap-2">
        {mode === 'sandbox' ? <ShieldCheck size={13} className="text-success" /> : <Cpu size={13} />}
        <span className={`text-xs font-medium ${active ? 'text-accent' : 'text-fg'}`}>
          {EXECUTION_LABEL[mode]}
        </span>
        {active && <Check size={12} className="ml-auto text-accent" aria-hidden="true" />}
      </span>
      <span className="text-2xs leading-relaxed text-fg-subtle">{hint}</span>
      <span className="mt-1 font-mono text-2xs text-fg-subtle">{mode}</span>
    </button>
  )
}
