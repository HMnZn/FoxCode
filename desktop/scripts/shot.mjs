/**
 * Headless screenshot harness.
 *
 *   node scripts/shot.mjs [outputPath] [--no-build] [--delay=ms] [--click="<text>[+<text>…]"]
 *
 * Builds the renderer (unless --no-build), then launches Electron with
 * FOXCODE_SHOT set so `electron/main.js` captures the real window and exits.
 * `--click` clicks, in order, the first button containing each `+`-separated
 * text (e.g. a starter card, then the send button) so the PNG can show a live
 * run instead of the empty state. Used to verify the UI without a human at the
 * keyboard.
 *
 * Restricted environments that cannot start the Chromium sandbox need
 * `FOXCODE_ELECTRON_FLAGS="--no-sandbox --disable-gpu"`.
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { electronBinary, electronEnv, electronFlags } from './electron-bin.mjs'

const root = process.cwd()
const isWindows = process.platform === 'win32'
const args = process.argv.slice(2)
const flags = new Set(args.filter((arg) => arg.startsWith('--')))
const positional = args.filter((arg) => !arg.startsWith('--'))
const target = positional[0] ?? path.join('artifacts', 'foxcode-studio.png')
const delayFlag = args.find((arg) => arg.startsWith('--delay='))
const delay = delayFlag ? Number(delayFlag.split('=')[1]) : 2600
const clickFlag = args.find((arg) => arg.startsWith('--click='))
const click = clickFlag ? clickFlag.slice('--click='.length) : undefined

const bin = (name) => path.join(root, 'node_modules', '.bin', isWindows ? `${name}.cmd` : name)

function run(command, commandArgs, env, shell = isWindows) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, commandArgs, {
      cwd: root,
      stdio: 'inherit',
      shell,
      env: electronEnv(env),
    })
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${command} exited ${code}`))))
    child.on('error', reject)
  })
}

if (!flags.has('--no-build')) {
  console.log('building renderer…')
  await run(bin('vite'), ['build', '--logLevel', 'warn'], {})
}

if (!fs.existsSync(path.join(root, 'dist', 'index.html'))) {
  console.error('dist/index.html is missing; run without --no-build')
  process.exit(1)
}

fs.mkdirSync(path.dirname(path.resolve(root, target)), { recursive: true })

await run(
  electronBinary(root),
  [...electronFlags(), '.'],
  {
    FOXCODE_SHOT: target,
    FOXCODE_SHOT_DELAY: String(delay),
    ...(click ? { FOXCODE_SHOT_CLICK: click } : {}),
  },
  false,
)

const resolved = path.resolve(root, target)
if (!fs.existsSync(resolved)) {
  console.error(`screenshot was not written: ${resolved}`)
  process.exit(1)
}
console.log(`screenshot ready: ${resolved}`)
