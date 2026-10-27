// 本地模拟一次「发版」，用来验收应用层增量更新，不需要真的发布到 GitHub。
//
//   node scripts/update-flow-demo.mjs
//
// 做三件事：
// 1. 用构建产物（Windows：release/DSH；macOS：release/DSH-X.app）造一套「0.1.21」的假发布资产，
//    放进 release/test-release/
// 2. 在 8899 起静态服务器，把这个目录当发布页
// 3. 把构建产物复制成 release/test-install，更新只改这份副本，不动构建产物
//
// 然后按打印出来的命令启动测试安装：管理器里点更新，走
// 下载 → 替换 resources/app（mac 还会重签 .app）→ 重启，版本号变成 0.1.21。
// Electron 版本变化时不再单独下 runtime，管理器会回退到完整安装包自更新。
//
// macOS 也可以跳过 npm run dist，直接用现成的包：
//   DSH_DEMO_APP=/Applications/DSH-X.app node scripts/update-flow-demo.mjs
// 增量只对 ad-hoc / 未签名的包开放；固定证书签名的包会回退完整安装包。

import { spawnSync } from 'node:child_process'
import { createServer } from 'node:http'
import { createReadStream, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { cp, mkdir, readFile } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import { buildAppAssets } from './app-manifest.mjs'
import { testReleaseKeyPem } from './test-release-key.mjs'

const ROOT = join(import.meta.dirname, '..')
const RELEASE = join(ROOT, 'release')
const TEST_RELEASE = join(RELEASE, 'test-release')
const TEST_INSTALL = join(RELEASE, 'test-install')
const PORT = 8899
const CURRENT = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version
const NEXT = '0.1.21'
const electronVersion = JSON.parse(await readFile(join(ROOT, 'node_modules', 'electron', 'package.json'), 'utf8')).version
const IS_MAC = process.platform === 'darwin'
const PLATFORM = IS_MAC ? 'mac' : 'win'
// 也可以用 DSH_DEMO_APP 指向已安装的 .app（例如从 CI artifact 里解出来的），省掉一次 npm run dist
const BUNDLE = resolve(String(process.env.DSH_DEMO_APP || '').trim() || join(RELEASE, 'DSH-X.app'))
const APP = IS_MAC ? join(BUNDLE, 'Contents', 'Resources', 'app') : join(RELEASE, 'DSH', 'resources', 'app')
const TEST_APP = IS_MAC ? join(TEST_INSTALL, 'DSH-X.app') : join(TEST_INSTALL, 'DSH.exe')
const LAUNCH = IS_MAC ? join(TEST_APP, 'Contents', 'MacOS', 'DSH') : TEST_APP

async function buildAssets() {
  if (!existsSync(APP)) throw new Error(`缺少 ${APP}：先跑一次 npm run dist（mac 也可以用 DSH_DEMO_APP 指向现成的 .app）`)
  rmSync(TEST_RELEASE, { recursive: true, force: true })
  await mkdir(TEST_RELEASE, { recursive: true })
  // 假 0.1.21：拿构建产物里的 app 复制一份，改版本号（界面上能看出来更新成功）
  const staged = join(RELEASE, 'test-app-src')
  rmSync(staged, { recursive: true, force: true })
  await cp(APP, staged, { recursive: true })
  const pkgPath = join(staged, 'package.json')
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
  pkg.version = NEXT
  writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`)
  const assets = await buildAppAssets({ appDir: staged, version: NEXT, electronVersion, platform: PLATFORM, outDir: TEST_RELEASE, privateKeyPem: testReleaseKeyPem() })
  console.log(`假发布资产：${basename(assets.zipPath)}（${(assets.manifest.archive.size / 1048576).toFixed(1)} MB）`)
}

function serve() {
  const server = createServer((req, res) => {
    const name = basename(decodeURIComponent(String(req.url || '/').split('?')[0]))
    try {
      const file = join(TEST_RELEASE, name)
      const stat = statSync(file)
      res.writeHead(200, { 'content-length': stat.size })
      createReadStream(file).pipe(res)
    } catch {
      res.writeHead(404)
      res.end()
    }
  })
  server.on('error', (error) => {
    if (error.code === 'EADDRINUSE') console.log(`端口 ${PORT} 已在用，沿用现有服务`)
    else throw error
  })
  server.listen(PORT, '127.0.0.1', () => console.log(`测试发布页：http://127.0.0.1:${PORT}/`))
  return server
}

async function prepareInstall() {
  if (!existsSync(APP)) throw new Error(`缺少 ${APP}：先跑一次 npm run dist（mac 也可以用 DSH_DEMO_APP 指向现成的 .app）`)
  rmSync(TEST_INSTALL, { recursive: true, force: true })
  await mkdir(TEST_INSTALL, { recursive: true })
  if (IS_MAC) {
    // ditto 保留符号链接、权限和扩展属性；.app 的 Frameworks 里有符号链接，cp 容易弄丢
    const result = spawnSync('ditto', [BUNDLE, TEST_APP], { stdio: 'inherit' })
    if (result.status !== 0) throw new Error('ditto 复制 .app 失败')
  } else {
    await cp(join(RELEASE, 'DSH'), TEST_INSTALL, { recursive: true })
  }
  console.log(`测试安装目录：${TEST_INSTALL}`)
}

await buildAssets()
const server = serve()
await prepareInstall()
console.log('')
console.log(`启动测试安装（当前 ${CURRENT}），管理器里点更新应看到 ${NEXT}：`)
console.log(`  DSH_UPDATE_BASE=http://127.0.0.1:${PORT} DSH_UPDATE_VERSION=${NEXT} "${LAUNCH}"`)
if (IS_MAC) console.log('  （先退出已安装的 DSH-X：测试副本的 bundle id 相同，单实例锁会把它拦下）')
console.log('')
console.log('点「更新到 0.1.21」：只下载 app 增量 → 替换 resources/app → 重启，版本号应变成 0.1.21。')
console.log('Electron 版本变化时不会再单独下 runtime，管理器会回退到完整安装包自更新。')
console.log('测试完 Ctrl+C 结束本地发布页。')
void server
