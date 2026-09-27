import type {
  HostCommand,
  HostFrame,
  HostInfo,
  PermissionRequest,
  SessionSummary,
} from '@/types/protocol'

/** Window-level controls exposed by the Electron preload script. */
export interface WindowControls {
  minimize(): void
  toggleMaximize(): void
  close(): void
  onMaximizeChange(cb: (maximized: boolean) => void): () => void
}

/**
 * The single seam between the renderer and a FoxCode host.
 *
 * `IpcBridge` talks to the Electron main process, which in turn drives a
 * Python `fox serve` sidecar (JSON-RPC over stdio/WebSocket). `MockBridge`
 * implements the exact same contract entirely in the renderer so the UI can
 * run with no Python sidecar at all (`transport: "mock"` in `HostInfo`).
 */
export interface FoxBridge {
  readonly kind: 'ipc' | 'mock'
  readonly window: WindowControls
  platform: NodeJS.Platform | string

  info(): Promise<HostInfo>
  sessions(): Promise<SessionSummary[]>
  send(command: HostCommand): Promise<unknown>

  /** Host event frames, already stamped with `seq` + `ts`. */
  onFrame(cb: (frame: HostFrame) => void): () => void
  /** Blocking `before_tool_call` round-trips awaiting a UI answer. */
  onPermission(cb: (request: PermissionRequest) => void): () => void
  /** Transport-level status (sidecar connected / crashed / reconnecting). */
  onTransport(cb: (status: TransportStatus) => void): () => void

  pickDirectory(): Promise<string | null>
  openExternal(url: string): Promise<void>
  /** Reveal a path in the OS file manager (no-op outside the Electron shell). */
  reveal(path: string): Promise<boolean>
  /** Only available in the Electron shell; no-op for the mock. */
  themeFlash(): void
}

export interface TransportStatus {
  state: 'connecting' | 'ready' | 'degraded' | 'offline'
  detail?: string
  since: number
}
