import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { TerminalTab } from '@/components/layout/TerminalPanel'
import { EMPTY_SCREEN, appendOutput } from '@/lib/terminalText'
import { useSession } from '@/store/sessionStore'
import { useTerminal } from '@/store/terminalStore'

const shell = vi.hoisted(() => ({
  driver: {
    kind: 'native' as const,
    start: vi.fn(async ({ cwd }: { cwd: string }) => ({
      id: 'term-1',
      shell: 'cmd.exe',
      cwd,
      pid: 4242,
    })),
    write: vi.fn(async () => true),
    kill: vi.fn(async () => {}),
    onData: vi.fn(() => () => {}),
    onExit: vi.fn(() => () => {}),
  },
}))

vi.mock('@/bridge', () => ({
  getBridge: () => ({ platform: 'win32', terminal: shell.driver }),
}))

const WORK = 'C:\\Users\\Qin\\Desktop\\coding_agent\\FoxCode'

describe('TerminalTab', () => {
  beforeEach(() => {
    shell.driver.start.mockClear()
    shell.driver.write.mockClear()
    shell.driver.kill.mockClear()
    useSession.setState({ host: { cwd: WORK } as never })
    useTerminal.setState({
      status: 'running',
      id: 'term-1',
      shell: 'cmd.exe',
      cwd: WORK,
      exitCode: null,
      error: null,
      screen: appendOutput(EMPTY_SCREEN, 'Microsoft Windows\r\nready\n'),
      input: '',
      history: [],
      cursor: null,
    })
  })

  it('shows where it runs and what the shell printed', () => {
    render(<TerminalTab />)
    expect(screen.getByLabelText('终端')).toBeTruthy()
    expect(screen.getByText('cmd.exe · FoxCode')).toBeTruthy()
    expect(screen.getByText('运行中')).toBeTruthy()
    expect(screen.getByText(/ready/)).toBeTruthy()
  })

  it('runs what you type on Enter', () => {
    render(<TerminalTab />)
    const input = screen.getByLabelText('终端命令') as HTMLInputElement
    fireEvent.change(input, { target: { value: 'git status' } })
    fireEvent.keyDown(input, { key: 'Enter', code: 'Enter' })
    expect(shell.driver.write).toHaveBeenCalledWith('term-1', 'git status\r\n')
    expect(screen.getByText(/❯ git status/)).toBeTruthy()
  })

  it('restarts the shell in the same folder from its own header', () => {
    render(<TerminalTab />)
    fireEvent.click(screen.getByLabelText('重新启动终端'))
    expect(shell.driver.kill).toHaveBeenCalledWith('term-1')
    expect(shell.driver.start).toHaveBeenCalledWith({ cwd: WORK })
  })

  it('refuses to send anything once the shell has exited', () => {
    useTerminal.setState({ status: 'exited', id: null })
    render(<TerminalTab />)
    const input = screen.getByLabelText('终端命令') as HTMLInputElement
    expect((input as HTMLInputElement).placeholder).toBe('终端未在运行')
    fireEvent.change(input, { target: { value: 'git status' } })
    fireEvent.keyDown(input, { key: 'Enter', code: 'Enter' })
    expect(shell.driver.write).not.toHaveBeenCalled()
  })
})
