/**
 * 项目环境（issue #72）：新建启动项时选一个项目目录，数据目录落在 <项目>/.dsh，
 * 启动时子进程在项目根里跑；顺带能从别的用户目录把已有 Profile 复制进来。
 *
 * 这里守的是三件用户看得见的事：
 *   1) 一次保存就把目录、Profile、依赖和启动项建好，不用手搬 Profile；
 *   2) 复制过来的是配置，不是历史：目标环境里没有来源会话，来源那份也不被动到；
 *   3) 子进程真的在项目根里跑（cwd），不然新会话会落在 .dsh 里。
 */
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { packumentOf, startChannelServer } from './update-channel-fixture.mjs'

/** 起得来的假 dsh，额外把 cwd 记到 DSH_HOME/cwd，用来验「子进程在项目根里跑」。 */
const recordCwdBin = (version) => `import { createServer } from 'node:http'
import { appendFileSync } from 'node:fs'
import { join } from 'node:path'
const home = process.env.DSH_HOME
appendFileSync(join(home, 'spawned'), '${version}\\n')
appendFileSync(join(home, 'cwd'), process.cwd() + '\\n')
const server = createServer((req, res) => res.end('fake dsh ${version}'))
const at = process.argv.indexOf('--port')
server.listen(at >= 0 ? Number(process.argv[at + 1]) : 0, '127.0.0.1', () => console.log('dsh web: http://127.0.0.1:' + server.address().port + '/?token=fake'))
`

const env = await startChannelServer({
  prefix: 'dsh-launch-project-',
  packument: packumentOf({ latest: '1.0.0' }, ['1.0.0']),
  installed: ['1.0.0'],
  bin: recordCwdBin,
})
test.after(() => env.cleanup())

const save = (body) => env.call('/api/launch-presets', body)
const profileFile = (home, profile, name) => join(home, 'profiles', profile, name)

/** 在某个用户目录里手造一份「已经调好的 Profile」（无依赖，省掉安装那一步）。 */
function seedProfile(home, profile, { patch = '', marker = 'source' } = {}) {
  const dir = join(home, 'profiles', profile)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'package.json'), JSON.stringify({
    name: `dsh-profile-${profile}`,
    private: true,
    marker,
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-web-app'] } },
  }, null, 2))
  if (patch) writeFileSync(join(dir, 'cordis.patch.yml'), patch)
  // 复制时要跳过的东西：真实环境里有几百 MB
  mkdirSync(join(dir, 'node_modules', 'left-pad'), { recursive: true })
  writeFileSync(join(dir, 'node_modules', 'left-pad', 'index.js'), 'module.exports = 1\n')
  return dir
}

test('项目目录：一次保存就把 <项目>/.dsh 建好，启动项记住项目目录', async () => {
  const project = join(env.root, 'projects', 'project-a')
  const result = await save({ name: '项目 A', version: '1.0.0', profile: 'work', workdir: project, ensureProfile: true })
  assert.ok(result.ok, `保存失败：HTTP ${result.status} ${JSON.stringify(result.data)}`)
  assert.equal(result.data.entry.workdir, project, '启动项要记住项目目录')
  assert.equal(result.data.entry.dshHome, join(project, '.dsh'), '数据目录固定是项目里的 .dsh')
  assert.ok(existsSync(join(project, '.dsh', 'profiles', 'work', 'package.json')), 'Profile 要建在项目的数据目录里')
  assert.ok(!existsSync(join(env.home, 'profiles', 'work')), '不能再建到全局目录去')

  const state = await env.state()
  const entry = (state.launchPresets || []).find((item) => item.id === result.data.entry.id)
  assert.equal(entry.workdir, project, '状态里也要带着项目目录')
  assert.equal(entry.dshHome, join(project, '.dsh'))
})

test('项目目录不存在时按「新建项目」处理；相对路径直接拒绝', async () => {
  const project = join(env.root, 'projects', 'fresh')
  const created = await save({ name: '新项目', version: '1.0.0', profile: 'work', workdir: project, ensureProfile: true })
  assert.ok(created.ok, `保存失败：HTTP ${created.status} ${JSON.stringify(created.data)}`)
  assert.ok(existsSync(project), '项目目录要建出来')
  assert.ok(existsSync(join(project, '.dsh', 'profiles', 'work')), '数据目录也要跟着建')

  const bad = await save({ name: '相对路径', version: '1.0.0', profile: 'work', workdir: 'projects/rel' })
  assert.equal(bad.ok, false, '相对路径不能悄悄按启动器的工作目录算')
  assert.match(String(bad.data.error), /绝对路径/)
  const state = await env.state()
  assert.ok(!(state.launchPresets || []).some((entry) => entry.name === '相对路径'), '失败的请求不能留下启动项')
})

test('从别的用户目录复制 Profile：配置过来、依赖重装、历史和 node_modules 不跟过来', async () => {
  const sourceHome = join(env.root, 'global-home')
  const patch = "- id: dsh-x-memory\n  disabled: true\n"
  seedProfile(sourceHome, 'ios-dev', { patch })
  const project = join(env.root, 'projects', 'project-b')
  const result = await save({
    name: '项目 B',
    version: '1.0.0',
    profile: 'ios-dev',
    workdir: project,
    copyFrom: { profile: 'ios-dev', home: sourceHome },
  })
  assert.ok(result.ok, `保存失败：HTTP ${result.status} ${JSON.stringify(result.data)}`)

  const target = join(project, '.dsh', 'profiles', 'ios-dev')
  const manifest = JSON.parse(readFileSync(join(target, 'package.json'), 'utf8'))
  assert.equal(manifest.name, 'dsh-profile-ios-dev', '复制出来的 Profile 要按新名字改名，别顶着来源的名字')
  assert.deepEqual(manifest.dsh.profile.bundles, ['@deepseek-ai/dsh-web-app'], '插件清单要保留')
  assert.equal(readFileSync(join(target, 'cordis.patch.yml'), 'utf8'), patch, '开关（补丁层）要原样过来')
  assert.ok(!existsSync(join(target, 'node_modules')), 'node_modules 不复制，装依赖是复制之后的事')
  assert.ok(!existsSync(join(project, '.dsh', 'sessions')), '新环境不继承来源的会话历史')

  // 来源那份不能被动到：复制是读，不是搬
  assert.ok(existsSync(join(sourceHome, 'profiles', 'ios-dev', 'node_modules', 'left-pad', 'index.js')), '来源的 node_modules 要还在')
  assert.equal(JSON.parse(readFileSync(profileFile(sourceHome, 'ios-dev', 'package.json'), 'utf8')).name, 'dsh-profile-ios-dev')
})

test('目标里已经有同名 Profile 时不再复制，别覆盖用户后来改的那份', async () => {
  const sourceHome = join(env.root, 'global-home-2')
  seedProfile(sourceHome, 'keep', { marker: 'source' })
  const project = join(env.root, 'projects', 'project-c')
  const target = join(project, '.dsh', 'profiles', 'keep')
  mkdirSync(target, { recursive: true })
  writeFileSync(join(target, 'package.json'), JSON.stringify({ name: 'dsh-profile-keep', private: true, marker: 'mine' }))

  const result = await save({
    name: '项目 C',
    version: '1.0.0',
    profile: 'keep',
    workdir: project,
    copyFrom: { profile: 'keep', home: sourceHome },
  })
  assert.ok(result.ok, `保存失败：HTTP ${result.status} ${JSON.stringify(result.data)}`)
  assert.equal(JSON.parse(readFileSync(join(target, 'package.json'), 'utf8')).marker, 'mine', '目标已有的配置不能被覆盖')
})

test('项目环境的子进程在项目根里跑（新会话不进 .dsh）', async () => {
  const project = join(env.root, 'projects', 'project-d')
  const saved = await save({ name: '项目 D', version: '1.0.0', profile: 'work', workdir: project, ensureProfile: true })
  assert.ok(saved.ok, `保存失败：HTTP ${saved.status} ${JSON.stringify(saved.data)}`)
  const id = saved.data.entry.id

  const started = await env.call('/api/start', { version: '1.0.0', profile: 'work' }, { 'x-dsh-launch-id': id })
  assert.ok(started.ok, `启动失败：HTTP ${started.status} ${JSON.stringify(started.data)}`)

  const cwdFile = join(project, '.dsh', 'cwd')
  assert.ok(existsSync(cwdFile), '子进程没留下工作目录记录，说明它没按项目环境启动')
  assert.equal(readFileSync(cwdFile, 'utf8').trim(), realpathSync(project), 'cwd 要是项目根，不是 <项目>/.dsh')
  assert.ok(existsSync(join(project, '.dsh', 'spawned')), '数据目录仍然是 <项目>/.dsh')
  await env.call('/api/stop', { version: '1.0.0', profile: 'work', home: join(project, '.dsh') }, { 'x-dsh-launch-id': id })
})

test('手工启动 / 重启（不带启动项 ID）也认得项目环境，仍按项目根跑', async () => {
  const project = join(env.root, 'projects', 'project-e')
  const saved = await save({ name: '项目 E', version: '1.0.0', profile: 'work', workdir: project, ensureProfile: true })
  assert.ok(saved.ok, `保存失败：HTTP ${saved.status} ${JSON.stringify(saved.data)}`)
  // 重启、托盘启动都不带 x-dsh-launch-id，只带目录；项目绑定挂在目录上，所以照样对得上
  const home = join(project, '.dsh')
  const headers = { 'x-dsh-home': encodeURIComponent(home) }
  const started = await env.call('/api/start', { version: '1.0.0', profile: 'work' }, headers)
  assert.ok(started.ok, `启动失败：HTTP ${started.status} ${JSON.stringify(started.data)}`)
  assert.equal(readFileSync(join(home, 'cwd'), 'utf8').trim(), realpathSync(project), '没有启动项 ID 也得按项目根跑')
  await env.call('/api/stop', { version: '1.0.0', profile: 'work', home }, headers)
})

test('settings：workdir 走绝对路径校验，坏值不留半截启动项', async () => {
  const settings = await import('../settings.js')
  assert.equal(settings.safeWorkdir(''), '')
  assert.equal(settings.safeWorkdir(undefined), '')
  assert.throws(() => settings.safeWorkdir('proj'), /绝对路径/)
  const parsed = settings.safeLaunchPresets([{
    id: 'aaaaaaaaaaaaaaaa', name: 'x', version: '1.0.0', profile: 'web', workdir: 'proj',
  }])
  assert.ok(!parsed.some((item) => item.id === 'aaaaaaaaaaaaaaaa'), '坏 workdir 的启动项整条丢掉，别留下不能用的环境')
  const kept = settings.safeLaunchPresets([{
    id: 'aaaaaaaaaaaaaaaa', name: 'x', version: '1.0.0', profile: 'web', workdir: join(env.root, 'p'),
  }])
  assert.equal(kept.find((item) => item.id === 'aaaaaaaaaaaaaaaa')?.workdir, join(env.root, 'p'))
})
