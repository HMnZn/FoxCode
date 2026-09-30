import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { TerminalTab } from '@/components/layout/TerminalPanel'
import { useSession } from '@/store/sessionStore'
import { useTerminal } from '@/store/terminalStore'
import { useUi } from '@/store/uiStore'

const xterm = vi.hoisted(() => {
  const instances: MockTerminal[] = []
  class MockTerminal {
    cols = 80
    rows = 24
    write = vi.fn()
    reset = vi.fn()
    focus = vi.fn()
    dispose = vi.fn()
    private dataListener: ((data: string) => void) | null = null
    private resizeListener: ((size: { cols: number; rows: number }) => void) | null = null

    constructor(readonly options?: { theme?: { background?: string } }) { instances.push(this) }
    loadAddon(): void {}
    open(element: HTMLElement): void { element.dataset.xtermOpen = 'true' }
    onData(listener: (data: string) => void) {
      this.dataListener = listener
      return { dispose: vi.fn() }
    }
    onResize(listener: (size: { cols: number; rows: number }) => void) {
      this.resizeListener = listener
      return { dispose: vi.fn() }
    }
    emitData(data: string): void { this.dataListener?.(data) }
    emitResize(cols: number, rows: number): void { this.resizeListener?.({ cols, rows }) }
  }
  return { MockTerminal, instances }
})

vi.mock('@xterm/xterm', () => ({ Terminal: xterm.MockTerminal }))
vi.mock('@xterm/addon-fit', () => ({
  FitAddon: class { fit = vi.fn(); dispose = vi.fn() },
}))

const shell = vi.hoisted(() => ({
  driver: {
    kind: 'native' as const,
    start: vi.fn(async ({ cwd }: { cwd: string }) => ({
      id: 'term-1', shell: '/bin/zsh', cwd, pid: 4242,
    })),
    write: vi.fn(async () => true),
    resize: vi.fn(async () => true),
    kill: vi.fn(async () => true),
    onData: vi.fn(() => () => {}),
    onExit: vi.fn(() => () => {}),
  },
}))

vi.mock('@/bridge', () => ({
  getBridge: () => ({ platform: 'darwin', terminal: shell.driver }),
}))

const WORK = '/Users/qin/coding_agent/FoxCode'

describe('TerminalTab', () => {
  beforeEach(() => {
    xterm.instances.length = 0
    shell.driver.start.mockClear()
    shell.driver.write.mockClear()
    shell.driver.resize.mockClear()
    shell.driver.kill.mockClear()
    useSession.setState({ host: { cwd: WORK } as never })
    useUi.setState({ theme: 'dark' })
    useTerminal.setState({
      status: 'running', id: 'term-1', shell: '/bin/zsh', cwd: WORK,
      exitCode: null, error: null, output: '\u001b[32mready\u001b[0m\r\n% ',
    })
  })

  it('mounts a native terminal surface and replays PTY output', () => {
    render(<TerminalTab />)
    expect(screen.getByLabelText('终端')).toBeTruthy()
    expect(screen.getByText('/bin/zsh · FoxCode')).toBeTruthy()
    expect(screen.getByText('运行中')).toBeTruthy()
    expect(screen.queryByLabelText('终端命令')).toBeNull()
    expect(screen.getByLabelText('原生终端区域').getAttribute('data-xterm-open')).toBe('true')
    expect(xterm.instances[0].write).toHaveBeenCalledWith('\u001b[32mready\u001b[0m\r\n% ')
  })

  it('keeps the xterm viewport transparent in the light theme', () => {
    useUi.setState({ theme: 'light' })
    render(<TerminalTab />)
    const surface = screen.getByLabelText('原生终端区域')
    expect(surface.className).toContain('[&_.xterm-viewport]:!bg-transparent')
    expect(xterm.instances[0].options?.theme?.background).toBe('#00000000')
  })

  it('sends each xterm keyboard sequence directly to the PTY', () => {
    render(<TerminalTab />)
    xterm.instances[0].emitData('git status')
    xterm.instances[0].emitData('\r')
    xterm.instances[0].emitData('\u0003')
    expect(shell.driver.write).toHaveBeenNthCalledWith(1, 'term-1', 'git status')
    expect(shell.driver.write).toHaveBeenNthCalledWith(2, 'term-1', '\r')
    expect(shell.driver.write).toHaveBeenNthCalledWith(3, 'term-1', '\u0003')
  })

  it('resizes the PTY when xterm changes dimensions', () => {
    render(<TerminalTab />)
    xterm.instances[0].emitResize(112, 36)
    expect(shell.driver.resize).toHaveBeenCalledWith('term-1', 112, 36)
  })

  it('restarts the shell in the same folder from its header', async () => {
    render(<TerminalTab />)
    fireEvent.click(screen.getByLabelText('重新启动终端'))
    expect(shell.driver.kill).toHaveBeenCalledWith('term-1')
    await waitFor(() => expect(shell.driver.start).toHaveBeenCalledWith({ cwd: WORK, cols: 80, rows: 24 }))
  })

  it('does not forward keys once the PTY has exited', () => {
    useTerminal.setState({ status: 'exited', id: null })
    render(<TerminalTab />)
    xterm.instances[0].emitData('git status\r')
    expect(shell.driver.write).not.toHaveBeenCalled()
  })

  it('starts after a workspace arrives if the tab opened during host startup', async () => {
    useSession.setState({ host: null })
    useTerminal.setState({ status: 'idle', id: null, shell: null, cwd: null, error: '还没有工作区', output: '' })
    const view = render(<TerminalTab />)
    expect(shell.driver.start).not.toHaveBeenCalled()

    useSession.setState({ host: { cwd: WORK } as never })
    view.rerender(<TerminalTab />)

    await waitFor(() => expect(shell.driver.start).toHaveBeenCalledWith({ cwd: WORK, cols: 80, rows: 24 }))
    expect(useTerminal.getState().status).toBe('running')
    expect(useTerminal.getState().error).toBeNull()
  })
})
