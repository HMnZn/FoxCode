import type { TerminalDriver } from '@/bridge/terminal'
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
 * Python `fox_serve` sidecar (NDJSON over stdio). `MockBridge`
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
  /** Open a native terminal rooted at the workspace. */
  openTerminal(path: string): Promise<boolean>
  /**
   * The embedded terminal: a shell owned by the Electron main process, driving
   * the panel inside the window. Independent of the host, so the mock bridge
   * forwards to it as well (`demoDriver()` when there is no shell at all).
   */
  readonly terminal: TerminalDriver
  /** Only available in the Electron shell; no-op for the mock. */
  themeFlash(): void
}

export interface TransportStatus {
  state: 'connecting' | 'ready' | 'degraded' | 'offline'
  detail?: string
  since: number
}
