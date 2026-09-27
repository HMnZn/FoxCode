/**
 * Development launcher: start the Vite dev server, wait until it serves, then
 * launch Electron pointed at it. Both children inherit stdio, so their logs
 * land in this terminal and no pipe handles are needed.
 *
 *   node scripts/dev.mjs              # 普通模式；Chromium 起不来时自动软模式重试一次
 *   node scripts/dev.mjs --no-gpu     # 直接软模式：禁用 GPU/沙箱/崩溃上报
 *
 * 两个已知陷阱 worth knowing about:
 *   - 端口预检。上一次没退干净的 dev server 会继续应答我们的健康检查，于是我们会
 *     对着*旧*服务器拉起第二个 Electron，两个实例抢同一份 GPU 缓存目录，最后得到
 *     一句几乎无法反推的 `FATAL: GPU process isn't usable. Goodbye.`。
 *   - 启动崩溃码。受限环境/没有交互式桌面时 Chromium 会以 STATUS_BREAKPOINT 之类
 *     的码在 0s 退出，这时追加 --no-sandbox --disable-gpu 就能起来。
 */
import { execFileSync, spawn } from 'node:child_process'
import path from 'node:path'
import process from 'node:process'
import { electronBinary, electronEnv, electronFlags } from './electron-bin.mjs'

const root = process.cwd()
const isWindows = process.platform === 'win32'
const noGpu = process.argv.includes('--no-gpu')
const PORT = Number(process.env.FOXCODE_DEV_PORT ?? 5273)
const URL = `http://127.0.0.1:${PORT}`
/** Poll both spellings: whichever the dev server actually bound to is the one Electron loads. */
const CANDIDATES = [URL, `http://localhost:${PORT}`]
/** Enough to start Chromium in environments where its GPU/sandbox cannot initialize. */
const SOFT_FLAGS = [
  '--no-sandbox',
  '--disable-gpu',
  '--disable-crash-reporter',
  `--user-data-dir=${path.join(root, '..', '.build-cache', 'electron-userdata-dev')}`,
]
/**
 * Exit codes Chromium uses when the browser process cannot start at all, reported
 * by Node as unsigned 32-bit values:
 *   2147483651 = 0x80000003 STATUS_BREAKPOINT, 3221225477 = 0xC0000005 ACCESS_VIOLATION,
 *   4294930435 = 0xFFFF7003 (crashpad / no interactive desktop).
 */
const LAUNCH_CRASH_CODES = new Set([2147483651, 3221225477, 4294930435])

const bin = (name) => path.join(root, 'node_modules', '.bin', isWindows ? `${name}.cmd` : name)

/** Vite still runs through its npm shim; only Electron needs the raw binary. */
const childEnv = electronEnv()

let shuttingDown = false

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
  console.log(`端口 ${PORT} 已被占用：${URL} 已有服务在应答${pid ? `（PID ${pid}）` : ''}。`)
  console.log('多半是上一次的 dev server 还在后台跑。先结束它，或者换个端口：')
  if (pid) console.log(`  Stop-Process -Id ${pid} -Force`)
  console.log(`  $env:FOXCODE_DEV_PORT=${PORT + 1}; npm run dev`)
  process.exit(1)
}

if (noGpu) console.log(`软模式：Electron 追加 ${SOFT_FLAGS.join(' ')}`)

const vite = spawn(bin('vite'), ['--port', String(PORT), '--strictPort'], {
  cwd: root,
  stdio: 'inherit',
  shell: isWindows,
  env: childEnv,
})

const viteExited = new Promise((resolve) => vite.on('exit', resolve))

vite.on('exit', (code) => {
  if (shuttingDown) return
  console.error(`vite exited with code ${code}`)
  process.exit(code ?? 1)
})

/** Resolves to the URL that answered, or `null` after logging why nothing did. */
async function waitForServer(timeoutMs = 40_000) {
  const deadline = Date.now() + timeoutMs
  let lastError = 'no attempt yet'
  while (Date.now() < deadline) {
    if (vite.exitCode !== null) return null
    for (const candidate of CANDIDATES) {
      try {
        const response = await fetch(candidate, { method: 'GET' })
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

function shutdown(code) {
  if (shuttingDown) return
  shuttingDown = true
  vite.kill()
  process.exit(code)
}

process.on('SIGINT', () => shutdown(0))
process.on('SIGTERM', () => shutdown(0))

function launchElectron(devServerUrl, flags, { allowSoftRetry }) {
  const electron = spawn(electronBinary(root), [...electronFlags(), ...flags, '.'], {
    cwd: root,
    stdio: 'inherit',
    env: electronEnv({ VITE_DEV_SERVER_URL: devServerUrl }),
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
