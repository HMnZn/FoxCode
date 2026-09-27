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
    const allowed = new Set(['host:frame', 'host:permission', 'host:transport', 'window:maximized'])
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
  themeFlash: () => ipcRenderer.invoke('app:theme-flash'),
})
