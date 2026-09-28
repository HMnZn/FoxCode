/**
 * Preload: the only bridge between the sandboxed renderer and the main process.
 *
 * Everything is explicitly enumerated. `available` is false when no
 * `fox serve` sidecar was configured, which makes the renderer fall back to its
 * built-in demo host instead of showing a dead connection.
 */
const { contextBridge, ipcRenderer } = require('electron')

const sidecarArg = process.argv.find((arg) => arg.startsWith('--foxcode-sidecar='))
const sidecarConfigured = sidecarArg?.split('=')[1] === '1'

/** Wrap an ipcRenderer listener so the renderer only gets the payload. */
function subscribe(channel, listener) {
  const handler = (_event, payload) => listener(payload)
  ipcRenderer.on(channel, handler)
  return () => ipcRenderer.removeListener(channel, handler)
}

contextBridge.exposeInMainWorld('foxcode', {
  available: sidecarConfigured,
  platform: process.platform,
  invoke: (channel, payload) => {
    const allowed = new Set([
      'window:minimize',
      'window:toggle-maximize',
      'window:close',
      'window:state',
      'dialog:pick-directory',
      'dialog:save-file',
      'shell:open-external',
      'shell:show-item',
      'terminal:open',
      'terminal:start',
      'terminal:write',
      'terminal:kill',
      'app:theme-flash',
      'host:mode',
      'host:info',
      'host:sessions',
      'host:command',
    ])
    if (!allowed.has(channel)) return Promise.reject(new Error(`channel not allowed: ${channel}`))
    return ipcRenderer.invoke(channel, payload)
  },
  on: (channel, listener) => {
    const allowed = new Set([
      'host:frame',
      'host:permission',
      'host:transport',
      'window:maximized',
      'terminal:data',
      'terminal:exit',
    ])
    if (!allowed.has(channel)) return () => {}
    return subscribe(channel, listener)
  },
  window: {
    minimize: () => ipcRenderer.invoke('window:minimize'),
    toggleMaximize: () => ipcRenderer.invoke('window:toggle-maximize'),
    close: () => ipcRenderer.invoke('window:close'),
    onMaximizeChange: (callback) => subscribe('window:maximized', callback),
  },
  pickDirectory: () => ipcRenderer.invoke('dialog:pick-directory'),
  openExternal: (url) => ipcRenderer.invoke('shell:open-external', url),
  revealPath: (target) => ipcRenderer.invoke('shell:show-item', target),
  openTerminal: (target) => ipcRenderer.invoke('terminal:open', target),
  // The in-app terminal is a shell feature of the main process, not part of the
  // `fox serve` sidecar, so it stays available in demo mode too.
  terminal: {
    start: (options) => ipcRenderer.invoke('terminal:start', options),
    write: (id, data) => ipcRenderer.invoke('terminal:write', { id, data }),
    kill: (id) => ipcRenderer.invoke('terminal:kill', id),
    onData: (listener) => subscribe('terminal:data', listener),
    onExit: (listener) => subscribe('terminal:exit', listener),
  },
  themeFlash: () => ipcRenderer.invoke('app:theme-flash'),
})
