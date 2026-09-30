import { beforeEach, describe, expect, it, vi } from 'vitest'

import { useSession } from '@/store/sessionStore'
import { useTerminal } from '@/store/terminalStore'

const shell = vi.hoisted(() => {
  const data: Array<(event: { id: string; data: string }) => void> = []
  const exit: Array<(event: { id: string; code: number | null; signal: string | null }) => void> = []
  const driver = {
    kind: 'native' as const,
    start: vi.fn(async ({ cwd }: { cwd: string }) => ({
      id: 'term-1', shell: '/bin/zsh', cwd, pid: 4242,
    })),
    write: vi.fn(async () => true),
    resize: vi.fn(async () => true),
    kill: vi.fn(async () => true),
    onData: vi.fn((listener: (event: { id: string; data: string }) => void) => {
      data.push(listener)
      return () => {}
    }),
    onExit: vi.fn((listener: (event: { id: string; code: number | null; signal: string | null }) => void) => {
      exit.push(listener)
      return () => {}
    }),
  }
  return { driver, data, exit }
})

vi.mock('@/bridge', () => ({
  getBridge: () => ({ platform: 'darwin', terminal: shell.driver }),
}))

const WORK = '/Users/qin/coding_agent/FoxCode'

function reset(): void {
  useTerminal.setState({
    status: 'idle', id: null, shell: null, cwd: null, exitCode: null, error: null, output: '',
  })
}

describe('terminalStore', () => {
  beforeEach(() => {
    reset()
    shell.driver.start.mockClear()
    shell.driver.write.mockClear()
    shell.driver.resize.mockClear()
    shell.driver.kill.mockClear()
    useSession.setState({ host: { cwd: WORK } as never })
  })

  it('starts a native PTY in the workspace with its measured size', async () => {
    await useTerminal.getState().ensure(undefined, { cols: 96, rows: 31 })
    expect(shell.driver.start).toHaveBeenCalledWith({ cwd: WORK, cols: 96, rows: 31 })
    expect(useTerminal.getState().status).toBe('running')
    expect(useTerminal.getState().shell).toBe('/bin/zsh')
  })

  it('says so when there is no workspace to run in', async () => {
    useSession.setState({ host: null })
    await useTerminal.getState().ensure()
    expect(useTerminal.getState().error).toContain('还没有工作区')
    expect(shell.driver.start).not.toHaveBeenCalled()
  })

  it('does not restart a shell that already runs in the same place', async () => {
    await useTerminal.getState().ensure(WORK)
    await useTerminal.getState().ensure(WORK)
    expect(shell.driver.start).toHaveBeenCalledTimes(1)
  })

  it('retains the raw PTY stream and flushes it on exit', async () => {
    await useTerminal.getState().ensure(WORK)
    const raw = '\u001b[32mFoxCode\u001b[0m\r\n% '
    shell.data.forEach((listener) => listener({ id: 'term-1', data: raw }))
    shell.exit.forEach((listener) => listener({ id: 'term-1', code: 0, signal: null }))
    expect(useTerminal.getState().output).toBe(raw)
    expect(useTerminal.getState().status).toBe('exited')
    expect(useTerminal.getState().exitCode).toBe(0)
  })

  it('ignores output that belongs to another PTY', async () => {
    await useTerminal.getState().ensure(WORK)
    shell.data.forEach((listener) => listener({ id: 'term-9', data: 'not ours' }))
    useTerminal.getState().flush()
    expect(useTerminal.getState().output).toBe('')
  })

  it('clears only the replay buffer', async () => {
    await useTerminal.getState().ensure(WORK)
    useTerminal.getState().feed('noise')
    useTerminal.getState().flush()
    useTerminal.getState().clear()
    expect(useTerminal.getState().output).toBe('')
    expect(useTerminal.getState().status).toBe('running')
  })

  it('kills the PTY when the terminal tab is closed', async () => {
    await useTerminal.getState().ensure(WORK)
    useTerminal.getState().stop()
    expect(shell.driver.kill).toHaveBeenCalledWith('term-1')
    expect(useTerminal.getState().status).toBe('exited')
    expect(useTerminal.getState().id).toBeNull()
  })
})
