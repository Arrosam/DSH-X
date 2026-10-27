// 本地模拟一次「发版」，用来验收应用层增量更新（换 resources/app + 重启），不需要真的发布到 GitHub。
//
//   npm run dist                       # 先出一份 Windows 安装目录 release/DSH
//   node scripts/update-flow-demo.mjs
//
// 做三件事：
// 1. 用当前打包产物（release/DSH/resources/app）造一套「当前版本」的 app 资产，
//    再复制一份把版本号改成 0.1.21，造一套「新版本」资产（有 release/release-key.pem 就签名）
// 2. 在 8899 起一个静态服务器，把这个目录当发布页
// 3. 把 release/DSH 拷成 release/test-install/，让你在副本上验证，不弄脏真安装目录
//
// 然后按打印出来的命令启动 test-install/DSH.exe：管理器里点「更新」应看到 0.1.21，
// 走增量下载 → 切换 → 重启，版本号变成 0.1.21。
// 运行时（Node / Electron）不在这条链路里：它们放在每用户数据目录，更新只换 app 层。

import { createServer } from 'node:http'
import { createReadStream, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { cp } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { buildAppAssets } from './app-manifest.mjs'

const ROOT = join(import.meta.dirname, '..')
const RELEASE = join(ROOT, 'release')
const INSTALL = join(RELEASE, 'DSH')
const APP_SOURCE = join(INSTALL, 'resources', 'app')
const TEST_RELEASE = join(RELEASE, 'test-release')
const TEST_INSTALL = join(RELEASE, 'test-install')
const PORT = 8899
const CURRENT = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version
const NEXT = '0.1.21'

async function buildAssets() {
  if (!existsSync(APP_SOURCE)) throw new Error(`缺少 ${APP_SOURCE}：先跑一次 npm run dist（Windows）`)
  rmSync(TEST_RELEASE, { recursive: true, force: true })
  mkdirSync(TEST_RELEASE, { recursive: true })
  // 当前版本：用刚打出来的 app 原样出一套，和 release/DSH 里的内容一致
  const now = await buildAppAssets({ appDir: APP_SOURCE, version: CURRENT, platform: 'win', outDir: TEST_RELEASE })
  console.log(`当前版本资产：${basename(now.zipPath)}（${(now.manifest.archive.size / 1048576).toFixed(1)} MB）`)

  // 假 0.1.21：拿当前 app 复制一份，只改版本号（界面上能看出来更新成功）
  const staged = join(RELEASE, 'test-app-src')
  rmSync(staged, { recursive: true, force: true })
  await cp(APP_SOURCE, staged, { recursive: true })
  const pkgPath = join(staged, 'package.json')
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
  pkg.version = NEXT
  writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`)
  const next = await buildAppAssets({ appDir: staged, version: NEXT, platform: 'win', outDir: TEST_RELEASE })
  console.log(`新版本资产：${basename(next.zipPath)}（${(next.manifest.archive.size / 1048576).toFixed(1)} MB）`)
  rmSync(staged, { recursive: true, force: true })
  if (!next.sigPath) {
    console.log('')
    console.log('注意：没有 release/release-key.pem，清单没签名，客户端不会走增量更新（会回退完整安装包）。')
    console.log('要验证增量：node scripts/release-manifest.mjs keygen，再重跑本脚本与 npm run dist。')
  }
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

/** 在副本上验证更新：真安装目录被换掉时不好恢复，也不好继续做别的验证。 */
async function prepareInstall() {
  rmSync(TEST_INSTALL, { recursive: true, force: true })
  await cp(INSTALL, TEST_INSTALL, { recursive: true })
  console.log(`测试安装目录：${TEST_INSTALL}`)
}

await buildAssets()
const server = serve()
await prepareInstall()
console.log('')
console.log('启动测试安装（DSH_UPDATE_* 是本地测试通道，指向本脚本起的发布页）：')
console.log(`  DSH_UPDATE_BASE=http://127.0.0.1:${PORT} DSH_UPDATE_VERSION=${NEXT} "${join(TEST_INSTALL, 'DSH.exe')}"`)
console.log('')
console.log(`管理器里点「更新」应看到 ${NEXT}：下载 app 整包 → 校验 → 替换 resources/app → 重启，版本号变成 ${NEXT}。`)
console.log('测试完 Ctrl+C 结束本地发布页。')
void server
