/**
 * TerminalTab — 右侧工作台里的终端标签。
 *
 * It is deliberately *not* an xterm.js surface. The shell behind it runs on pipes
 * (`electron/terminal.js`), which means: no PTY, no cursor addressing, no resize,
 * no SIGINT. What it does give you is the thing a coding agent's terminal is
 * actually used for — run a command, watch it print, keep the scrollback — and it
 * needs no native dependency to work in a plain Electron bundle.
 *
 * The prompt line is ours (a shell on a pipe never prints one), so the transcript
 * reads as `❯ <what you typed>` followed by the command's own output.
 *
 * 标签的关闭就是结束这个 shell（`railStore.close` 会 `stop()`）：面板收起时
 * 进程继续跑，收起和关掉是两件事。
 */
import { useEffect, useMemo, useRef } from 'react'
import { Eraser, RotateCw, SquareTerminal } from 'lucide-react'
import { Chip, IconButton, Tooltip, type ChipTone } from '@/components/ui'
import { basename } from '@/lib/format'
import { screenText } from '@/lib/terminalText'
import { TERMINAL_PROMPT, useTerminal, type TerminalStatus } from '@/store/terminalStore'
import { useSession } from '@/store/sessionStore'

const STATUS: Record<TerminalStatus, { label: string; tone: ChipTone }> = {
  idle: { label: '未启动', tone: 'neutral' },
  starting: { label: '启动中', tone: 'info' },
  running: { label: '运行中', tone: 'success' },
  exited: { label: '已退出', tone: 'warn' },
}

export function TerminalTab({ className }: { className?: string }) {
  const host = useSession((state) => state.host)
  const status = useTerminal((state) => state.status)
  const shell = useTerminal((state) => state.shell)
  const sessionId = useTerminal((state) => state.id)
  const cwd = useTerminal((state) => state.cwd)
  const error = useTerminal((state) => state.error)
  const screen = useTerminal((state) => state.screen)
  const input = useTerminal((state) => state.input)
  const restart = useTerminal((state) => state.restart)
  const submit = useTerminal((state) => state.submit)
  const setInput = useTerminal((state) => state.setInput)
  const recall = useTerminal((state) => state.recall)
  const clear = useTerminal((state) => state.clear)

  const viewportRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const text = useMemo(() => screenText(screen), [screen])

  // 打开就聚焦命令行：终端标签出现后第一件事总是敲字。
  useEffect(() => {
    inputRef.current?.focus()
  }, [status])

  // 跟随输出，但只在用户本来就在底部时跟随 —— 往回翻历史时不该被拽回来。
  useEffect(() => {
    const viewport = viewportRef.current
    if (!viewport) return
    const distance = viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight
    if (distance < 120) viewport.scrollTop = viewport.scrollHeight
  }, [text])

  const info = STATUS[status]
  const target = cwd ?? host?.cwd ?? null

  return (
    <div aria-label="终端" className={className ? `flex min-h-0 flex-1 flex-col ${className}` : 'flex min-h-0 flex-1 flex-col'}>
      <header className="flex h-9 shrink-0 items-center gap-2 border-b border-line px-3">
        <SquareTerminal size={13} className="shrink-0 text-info" />
        <span className="truncate font-mono text-[10.5px] text-fg-caption">
          {shell ? `${shell} · ${target ? basename(target) : ''}` : (target ?? '未连接工作区')}
        </span>
        <Chip tone={info.tone} size="xs">
          {info.label}
        </Chip>
        <div className="ml-auto flex items-center">
          <Tooltip content="清空回看（Ctrl+L）" side="top">
            <IconButton label="清空终端" variant="ghost" size="xs" onClick={clear}>
              <Eraser size={13} />
            </IconButton>
          </Tooltip>
          <Tooltip content="重新启动 shell（没有 PTY，卡住的命令只能用这个结束）" side="top">
            <IconButton
              label="重新启动终端"
              variant="ghost"
              size="xs"
              disabled={!sessionId && status !== 'exited'}
              onClick={() => void restart()}
            >
              <RotateCw size={13} />
            </IconButton>
          </Tooltip>
        </div>
      </header>

      <div ref={viewportRef} className="scroll-quiet min-h-0 flex-1 overflow-auto px-3 py-2">
        {error ? (
          <p className="font-mono text-[11.5px] leading-[1.7] text-danger">{error}</p>
        ) : text ? (
          <pre className="font-mono text-[11.5px] leading-[1.7] whitespace-pre-wrap break-words text-fg-muted">
            {text}
          </pre>
        ) : (
          <p className="text-[11.5px] leading-[1.7] text-fg-subtle">
            {status === 'starting'
              ? '正在启动 shell…'
              : '在下面输入命令后回车。终端是行模式的：vim / top 这类全屏程序不支持，命令卡住时用右上角的「重新启动」。'}
          </p>
        )}
      </div>

      <form
        className="flex shrink-0 items-center gap-2 border-t border-line px-3 py-2"
        onSubmit={(event) => {
          event.preventDefault()
          submit()
        }}
      >
        <span aria-hidden="true" className="font-mono text-[12px] text-fg-subtle">
          {TERMINAL_PROMPT}
        </span>
        <input
          ref={inputRef}
          aria-label="终端命令"
          autoComplete="off"
          spellCheck={false}
          placeholder={status === 'running' ? '输入命令，回车运行' : '终端未在运行'}
          className="min-w-0 flex-1 bg-transparent font-mono text-[12px] text-fg outline-none placeholder:text-fg-subtle"
          value={input}
          onChange={(event) => setInput(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              // 显式提交：一个 input 的表单本来就会隐式提交，但把回车写清楚，
              // 就不必依赖浏览器的隐式行为（也用不着为测试造假 submit 事件）。
              event.preventDefault()
              submit()
              return
            }
            if (event.key === 'ArrowUp') {
              event.preventDefault()
              recall(-1)
              return
            }
            if (event.key === 'ArrowDown') {
              event.preventDefault()
              recall(1)
              return
            }
            if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'l') {
              event.preventDefault()
              clear()
            }
          }}
        />
        <span className="shrink-0 text-[10px] text-fg-subtle">Enter 运行 · ↑↓ 历史</span>
      </form>
    </div>
  )
}
