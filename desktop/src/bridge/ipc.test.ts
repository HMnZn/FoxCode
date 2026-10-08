import { describe, expect, it, vi } from 'vitest'
import { IpcBridge, unwrapIpcError, type FoxcodeApi } from '@/bridge/ipc'

/**
 * Electron's `ipcRenderer.invoke` rejection text is plumbing, not information.
 * The host's own message ("工作区不可写：无法创建 …") is what the banner must show;
 * before this unwrap the user read `Error invoking remote method 'host:command'`
 * and could only say "工作区无法切换".
 */
describe('unwrapIpcError', () => {
  it('strips the Electron invoke wrapper', () => {
    const wrapped = new Error(
      "Error invoking remote method 'host:command': PermissionError: [WinError 5] 拒绝访问: 'C:\\x\\.foxcode'",
    )
    const error = unwrapIpcError(wrapped)
    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toBe(
      "PermissionError: [WinError 5] 拒绝访问: 'C:\\x\\.foxcode'",
    )
  })

  it('drops a doubled Error prefix', () => {
    const error = unwrapIpcError(
      new Error("Error invoking remote method 'host:command': Error: 宿主运行时尚未就绪或已关闭"),
    )
    expect((error as Error).message).toBe('宿主运行时尚未就绪或已关闭')
  })

  it('unwraps the same text when it arrives as a plain string', () => {
    const error = unwrapIpcError("Error invoking remote method 'host:command': boom")
    expect((error as Error).message).toBe('boom')
  })

  it('returns an unrelated error untouched', () => {
    const original = new Error('Runtime is switching or reloading')
    expect(unwrapIpcError(original)).toBe(original)
  })
})

describe('IpcBridge host queries', () => {
  it('routes host info and sessions through the command transport', async () => {
    const info = { cwd: '/workspace' }
    const sessions = [{ id: 'session-1' }]
    const invoke = vi.fn().mockResolvedValueOnce(info).mockResolvedValueOnce(sessions)
    const bridge = new IpcBridge({ invoke, window: {}, terminal: {}, platform: 'darwin' } as unknown as FoxcodeApi)
    expect(await bridge.info()).toEqual(info)
    expect(await bridge.sessions()).toEqual(sessions)
    expect(invoke.mock.calls).toEqual([
      ['host:command', { method: 'host.info' }],
      ['host:command', { method: 'sessions.list' }],
    ])
  })

  it('unwraps failures for convenience queries as well as other commands', async () => {
    const invoke = vi.fn().mockRejectedValue(new Error("Error invoking remote method 'host:command': Error: 宿主尚未就绪"))
    const bridge = new IpcBridge({ invoke, window: {}, terminal: {}, platform: 'darwin' } as unknown as FoxcodeApi)
    await expect(bridge.info()).rejects.toThrow('宿主尚未就绪')
    await expect(bridge.sessions()).rejects.toThrow('宿主尚未就绪')
  })
})
