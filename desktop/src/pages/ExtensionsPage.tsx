/**
 * ExtensionsPage — 宿主扩展的加载与开关。
 *
 * 扩展是**配置驱动**的：一个扩展是否生效，取决于 settings.json 的 `extensions`
 * 列表里有没有它的 spec（`module:pkg.mod:setup` / `entrypoint:name` / 文件绝对路径）。
 * 项目级 settings.json 一旦写了 `extensions` 键，它整体覆盖用户级（列表是替换语义），
 * 所以这里显示的「生效作用域」就是宿主真正读取的那个文件。
 *
 * 开关由宿主执行：改配置 → `runtime.reload()` 热重载 → 失败回滚。前端只负责发命令和
 * 重新拉 `host.info`（`extensions.set` 的返回里也带了刷新后的两个列表）。
 */
import { useEffect, useMemo, useState } from 'react'
import { AlertTriangle, Ban, FolderCog, Info, ShieldCheck, UserCog } from 'lucide-react'
import { Chip, EmptyState, Switch, Tooltip } from '@/components/ui'
import { FoxMark } from '@/components/brand/Fox'
import { useSession } from '@/store/sessionStore'
import { shortPath, truncate } from '@/lib/format'
import type { ExtensionInfo } from '@/types/protocol'

type Tone = 'neutral' | 'accent' | 'success' | 'warn' | 'danger' | 'info' | 'think'

/** 与宿主文档一致的判定顺序，前一步拒绝就不会再往下走。 */
const HOOK_CHAIN: ReadonlyArray<{ label: string; body: string; tone: Tone }> = [
  { label: '1 · 未信任项目', body: '项目被标记为未信任时，写入与执行直接拒绝', tone: 'danger' },
  { label: '2 · 静态权限检查', body: '按当前权限模式判定路径与命令是否越界', tone: 'warn' },
  { label: '3 · 宿主 before_tool_call', body: '宿主内置规则，例如保护敏感文件', tone: 'info' },
  { label: '4 · 扩展 before_tool', body: '扩展按注册顺序依次表决', tone: 'accent' },
]

const KIND_LABEL: Record<string, string> = {
  module: '模块',
  entrypoint: '入口点',
  file: '文件',
}

const ORIGIN_LABEL: Record<string, string> = {
  builtin: '内置',
  user: '用户目录',
  project: '项目目录',
}

/** 一个扩展在配置里的唯一标识（宿主接受 id / spec / 路径）。 */
function extensionId(extension: ExtensionInfo): string {
  return extension.id ?? extension.spec ?? extension.path ?? extension.name
}

export function ExtensionsPage() {
  const host = useSession((state) => state.host)
  const setExtension = useSession((state) => state.setExtension)
  const [pending, setPending] = useState<ReadonlySet<string>>(new Set())

  const extensions = useMemo(() => host?.extensions ?? [], [host?.extensions])
  const available = useMemo(() => host?.availableExtensions ?? [], [host?.availableExtensions])
  const enabledCount = extensions.filter((extension) => extension.enabled).length
  const failingCount = extensions.filter((extension) => Boolean(extension.error)).length
  const projectLocked = host ? host.projectTrusted === false : false
  const scope = extensions[0]?.scope ?? available[0]?.scope ?? 'user'

  // 切换目标会话/工作目录后，上一轮的「进行中」标记不应该留着。
  useEffect(() => {
    setPending(new Set())
  }, [host?.cwd, host?.sessionFile])

  const toggle = async (extension: ExtensionInfo, enabled: boolean) => {
    const id = extensionId(extension)
    setPending((prev) => new Set(prev).add(id))
    try {
      await setExtension(id, enabled)
    } catch {
      // 失败原因已经由 store 弹出 toast，这里只需要复位开关状态。
    } finally {
      setPending((prev) => {
        const next = new Set(prev)
        next.delete(id)
        return next
      })
    }
  }

  return (
    <div className="scroll-quiet flex h-full flex-col overflow-y-auto bg-canvas">
      <div className="mx-auto flex w-full max-w-[1100px] flex-col gap-4 p-6">
        <header className="flex flex-wrap items-center gap-2">
          <h1 className="text-[20px] leading-[28px] font-medium text-fg">扩展</h1>
          <Chip size="sm" mono>
            {extensions.length + available.length}
          </Chip>
          <Chip size="sm" tone="success">
            已启用 {enabledCount}
          </Chip>
          {available.length > 0 && (
            <Chip size="sm" tone="info">
              可加载 {available.length}
            </Chip>
          )}
          {failingCount > 0 && (
            <Chip size="sm" tone="danger">
              加载失败 {failingCount}
            </Chip>
          )}
          <span className="ml-auto inline-flex items-center gap-1.5 text-2xs text-fg-subtle">
            {scope === 'project' ? <FolderCog size={12} /> : <UserCog size={12} />}
            生效作用域
            <Chip size="xs" tone={scope === 'project' ? 'accent' : 'neutral'}>
              {scope === 'project' ? '项目级 .foxcode/settings.json' : '用户级 ~/.foxcode/settings.json'}
            </Chip>
          </span>
        </header>

        <p className="max-w-[86ch] text-xs leading-relaxed text-fg-muted">
          扩展与主程序隔离：宿主只在启动（或重载）时读取 settings.json 的{' '}
          <span className="font-mono">extensions</span> 列表并调用各自的 <span className="font-mono">setup</span>。
          打开开关 = 把 spec 写进配置文件并热重载（当前会话、模型与历史都保留）；关闭 = 从所有作用域移除。
          项目级配置里一旦出现 <span className="font-mono">extensions</span> 键，它会整体覆盖用户级列表。
        </p>

        {projectLocked && (
          <div className="flex items-start gap-2 rounded-lg bg-warn-soft p-3 text-2xs text-warn">
            <AlertTriangle size={13} className="mt-px shrink-0" aria-hidden="true" />
            <span>
              当前项目未受信任，宿主会拒绝写入项目级配置。可以先信任项目，或把扩展装到用户级目录。
            </span>
          </div>
        )}

        <section className="surface-card flex flex-col gap-3 p-4">
          <div className="flex items-center gap-2">
            <ShieldCheck size={13} className="text-success" aria-hidden="true" />
            <h2 className="text-xs font-medium text-fg-muted">钩子判定顺序</h2>
            <span className="ml-auto text-2xs text-fg-subtle">任一层拒绝即终止，钩子只能收紧权限</span>
          </div>
          <div className="flex flex-wrap items-stretch gap-2">
            {HOOK_CHAIN.map((step, index) => (
              <div key={step.label} className="flex min-w-0 items-center gap-2">
                {index > 0 && <span className="text-fg-subtle" aria-hidden="true">→</span>}
                <div className="min-w-[180px] flex-1 rounded-lg border border-line bg-surface-2 px-3 py-2">
                  <Chip size="xs" tone={step.tone}>
                    {step.label}
                  </Chip>
                  <p className="mt-1.5 text-2xs leading-relaxed text-fg-subtle">{step.body}</p>
                </div>
              </div>
            ))}
          </div>
        </section>

        <section className="flex flex-col gap-2">
          <div className="flex items-center gap-2">
            <h2 className="text-xs font-medium text-fg-muted">已启用</h2>
            <Chip size="xs" mono>
              {extensions.length}
            </Chip>
            <span className="text-2xs text-fg-subtle">写在生效作用域的 extensions 列表里</span>
          </div>
          {extensions.length === 0 ? (
            <EmptyState
              mascot={<FoxMark size={46} tone="outline" className="text-accent opacity-70" />}
              title="宿主没有加载扩展"
              description="在下面的「可加载」里打开一个，或把 module:pkg.mod:setup 写进 settings.json 的 extensions。"
            />
          ) : (
            extensions.map((extension) => (
              <ExtensionCard
                key={extensionId(extension)}
                extension={extension}
                enabled
                pending={pending.has(extensionId(extension))}
                onToggle={(next) => void toggle(extension, next)}
              />
            ))
          )}
        </section>

        <section className="flex flex-col gap-2">
          <div className="flex items-center gap-2">
            <h2 className="text-xs font-medium text-fg-muted">可加载</h2>
            <Chip size="xs" mono>
              {available.length}
            </Chip>
            <span className="text-2xs text-fg-subtle">
              宿主发现得到、但还没写进配置；打开开关即写入并热重载
            </span>
          </div>
          {available.length === 0 ? (
            <p className="rounded-lg border border-line bg-surface-2 p-3 text-2xs leading-relaxed text-fg-subtle">
              宿主没有发现其它扩展。可发现位置：
              <span className="font-mono"> packages/fox_coding_agent/src/extensions/*/extension.py</span>、
              <span className="font-mono"> ~/.foxcode/extensions/*.py</span>、
              <span className="font-mono"> &lt;项目&gt;/.foxcode/extensions/*.py</span>。
            </p>
          ) : (
            available.map((extension) => {
              const locked = projectLocked && extension.scope === 'project'
              return (
                <ExtensionCard
                  key={extensionId(extension)}
                  extension={extension}
                  enabled={false}
                  pending={pending.has(extensionId(extension))}
                  disabled={locked}
                  disabledReason="项目未受信任：信任后才能写入项目级配置"
                  onToggle={(next) => void toggle(extension, next)}
                />
              )
            })
          )}
        </section>

        <footer className="flex flex-wrap items-center gap-2 border-t border-line pt-3 text-2xs text-fg-subtle">
          <Info size={12} aria-hidden="true" />
          <span>
            共 <span className="font-mono tabular-nums text-fg-muted">{extensions.length}</span> 个已启用、
            <span className="font-mono tabular-nums text-fg-muted"> {available.length}</span> 个可加载；钩子数量合计{' '}
            <span className="font-mono tabular-nums text-fg-muted">
              {extensions.reduce((sum, extension) => sum + extension.hooks.length, 0)}
            </span>
            。
          </span>
        </footer>
      </div>
    </div>
  )
}

interface ExtensionCardProps {
  extension: ExtensionInfo
  enabled: boolean
  pending: boolean
  disabled?: boolean
  disabledReason?: string
  onToggle: (enabled: boolean) => void
}

function ExtensionCard({
  extension,
  enabled,
  pending,
  disabled,
  disabledReason,
  onToggle,
}: ExtensionCardProps) {
  const contributions: ReadonlyArray<{ label: string; values: string[]; tone: Tone }> = [
    { label: '工具', values: extension.tools ?? [], tone: 'accent' },
    { label: '命令', values: extension.commands ?? [], tone: 'info' },
    { label: '服务', values: extension.services ?? [], tone: 'think' },
    { label: '上下文变换', values: extension.contextTransforms ?? [], tone: 'success' },
    { label: '钩子', values: extension.hooks ?? [], tone: 'neutral' },
  ]
  const unknownFile =
    extension.kind === 'file' && extension.probed !== true && !extension.error

  return (
    <article className="surface-card flex flex-col gap-2 p-3">
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <span className="truncate font-mono text-[13px] font-medium text-fg" title={extension.name}>
          {extension.name}
        </span>
        {extension.kind && <Chip size="xs">{KIND_LABEL[extension.kind] ?? extension.kind}</Chip>}
        {extension.scope && (
          <Chip size="xs" tone={extension.scope === 'project' ? 'accent' : 'neutral'}>
            {extension.scope === 'project' ? '项目级' : '用户级'}
          </Chip>
        )}
        {extension.origin && (
          <Chip size="xs" tone="neutral">
            {ORIGIN_LABEL[extension.origin] ?? extension.origin}
          </Chip>
        )}
        {extension.shadowed?.length ? (
          <Tooltip content="另一个作用域的配置里也有它，而列表是整体替换的" side="top">
            <Chip size="xs" tone="warn">
              另有 {extension.shadowed.length} 处引用
            </Chip>
          </Tooltip>
        ) : null}
        <span className="ml-auto font-mono text-2xs text-fg-subtle" title={extension.path}>
          {truncate(shortPath(extension.path, 3), 48)}
        </span>
      </div>

      {extension.description && (
        <p className="max-w-[92ch] text-2xs leading-relaxed text-fg-muted">{extension.description}</p>
      )}

      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        {contributions
          .filter((item) => item.values.length > 0)
          .map((item) => (
            <span key={item.label} className="inline-flex flex-wrap items-center gap-1">
              <span className="text-2xs text-fg-subtle">{item.label}</span>
              {item.values.map((value) => (
                <Chip key={value} size="xs" tone={item.tone} mono>
                  {value}
                </Chip>
              ))}
            </span>
          ))}
        {contributions.every((item) => item.values.length === 0) && !unknownFile && (
          <span className="text-2xs text-fg-subtle">没有向宿主注册任何工具、命令或钩子</span>
        )}
      </div>

      {unknownFile && (
        <p className="text-2xs leading-relaxed text-fg-subtle">
          文件扩展不会被宿主预先执行：这里只读到了 docstring，工具与钩子要等启用后由宿主加载。
        </p>
      )}

      {extension.error && (
        <div className="flex items-start gap-2 rounded-lg bg-danger-soft p-2.5 text-2xs text-danger">
          <AlertTriangle size={13} className="mt-px shrink-0" aria-hidden="true" />
          <span className="min-w-0 break-words">{extension.error}</span>
        </div>
      )}

      <div className="mt-auto flex items-center gap-2 border-t border-line pt-2">
        <Switch
          checked={enabled}
          onChange={(next) => onToggle(next)}
          disabled={pending || disabled}
          label={<span className="text-2xs">{enabled ? '已启用' : '启用'}</span>}
        />
        {pending && <span className="text-2xs text-fg-subtle">宿主正在重载扩展…</span>}
        {!pending && disabled && (
          <Tooltip content={disabledReason ?? ''} side="top">
            <span className="inline-flex items-center gap-1 text-2xs text-warn">
              <Ban size={12} aria-hidden="true" />
              {disabledReason}
            </span>
          </Tooltip>
        )}
        {!pending && !disabled && (
          <span className="text-2xs text-fg-subtle">
            {enabled ? '关闭后从配置中移除' : '打开后写入配置并热重载'}
          </span>
        )}
      </div>
    </article>
  )
}
