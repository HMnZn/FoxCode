import type { FoxcodeApi } from '@/bridge/ipc'

/**
 * Electron 外壳里那两件**不需要 sidecar** 的原生能力：开终端、在文件管理器里定位。
 *
 * `window.foxcode.available` 说的是「有没有 fox serve 宿主」，而这两件事由主进程自己
 * 就能做。所以演示宿主（没有 sidecar 时的内置模拟器）也要把它们透传出去，否则用户在
 * 演示模式里点「新建终端」永远只得到一句「演示模式不能打开系统终端」。
 *
 * 浏览器里跑 `vite dev` 时 `window.foxcode` 不存在，返回 null，调用方退回原来的提示。
 */
export type NativeShell = Pick<FoxcodeApi, 'platform' | 'openTerminal' | 'revealPath'>

export function nativeShell(): NativeShell | null {
  if (typeof window === 'undefined') return null
  const api = window.foxcode
  if (!api || typeof api.openTerminal !== 'function') return null
  return api
}
