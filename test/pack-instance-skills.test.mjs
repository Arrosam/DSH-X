/**
 * 整合包技能跟着实例走：home/skills/** 装进 profiles/<实例>/skills/，补丁层挂一行只扫这个目录的
 * skill-filesystem；同一用户目录下的两个实例互不看到对方的技能，卸载 / 迁移 / 导出语义都对。
 */
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

import { writeZip } from '../src/zip.js'
import {
  INSTANCE_SKILLS_ROW,
  applyInstall,
  exportPack,
  hasInstanceSkillsRow,
  legacyPackSkills,
  migratePackSkills,
  parsePackArchive,
  parsePackDir,
  planInstall,
  readPackState,
  rememberPack,
  replacePack,
  uninstallPack,
  withInstanceSkillsRow,
} from '../src/packs.js'
import { insertedIds } from '../src/plugins.js'
import { listSkills, skillRoots } from '../src/skills.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const WORKBENCH = join(ROOT, 'src', 'packs', 'dsh-x-workbench')

function tempDir(prefix = 'dsh-inst-skills-') {
  return mkdtempSync(join(tmpdir(), prefix))
}

function makePack({ manifest = {}, entries = [] } = {}) {
  return parsePackArchive(writeZip([
    { name: 'dspack.json', data: JSON.stringify({ format: 'dspack', version: 3 }) },
    {
      name: 'manifest.json',
      data: JSON.stringify({
        manifestVersion: 5,
        type: 'profile',
        name: 'demo',
        version: '1.0.0',
        profileName: 'demo',
        bundles: ['dsh-cost-meter'],
        dependencies: { 'dsh-cost-meter': '1.7.37' },
        ...manifest,
      }),
    },
    { name: 'package.json', data: '{"name":"dsh-profile-demo","private":true}\n' },
    ...entries,
  ]))
}

const SKILL = (name) => `---\nname: ${name}\ndescription: ${name} 技能\n---\n正文\n`

async function install(home, dataDir, pack, profile) {
  const plan = planInstall(pack, { home, profile })
  assert.equal(plan.ok, true, plan.errors.join('；'))
  const result = await applyInstall(plan, { home, dataDir, pack })
  rememberPack(dataDir, result.record)
  return { plan, record: result.record }
}

function instanceSkillNames(home, profile) {
  const roots = skillRoots(home, { profileDir: join(home, 'profiles', profile) }).filter((root) => root.key === 'instance')
  return listSkills(roots).map((skill) => `${skill.root}:${skill.dirName}`).sort()
}

// ---- 补丁层那一行 ----

test('实例技能行：空文件、模板 [] 占位、注释、条目列表都能挂；行内数组拒绝', () => {
  const empty = withInstanceSkillsRow('')
  assert.equal(empty.ok, true)
  assert.equal(empty.changed, true)
  assert.ok(hasInstanceSkillsRow(empty.text))

  const placeholder = withInstanceSkillsRow('# 你的补丁层\n[]\n')
  assert.equal(placeholder.ok, true)
  assert.match(placeholder.text, /^# 你的补丁层\n# \[\]\n/, '模板 [] 注释掉，不和块状条目混写')
  assert.ok(!/^\[\]$/m.test(placeholder.text))

  const list = withInstanceSkillsRow('- id: x\n  disabled: true')
  assert.equal(list.ok, true)
  assert.ok(list.text.startsWith('- id: x\n  disabled: true\n'), '原有内容一字不改')
  assert.deepEqual(insertedIds(list.text), [INSTANCE_SKILLS_ROW], '插件页按 insert 块认得出这一行')
  assert.match(list.text, /includeDefaultRoots: false/, '不重复扫 DSH_HOME / 项目根')
  assert.match(list.text, /new URL\('skills\/', baseUrl\)/, '路径相对 profile 目录现算，不写死绝对路径')

  const again = withInstanceSkillsRow(list.text)
  assert.equal(again.changed, false, '已经挂过就不重复挂')
  assert.equal(again.text, list.text)

  const flow = withInstanceSkillsRow('[{ id: x, disabled: true }]\n')
  assert.equal(flow.ok, false)
  assert.match(flow.reason, /行内数组/)
})

// ---- 安装计划 ----

test('安装计划：包没带补丁层时把那一行挂在现有补丁层上，技能写进实例', () => {
  const home = tempDir()
  mkdirSync(join(home, 'profiles', 'demo'), { recursive: true })
  writeFileSync(join(home, 'profiles', 'demo', 'cordis.patch.yml'), '- id: mine\n  disabled: true\n')
  const pack = makePack({ entries: [{ name: 'home/skills/a/SKILL.md', data: SKILL('a') }] })
  const plan = planInstall(pack, { home, profile: 'demo' })
  assert.equal(plan.ok, true)
  const patch = plan.writes.find((write) => write.rel === 'profiles/demo/cordis.patch.yml')
  assert.ok(patch, '要动补丁层')
  assert.ok(patch.data.startsWith('- id: mine\n  disabled: true\n'), '用户原来的补丁行留着')
  assert.ok(hasInstanceSkillsRow(patch.data))
  assert.equal(plan.writes.find((write) => write.rel === 'profiles/demo/skills/a/SKILL.md')?.kind, 'skill')
  assert.ok(plan.notes.some((note) => note.kind === 'instance-skills' && note.skills.includes('a')))
})

test('安装计划：包自带补丁层时挂在包的补丁层后面', () => {
  const home = tempDir()
  const pack = makePack({
    entries: [
      { name: 'overrides/cordis.patch.yml', data: '- id: from-pack\n  disabled: true\n' },
      { name: 'home/skills/a/SKILL.md', data: SKILL('a') },
    ],
  })
  const plan = planInstall(pack, { home, profile: 'demo' })
  const patch = plan.writes.find((write) => write.rel === 'profiles/demo/cordis.patch.yml')
  assert.ok(patch.data.startsWith('- id: from-pack\n'))
  assert.ok(hasInstanceSkillsRow(patch.data))
})

test('安装计划：新包没带技能、但实例里已有上一个包的技能，换补丁层时那一行照挂', () => {
  const home = tempDir()
  mkdirSync(join(home, 'profiles', 'demo', 'skills', 'old'), { recursive: true })
  writeFileSync(join(home, 'profiles', 'demo', 'skills', 'old', 'SKILL.md'), SKILL('old'))
  const pack = makePack({ entries: [{ name: 'overrides/cordis.patch.yml', data: '- id: from-pack\n  disabled: true\n' }] })
  const plan = planInstall(pack, { home, profile: 'demo' })
  const patch = plan.writes.find((write) => write.rel === 'profiles/demo/cordis.patch.yml')
  assert.ok(hasInstanceSkillsRow(patch.data), '否则旧技能会悄悄不加载')
})

test('安装计划：没有技能也没有旧技能时完全不碰补丁层', () => {
  const home = tempDir()
  mkdirSync(join(home, 'profiles', 'demo'), { recursive: true })
  writeFileSync(join(home, 'profiles', 'demo', 'cordis.patch.yml'), '- id: mine\n  disabled: true\n')
  const plan = planInstall(makePack(), { home, profile: 'demo' })
  assert.ok(!plan.writes.some((write) => write.rel === 'profiles/demo/cordis.patch.yml'))
})

test('安装计划：现有补丁层是行内数组时拒装，不写坏', () => {
  const home = tempDir()
  mkdirSync(join(home, 'profiles', 'demo'), { recursive: true })
  writeFileSync(join(home, 'profiles', 'demo', 'cordis.patch.yml'), '[{ id: x, disabled: true }]\n')
  const plan = planInstall(makePack({ entries: [{ name: 'home/skills/a/SKILL.md', data: SKILL('a') }] }), { home, profile: 'demo' })
  assert.equal(plan.ok, false)
  assert.match(plan.errors.join(), /行内数组/)
})

test('dshhome 形态：技能装进每个声明的 profile，不进 DSH_HOME', () => {
  const home = tempDir()
  const pack = parsePackArchive(writeZip([
    { name: 'dspack.json', data: JSON.stringify({ format: 'dspack', version: 3 }) },
    {
      name: 'manifest.json',
      data: JSON.stringify({
        manifestVersion: 5,
        type: 'dshhome',
        name: 'whole-home',
        version: '1.0.0',
        profiles: {
          work: { bundles: ['dsh-cost-meter'], dependencies: { 'dsh-cost-meter': '1.7.37' } },
          play: { bundles: ['dsh-meme'], dependencies: { 'dsh-meme': '1.0.0' } },
        },
      }),
    },
    { name: 'profiles/work/cordis.patch.yml', data: '- id: w\n  disabled: true\n' },
    { name: 'home/skills/a/SKILL.md', data: SKILL('a') },
  ]))
  const plan = planInstall(pack, { home, profile: 'ignored' })
  assert.equal(plan.ok, true, plan.errors.join())
  const rels = plan.writes.map((write) => write.rel)
  assert.ok(rels.includes('profiles/work/skills/a/SKILL.md'))
  assert.ok(rels.includes('profiles/play/skills/a/SKILL.md'))
  assert.ok(!rels.includes('skills/a/SKILL.md'))
  const work = plan.writes.find((write) => write.rel === 'profiles/work/cordis.patch.yml').data
  assert.ok(work.startsWith('- id: w\n'), 'profile 自带的补丁层还在')
  assert.ok(hasInstanceSkillsRow(work))
  assert.ok(hasInstanceSkillsRow(plan.writes.find((write) => write.rel === 'profiles/play/cordis.patch.yml').data))
})

// ---- 端到端：内置的 dsh-x-workbench ----

test('dsh-x-workbench：装进 workbench 后技能只在这个实例里，同一 DSH_HOME 的另一个实例看不到', async () => {
  const home = tempDir()
  const dataDir = tempDir('dsh-inst-data-')
  // 另一个实例：先有一份自己的补丁层
  mkdirSync(join(home, 'profiles', 'web'), { recursive: true })
  writeFileSync(join(home, 'profiles', 'web', 'package.json'), '{"name":"dsh-profile-web","private":true}\n')
  writeFileSync(join(home, 'profiles', 'web', 'cordis.patch.yml'), '[]\n')

  const pack = parsePackDir(WORKBENCH)
  assert.equal(pack.ok, true, pack.errors.join())
  const { record } = await install(home, dataDir, pack, 'workbench')

  assert.deepEqual(instanceSkillNames(home, 'workbench'), ['instance:agent-browser', 'instance:electron'])
  assert.deepEqual(instanceSkillNames(home, 'web'), [], '另一个实例什么都看不到')
  assert.equal(existsSync(join(home, 'skills')), false, 'DSH_HOME/skills 一个文件都没写')
  assert.ok(existsSync(join(home, 'profiles', 'workbench', 'skills', 'agent-browser', 'references', 'commands.md')), '技能的参考文档也跟过去')
  assert.ok(hasInstanceSkillsRow(readFileSync(join(home, 'profiles', 'workbench', 'cordis.patch.yml'), 'utf8')))
  assert.equal(readFileSync(join(home, 'profiles', 'web', 'cordis.patch.yml'), 'utf8'), '[]\n', '另一个实例的补丁层不动')
  assert.ok(record.files.every((item) => !item.rel.startsWith('skills/')))

  // 卸载：技能连同空目录一起清掉
  uninstallPack(record, { home })
  assert.equal(existsSync(join(home, 'profiles', 'workbench', 'skills')), false)
  assert.deepEqual(instanceSkillNames(home, 'workbench'), [])
})

test('卸载：技能文件删掉、补丁层回到装包前（同一实例里用户自己的技能不动）', async () => {
  const home = tempDir()
  const dataDir = tempDir('dsh-inst-data-')
  const profileDir = join(home, 'profiles', 'demo')
  mkdirSync(join(profileDir, 'skills', 'mine'), { recursive: true })
  writeFileSync(join(profileDir, 'package.json'), '{"name":"dsh-profile-demo","private":true}\n')
  writeFileSync(join(profileDir, 'cordis.patch.yml'), '- id: mine\n  disabled: true\n')
  writeFileSync(join(profileDir, 'skills', 'mine', 'SKILL.md'), SKILL('mine'))
  const { record } = await install(home, dataDir, makePack({ entries: [{ name: 'home/skills/a/SKILL.md', data: SKILL('a') }] }), 'demo')
  assert.deepEqual(instanceSkillNames(home, 'demo'), ['instance:a', 'instance:mine'])

  uninstallPack(record, { home })
  assert.deepEqual(instanceSkillNames(home, 'demo'), ['instance:mine'])
  assert.equal(existsSync(join(profileDir, 'skills', 'a')), false, '空目录也清掉')
  assert.equal(readFileSync(join(profileDir, 'cordis.patch.yml'), 'utf8'), '- id: mine\n  disabled: true\n')
})

// ---- 导出 ----

test('导出：实例技能总是回到 home/skills/，装回去还是进实例；DSH_HOME 那份要勾选才带、同名以实例为准', () => {
  const home = tempDir()
  const profileDir = join(home, 'profiles', 'demo')
  mkdirSync(join(profileDir, 'skills', 'a'), { recursive: true })
  writeFileSync(join(profileDir, 'package.json'), JSON.stringify({ name: 'dsh-profile-demo', private: true, dependencies: {}, dsh: { profile: { bundles: [] } } }))
  writeFileSync(join(profileDir, 'skills', 'a', 'SKILL.md'), SKILL('a'))
  mkdirSync(join(home, 'skills', 'a'), { recursive: true })
  mkdirSync(join(home, 'skills', 'user-only'), { recursive: true })
  writeFileSync(join(home, 'skills', 'a', 'SKILL.md'), 'DSH_HOME 里的旧版本')
  writeFileSync(join(home, 'skills', 'user-only', 'SKILL.md'), SKILL('user-only'))

  const plain = exportPack({ profileDir, home, name: 'demo' })
  assert.deepEqual(plain.homeFiles, ['skills/a/SKILL.md'])
  assert.deepEqual(plain.instanceSkills, ['skills/a/SKILL.md'])
  assert.ok(!plain.entries.some((name) => name.startsWith('overrides/skills')), '技能目录不当 overrides 导出')

  const full = exportPack({ profileDir, home, name: 'demo', includeHome: true })
  assert.deepEqual(full.homeFiles.sort(), ['skills/a/SKILL.md', 'skills/user-only/SKILL.md'])
  const back = parsePackArchive(full.buffer)
  assert.equal(back.files.get('home/skills/a/SKILL.md').toString(), SKILL('a'), '同名路径用实例里的')

  const plan = planInstall(back, { home: tempDir(), profile: 'again' })
  const rels = plan.writes.map((write) => write.rel)
  assert.ok(rels.includes('profiles/again/skills/a/SKILL.md'))
  assert.ok(rels.includes('profiles/again/skills/user-only/SKILL.md'))
})

// ---- 老安装的兼容 ----

/** 模拟老版本的安装结果：技能写在 DSH_HOME/skills，记录里 kind 为 home。 */
function legacyInstall(home, dataDir) {
  const profileDir = join(home, 'profiles', 'demo')
  const backupDir = join(dataDir, 'packs', 'backups', '20260101000000-demo')
  mkdirSync(join(backupDir, 'files', 'skills', 'shared'), { recursive: true })
  mkdirSync(join(profileDir), { recursive: true })
  mkdirSync(join(home, 'skills', 'a', 'references'), { recursive: true })
  mkdirSync(join(home, 'skills', 'shared'), { recursive: true })
  writeFileSync(join(profileDir, 'package.json'), '{"name":"dsh-profile-demo","private":true}\n')
  writeFileSync(join(profileDir, 'cordis.patch.yml'), '- id: mine\n  disabled: true\n')
  writeFileSync(join(home, 'skills', 'a', 'SKILL.md'), SKILL('a'))
  writeFileSync(join(home, 'skills', 'a', 'references', 'r.md'), '参考')
  // 包覆盖过的用户技能：备份里是用户原来的版本
  writeFileSync(join(home, 'skills', 'shared', 'SKILL.md'), SKILL('shared'))
  writeFileSync(join(backupDir, 'files', 'skills', 'shared', 'SKILL.md'), '用户原来的 shared')
  const record = {
    id: 'demo@1.0.0',
    name: 'demo',
    version: '1.0.0',
    profile: 'demo',
    backupDir,
    createdProfile: false,
    files: [
      { rel: 'profiles/demo/package.json', existed: true, kind: 'manifest' },
      { rel: 'skills/a/SKILL.md', existed: false, kind: 'home' },
      { rel: 'skills/a/references/r.md', existed: false, kind: 'home' },
      { rel: 'skills/shared/SKILL.md', existed: true, kind: 'home' },
      { rel: 'AGENTS.md', existed: false, kind: 'home' },
    ],
  }
  mkdirSync(join(backupDir, 'files', 'profiles', 'demo'), { recursive: true })
  writeFileSync(join(backupDir, 'files', 'profiles', 'demo', 'package.json'), '{"name":"dsh-profile-demo","private":true}\n')
  rememberPack(dataDir, record)
  return { record, profileDir }
}

test('老安装：认得出留在 DSH_HOME 的整合包技能，不动它们', () => {
  const home = tempDir()
  const dataDir = tempDir('dsh-inst-data-')
  const { record } = legacyInstall(home, dataDir)
  const found = legacyPackSkills(record, home)
  assert.deepEqual(found.skills, ['a', 'shared'])
  assert.deepEqual(found.files.map((item) => item.rel), ['skills/a/SKILL.md', 'skills/a/references/r.md', 'skills/shared/SKILL.md'])
  assert.ok(existsSync(join(home, 'skills', 'a', 'SKILL.md')), '只认不动')
})

test('老安装：迁移把技能挪进实例，DSH_HOME 回到装包前，之后卸载一并清理', () => {
  const home = tempDir()
  const dataDir = tempDir('dsh-inst-data-')
  const { record, profileDir } = legacyInstall(home, dataDir)
  // 另一个记录排在它后面：迁移不能改清单顺序（撤销顺序靠它）
  rememberPack(dataDir, { name: 'later', profile: 'other', files: [], backupDir: join(dataDir, 'x') })

  const result = migratePackSkills(record, { home })
  assert.deepEqual(result.skills, ['a', 'shared'])
  replacePack(dataDir, result.record)
  assert.deepEqual(readPackState(dataDir).packs.map((item) => item.name), ['demo', 'later'])

  assert.deepEqual(instanceSkillNames(home, 'demo'), ['instance:a', 'instance:shared'])
  assert.equal(readFileSync(join(profileDir, 'skills', 'a', 'references', 'r.md'), 'utf8'), '参考')
  assert.equal(existsSync(join(home, 'skills', 'a')), false, '包新建的技能从 DSH_HOME 删掉（连空目录）')
  assert.equal(readFileSync(join(home, 'skills', 'shared', 'SKILL.md'), 'utf8'), '用户原来的 shared', '包覆盖过的还原成用户原来的')
  assert.ok(existsSync(join(home, 'skills')), 'DSH_HOME/skills 本身是用户目录，不删')
  assert.ok(hasInstanceSkillsRow(readFileSync(join(profileDir, 'cordis.patch.yml'), 'utf8')))
  assert.deepEqual(legacyPackSkills(result.record, home).skills, [], '迁完就不再报')
  assert.ok(result.record.files.some((item) => item.rel === 'AGENTS.md'), '非技能的用户级文件记录留着')

  uninstallPack(result.record, { home })
  assert.equal(existsSync(join(profileDir, 'skills')), false)
  assert.equal(readFileSync(join(profileDir, 'cordis.patch.yml'), 'utf8'), '- id: mine\n  disabled: true\n', '补丁层回到迁移前')
  assert.equal(readFileSync(join(home, 'skills', 'shared', 'SKILL.md'), 'utf8'), '用户原来的 shared')
})

test('老安装：补丁层没法安全追加时整体拒绝，DSH_HOME 一个文件不动', () => {
  const home = tempDir()
  const dataDir = tempDir('dsh-inst-data-')
  const { record, profileDir } = legacyInstall(home, dataDir)
  writeFileSync(join(profileDir, 'cordis.patch.yml'), '[{ id: x }]\n')
  assert.throws(() => migratePackSkills(record, { home }), /行内数组/)
  assert.ok(existsSync(join(home, 'skills', 'a', 'SKILL.md')))
  assert.equal(existsSync(join(profileDir, 'skills')), false)
  assert.deepEqual(readdirSync(join(home, 'skills')).sort(), ['a', 'shared'])
})
