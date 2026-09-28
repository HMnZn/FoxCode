import { beforeEach, describe, expect, it, vi } from 'vitest'

import { EMPTY_SCREEN, screenText } from '@/lib/terminalText'
import { useSession } from '@/store/sessionStore'
import { useTerminal } from '@/store/terminalStore'

/**
 * The store talks to the shell through `bridge.terminal`; the mock below is that
 * driver, with the two event hooks kept reachable so a test can play the shell.
 */
const shell = vi.hoisted(() => {
  const data: Array<(event: { id: string; data: string }) => void> = []
  const exit: Array<(event: { id: string; code: number | null; signal: string | null }) => void> = []
  const driver = {
    kind: 'native' as const,
    start: vi.fn(async ({ cwd }: { cwd: string }) => ({
      id: 'term-1',
      shell: 'cmd.exe',
      cwd,
      pid: 4242,
    })),
    write: vi.fn(async () => true),
    kill: vi.fn(async () => {}),
    onData: vi.fn((listener: (event: { id: string; data: string }) => void) => {
      data.push(listener)
      return () => {}
    }),
    onExit: vi.fn(
      (listener: (event: { id: string; code: number | null; signal: string | null }) => void) => {
        exit.push(listener)
        return () => {}
      },
    ),
  }
  return { driver, data, exit }
})

vi.mock('@/bridge', () => ({
  getBridge: () => ({ platform: 'win32', terminal: shell.driver }),
}))

const WORK = 'C:\\Users\\Qin\\Desktop\\coding_agent\\FoxCode'

function reset(): void {
  useTerminal.setState({
    status: 'idle',
    id: null,
    shell: null,
    cwd: null,
    exitCode: null,
    error: null,
    screen: EMPTY_SCREEN,
    input: '',
    history: [],
    cursor: null,
  })
}

describe('terminalStore', () => {
  beforeEach(() => {
    reset()
    shell.driver.start.mockClear()
    shell.driver.write.mockClear()
    shell.driver.kill.mockClear()
    useSession.setState({ host: { cwd: WORK } as never })
  })

  it('starts a shell in the workspace', async () => {
    await useTerminal.getState().ensure()
    await vi.waitFor(() => expect(useTerminal.getState().status).toBe('running'))
    expect(shell.driver.start).toHaveBeenCalledWith({ cwd: WORK })
    expect(useTerminal.getState().shell).toBe('cmd.exe')
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

  it('echoes the typed line locally and writes it with CRLF', async () => {
    await useTerminal.getState().ensure(WORK)
    useTerminal.getState().setInput('python -V')
    useTerminal.getState().submit()
    expect(shell.driver.write).toHaveBeenCalledWith('term-1', 'python -V\r\n')
    expect(screenText(useTerminal.getState().screen)).toBe('❯ python -V\n')
    expect(useTerminal.getState().history).toEqual(['python -V'])
    expect(useTerminal.getState().input).toBe('')
  })

  it('ignores an empty line', async () => {
    await useTerminal.getState().ensure(WORK)
    useTerminal.getState().setInput('   ')
    useTerminal.getState().submit()
    expect(shell.driver.write).not.toHaveBeenCalled()
  })

  it('handles clear itself instead of sending it', async () => {
    await useTerminal.getState().ensure(WORK)
    useTerminal.getState().feed('noise\n')
    useTerminal.getState().flush()
    useTerminal.getState().setInput('cls')
    useTerminal.getState().submit()
    expect(shell.driver.write).not.toHaveBeenCalled()
    expect(screenText(useTerminal.getState().screen)).toBe('')
    expect(useTerminal.getState().history).toEqual(['cls'])
  })

  it('folds shell output into the screen and flushes it on exit', async () => {
    await useTerminal.getState().ensure(WORK)
    shell.data.forEach((listener) => listener({ id: 'term-1', data: 'Microsoft Windows\r\nready\n' }))
    shell.exit.forEach((listener) => listener({ id: 'term-1', code: 0, signal: null }))
    // CRLF 只是行尾：回车把光标放回行首，换行才结算这一行。
    expect(screenText(useTerminal.getState().screen)).toBe('Microsoft Windows\nready\n')
    expect(useTerminal.getState().status).toBe('exited')
    expect(useTerminal.getState().exitCode).toBe(0)
  })

  it('ignores output that belongs to another terminal', async () => {
    await useTerminal.getState().ensure(WORK)
    shell.data.forEach((listener) => listener({ id: 'term-9', data: 'not ours' }))
    useTerminal.getState().flush()
    expect(screenText(useTerminal.getState().screen)).toBe('')
  })

  it('refuses a non-ASCII command line on Windows and says why', async () => {
    await useTerminal.getState().ensure(WORK)
    useTerminal.getState().setInput('echo 中文')
    useTerminal.getState().submit()
    // 乱码的命令行不只是难读：cmd 会停在 More? 等一个闭合引号，所以干脆不发。
    expect(shell.driver.write).not.toHaveBeenCalled()
    expect(screenText(useTerminal.getState().screen)).toContain('这行没有发出去')
    expect(screenText(useTerminal.getState().screen)).toContain('More?')
  })

  it('walks the history with the arrow keys', async () => {
    await useTerminal.getState().ensure(WORK)
    for (const line of ['first', 'second']) {
      useTerminal.getState().setInput(line)
      useTerminal.getState().submit()
    }
    useTerminal.getState().recall(-1)
    expect(useTerminal.getState().input).toBe('second')
    useTerminal.getState().recall(-1)
    expect(useTerminal.getState().input).toBe('first')
    useTerminal.getState().recall(1)
    expect(useTerminal.getState().input).toBe('second')
  })

  it('kills the shell when the terminal is ended', async () => {
    await useTerminal.getState().ensure(WORK)
    useTerminal.getState().stop()
    expect(shell.driver.kill).toHaveBeenCalledWith('term-1')
    expect(useTerminal.getState().status).toBe('exited')
    expect(useTerminal.getState().id).toBeNull()
  })
})
