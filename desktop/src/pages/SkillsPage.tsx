/**
 * SkillsPage — 宿主发现的技能。
 *
 * 技能是宿主绑定到 `invoke_skill` 的 Markdown 指令包；本页只做展示、检索与调用，
 * 「启用 / 停用」读自宿主且在本协议版本下不可写。
 */
import { useDeferredValue, useMemo, useState } from 'react'
import { Blocks, Search, Sparkles, Terminal } from 'lucide-react'
import {
  Button,
  Chip,
  Dialog,
  EmptyState,
  Switch,
  TextArea,
  TextInput,
} from '@/components/ui'
import { FoxMascot } from '@/components/brand/Fox'
import { useSession } from '@/store/sessionStore'
import type { CommandInfo, SkillInfo } from '@/types/protocol'

/** 宿主给的 source 是短标识（user / project），界面上讲人话。 */
const SOURCE_LABEL: Record<string, string> = {
  user: '用户级',
  project: '项目级',
  builtin: '内置',
  global: '全局',
}

function sourceLabel(source: string): string {
  return SOURCE_LABEL[source] ?? source
}

export function SkillsPage() {
  const host = useSession((state) => state.host)
  const invokeSkill = useSession((state) => state.invokeSkill)

  const [query, setQuery] = useState('')
  const [enabledOnly, setEnabledOnly] = useState(false)
  const [callingName, setCallingName] = useState<string | null>(null)
  const [instructions, setInstructions] = useState('')

  const deferredQuery = useDeferredValue(query)

  const skills = useMemo(() => host?.skills ?? [], [host?.skills])
  const commands = useMemo(() => host?.commands ?? [], [host?.commands])

  const visible = useMemo(() => {
    const needle = deferredQuery.trim().toLowerCase()
    return skills.filter((skill) => {
      if (enabledOnly && !skill.enabled) return false
      if (!needle) return true
      return `${skill.name} ${skill.description} ${skill.source}`.toLowerCase().includes(needle)
    })
  }, [deferredQuery, enabledOnly, skills])

  /** 按 source 分组，保持宿主给出的原始顺序。 */
  const groups = useMemo(() => {
    const map = new Map<string, SkillInfo[]>()
    for (const skill of visible) {
      const key = skill.source || '未标注来源'
      const bucket = map.get(key)
      if (bucket) bucket.push(skill)
      else map.set(key, [skill])
    }
    return [...map.entries()]
  }, [visible])

  const enabledCount = skills.filter((skill) => skill.enabled).length

  const closeDialog = () => {
    setCallingName(null)
    setInstructions('')
  }

  const confirmInvoke = () => {
    if (callingName == null) return
    void invokeSkill(callingName)
    closeDialog()
  }

  return (
    <div className="scroll-quiet flex h-full flex-col overflow-y-auto bg-canvas">
      <div className="mx-auto flex w-full max-w-[960px] flex-col gap-6 px-8 py-9 lg:px-12">
        <header className="flex flex-wrap items-center gap-2">
          <h1 className="text-[26px] leading-8 font-medium tracking-[-0.02em] text-fg">技能</h1>
          <Chip size="sm" mono>
            {skills.length}
          </Chip>
          <Chip size="sm" tone="success">
            已启用 {enabledCount}
          </Chip>
        </header>

        <p className="max-w-[72ch] text-xs leading-relaxed text-fg-muted">
          技能是存放于磁盘的 Markdown 指令包，宿主启动时扫描出来并绑定到 <span className="font-mono">invoke_skill</span>
          工具。调用后宿主会把技能正文注入当前上下文；技能来源与启用状态由宿主决定，本页只读展示。
        </p>

        <div className="flex flex-wrap items-center gap-3">
          <div className="w-[280px] min-w-[200px]">
            <TextInput
              size="sm"
              iconLeft={<Search size={13} aria-hidden="true" />}
              placeholder="搜索名称 / 描述 / 来源…"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onClear={() => setQuery('')}
              aria-label="搜索技能"
            />
          </div>
          <Switch checked={enabledOnly} onChange={setEnabledOnly} label="只看已启用" />
          <span className="ml-auto text-2xs text-fg-subtle">
            共 <span className="font-mono tabular-nums text-fg-muted">{visible.length}</span> 个技能
          </span>
        </div>

        {visible.length === 0 ? (
          <EmptyState
            mascot={<FoxMascot size={92} />}
            title={skills.length === 0 ? '宿主没有发现技能' : '没有匹配的技能'}
            description={
              skills.length === 0
                ? '技能以 Markdown 文件存放在宿主的技能目录中，新增文件后刷新宿主即可看到。'
                : '试试清空关键词，或关闭「只看已启用」。'
            }
            action={
              enabledOnly || query.length > 0 ? (
                <Button
                  variant="outline"
                  onClick={() => {
                    setQuery('')
                    setEnabledOnly(false)
                  }}
                >
                  清空筛选
                </Button>
              ) : undefined
            }
          />
        ) : (
          <div className="flex flex-col gap-4">
            {groups.map(([source, group]) => (
              <section key={source} className="flex flex-col gap-2">
                <div className="flex items-center gap-2">
                  <h2 className="text-xs font-medium text-fg-muted">{sourceLabel(source)}</h2>
                  <Chip size="xs">{group.length}</Chip>
                  <span className="h-px flex-1 bg-line" aria-hidden="true" />
                </div>
                <div className="grid gap-2 md:grid-cols-2 xl:grid-cols-3">
                  {group.map((skill) => (
                    <article key={`${source}:${skill.name}`} className="surface-card flex flex-col gap-2 p-3">
                      <div className="flex min-w-0 items-center gap-2">
                        <span className="truncate font-mono text-[13px] font-medium text-fg" title={skill.name}>
                          {skill.name}
                        </span>
                        <span className="ml-auto flex shrink-0 items-center gap-1">
                          <Chip size="xs" tone={skill.enabled ? 'success' : 'neutral'}>
                            {skill.enabled ? '已启用' : '已停用'}
                          </Chip>
                        </span>
                      </div>
                      <p className="line-clamp-3 text-xs leading-relaxed text-fg-muted">
                        {skill.description || '（没有描述）'}
                      </p>
                      <div className="mt-auto flex items-center gap-2 border-t border-line pt-2">
                        <Button
                          size="xs"
                          variant="secondary"
                          iconLeft={<Sparkles size={12} aria-hidden="true" />}
                          onClick={() => {
                            setInstructions('')
                            setCallingName(skill.name)
                          }}
                        >
                          调用
                        </Button>
                        <span className="ml-auto text-2xs text-fg-subtle">
                          {skill.enabled ? '可被模型主动调用' : '已停用，模型不会调用'}
                        </span>
                      </div>
                    </article>
                  ))}
                </div>
              </section>
            ))}
          </div>
        )}

        <section className="flex flex-col gap-2">
          <div className="flex flex-wrap items-center gap-2">
            <Terminal size={13} className="text-fg-muted" aria-hidden="true" />
            <h2 className="text-xs font-medium text-fg-muted">命令</h2>
            <Chip size="xs">{commands.length}</Chip>
            <span className="text-2xs text-fg-subtle">
              在输入框中以 <span className="font-mono text-fg-muted">/名称</span> 触发
            </span>
          </div>
          {commands.length === 0 ? (
            <p className="surface-card p-3 text-xs text-fg-subtle">宿主没有注册任何斜杠命令。</p>
          ) : (
            <div className="surface-card overflow-hidden">
              <table className="w-full border-collapse text-xs">
                <thead>
                  <tr className="border-b border-line text-2xs text-fg-subtle">
                    <th className="w-[220px] px-3 py-2 text-left font-medium">命令</th>
                    <th className="px-3 py-2 text-left font-medium">说明</th>
                    <th className="w-[200px] px-3 py-2 text-left font-medium">参数</th>
                  </tr>
                </thead>
                <tbody>
                  {commands.map((command) => (
                    <CommandRow key={command.name} command={command} />
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        <div className="flex items-start gap-2 rounded-lg border border-line bg-surface-2 p-3 text-2xs text-fg-subtle">
          <Blocks size={13} className="mt-px shrink-0 text-info" aria-hidden="true" />
          <span>
            技能与命令都由宿主进程提供，页面不缓存副本；切换工作目录或重新加载运行时后，列表会随宿主状态刷新。
          </span>
        </div>

        <Dialog
          open={callingName != null}
          onClose={closeDialog}
          size="sm"
          title="调用技能"
          description={
            callingName != null ? (
              <>
                即将通过 <span className="font-mono text-fg-muted">invoke_skill</span> 调用{' '}
                <span className="font-mono text-fg-muted">{callingName}</span>。
              </>
            ) : undefined
          }
          footer={
            <>
              <Button variant="ghost" onClick={closeDialog}>
                取消
              </Button>
              <Button variant="primary" iconLeft={<Sparkles size={13} aria-hidden="true" />} onClick={confirmInvoke}>
                调用
              </Button>
            </>
          }
        >
          <div className="flex flex-col gap-1.5">
            <span className="text-2xs text-fg-muted">附加说明（可留空）</span>
            <TextArea
              minRows={3}
              maxRows={8}
              value={instructions}
              onChange={(event) => setInstructions(event.target.value)}
              placeholder="例如：只关注鉴权流程，先给出调用链再给结论。"
              aria-label="附加说明"
            />
            <span className="text-2xs text-fg-subtle">
              当前协议下 <span className="font-mono">invoke_skill</span> 只接收技能名称，这段文字仅在宿主支持透传指令时才生效。
            </span>
          </div>
        </Dialog>
      </div>
    </div>
  )
}

function CommandRow({ command }: { command: CommandInfo }) {
  return (
    <tr className="border-b border-line last:border-b-0">
      <td className="px-3 py-2 align-top font-mono text-accent">/{command.name}</td>
      <td className="px-3 py-2 align-top text-fg-muted">{command.description || '—'}</td>
      <td className="px-3 py-2 align-top font-mono text-fg-subtle">{command.argumentHint || '—'}</td>
    </tr>
  )
}
