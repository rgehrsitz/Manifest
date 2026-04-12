#!/usr/bin/env node

import { execFileSync } from 'child_process'
import { existsSync, readdirSync, readFileSync, statSync } from 'fs'
import { join, resolve } from 'path'

import { listPackage } from '@electron/asar'
import plist from 'plist'

const ROOT_DIR = resolve(new URL('..', import.meta.url).pathname)
const DIST_DIR = join(ROOT_DIR, 'dist')
const REQUIRED_ASSETS = [
  join(ROOT_DIR, 'resources', 'manifest.svg'),
  join(ROOT_DIR, 'resources', 'icon.png'),
  join(ROOT_DIR, 'resources', 'icon.icns'),
  join(ROOT_DIR, 'resources', 'icon.ico'),
]

function assert(condition, message) {
  if (!condition) {
    throw new Error(message)
  }
}

function ensureFile(path) {
  assert(existsSync(path), `Missing required file: ${path}`)
  assert(statSync(path).size > 0, `File is empty: ${path}`)
}

function run(command, args, env = {}) {
  execFileSync(command, args, {
    cwd: ROOT_DIR,
    env: {
      ...process.env,
      ...env,
    },
    stdio: 'inherit',
  })
}

function findBundle(startDir, suffix) {
  const stack = [startDir]

  while (stack.length > 0) {
    const current = stack.pop()
    if (!current || !existsSync(current)) continue

    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const fullPath = join(current, entry.name)
      if (entry.isDirectory()) {
        if (entry.name.endsWith(suffix)) return fullPath
        stack.push(fullPath)
      }
    }
  }

  return null
}

function buildHostPackage() {
  run('bun', ['run', 'rebuild:native:electron'])
  run('bun', ['run', 'build'])

  const args = ['--publish', 'never', '--dir']
  const env = {}

  if (process.platform === 'darwin') {
    args.unshift('-c.mac.identity=null')
    args.unshift('--mac')
    env.CSC_IDENTITY_AUTO_DISCOVERY = 'false'
  }
  else if (process.platform === 'win32') args.unshift('--win')
  else args.unshift('--linux')

  run(join(ROOT_DIR, 'node_modules', '.bin', 'electron-builder'), args, env)
}

function verifyMacBundle() {
  const appBundle = findBundle(DIST_DIR, '.app')
  assert(appBundle, `Could not find a packaged .app bundle under ${DIST_DIR}`)

  const infoPlistPath = join(appBundle, 'Contents', 'Info.plist')
  ensureFile(infoPlistPath)

  const info = plist.parse(readFileSync(infoPlistPath, 'utf8'))
  assert(info.CFBundleDisplayName === 'Manifest' || info.CFBundleName === 'Manifest', 'Packaged app bundle is not branded as Manifest')

  const iconBaseName = String(info.CFBundleIconFile ?? 'Manifest')
  const iconFileName = iconBaseName.endsWith('.icns') ? iconBaseName : `${iconBaseName}.icns`
  ensureFile(join(appBundle, 'Contents', 'Resources', iconFileName))

  const asarPath = join(appBundle, 'Contents', 'Resources', 'app.asar')
  ensureFile(asarPath)

  const asarEntries = new Set(listPackage(asarPath))
  assert(
    asarEntries.has('/resources/icon.png') || asarEntries.has('resources/icon.png'),
    'Packaged app.asar is missing resources/icon.png for runtime icon usage'
  )
  assert(
    asarEntries.has('/out/renderer/favicon.png') || asarEntries.has('out/renderer/favicon.png'),
    'Packaged app.asar is missing the branded favicon asset'
  )
}

function verifyWindowsBundle() {
  const unpackedDir = join(DIST_DIR, 'win-unpacked')
  assert(existsSync(unpackedDir), `Could not find Windows unpacked output at ${unpackedDir}`)
  ensureFile(join(unpackedDir, 'Manifest.exe'))
}

function verifyLinuxBundle() {
  const appImage = readdirSync(DIST_DIR).find((entry) => entry.endsWith('.AppImage'))
  assert(appImage, `Could not find Linux AppImage output under ${DIST_DIR}`)
  ensureFile(join(DIST_DIR, appImage))
}

function main() {
  REQUIRED_ASSETS.forEach(ensureFile)
  buildHostPackage()

  if (process.platform === 'darwin') verifyMacBundle()
  else if (process.platform === 'win32') verifyWindowsBundle()
  else verifyLinuxBundle()

  console.log(`Verified packaged branding assets for ${process.platform}`)
}

main()
