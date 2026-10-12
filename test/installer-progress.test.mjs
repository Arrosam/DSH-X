import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'

const html = readFileSync(new URL('../installer/index.html', import.meta.url), 'utf8')
const code = html.match(/<script>([\s\S]*?)<\/script>/)[1]

function installer(config = {}) {
  const elements = new Map(), calls = [], timers = []
  const element = (id) => {
    if (!elements.has(id)) {
      const classes = new Set(), attributes = new Map()
      elements.set(id, {
        value: '', checked: true, style: {}, hidden: false,
        classList: { toggle: (name, active) => active ? classes.add(name) : classes.delete(name), contains: name => classes.has(name) },
        setAttribute: (name, value) => attributes.set(name, value), getAttribute: name => attributes.get(name),
        toggleAttribute() {}, getAnimations: () => [], animate() {}, focus() {},
      })
    }
    return elements.get(id)
  }
  const window = { __INSTALLER__: { preview: false, autoUpdate: true, language: 'zh-CN', version: '0.1.17', path: 'C:\\原安装目录', ...config }, ipc: { postMessage: value => calls.push(JSON.parse(value)) } }
  const context = vm.createContext({
    window, navigator: { language: 'zh-CN' }, matchMedia: () => ({ matches: true }),
    document: { getElementById: element, documentElement: element('html'), addEventListener() {} },
    setTimeout: callback => timers.push(callback), setInterval() {}, clearInterval() {},
  })
  vm.runInContext(code, context)
  return { window, calls, timers, element }
}

test('自动更新打开即开始，显示真实进度，成功后自动重启并清理安装包', () => {
  const ui = installer()
  assert.deepEqual(ui.calls, [{ action: 'install', path: 'C:\\原安装目录', desktop: true }])
  assert.equal(ui.element('heading').textContent, '正在更新 DSH-X')
  assert.equal(ui.element('shell').classList.contains('busy'), true)
  ui.window.installerEvent({ type: 'progress', stage: 'files', percent: 42 })
  assert.equal(ui.element('percent').textContent, '42%')
  assert.equal(ui.element('progressLabel').textContent, '正在解压文件')
  assert.equal(ui.timers.length, 0, '仅收到进度不能提前重启')
  ui.window.installerEvent({ type: 'done' })
  ui.timers[0]()
  assert.deepEqual(ui.calls[1], { action: 'finish', launch: true, deleteInstaller: true })
})

test('更新失败保留具体错误且不会重启，用户可在进度窗口重试', () => {
  const ui = installer()
  ui.window.installerEvent({ type: 'error', message: '文件被占用，安装退出码 5' })
  assert.equal(ui.element('error').textContent, '文件被占用，安装退出码 5')
  assert.equal(ui.element('primary').disabled, false)
  assert.equal(ui.timers.length, 0)
  ui.element('primary').onclick()
  assert.equal(ui.calls.length, 2)
  assert.equal(ui.calls[1].action, 'install')
})

test('普通安装保留确认步骤和完成选项，不会自动开始或自动重启', () => {
  const ui = installer({ autoUpdate: false, language: 'en' })
  assert.equal(ui.calls.length, 0)
  assert.equal(ui.element('heading').textContent, 'Install DSH-X')
  ui.element('primary').onclick()
  assert.equal(ui.calls[0].action, 'install')
  ui.window.installerEvent({ type: 'done' })
  assert.equal(ui.timers.length, 0)
  ui.element('launch').checked = false
  ui.element('delete').checked = false
  ui.element('primary').onclick()
  assert.deepEqual(ui.calls[1], { action: 'finish', launch: false, deleteInstaller: false })
})
