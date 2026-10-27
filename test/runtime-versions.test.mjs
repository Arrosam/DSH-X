import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  ELECTRON_VERSION,
  NODE_VERSION,
  PACKAGED,
  RUNTIME_VERSIONS,
  electronArchive,
  electronRuntime,
  installRootOf,
  isPackagedAppRoot,
  nodeArchive,
  runtimeNode,
  runtimePlatformKey,
  shellExecutable,
} from '../platform.js'

const tempRoot = () => mkdtempSync(join(realpathSync.native(tmpdir()), 'dsh-runtime-versions-'))
const SHA256_RE = /^[a-f0-9]{64}$/
let nextId = 0
const tempDir = (base) => join(base, String(nextId++))

test('runtime-versions.json 是版本与哈希的单一来源：每平台的文件名带版本、sha256 有效', () => {
  const table = JSON.parse(readFileSync(new URL('../runtime-versions.json', import.meta.url), 'utf8'))
  assert.deepEqual(table, RUNTIME_VERSIONS)
  assert.equal(table.node.version, NODE_VERSION)
  assert.equal(table.electron.version, ELECTRON_VERSION)
  assert.match(NODE_VERSION, /^\d+\.\d+\.\d+$/)
  assert.match(ELECTRON_VERSION, /^\d+\.\d+\.\d+$/)
  for (const [name, section] of Object.entries({ node: table.node, electron: table.electron })) {
    for (const [key, entry] of Object.entries(section)) {
      if (key === 'version') continue
      assert.match(key, /^(?:darwin|win32)-(?:x64|arm64)$/, `${name} 的 ${key} 要写成 平台-架构`)
      assert.ok(entry.file.includes(section.version), `${name} 的 ${key} 文件名要带版本号`)
      assert.match(entry.sha256, SHA256_RE, `${name} 的 ${key} 缺有效 sha256`)
    }
    // 两个平台三种架构：Windows 只发 x64（Electron 的 Windows arm64 包不在支持清单里）
    assert.ok(section['darwin-arm64'] && section['darwin-x64'], `${name} 缺 macOS 两种架构`)
    assert.ok(section['win32-x64'], `${name} 缺 Windows x64`)
  }
})

test('按 平台+架构 取压缩包；没收录的组合返回 null（页面据此说「不支持」而不是硬下错包）', () => {
  assert.equal(runtimePlatformKey('darwin', 'arm64'), 'darwin-arm64')
  assert.equal(electronArchive('darwin', 'arm64').file, RUNTIME_VERSIONS.electron['darwin-arm64'].file)
  assert.equal(nodeArchive('win32', 'x64').file, RUNTIME_VERSIONS.node['win32-x64'].file)
  assert.equal(electronArchive('linux', 'x64'), null)
  assert.equal(electronArchive('win32', 'arm64'), null)
})

test('electronRuntime 只认 .ready：解压到一半的目录不算装好', () => {
  const root = tempRoot()
  try {
    const appDir = tempDir(root)
    assert.equal(electronRuntime(appDir).installed, false)
    const version = ELECTRON_VERSION
    const dir = join(appDir, 'runtime', 'electron', version)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'partial'), '')
    assert.equal(electronRuntime(appDir).installed, false, '没有 .ready 就是半成品')
    writeFileSync(join(dir, '.ready'), '{}')
    assert.equal(electronRuntime(appDir).installed, true)
    // 可执行文件路径按平台推导（写 .ready 前的自检与外壳拉起用它）
    assert.equal(electronRuntime(appDir, { platform: 'darwin' }).executable, join(dir, 'Electron.app', 'Contents', 'MacOS', 'Electron'))
    assert.equal(electronRuntime(appDir, { platform: 'win32' }).executable, join(dir, 'electron.exe'))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('打包布局：<安装根>/resources/app；外壳可执行文件从安装根推出来', () => {
  assert.equal(isPackagedAppRoot('/Applications/DSH-X.app/Contents/Resources/app'), true)
  assert.equal(isPackagedAppRoot('/Applications/DSH-X.app/Contents/Resources/app/'), true)
  assert.equal(isPackagedAppRoot('C:\\Program Files\\DSH\\resources\\app'), true)
  assert.equal(isPackagedAppRoot('/Users/a/code/DSH-X'), false)
  assert.equal(isPackagedAppRoot('/Applications/DSH-X.app/Contents/Resources'), false)
  // 源码运行的 ROOT 不是 resources/app，PACKAGED 必须为假（增量更新才会退回完整安装包）
  assert.equal(PACKAGED, false)

  // 安装根是用宿主平台的 path 模块推的（真实运行时平台永远和宿主一致），所以按宿主分开断言
  if (process.platform === 'win32') {
    const winRoot = 'C:\\Program Files\\DSH\\resources\\app'
    assert.equal(installRootOf(winRoot), 'C:\\Program Files\\DSH')
    assert.equal(installRootOf('C:\\Users\\a\\DSH-X'), '')
    assert.equal(shellExecutable(winRoot, 'win32', () => true), 'C:\\Program Files\\DSH\\DSH.exe')
    assert.equal(shellExecutable(winRoot, 'win32', () => false), '', '文件不在就别返回一个起不来的路径')
  } else {
    const macRoot = '/Applications/DSH-X.app/Contents/Resources/app'
    assert.equal(installRootOf(macRoot), '/Applications/DSH-X.app/Contents')
    assert.equal(installRootOf('/Users/a/code/DSH-X'), '')
    assert.equal(shellExecutable(macRoot, 'darwin', () => true), '/Applications/DSH-X.app/Contents/MacOS/DSH')
    assert.equal(shellExecutable(macRoot, 'darwin', () => false), '', '文件不在就别返回一个起不来的路径')
    assert.equal(shellExecutable('/Users/a/code/DSH-X', 'darwin', () => true), '', '源码运行没有外壳可拉起')
  }
})

test('RUNTIME_NODE 优先用外壳下载的 node；旧布局与源码运行仍能回退', () => {
  // 原生外壳拉服务时通过 DSH_RUNTIME_NODE 指过来，这是主路径
  assert.equal(runtimeNode({ DSH_RUNTIME_NODE: '/data/runtime/node/22.19.0/bin/node' }, '/app', false), '/data/runtime/node/22.19.0/bin/node')
  // 源码运行：就是当前这个 node
  assert.equal(runtimeNode({}, '/app', false), process.execPath)
  // 过渡期 / 旧 Electron 外壳：自带 node 优先，没有就是 Electron 本体（环境变量由 RUNTIME_NODE_ENV 补）
  const root = tempRoot()
  try {
    mkdirSync(join(root, 'node'), { recursive: true })
    const bundled = join(root, 'node', process.platform === 'win32' ? 'node.exe' : 'node')
    writeFileSync(bundled, '')
    assert.equal(runtimeNode({}, root, true), bundled)
    assert.equal(runtimeNode({}, tempDir(root), true), process.execPath)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
