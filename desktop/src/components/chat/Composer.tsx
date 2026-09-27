import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import {
  AlertTriangle,
  ArrowUp,
  Copy,
  CornerDownLeft,
  FolderOpen,
  FolderTree,
  ListPlus,
  Slash,
  Sparkles,
  Square,
  Zap,
} from 'lucide-react'
import {
  Button,
  Chip,
  IconButton,
  Kbd,
  Menu,
  MenuItem,
  MenuLabel,
  MenuSeparator,
  Tooltip,
  toast,
} from '@/components/ui'
import { useSession } from '@/store/sessionStore'
import { useUi } from '@/store/uiStore'
import { samePath, useWorkspace, workspaceName } from '@/store/workspaceStore'
import { shortPath } from '@/lib/format'
import {
  PERMISSION_LABEL,
  PERMISSION_MODES,
  THINKING_LEVELS,
  type CommandInfo,
  type ThinkingLevel,
} from '@/types/protocol'
import { cn } from '@/lib/cn'

const THINKING_LABEL: Record<ThinkingLevel, string> = {
  off: '思考关闭',
  minimal: '极简',
  low: '低',
  medium: '中',
  high: '高',
  xhigh: '极高',
}

const MAX_HEIGHT = 260

export interface ComposerProps {
  draftKey: string
  className?: string
}

/**
 * Message composer.
 *
 * Sending follows the host contract exactly: `prompt` throws while a run is in
 * flight, so a busy composer switches to `steer` (delivered to the running
 * loop) or `follow_up` (queued behind it) instead of failing.
 */
export function Composer({ draftKey, className }: ComposerProps) {
  const draft = useUi((s) => s.drafts[draftKey] ?? '')
  const setDraft = useUi((s) => s.setDraft)
  const host = useSession((s) => s.host)
  const timeline = useSession((s) => s.timeline)
  const prompt = useSession((s) => s.prompt)
  const steer = useSession((s) => s.steer)
  const followUp = useSession((s) => s.followUp)
  const abort = useSession((s) => s.abort)
  const runCommand = useSession((s) => s.runCommand)
  const invokeSkill = useSession((s) => s.invokeSkill)
  const setThinking = useSession((s) => s.setThinking)
  const setPermissionMode = useSession((s) => s.setPermissionMode)
  const selectModel = useSession((s) => s.selectModel)
  const bridge = useSession((s) => s.bridge)
  const recentWorkspaces = useWorkspace((s) => s.recent)
  const pickWorkspace = useWorkspace((s) => s.pick)
  const openWorkspace = useWorkspace((s) => s.open)

  const busy = timeline.status === 'streaming' || timeline.status === 'compacting'
  const [queueMode, setQueueMode] = useState<'steer' | 'follow_up'>('steer')
  const [picker, setPicker] = useState<number | null>(null)
  const area = useRef<HTMLTextAreaElement>(null)

  useLayoutEffect(() => {
    const node = area.current
    if (!node) return
    node.style.height = 'auto'
    node.style.height = `${Math.min(node.scrollHeight, MAX_HEIGHT)}px`
  }, [draft])

  const value = draft
  const slashQuery = useMemo(() => {
    const match = /^\/([^\s/]*)$/.exec(value)
    return match ? match[1].toLowerCase() : null
  }, [value])

  const commands: CommandInfo[] = host?.commands ?? []
  const matches = useMemo(() => {
    if (slashQuery === null) return []
    return commands
      .filter(
        (c) =>
          !slashQuery ||
          c.name.toLowerCase().includes(slashQuery) ||
          c.description.toLowerCase().includes(slashQuery),
      )
      .slice(0, 8)
  }, [commands, slashQuery])

  useEffect(() => {
    setPicker(matches.length ? 0 : null)
  }, [matches.length, slashQuery])

  const submit = () => {
    const text = value.trim()
    if (!text) return
    if (text.startsWith('/')) {
      const [name, ...rest] = text.slice(1).split(/\s+/)
      if (commands.some((c) => c.name === name)) {
        setDraft(draftKey, '')
        void runCommand(name, rest.join(' '))
        return
      }
    }
    setDraft(draftKey, '')
    if (busy) {
      if (queueMode === 'steer') void steer(text)
      else void followUp(text)
      return
    }
    void prompt(text)
  }

  const accept = (index: number) => {
    const command = matches[index]
    if (!command) return
    setDraft(draftKey, `/${command.name} `)
    setPicker(null)
    area.current?.focus()
  }

  const onKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Escape') {
      if (picker !== null) {
        event.preventDefault()
        setPicker(null)
      }
      return
    }
    if (picker !== null && matches.length) {
      if (event.key === 'ArrowDown') {
        event.preventDefault()
        setPicker((i) => ((i ?? 0) + 1) % matches.length)
        return
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault()
        setPicker((i) => ((i ?? 0) - 1 + matches.length) % matches.length)
        return
      }
      if (event.key === 'Tab' || (event.key === 'Enter' && !event.shiftKey)) {
        event.preventDefault()
        accept(picker)
        return
      }
    }
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      submit()
    }
  }

  const approxTokens = value.length > 400 ? Math.ceil(value.length / 3.4) : 0

  return (
    <div className={cn('relative flex flex-col gap-1.5', className)}>
      {picker !== null && matches.length ? (
        <div className="absolute bottom-full left-0 z-20 mb-2 w-full overflow-hidden surface-pop">
          {matches.map((command, index) => (
            <button
              key={command.name}
              type="button"
              onMouseEnter={() => setPicker(index)}
              onClick={() => accept(index)}
              className={cn(
                'flex w-full items-center gap-2 px-3 py-1.5 text-left',
                index === picker ? 'bg-accent-soft/70' : 'hover:bg-surface-3',
              )}
            >
              <Slash size={12} className="shrink-0 text-fg-subtle" />
              <span className="font-mono text-[12px] text-fg">{command.name}</span>
              {command.argumentHint ? (
                <span className="font-mono text-2xs text-fg-subtle">{command.argumentHint}</span>
              ) : null}
              <span className="ml-auto truncate text-2xs text-fg-muted">{command.description}</span>
            </button>
          ))}
          <div className="flex items-center gap-3 border-t border-line px-3 py-1 text-2xs text-fg-subtle">
            <span className="inline-flex items-center gap-1">
              <Kbd>↑</Kbd>
              <Kbd>↓</Kbd> 选择
            </span>
            <span className="inline-flex items-center gap-1">
              <Kbd>Enter</Kbd> 补全
            </span>
            <span className="inline-flex items-center gap-1">
              <Kbd>Esc</Kbd> 关闭
            </span>
          </div>
        </div>
      ) : null}

      <div
        className={cn(
          'flex flex-col rounded-panel border bg-surface transition-colors',
          busy ? 'border-accent/40' : 'border-line hover:border-line-strong',
          'focus-within:border-line-strong',
        )}
      >
        {/*
          「生成中」也可能是真卡住了：宿主一直不发帧时，用户至少要知道等了多久、
          并且能自己中止，而不是只能看着转圈。
        */}
        {timeline.stalled ? (
          <div className="flex items-center gap-2 rounded-t-panel border-b border-warn/25 bg-warn-soft/40 px-3 py-1.5 text-[11.5px] text-warn">
            <AlertTriangle size={12} className="shrink-0" aria-hidden="true" />
            <span className="min-w-0 flex-1 truncate">{timeline.activity}</span>
            <Button variant="ghost" size="sm" onClick={() => void abort()}>
              中止本轮
            </Button>
          </div>
        ) : null}

        <textarea
          ref={area}
          value={value}
          rows={1}
          spellCheck={false}
          onChange={(event) => setDraft(draftKey, event.target.value)}
          onKeyDown={onKeyDown}
          placeholder={busy ? '运行中 — Enter 插入消息，Shift + Enter 换行' : '描述任务，/ 唤起命令，Shift + Enter 换行'}
          className={cn(
            'scroll-quiet w-full resize-none bg-transparent px-4 pt-3 pb-1 text-[13.5px] leading-6',
            'text-fg outline-none placeholder:text-fg-subtle',
          )}
        />

        <div className="flex items-center gap-1.5 px-2.5 pt-0.5 pb-2">
          <Tooltip content="插入命令前缀" side="top">
            <IconButton
              label="插入命令前缀"
              variant="ghost"
              size="sm"
              onClick={() => {
                if (!value.startsWith('/')) setDraft(draftKey, `/${value}`)
                area.current?.focus()
              }}
            >
              <Slash size={14} />
            </IconButton>
          </Tooltip>

          <Menu
            placement="top"
            align="start"
            label="调用技能"
            triggerClassName="gap-1 rounded-md border-transparent bg-transparent px-2 text-[10.5px] hover:border-transparent hover:bg-surface-2"
            trigger={
              <>
                <Sparkles size={13} />
                技能
              </>
            }
          >
            {(host?.skills ?? []).length === 0 ? (
              <MenuItem label="没有可用技能" disabled onSelect={() => undefined} />
            ) : (
              (host?.skills ?? []).map((skill) => (
                <MenuItem
                  key={skill.name}
                  label={skill.name}
                  hint={skill.description}
                  onSelect={() => void invokeSkill(skill.name)}
                />
              ))
            )}
          </Menu>

          <Tooltip
            content={host?.cwd ? `当前工作区：${host.cwd}` : '选择一个工作区文件夹'}
            side="top"
          >
            <Menu
              placement="top"
              align="start"
              label="工作区"
              triggerClassName="max-w-[200px] gap-1.5 rounded-md border-transparent bg-transparent px-2 text-[10.5px] hover:border-transparent hover:bg-surface-2"
              trigger={
                <>
                  <FolderTree size={12} aria-hidden="true" />
                  <span className="truncate">
                    {host?.cwd ? workspaceName(host.cwd) : '选择工作区'}
                  </span>
                </>
              }
            >
              <MenuItem
                label="切换工作区…"
                icon={<FolderOpen size={14} />}
                onSelect={() => void pickWorkspace()}
              />
              <MenuItem
                label="在文件管理器中打开"
                icon={<FolderTree size={14} />}
                disabled={!host?.cwd}
                onSelect={() => {
                  if (!host?.cwd) return
                  void bridge.reveal(host.cwd).then((ok) => {
                    if (!ok) {
                      toast.info({ title: '演示宿主没有文件管理器', description: host.cwd })
                    }
                  })
                }}
              />
              <MenuItem
                label="复制工作区路径"
                icon={<Copy size={14} />}
                disabled={!host?.cwd}
                onSelect={() => {
                  if (!host?.cwd) return
                  void navigator.clipboard
                    ?.writeText(host.cwd)
                    .then(() => toast.success({ title: '已复制工作区路径' }))
                    .catch(() => toast.danger({ title: '复制失败', description: host.cwd }))
                }}
              />

              {recentWorkspaces.length > 0 ? (
                <>
                  <MenuSeparator />
                  <MenuLabel>最近工作区</MenuLabel>
                  {recentWorkspaces.map((path) => (
                    <MenuItem
                      key={path}
                      label={workspaceName(path)}
                      hint={shortPath(path, 24)}
                      selected={samePath(host?.cwd, path)}
                      onSelect={() => void openWorkspace(path)}
                    />
                  ))}
                </>
              ) : null}
            </Menu>
          </Tooltip>

          <span className="ml-auto flex items-center gap-2 text-2xs text-fg-subtle">
            {approxTokens ? <span className="font-mono tabular-nums">≈{approxTokens} tok</span> : null}
            {busy ? (
              <span className="inline-flex items-center gap-1 rounded-sm bg-accent-soft px-1.5 py-0.5 text-accent">
                <Zap size={11} />
                运行中
              </span>
            ) : null}
          </span>

          {busy ? (
            <Menu
              placement="top"
              align="end"
              label="排队方式"
              triggerClassName="gap-1 rounded-md border-transparent bg-transparent px-2 text-[10.5px] hover:border-transparent hover:bg-surface-2"
              trigger={
                <>
                  <ListPlus size={13} />
                  {queueMode === 'steer' ? '立即插入' : '排队执行'}
                </>
              }
            >
              <MenuItem
                label="立即插入运行中回合"
                hint="steer"
                selected={queueMode === 'steer'}
                onSelect={() => setQueueMode('steer')}
              />
              <MenuItem
                label="当前回合结束后执行"
                hint="follow_up"
                selected={queueMode === 'follow_up'}
                onSelect={() => setQueueMode('follow_up')}
              />
            </Menu>
          ) : null}

          <span className="hidden items-center gap-1.5 md:flex">
            <Menu
              placement="top"
              align="end"
              label="思考等级"
              triggerClassName="rounded-md border-transparent bg-transparent px-2 text-[10.5px] hover:border-transparent hover:bg-surface-2"
              trigger={host ? THINKING_LABEL[host.thinkingLevel] : '思考 —'}
            >
              {THINKING_LEVELS.map((level) => (
                <MenuItem
                  key={level}
                  label={THINKING_LABEL[level]}
                  selected={host?.thinkingLevel === level}
                  onSelect={() => void setThinking(level)}
                />
              ))}
            </Menu>

            <Menu
              placement="top"
              align="end"
              label="权限模式"
              triggerClassName={cn(
                'rounded-md border-transparent bg-transparent px-2 text-[10.5px] hover:border-transparent hover:bg-surface-2',
                host?.permissionMode === 'full-access' && 'text-warn',
              )}
              trigger={host ? PERMISSION_LABEL[host.permissionMode] : '权限 —'}
            >
              {PERMISSION_MODES.map((mode) => (
                <MenuItem
                  key={mode}
                  label={PERMISSION_LABEL[mode]}
                  hint={mode}
                  selected={host?.permissionMode === mode}
                  onSelect={() => void setPermissionMode(mode)}
                />
              ))}
            </Menu>

            <Menu
              placement="top"
              align="end"
              label="切换模型"
              triggerClassName="max-w-[160px] rounded-md border-transparent bg-transparent px-2 font-mono text-[10.5px] hover:border-transparent hover:bg-surface-2"
              trigger={<span className="truncate">{host?.model?.displayName ?? '模型 —'}</span>}
            >
              {(host?.availableModels ?? []).map((model) => (
                <MenuItem
                  key={model.id}
                  label={model.displayName}
                  hint={model.provider}
                  selected={host?.model?.id === model.id}
                  onSelect={() => void selectModel(model.id)}
                />
              ))}
            </Menu>
          </span>

          {busy ? (
            <Button
              variant="danger"
              size="sm"
              iconLeft={<Square size={12} />}
              onClick={() => void abort()}
            >
              中止
            </Button>
          ) : null}

          <Button
            variant="primary"
            size="sm"
            disabled={!value.trim()}
            iconLeft={<ArrowUp size={13} />}
            onClick={submit}
          >
            发送
          </Button>
        </div>
      </div>

      <div className="flex items-center gap-2 px-2 text-2xs text-fg-subtle">
        <CornerDownLeft size={11} />
        <span>Enter 发送 · Shift + Enter 换行</span>
        {host?.projectTrusted === false ? (
          <Chip size="xs" tone="warn">
            项目未受信任
          </Chip>
        ) : null}
        <span className="ml-auto font-mono">{host?.sessionFile?.split(/[\\/]/).pop() ?? ''}</span>
      </div>
    </div>
  )
}
