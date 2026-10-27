// 本地模拟一次「核心发版」，验收 npm 核心包更新，不需要真的发布到 npm。
//
//   node scripts/update-flow-demo.mjs
//
// 做三件事：
// 1. 用 release/DSH/resources/app 打一份「0.1.21」的假核心 tarball，放进 release/test-release/
// 2. 在 8899 起一个假的 npm registry（元数据 + tarball），客户端用 DSH_CORE_REGISTRY 指过来
// 3. 把 release/DSH 复制成 release/test-install，更新只改这份副本
//
// 然后按打印出来的命令启动测试安装：管理器里点更新，走
// 查 npm 元数据 → 下载 tarball → sha512 校验 → 解压 → 换 resources/app → 重启。

import { spawnSync } from 'node:child_process'
import { createServer } from 'node:http'
import { createReadStream, existsSync, mkdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { cp, mkdir, readFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { buildCorePackage } from './pack-core.mjs'

const ROOT = join(import.meta.dirname, '..')
const RELEASE = join(ROOT, 'release')
const TEST_RELEASE = join(RELEASE, 'test-release')
const TEST_INSTALL = join(RELEASE, 'test-install')
const PORT = 8899
const CURRENT = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version
const NEXT = '0.1.21'
const IS_MAC = process.platform === 'darwin'
const APP = IS_MAC
  ? join(RELEASE, 'DSH-X.app', 'Contents', 'Resources', 'app')
  : join(RELEASE, 'DSH', 'resources', 'app')
const TEST_APP = IS_MAC ? join(TEST_INSTALL, 'DSH-X.app') : join(TEST_INSTALL, 'DSH.exe')
const LAUNCH = IS_MAC ? join(TEST_APP, 'Contents', 'MacOS', 'DSH') : TEST_APP
const electronVersion = JSON.parse(await readFile(join(ROOT, 'node_modules', 'electron', 'package.json'), 'utf8')).version
const PACKAGE = process.env.DSH_CORE_PACKAGE || (IS_MAC ? 'dsh-x-core-mac' : 'dsh-x-core-win')

let metadata = null
let tarballName = ''

async function buildAssets() {
  if (!existsSync(join(APP, 'server.js'))) throw new Error(`缺少 ${APP}，先跑一次 npm run dist`)
  rmSync(TEST_RELEASE, { recursive: true, force: true })
  await mkdir(TEST_RELEASE, { recursive: true })
  const core = await buildCorePackage({ appDir: APP, version: NEXT, outDir: TEST_RELEASE, name: PACKAGE, electronVersion })
  tarballName = basename(core.tgzPath)
  metadata = {
    name: PACKAGE,
    'dist-tags': { latest: NEXT },
    versions: {
      [NEXT]: {
        name: PACKAGE,
        version: NEXT,
        dist: {
          tarball: `http://127.0.0.1:${PORT}/${tarballName}`,
          integrity: core.integrity,
          shasum: core.shasum,
          unpackedSize: 0,
        },
        dshX: { electron: electronVersion },
      },
    },
  }
  console.log(`假核心包：${tarballName}（${(core.size / 1048576).toFixed(1)} MB）`)
}

function serve() {
  const server = createServer((req, res) => {
    const name = basename(decodeURIComponent(String(req.url || '/').split('?')[0]))
    if (name === PACKAGE) {
      const body = Buffer.from(JSON.stringify(metadata))
      res.writeHead(200, { 'content-type': 'application/json', 'content-length': body.length })
      res.end(body)
      return
    }
    try {
      const file = join(TEST_RELEASE, name)
      const stat = statSync(file)
      if (!stat.isFile()) throw new Error('not a file')
      res.writeHead(200, { 'content-length': stat.size })
      createReadStream(file).on('error', () => res.destroy()).pipe(res)
    } catch {
      res.writeHead(404)
      res.end()
    }
  })
  server.on('error', (error) => {
    if (error.code === 'EADDRINUSE') console.log(`端口 ${PORT} 已在用，沿用现有服务`)
    else throw error
  })
  server.listen(PORT, '127.0.0.1', () => console.log(`假 npm registry：http://127.0.0.1:${PORT}/`))
  return server
}

async function prepareInstall() {
  if (!existsSync(join(APP, 'server.js'))) throw new Error(`缺少 ${APP}，先跑一次 npm run dist`)
  rmSync(TEST_INSTALL, { recursive: true, force: true })
  await mkdir(TEST_INSTALL, { recursive: true })
  if (IS_MAC) {
    const bundle = join(RELEASE, 'DSH-X.app')
    const result = spawnSync('ditto', [bundle, TEST_APP], { stdio: 'inherit' })
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
console.log(`  DSH_CORE_REGISTRY=http://127.0.0.1:${PORT} "${LAUNCH}"`)
console.log('')
console.log('点「更新到 0.1.21」：查 npm 元数据 → 下载核心 tarball → sha512 校验 → 换 resources/app → 重启。')
console.log('Electron 版本变化时核心包会拒绝，管理器回退到完整安装包。')
console.log('测试完 Ctrl+C 结束本地 registry。')
void server
