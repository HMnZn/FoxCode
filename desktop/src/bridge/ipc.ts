import type { FoxBridge, TransportStatus, WindowControls } from '@/bridge/types'
import {
  nativeTerminalDriver,
  type TerminalApi,
  type TerminalDriver,
} from '@/bridge/terminal'
import type {
  HostCommand,
  HostFrame,
  HostInfo,
  PermissionRequest,
  SessionSummary,
} from '@/types/protocol'

/** Shape injected by `desktop/electron/preload.js` via contextBridge. */
export interface FoxcodeApi {
  available: true
  platform: string
  invoke(channel: string, payload?: unknown): Promise<unknown>
  on(channel: string, listener: (payload: never) => void): () => void
  window: {
    minimize(): void
    toggleMaximize(): void
    close(): void
    onMaximizeChange(cb: (maximized: boolean) => void): () => void
  }
  pickDirectory(): Promise<string | null>
  openExternal(url: string): Promise<void>
  revealPath(path: string): Promise<boolean>
  openTerminal(path: string): Promise<boolean>
  terminal: TerminalApi
  themeFlash(): void
}

declare global {
  interface Window {
    foxcode?: FoxcodeApi
  }
}

/**
 * Electron wraps every rejected `ipcRenderer.invoke` as
 * `Error invoking remote method 'host:command': <real message>`. That wrapper is
 * Electron plumbing, not information: it pushed the host's own Chinese reason
 * ("工作区不可写：无法创建 …") out of the visible part of the warning banner and
 * left the user staring at an English implementation detail. Unwrap it once, here.
 */
export function unwrapIpcError(error: unknown): unknown {
  const raw = error instanceof Error ? error.message : String(error)
  const cleaned = raw
    .replace(/^Error invoking remote method '[^']*':\s*/, '')
    .replace(/^Error:\s*/, '')
  if (cleaned === raw) return error
  return new Error(cleaned)
}

/**
 * Bridge to the Electron main process, which owns the Python `fox serve`
 * sidecar. Main re-emits host frames verbatim, so this class stays thin: it
 * only routes channels and keeps the renderer free of Node APIs.
 */
export class IpcBridge implements FoxBridge {
  readonly kind = 'ipc' as const
  readonly platform: string
  readonly window: WindowControls
  /** The embedded terminal is main-process machinery, so it is always native. */
  readonly terminal: TerminalDriver

  constructor(private readonly api: FoxcodeApi) {
    this.platform = api.platform
    this.terminal = nativeTerminalDriver(api.terminal)
    this.window = {
      minimize: () => api.window.minimize(),
      toggleMaximize: () => api.window.toggleMaximize(),
      close: () => api.window.close(),
      onMaximizeChange: (cb) => api.window.onMaximizeChange(cb),
    }
  }

  info(): Promise<HostInfo> {
    return this.api.invoke('host:info').catch((error) => {
      throw unwrapIpcError(error)
    }) as Promise<HostInfo>
  }

  sessions(): Promise<SessionSummary[]> {
    return this.api.invoke('host:sessions').catch((error) => {
      throw unwrapIpcError(error)
    }) as Promise<SessionSummary[]>
  }

  send(command: HostCommand): Promise<unknown> {
    return this.api.invoke('host:command', command).catch((error) => {
      throw unwrapIpcError(error)
    })
  }

  onFrame(cb: (frame: HostFrame) => void): () => void {
    return this.api.on('host:frame', cb as (payload: never) => void)
  }

  onPermission(cb: (request: PermissionRequest) => void): () => void {
    return this.api.on('host:permission', cb as (payload: never) => void)
  }

  onTransport(cb: (status: TransportStatus) => void): () => void {
    return this.api.on('host:transport', cb as (payload: never) => void)
  }

  pickDirectory(): Promise<string | null> {
    return this.api.pickDirectory()
  }

  openExternal(url: string): Promise<void> {
    return this.api.openExternal(url)
  }

  reveal(path: string): Promise<boolean> {
    return this.api.revealPath(path)
  }

  openTerminal(path: string): Promise<boolean> {
    return this.api.openTerminal(path)
  }

  themeFlash(): void {
    this.api.themeFlash()
  }
}
