/** Ensure node-pty's Unix helper keeps the executable bit after npm extraction. */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

if (process.platform !== 'win32') {
  const scriptsDir = path.dirname(fileURLToPath(import.meta.url))
  const packageRoot = path.join(scriptsDir, '..', 'node_modules', 'node-pty')
  const helpers = []
  const prebuilds = path.join(packageRoot, 'prebuilds')
  if (fs.existsSync(prebuilds)) {
    for (const platformArch of fs.readdirSync(prebuilds)) {
      helpers.push(path.join(prebuilds, platformArch, 'spawn-helper'))
    }
  }
  helpers.push(path.join(packageRoot, 'build', 'Release', 'spawn-helper'))

  for (const helper of helpers) {
    if (!fs.existsSync(helper)) continue
    const mode = fs.statSync(helper).mode
    if ((mode & 0o111) === 0) fs.chmodSync(helper, mode | 0o755)
  }
}
