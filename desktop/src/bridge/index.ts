import { IpcBridge } from '@/bridge/ipc'
import { MockHost } from '@/bridge/mock/mockHost'
import type { FoxBridge } from '@/bridge/types'

let instance: FoxBridge | null = null

/**
 * Resolve the single host bridge for this renderer.
 *
 * Inside the Electron shell (`window.foxcode` injected by preload) the UI
 * talks to the main process, which drives the Python sidecar. Anywhere else —
 * `vite dev` in a browser, or an Electron build without a reachable sidecar —
 * the in-renderer `MockHost` takes over so the UI is fully explorable.
 */
export function getBridge(): FoxBridge {
  if (instance) return instance
  const api = typeof window !== 'undefined' ? window.foxcode : undefined
  const bridge: FoxBridge = api?.available ? new IpcBridge(api) : new MockHost()
  instance = bridge
  return bridge
}

export type { FoxBridge } from '@/bridge/types'
