import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import {
  AlertTriangle,
  ArrowUp,
  FileText,
  FolderOpen,
  ImagePlus,
  Settings2,
  Slash,
  Sparkles,
  Square,
  Zap,
  X,
} from 'lucide-react'
import {
  Button,
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
import { QueuedMessages } from '@/components/chat/QueuedMessages'
import { useUi } from '@/store/uiStore'
import { formatBytes } from '@/lib/format'
import {
  INTERACTION_LABEL,
  INTERACTION_MODES,
  EXECUTION_LABEL,
  EXECUTION_MODES,
  PERMISSION_LABEL,
  PERMISSION_MODES,
  THINKING_LEVELS,
  type CommandInfo,
  type PromptImage,
  type ThinkingLevel,
  type WorkspaceDirectory,
} from '@/types/protocol'
import { cn } from '@/lib/cn'

/**
 * `/` 目录刻意只留两件事：**把文件加进这条消息** 与 **压缩上下文**。
 *
 * 其余命令（权限、模型、导出、技能、prompt…）在 Ctrl+K 面板和各自的页面里都有，
 * 全堆在输入框上只会挡住正文。手敲 `/compact` 这类真名仍然照旧可用。
 */
const SLASH_FILE = '文件'
const SLASH_COMPACT = '压缩'
const SLASH_ALIASES: Record<string, string> = { [SLASH_COMPACT]: 'compact' }

/** 上一级目录（`files.list` 的路径是相对工作区的 POSIX 风格）。 */
function parentOf(path: string): string {
  const cut = path.replace(/\/+$/, '').lastIndexOf('/')
  return cut <= 0 ? '' : path.slice(0, cut)
}

const THINKING_LABEL: Record<ThinkingLevel, string> = {
  off: '思考关闭',
  minimal: '极简',
  low: '低',
  medium: '中',
  high: '高',
  xhigh: '极高',
}

const MAX_HEIGHT = 260
const MAX_IMAGES = 4
const MAX_IMAGE_BYTES = 8 * 1024 * 1024
const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])

function readImage(file: File): Promise<PromptImage> {
  return new Promise((resolve, reject) => {
    if (!IMAGE_TYPES.has(file.type)) {
      reject(new Error(`不支持 ${file.type || file.name}，请选择 PNG/JPEG/WebP/GIF`))
      return
    }
    if (file.size > MAX_IMAGE_BYTES) {
      reject(new Error(`${file.name} 超过 8 MiB`))
      return
    }
    const reader = new FileReader()
    reader.onerror = () => reject(reader.error ?? new Error(`无法读取 ${file.name}`))
    reader.onload = () => {
      const value = String(reader.result ?? '')
      const comma = value.indexOf(',')
      if (comma < 0) reject(new Error(`${file.name} 不是有效图片`))
      else resolve({ name: file.name, mimeType: file.type, data: value.slice(comma + 1), size: file.size })
    }
    reader.readAsDataURL(file)
  })
}

export interface ComposerProps {
  draftKey: string
  className?: string
  hero?: boolean
}

/**
 * Message composer.
 *
 * 运行中普通发送不会打断这一轮：消息先落在输入框上方的排队小框里（可改、可删），
 * 等这一轮结束由 `drainQueue()` 发出去；要抢先就在小框上点 ⚡（或 Ctrl/Cmd+Enter）
 * 走 `steer`，由宿主中断当前请求并消费 steering 队列。
 *
 * `/` 目录只有两项（见 `SLASH_FILE` / `SLASH_COMPACT`）：把工作区文件加进这条消息、
 * 压缩上下文；`/文件` 会打开工作区选择器，选中后把 `@路径` 接进草稿。
 */
export function Composer({ draftKey, className, hero = false }: ComposerProps) {
  const draft = useUi((s) => s.drafts[draftKey] ?? '')
  const setDraft = useUi((s) => s.setDraft)
  const selectedSkill = useUi((s) => s.selectedSkills[draftKey] ?? null)
  const setSelectedSkill = useUi((s) => s.setSelectedSkill)
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
  const setInteractionMode = useSession((s) => s.setInteractionMode)
  const setExecutionMode = useSession((s) => s.setExecutionMode)
  const implementPlan = useSession((s) => s.implementPlan)
  const selectModel = useSession((s) => s.selectModel)
  const bridge = useSession((s) => s.bridge)

  const busy = timeline.status === 'streaming' || timeline.status === 'compacting'
  const hasPendingPlan = timeline.blocks.some((block) => block.kind === 'plan' && !block.decision)
  const [picker, setPicker] = useState<number | null>(null)
  const [dir, setDir] = useState<WorkspaceDirectory | null>(null)
  const [dirIndex, setDirIndex] = useState(0)
  const [images, setImages] = useState<PromptImage[]>([])
  const area = useRef<HTMLTextAreaElement>(null)
  const imageInput = useRef<HTMLInputElement>(null)
  const list = useRef<HTMLDivElement>(null)
  const dirList = useRef<HTMLDivElement>(null)

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

  const hostCommands: CommandInfo[] = host?.commands ?? []
  const commands: CommandInfo[] = useMemo(
    () => [
      { name: SLASH_FILE, description: '把工作区里的文件加进这条消息', argumentHint: '[路径]' },
      ...hostCommands
        .filter((command) => command.name === 'compact')
        .map((command) => ({ ...command, name: SLASH_COMPACT, argumentHint: '' })),
    ],
    [hostCommands],
  )
  const matches = useMemo(() => {
    if (slashQuery === null) return []
    return commands.filter(
      (c) =>
        !slashQuery ||
        c.name.toLowerCase().includes(slashQuery) ||
        c.description.toLowerCase().includes(slashQuery),
    )
  }, [commands, slashQuery])

  useEffect(() => {
    setPicker(matches.length ? 0 : null)
  }, [matches.length, slashQuery])

  // 列表比弹层高时要能把选中项滚进视野（键盘 ↑↓ 走到底部不会「看不见选中谁」）。
  useEffect(() => {
    if (picker === null) return
    const node = list.current?.children[picker]
    if (node instanceof HTMLElement) node.scrollIntoView({ block: 'nearest' })
  }, [picker])

  useEffect(() => {
    const node = dirList.current?.children[dirIndex]
    if (node instanceof HTMLElement) node.scrollIntoView({ block: 'nearest' })
  }, [dirIndex, dir])

  /** 打开工作区文件选择器（`/文件` 不带参数时走这条路）。 */
  const openFilePicker = async (path = '') => {
    setPicker(null)
    try {
      const listing = (await bridge.send({
        method: 'files.list',
        params: path ? { path } : undefined,
      })) as WorkspaceDirectory
      // 目录排前面，名字排序：键盘上下走的时候直觉上先看到可以进去的地方。
      const entries = [...(listing?.entries ?? [])].sort((a, b) =>
        a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'directory' ? -1 : 1,
      )
      setDir({ ...listing, entries })
      setDirIndex(0)
    } catch (error) {
      toast.danger({
        title: '读不到工作区文件',
        description: error instanceof Error ? error.message : String(error),
      })
    }
  }

  /** 把 `@路径` 接进草稿（前面已经写了一半的话保留），并顺手在右侧打开它。 */
  const insertMention = (path: string) => {
    // 取 store 里的最新草稿而不是闭包里的 `value`：`/文件 <路径>` 那条路会先把
    // `/文件 …` 清掉，再插引用，用旧值会把命令原文一起留在输入框里。
    const base = useUi.getState().drafts[draftKey] ?? ''
    const rest = base.replace(/^\/[^\s]*\s*/, '')
    const spacer = rest && !rest.endsWith(' ') ? ' ' : ''
    setDraft(draftKey, `${rest}${spacer}@${path} `)
    setDir(null)
    area.current?.focus()
  }

  const chooseEntry = (index: number) => {
    const entry = dir?.entries[index]
    if (!entry) return
    if (entry.type === 'directory') void openFilePicker(entry.path)
    else insertMention(entry.path)
  }

  const addImages = async (files: File[]) => {
    const room = MAX_IMAGES - images.length
    if (room <= 0) {
      toast.warn({ title: `每条消息最多 ${MAX_IMAGES} 张图片` })
      return
    }
    try {
      const additions = await Promise.all(files.slice(0, room).map(readImage))
      setImages((current) => [...current, ...additions].slice(0, MAX_IMAGES))
      if (files.length > room) toast.warn({ title: `只添加了前 ${room} 张图片` })
    } catch (error) {
      toast.danger({ title: '图片添加失败', description: error instanceof Error ? error.message : String(error) })
    }
  }

  const submit = (interrupt = false) => {
    const text = value.trim()
    if (!text && images.length === 0) return
    if (selectedSkill) {
      if (!text) {
        toast.info({ title: '请先描述要交给技能完成的任务' })
        return
      }
      if (busy) {
        toast.info({ title: '技能会在当前任务结束后才能调用' })
        return
      }
      if (images.length) {
        toast.warn({ title: '技能调用暂不接收图片', description: '移除图片后发送，或取消技能后按普通消息发送。' })
        return
      }
      setDraft(draftKey, '')
      setSelectedSkill(draftKey, null)
      void invokeSkill(selectedSkill, text)
      return
    }
    if (text.startsWith('/') && images.length === 0) {
      const [name, ...rest] = text.slice(1).split(/\s+/)
      if (name === SLASH_FILE) {
        const path = rest.join(' ').trim()
        setDraft(draftKey, '')
        if (path) insertMention(path)
        else void openFilePicker()
        return
      }
      const hostName = SLASH_ALIASES[name] ?? name
      if (hostCommands.some((c) => c.name === hostName)) {
        setDraft(draftKey, '')
        void runCommand(hostName, rest.join(' '))
        return
      }
    }
    const attachments = images
    setDraft(draftKey, '')
    setImages([])
    if (busy) {
      if (interrupt) void steer(text, true, attachments)
      else void followUp(text, attachments)
      return
    }
    void prompt(text, attachments)
  }

  const accept = (index: number) => {
    const command = matches[index]
    if (!command) return
    if (command.name === SLASH_FILE) {
      setDraft(draftKey, '')
      void openFilePicker()
      return
    }
    setDraft(draftKey, `/${command.name} `)
    setPicker(null)
    area.current?.focus()
  }

  const onKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (dir) {
      const count = dir.entries.length
      if (event.key === 'Escape') {
        event.preventDefault()
        if (dir.path) void openFilePicker(parentOf(dir.path))
        else setDir(null)
        return
      }
      if (count) {
        if (event.key === 'ArrowDown') {
          event.preventDefault()
          setDirIndex((i) => (i + 1) % count)
          return
        }
        if (event.key === 'ArrowUp') {
          event.preventDefault()
          setDirIndex((i) => (i - 1 + count) % count)
          return
        }
        if (event.key === 'Enter' && !event.shiftKey) {
          event.preventDefault()
          chooseEntry(dirIndex)
          return
        }
      }
      return
    }
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
      submit(event.ctrlKey || event.metaKey)
    }
  }

  const approxTokens = value.length > 400 ? Math.ceil(value.length / 3.4) : 0

  return (
    <div className={cn('relative flex flex-col', className)}>
      {dir ? (
        <div className="absolute bottom-full left-0 z-20 mb-2 w-full overflow-hidden surface-pop">
          <div className="flex items-center gap-2 border-b border-line px-3 py-1.5 text-2xs text-fg-subtle">
            <FolderOpen size={12} className="shrink-0" aria-hidden="true" />
            <span className="truncate font-mono text-fg-muted">{dir.path || dir.cwd}</span>
            <span className="ml-auto shrink-0">把文件加进这条消息</span>
          </div>
          <div
            ref={dirList}
            className="scroll-quiet max-h-[min(46vh,320px)] overflow-y-auto"
            aria-label="工作区文件"
          >
            {dir.entries.length ? (
              dir.entries.map((entry, index) => (
                <button
                  key={entry.path}
                  type="button"
                  onMouseEnter={() => setDirIndex(index)}
                  onClick={() => chooseEntry(index)}
                  className={cn(
                    'flex w-full items-center gap-2 px-3 py-1.5 text-left',
                    index === dirIndex ? 'bg-accent-soft/70' : 'hover:bg-surface-3',
                  )}
                >
                  {entry.type === 'directory' ? (
                    <FolderOpen size={12} className="shrink-0 text-fg-subtle" />
                  ) : (
                    <FileText size={12} className="shrink-0 text-fg-subtle" />
                  )}
                  <span className="truncate font-mono text-[12px] text-fg">{entry.name}</span>
                  {entry.type === 'directory' ? (
                    <span className="ml-auto shrink-0 text-2xs text-fg-muted">进入</span>
                  ) : (
                    <span className="ml-auto shrink-0 font-mono text-2xs text-fg-subtle">
                      {formatBytes(entry.size)}
                    </span>
                  )}
                </button>
              ))
            ) : (
              <div className="px-3 py-2 text-2xs text-fg-subtle">这个目录是空的</div>
            )}
          </div>
          <div className="flex items-center gap-3 border-t border-line px-3 py-1 text-2xs text-fg-subtle">
            <span className="inline-flex items-center gap-1">
              <Kbd>↑</Kbd>
              <Kbd>↓</Kbd> 选择
            </span>
            <span className="inline-flex items-center gap-1">
              <Kbd>Enter</Kbd> 选中
            </span>
            <span className="inline-flex items-center gap-1">
              <Kbd>Esc</Kbd> {dir.path ? '上一级' : '关闭'}
            </span>
            <span className="ml-auto">{dir.entries.length} 项</span>
          </div>
        </div>
      ) : null}

      {picker !== null && matches.length ? (
        <div className="absolute bottom-full left-0 z-20 mb-2 w-full overflow-hidden surface-pop">
          {/*
            命令目录要能装下宿主的全部命令：以前切到最后 8 条就没了，列表也不滚动，
            于是「/permission 之后的那些」谁也看不见。
          */}
          <div ref={list} className="scroll-quiet max-h-[min(46vh,320px)] overflow-y-auto">
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
                <span className="font-mono text-[12px] text-fg">/{command.name}</span>
                {command.argumentHint ? (
                  <span className="font-mono text-2xs text-fg-subtle">{command.argumentHint}</span>
                ) : null}
                <span className="ml-auto truncate text-2xs text-fg-muted">
                  {command.description}
                </span>
              </button>
            ))}
          </div>
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
            <span className="ml-auto">{matches.length} 条</span>
          </div>
        </div>
      ) : null}

      <div
        className={cn(
          'flex flex-col rounded-panel border-0 bg-input shadow-soft transition-shadow',
          busy ? 'ring-1 ring-info/35' : 'hover:shadow-prominent',
          'focus-within:shadow-prominent',
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

        <QueuedMessages className="rounded-t-panel border-b border-line/70" />

        {selectedSkill ? (
          <div className="flex items-center gap-2 border-b border-line/70 px-3 py-2 text-xs">
            <Sparkles size={13} className="shrink-0 text-accent" aria-hidden="true" />
            <span className="text-fg-subtle">使用技能</span>
            <span className="min-w-0 truncate rounded-md bg-accent-soft px-2 py-0.5 font-mono text-accent">
              {selectedSkill}
            </span>
            <button
              type="button"
              aria-label={`取消技能 ${selectedSkill}`}
              className="ml-auto grid size-6 place-items-center rounded-md text-fg-subtle hover:bg-interactive hover:text-fg"
              onClick={() => setSelectedSkill(draftKey, null)}
            >
              <X size={12} />
            </button>
          </div>
        ) : null}

        {images.length ? (
          <div className="flex gap-2 overflow-x-auto border-b border-line/70 px-3 py-2">
            {images.map((image, index) => (
              <div key={`${image.name}-${index}`} className="group relative size-16 shrink-0 overflow-hidden rounded-lg bg-surface-3">
                <img
                  src={`data:${image.mimeType};base64,${image.data}`}
                  alt={image.name}
                  className="size-full object-cover"
                />
                <button
                  type="button"
                  aria-label={`移除 ${image.name}`}
                  onClick={() => setImages((current) => current.filter((_, item) => item !== index))}
                  className="absolute right-1 top-1 grid size-5 place-items-center rounded-full bg-canvas/85 text-fg opacity-0 shadow group-hover:opacity-100 focus:opacity-100"
                >
                  <X size={12} />
                </button>
              </div>
            ))}
          </div>
        ) : null}

        <textarea
          ref={area}
          value={value}
          rows={1}
          spellCheck={false}
          onChange={(event) => setDraft(draftKey, event.target.value)}
          onPaste={(event) => {
            const files = Array.from(event.clipboardData.files).filter((file) => file.type.startsWith('image/'))
            if (!files.length) return
            event.preventDefault()
            void addImages(files)
          }}
          onKeyDown={onKeyDown}
          placeholder={busy
            ? '运行中 — Enter 排队（结束后自动发送），Ctrl/Cmd + Enter 立即插队'
            : hero
              ? '描述你想要构建的内容，/ 调用指令，@ 文件或对话'
              : '描述任务，/ 唤起命令，Shift + Enter 换行'}
          className={cn(
            'scroll-quiet min-h-11 w-full resize-none bg-transparent px-4 pt-3 pb-1 text-[14px] leading-6',
            hero && 'min-h-[84px] pt-4',
            'text-fg outline-none placeholder:text-fg-subtle',
          )}
        />

        <div className="flex min-w-0 flex-nowrap items-center gap-1.5 px-2 pt-0.5 pb-2">
          <input
            ref={imageInput}
            type="file"
            accept="image/png,image/jpeg,image/webp,image/gif"
            multiple
            className="hidden"
            onChange={(event) => {
              void addImages(Array.from(event.target.files ?? []))
              event.target.value = ''
            }}
          />
          <Tooltip content="添加图片（也可直接粘贴）" side="top">
            <IconButton
              label="添加图片"
              variant="soft"
              size="sm"
              className="rounded-full"
              disabled={images.length >= MAX_IMAGES}
              onClick={() => imageInput.current?.click()}
            >
              <ImagePlus size={14} />
            </IconButton>
          </Tooltip>
          <Tooltip content="插入命令前缀" side="top">
            <IconButton
              label="插入命令前缀"
              variant="soft"
              size="sm"
              className="rounded-full"
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
            triggerClassName="gap-1 rounded-sm border-transparent bg-transparent px-2 text-[12px] hover:border-transparent hover:bg-interactive"
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
                  selected={selectedSkill === skill.name}
                  onSelect={() => {
                    setSelectedSkill(draftKey, skill.name)
                    area.current?.focus()
                  }}
                />
              ))
            )}
          </Menu>

          <span className="ml-auto flex shrink-0 items-center gap-2 text-2xs text-fg-subtle">
            {approxTokens ? <span className="font-mono tabular-nums">≈{approxTokens} tok</span> : null}
            {busy ? (
              <span className="inline-flex items-center gap-1 rounded-sm bg-accent-soft px-1.5 py-0.5 text-accent">
                <Zap size={11} />
                运行中
              </span>
            ) : null}
          </span>

          {/*
            输入框只保留一个设置入口。工作区切换属于全局导航，继续放在侧栏、命令面板
            和设置页；模型、权限、模式等低频项收进同一个菜单，底栏因此始终保持单行。
          */}
          <Menu
            placement="top"
            align="end"
            label="对话设置"
            triggerClassName="size-8 shrink-0 rounded-full border-transparent bg-transparent px-0 text-fg-subtle hover:border-transparent hover:bg-interactive hover:text-fg"
            className="scroll-quiet max-h-[min(70vh,560px)] overflow-y-auto"
            trigger={<Settings2 size={14} />}
          >
            <MenuLabel>执行环境</MenuLabel>
            {EXECUTION_MODES.map((mode) => (
              <MenuItem
                key={mode}
                label={EXECUTION_LABEL[mode]}
                hint={mode === 'sandbox'
                  ? host?.sandbox.shell
                    ? `${host.sandbox.backend} · 项目内写入 · 禁止网络`
                    : '文件隔离；当前平台将禁用 shell'
                  : '直接在宿主系统执行'}
                selected={host?.executionMode === mode}
                onSelect={() => void setExecutionMode(mode)}
              />
            ))}
            <MenuSeparator />
            <MenuLabel>交互模式</MenuLabel>
            {INTERACTION_MODES.map((mode) => (
              <MenuItem
                key={mode}
                label={INTERACTION_LABEL[mode]}
                hint={mode === 'auto' ? '按每条请求判断' : mode === 'plan' ? '只读分析与规划' : '允许实施任务'}
                selected={host?.interactionMode === mode}
                onSelect={() => void setInteractionMode(mode)}
              />
            ))}
            <MenuSeparator />
            <MenuLabel>思考等级</MenuLabel>
            {THINKING_LEVELS.map((level) => (
              <MenuItem
                key={level}
                label={THINKING_LABEL[level]}
                selected={host?.thinkingLevel === level}
                onSelect={() => void setThinking(level)}
              />
            ))}
            <MenuSeparator />
            <MenuLabel>权限</MenuLabel>
            {PERMISSION_MODES.map((mode) => (
              <MenuItem
                key={mode}
                label={PERMISSION_LABEL[mode]}
                hint={mode}
                selected={host?.permissionMode === mode}
                onSelect={() => void setPermissionMode(mode)}
              />
            ))}
            <MenuSeparator />
            <MenuLabel>模型</MenuLabel>
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

          {!busy && host?.effectiveInteractionMode === 'plan' && !hasPendingPlan ? (
            <Button
              variant="secondary"
              size="sm"
              iconLeft={<Sparkles size={13} />}
              onClick={() => void implementPlan()}
            >
              开始实施
            </Button>
          ) : null}

          {busy ? (
            <Button
              variant="danger"
              size="sm"
              aria-label="中止本轮"
              className="size-8 rounded-full px-0"
              iconLeft={<Square size={12} />}
              onClick={() => void abort()}
            />
          ) : null}

          <Button
            variant="primary"
            size="sm"
            aria-label="发送"
            className="size-8 rounded-full px-0"
            disabled={!value.trim() && images.length === 0}
            iconLeft={<ArrowUp size={15} />}
            title={busy ? '加入排队（这一轮结束后自动发送）· Ctrl/Cmd+Enter 立即插队' : '发送'}
            onClick={() => submit(false)}
          />
        </div>
      </div>
    </div>
  )
}
