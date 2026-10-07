/**
 * Development launcher: start the Vite dev server, wait until it serves, then
 * launch Electron pointed at it. Both children inherit stdio, so their logs
 * land in this terminal and no pipe handles are needed.
 *
 *   node scripts/dev.mjs              # Chromium 起不来时重试，并记住成功的软模式
 *   node scripts/dev.mjs --no-gpu     # 直接软模式：禁用 GPU/沙箱/崩溃上报
 *   node scripts/dev.mjs --reset-gpu  # 清除兼容模式记录，重新尝试正常模式
 *
 * 两个已知陷阱：
 *   - 端口预检。上一次没退干净的 dev server 会继续应答我们的健康检查，于是我们会
 *     对着旧服务器拉起 Electron，页面与当前源码不一致。
 *   - 启动崩溃码。受限环境/没有交互式桌面时 Chromium 会以 STATUS_BREAKPOINT 之类
 *     的码在 0s 退出，这时追加 --no-sandbox --disable-gpu 就能起来。
 */
import { execFileSync, spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { electronBinary, electronEnv, electronFlags } from './electron-bin.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
const executable = electronBinary(root)
const isWindows = process.platform === 'win32'
const cacheRoot = path.resolve(root, '..', '.build-cache')
const launchStatePath = path.join(cacheRoot, 'electron-dev-launch.json')
const electronVersion = JSON.parse(fs.readFileSync(path.join(root, 'node_modules', 'electron', 'package.json'), 'utf8')).version
if (process.argv.includes('--reset-gpu')) fs.rmSync(launchStatePath, { force: true })
let savedSoftMode = false
try {
  const state = JSON.parse(fs.readFileSync(launchStatePath, 'utf8'))
  savedSoftMode = state.electronVersion === electronVersion && state.softMode === true
} catch {
  // First launch or an outdated/invalid state: try normal mode.
}
const noGpu = process.argv.includes('--no-gpu') || savedSoftMode
const PORT = Number(process.env.FOXCODE_DEV_PORT ?? 5273)
const DEV_URL = `http://127.0.0.1:${PORT}`
/** Poll both spellings: whichever the dev server actually bound to is the one Electron loads. */
const CANDIDATES = [DEV_URL, `http://localhost:${PORT}`]
/** Enough to start Chromium in environments where its GPU/sandbox cannot initialize. */
const SOFT_FLAGS = [
  '--no-sandbox',
  '--disable-gpu',
  '--disable-crash-reporter',
]
// Normal mode and its retry share a development profile, separate from the
// installed app. A retry must not switch profiles and lose browser storage.
const PROFILE_FLAGS = [`--user-data-dir=${path.join(cacheRoot, 'electron-userdata-dev')}`]
/**
 * Exit codes Chromium uses when the browser process cannot start at all, reported
 * by Node as unsigned 32-bit values:
 *   2147483651 = 0x80000003 STATUS_BREAKPOINT, 3221225477 = 0xC0000005 ACCESS_VIOLATION,
 *   4294930435 = 0xFFFF7003 (crashpad / no interactive desktop).
 */
const LAUNCH_CRASH_CODES = new Set([2147483651, 3221225477, 4294930435])

const childEnv = electronEnv()

let shuttingDown = false
let electron = null

/** Any HTTP answer means something already listens on the port. */
async function isPortBusy(port) {
  try {
    await fetch(`http://127.0.0.1:${port}`, { method: 'GET', signal: AbortSignal.timeout(1500) })
    return true
  } catch {
    return false
  }
}

/** Best-effort PID lookup so the message can tell the user what to stop. */
function listeningPid(port) {
  if (!isWindows) return null
  try {
    const output = execFileSync('netstat', ['-ano', '-p', 'TCP'], { encoding: 'utf8' })
    for (const line of output.split('\n')) {
      const match = line.trim().match(/^TCP\s+\S+:(\d+)\s+\S+\s+LISTENING\s+(\d+)$/)
      if (match && Number(match[1]) === port) return match[2]
    }
  } catch {
    /* netstat is a nicety, not a requirement */
  }
  return null
}

if (await isPortBusy(PORT)) {
  const pid = listeningPid(PORT)
  // stdout on purpose: PowerShell renders stderr as a red NativeCommandError block,
  // which buries this actionable message. The non-zero exit code still signals failure.
  console.log(`端口 ${PORT} 已被占用：${DEV_URL} 已有服务在应答${pid ? `（PID ${pid}）` : ''}。`)
  console.log('多半是上一次的 dev server 还在后台跑。先结束它，或者换个端口：')
  if (pid) console.log(`  Stop-Process -Id ${pid} -Force`)
  console.log(`  $env:FOXCODE_DEV_PORT=${PORT + 1}; npm run dev`)
  process.exit(1)
}

if (noGpu) {
  console.log(`${savedSoftMode ? '沿用上次成功的兼容模式' : '软模式'}：Electron 追加 ${SOFT_FLAGS.join(' ')}`)
  if (savedSoftMode) console.log('重新检测 GPU/沙箱：npm run dev -- --reset-gpu')
}

// Launch Node directly. Killing a Windows .cmd wrapper leaves its Vite child
// running and holding the dev port after the Electron window has closed.
const vite = spawn(process.execPath, [path.join(root, 'node_modules', 'vite', 'bin', 'vite.js'), '--port', String(PORT), '--strictPort'], {
  cwd: root,
  stdio: 'inherit',
  env: childEnv,
})

const viteExited = new Promise((resolve) => vite.on('exit', resolve))

vite.on('exit', (code) => {
  if (shuttingDown) return
  console.error(`vite exited with code ${code}`)
  shutdown(code ?? 1)
})
vite.on('error', (error) => {
  console.error(`无法启动 Vite：${error.message}`)
  shutdown(1)
})

/** Resolves to the URL that answered, or `null` after logging why nothing did. */
async function waitForServer(timeoutMs = 40_000) {
  const deadline = Date.now() + timeoutMs
  let lastError = 'no attempt yet'
  while (Date.now() < deadline) {
    if (vite.exitCode !== null) return null
    for (const candidate of CANDIDATES) {
      try {
        const response = await fetch(candidate, { method: 'GET', signal: AbortSignal.timeout(1500) })
        // Any HTTP answer means the server is listening; only transport errors count as "not ready".
        if (response.status < 500) return candidate
        lastError = `${candidate} answered ${response.status}`
      } catch (error) {
        lastError = `${candidate} -> ${error?.cause?.code ?? error?.message ?? error}`
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  console.error(`dev server did not answer on ${CANDIDATES.join(' or ')} (last: ${lastError})`)
  return null
}

function stopChild(child) {
  if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return
  if (isWindows) {
    try {
      execFileSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
    } catch {
      child.kill()
    }
  } else {
    child.kill()
  }
}

function shutdown(code) {
  if (shuttingDown) return
  shuttingDown = true
  stopChild(electron)
  stopChild(vite)
  process.exit(code)
}

process.on('SIGINT', () => shutdown(0))
process.on('SIGTERM', () => shutdown(0))

function launchElectron(devServerUrl, flags, { allowSoftRetry }) {
  electron = spawn(executable, [...PROFILE_FLAGS, ...electronFlags(), ...flags, '.'], {
    cwd: root,
    stdio: 'inherit',
    env: electronEnv({
      VITE_DEV_SERVER_URL: devServerUrl,
      FOXCODE_DEV_SOFT_MODE: flags.includes('--disable-gpu') ? '1' : '0',
      FOXCODE_DEV_LAUNCH_STATE: launchStatePath,
    }),
  })
  electron.on('error', (error) => {
    console.error(`无法启动 Electron：${error.message}`)
    shutdown(1)
  })
  const startedAt = Date.now()
  electron.on('exit', (code) => {
    if (shuttingDown) return
    const upFor = Date.now() - startedAt
    const crashed = (code ?? 0) !== 0 && upFor < 10_000
    if (crashed && allowSoftRetry && LAUNCH_CRASH_CODES.has(code)) {
      console.error(`\nElectron 启动 ${Math.round(upFor / 1000)}s 后崩溃（code ${code}）：Chromium 沙箱/GPU 起不来。`)
      console.error(`自动改用软模式重启一次：${SOFT_FLAGS.join(' ')}\n`)
      launchElectron(devServerUrl, SOFT_FLAGS, { allowSoftRetry: false })
      return
    }
    if (crashed) {
      console.error(`\nElectron 启动 ${Math.round(upFor / 1000)}s 后崩溃（code ${code}）。`)
      console.error('若上面出现 "GPU process isn\'t usable"、crashpad 报错或 GPU 缓存目录被占用，')
      console.error('说明当前环境起不了 Chromium 的 GPU/沙箱：')
      console.error('  npm run dev:no-gpu            # 等价于上面的软模式参数')
      console.error('  $env:FOXCODE_ELECTRON_FLAGS="…"   # 或自己指定开关')
    }
    shutdown(code ?? 0)
  })
}

const devServerUrl = await waitForServer()
if (!devServerUrl) {
  const viteStatus = await Promise.race([viteExited, Promise.resolve('still running')])
  if (viteStatus !== 'still running') console.error(`vite 已退出（code ${viteStatus}），不再启动 Electron。`)
  shutdown(1)
}

launchElectron(devServerUrl, noGpu ? SOFT_FLAGS : [], { allowSoftRetry: !noGpu })
