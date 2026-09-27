#!/usr/bin/env node
/**
 * Renders the 灵狐 mark (scripts/fox-icon.html) to PNG so it can be used as the
 * Electron window icon and as the page favicon, and assembles a multi-size
 * Windows .ico for packaging.
 *
 *   node scripts/icon.mjs
 *
 * Writes desktop/build/icon.png (window/taskbar), desktop/public/icon.png
 * (favicon, copied into dist/ by Vite) and desktop/build/icon.ico (installer /
 * shortcut icon). All three are committed, so this only needs to be re-run
 * after the mark changes.
 */
import { app, BrowserWindow, nativeImage } from 'electron'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')
const SIZE = 512
const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256]

app.commandLine.appendSwitch('no-sandbox')
app.commandLine.appendSwitch('disable-gpu')
app.disableHardwareAcceleration()

/**
 * Minimal ICO container writer: ICONDIR + one ICONDIRENTRY per image, then the
 * image payloads. Every payload is a PNG, which Windows has accepted since
 * Vista — no BMP/DIB encoding (and no extra dependency) required.
 */
function buildIco(images) {
  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0) // reserved
  header.writeUInt16LE(1, 2) // 1 = icon
  header.writeUInt16LE(images.length, 4)

  const directory = Buffer.alloc(16 * images.length)
  let offset = header.length + directory.length
  images.forEach(({ size, data }, index) => {
    const at = index * 16
    directory.writeUInt8(size >= 256 ? 0 : size, at + 0) // 0 means 256
    directory.writeUInt8(size >= 256 ? 0 : size, at + 1)
    directory.writeUInt8(0, at + 2) // palette size (true colour)
    directory.writeUInt8(0, at + 3) // reserved
    directory.writeUInt16LE(1, at + 4) // colour planes
    directory.writeUInt16LE(32, at + 6) // bits per pixel
    directory.writeUInt32LE(data.length, at + 8)
    directory.writeUInt32LE(offset, at + 12)
    offset += data.length
  })

  return Buffer.concat([header, directory, ...images.map((image) => image.data)])
}

async function main() {
  await app.whenReady()

  const win = new BrowserWindow({
    width: SIZE,
    height: SIZE,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    webPreferences: { offscreen: false, sandbox: true },
  })

  await win.loadFile(path.join(here, 'fox-icon.html'))
  // Let the SVG paint before the grab.
  await new Promise((resolve) => setTimeout(resolve, 350))

  const shot = await win.webContents.capturePage()
  const png = shot.resize({ width: SIZE, height: SIZE, quality: 'best' }).toPNG()

  const targets = [path.join(root, 'build', 'icon.png'), path.join(root, 'public', 'icon.png')]
  for (const file of targets) {
    await mkdir(path.dirname(file), { recursive: true })
    await writeFile(file, png)
    console.log(`icon written: ${file} (${png.length} bytes)`)
  }

  const source = nativeImage.createFromBuffer(png)
  const frames = ICO_SIZES.map((size) => ({
    size,
    data: source.resize({ width: size, height: size, quality: 'best' }).toPNG(),
  }))
  const ico = buildIco(frames)
  const icoPath = path.join(root, 'build', 'icon.ico')
  await writeFile(icoPath, ico)
  console.log(
    `icon written: ${icoPath} (${ico.length} bytes, sizes ${ICO_SIZES.join('/')})`,
  )

  win.destroy()
  app.quit()
}

main().catch((error) => {
  console.error(`icon render failed: ${error}`)
  app.exit(1)
})
