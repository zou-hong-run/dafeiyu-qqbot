import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { budgetFor, profileName, runtimeState } from '../src/ops/budget.js'
import { caps, memoryInfo, platform, sandboxStatus } from '../src/ops/platform.js'
import { cleanWorkspace } from '../src/ops/workspace.js'

test('内存档位按总量划分', () => {
  assert.equal(profileName(1600), 'tiny')
  assert.equal(profileName(3000), 'small')
  assert.equal(profileName(8000), 'medium')
  assert.equal(profileName(32000), 'large')
})

test('tiny 档的参数和 2G 机器匹配', () => {
  const b = budgetFor(1613)
  assert.equal(b.profile, 'tiny')
  assert.equal(b.mainHeapMB, 320)
  assert.equal(b.mcpHeapMB, 160)
  assert.equal(b.shellUlimitMB, 512)
  assert.equal(b.taskConcurrency, 2)
})

test('大内存机器自动放宽', () => {
  const b = budgetFor(16000)
  assert.equal(b.profile, 'large')
  assert.ok(b.taskConcurrency > 2, '并发应该比小机器多')
  assert.ok(b.shellUlimitMB > 512, '单命令上限应该更大')
})

test('运行时状态按可用内存分三档', () => {
  const tiny = budgetFor(1613)
  assert.equal(runtimeState(100, tiny), 'blocked')
  assert.equal(runtimeState(400, tiny), 'light-only')
  assert.equal(runtimeState(900, tiny), 'normal')
})

test('memoryInfo 返回可用的数字', () => {
  const info = memoryInfo()
  assert.ok(info.totalMB > 0, '总量应该大于 0')
  assert.ok(info.availableMB >= 0, '可用量不应为负')
  assert.ok(info.availableMB <= info.totalMB + 1, '可用量不该超过总量')
  assert.equal(typeof info.precise, 'boolean')
})

test('平台能力探测不抛错', () => {
  assert.ok(['linux', 'darwin', 'win32'].includes(platform) || typeof platform === 'string')
  assert.equal(typeof caps.canUlimit, 'boolean')
  // 只有 Linux 能靠 ulimit 限制内存
  if (platform !== 'linux') assert.equal(caps.canUlimit, false)
})

test('沙箱状态是探测出来的，不是写死的标签', () => {
  const sandbox = sandboxStatus()
  assert.equal(typeof sandbox.available, 'boolean')
  assert.ok(['bwrap', 'seatbelt', 'none'].includes(sandbox.kind))
  // 不可用时必须给出原因，不能只说「没有」
  if (!sandbox.available) assert.ok(sandbox.reason.length > 0, '不可用要给原因')
  // 非 Linux 一律不可用
  if (platform !== 'linux') assert.equal(sandbox.available, false)
})

test('/clean 只清临时目录，绝不动 scripts 和 src', () => {
  const tmpFile = path.join('tmp', 'clean-probe.txt')
  fs.mkdirSync('tmp', { recursive: true })
  fs.writeFileSync(tmpFile, 'probe')

  const before = {
    checkRefs: fs.existsSync('scripts/check-refs.js'),
    release: fs.existsSync('scripts/release.js'),
    index: fs.existsSync('src/index.js'),
  }

  cleanWorkspace({ includeDownloads: false })

  assert.equal(fs.existsSync(tmpFile), false, 'tmp 里的临时文件应该被清掉')
  assert.equal(fs.existsSync('scripts/check-refs.js'), before.checkRefs, 'scripts 不该被动')
  assert.equal(fs.existsSync('scripts/release.js'), before.release, 'scripts 不该被动')
  assert.equal(fs.existsSync('src/index.js'), before.index, 'src 不该被动')
})
