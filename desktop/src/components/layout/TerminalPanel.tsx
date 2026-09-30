/** A real xterm.js surface backed by node-pty in Electron's main process. */
import { useEffect, useRef } from 'react'
import { FitAddon } from '@xterm/addon-fit'
import { Terminal } from '@xterm/xterm'
import '@xterm/xterm/css/xterm.css'
import { Eraser, RotateCw, SquareTerminal } from 'lucide-react'
import { getBridge } from '@/bridge'
import { Chip, IconButton, Tooltip, type ChipTone } from '@/components/ui'
import { basename } from '@/lib/format'
import { useSession } from '@/store/sessionStore'
import { useTerminal, type TerminalStatus } from '@/store/terminalStore'
import { useUi, type Theme } from '@/store/uiStore'

const STATUS: Record<TerminalStatus, { label: string; tone: ChipTone }> = {
  idle: { label: '未启动', tone: 'neutral' },
  starting: { label: '启动中', tone: 'info' },
  running: { label: '运行中', tone: 'success' },
  exited: { label: '已退出', tone: 'warn' },
}

function terminalTheme(theme: Theme) {
  return theme === 'light'
    ? {
        background: '#00000000', foreground: '#555b63', cursor: '#4078e8',
        selectionBackground: '#b8d1ff88', black: '#34383e', brightBlack: '#747b85',
      }
    : {
        background: '#00000000', foreground: '#c8cbd0', cursor: '#8ab4ff',
        selectionBackground: '#4a638e88', black: '#303036', brightBlack: '#777780',
      }
}

export function TerminalTab({ className }: { className?: string }) {
  const host = useSession((state) => state.host)
  const status = useTerminal((state) => state.status)
  const shell = useTerminal((state) => state.shell)
  const sessionId = useTerminal((state) => state.id)
  const cwd = useTerminal((state) => state.cwd)
  const error = useTerminal((state) => state.error)
  const output = useTerminal((state) => state.output)
  const restart = useTerminal((state) => state.restart)
  const ensure = useTerminal((state) => state.ensure)
  const clear = useTerminal((state) => state.clear)
  const theme = useUi((state) => state.theme)

  const hostRef = useRef<HTMLDivElement>(null)
  const terminalRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const renderedLengthRef = useRef(0)
  const attemptedTargetRef = useRef<string | null>(null)

  const info = STATUS[status]
  const target = cwd ?? host?.cwd ?? null

  // xterm owns the prompt, cursor and keyboard. There is intentionally no
  // separate HTML input: every keystroke is sent directly to the native PTY.
  useEffect(() => {
    const element = hostRef.current
    if (!element) return

    const terminal = new Terminal({
      allowTransparency: true,
      convertEol: false,
      cursorBlink: true,
      cursorStyle: 'block',
      fontFamily: 'SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace',
      fontSize: 12,
      lineHeight: 1.3,
      macOptionIsMeta: true,
      scrollback: 5000,
      theme: terminalTheme(useUi.getState().theme),
    })
    const fit = new FitAddon()
    terminal.loadAddon(fit)
    terminal.open(element)
    terminalRef.current = terminal
    fitRef.current = fit

    const currentOutput = useTerminal.getState().output
    if (currentOutput) terminal.write(currentOutput)
    renderedLengthRef.current = currentOutput.length

    const fitTerminal = () => {
      try {
        fit.fit()
      } catch {
        return
      }
      const id = useTerminal.getState().id
      if (id) void getBridge().terminal.resize(id, terminal.cols, terminal.rows)
    }
    const frame = requestAnimationFrame(() => {
      fitTerminal()
      terminal.focus()
    })
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(fitTerminal)
    observer?.observe(element)

    const input = terminal.onData((data) => {
      const state = useTerminal.getState()
      if (state.id && state.status === 'running') void getBridge().terminal.write(state.id, data)
    })
    const resize = terminal.onResize(({ cols, rows }) => {
      const id = useTerminal.getState().id
      if (id) void getBridge().terminal.resize(id, cols, rows)
    })

    return () => {
      cancelAnimationFrame(frame)
      observer?.disconnect()
      input.dispose()
      resize.dispose()
      fit.dispose()
      terminal.dispose()
      terminalRef.current = null
      fitRef.current = null
    }
  }, [])

  useEffect(() => {
    const terminal = terminalRef.current
    if (terminal) terminal.options.theme = terminalTheme(theme)
  }, [theme])

  // Replay only the newly arrived bytes. A shorter buffer means the user used
  // the header's clear button or restarted, so reset the visual terminal too.
  useEffect(() => {
    const terminal = terminalRef.current
    if (!terminal) return
    const rendered = renderedLengthRef.current
    if (output.length < rendered) {
      terminal.reset()
      if (output) terminal.write(output)
    } else if (output.length > rendered) {
      terminal.write(output.slice(rendered))
    }
    renderedLengthRef.current = output.length
  }, [output])

  // The tab can mount before the host reports cwd. Start as soon as it arrives.
  useEffect(() => {
    if (!target || status !== 'idle' || sessionId || attemptedTargetRef.current === target) return
    attemptedTargetRef.current = target
    const terminal = terminalRef.current
    void ensure(target, terminal ? { cols: terminal.cols, rows: terminal.rows } : undefined)
  }, [ensure, sessionId, status, target])

  useEffect(() => {
    if (status !== 'running') return
    const terminal = terminalRef.current
    if (!terminal) return
    try {
      fitRef.current?.fit()
    } catch {
      // The panel can briefly be width 0 while the inspector animates open.
    }
    if (sessionId) void getBridge().terminal.resize(sessionId, terminal.cols, terminal.rows)
    terminal.focus()
  }, [sessionId, status])

  const currentSize = () => {
    const terminal = terminalRef.current
    return terminal ? { cols: terminal.cols, rows: terminal.rows } : undefined
  }

  return (
    <div aria-label="终端" className={className ? `flex min-h-0 flex-1 flex-col ${className}` : 'flex min-h-0 flex-1 flex-col'}>
      <header className="flex h-9 shrink-0 items-center gap-2 border-b border-line px-3">
        <SquareTerminal size={13} className="shrink-0 text-info" />
        <span className="truncate font-mono text-[10.5px] text-fg-caption">
          {shell ? `${shell} · ${target ? basename(target) : ''}` : (target ?? '未连接工作区')}
        </span>
        <Chip tone={info.tone} size="xs">{info.label}</Chip>
        <div className="ml-auto flex items-center">
          <Tooltip content="清空终端回看" side="top">
            <IconButton label="清空终端" variant="ghost" size="xs" onClick={() => { clear(); terminalRef.current?.focus() }}>
              <Eraser size={13} />
            </IconButton>
          </Tooltip>
          <Tooltip content="重新启动 shell" side="top">
            <IconButton
              label="重新启动终端"
              variant="ghost"
              size="xs"
              disabled={status === 'starting'}
              onClick={() => {
                attemptedTargetRef.current = target
                void restart(currentSize())
              }}
            >
              <RotateCw size={13} />
            </IconButton>
          </Tooltip>
        </div>
      </header>

      <div className="relative min-h-0 flex-1 bg-canvas">
        <div
          ref={hostRef}
          aria-label="原生终端区域"
          className="absolute inset-0 cursor-text px-2 py-2 [&_.xterm]:h-full [&_.xterm-viewport]:!bg-transparent [&_.xterm-viewport]:!overflow-y-auto"
          onMouseDown={() => terminalRef.current?.focus()}
        />
        {error ? (
          <div className="pointer-events-none absolute inset-x-3 top-3 rounded border border-danger/20 bg-canvas/95 px-3 py-2 font-mono text-[11px] text-danger">
            {error}
          </div>
        ) : status === 'starting' && !output ? (
          <div className="pointer-events-none absolute left-3 top-3 text-[11px] text-fg-subtle">正在启动 shell…</div>
        ) : null}
      </div>
    </div>
  )
}
