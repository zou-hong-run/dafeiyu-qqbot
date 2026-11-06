import test from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { addSchedule, cronMatches, nextMatchOf, parseSchedules, removeSchedule, schedulerStatus, useSchedulesDir } from '../src/tasks/scheduler.js'

// 别写到真实的 data/schedules.json：那会把用户正在用的定时任务清空
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sched-test-'))
useSchedulesDir(tmpDir)

test.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }))

// 出过「到点了没触发」，只能靠猜是 cron 写错了、还是调度器压根没启动。
// 下面这些断言就是让那三种情况能一眼分清。

test('nextMatchOf 算出下次触发时间', () => {
  const from = new Date('2026-11-07T00:46:00')
  const next = nextMatchOf('50 * * * *', from)
  assert.match(next, /00:50:00/, `实际：${next}`)
})

test('cron 写错时返回 null，不抛', () => {
  assert.equal(nextMatchOf('50 * *'), null)
  assert.equal(nextMatchOf('并不是 cron'), null)
  assert.equal(nextMatchOf(''), null)
})

test('cronMatches 只在命中的那一分钟为真', () => {
  assert.equal(cronMatches('50 * * * *', new Date('2026-11-07T00:50:05')), true)
  assert.equal(cronMatches('50 * * * *', new Date('2026-11-07T00:49:59')), false)
  assert.equal(cronMatches('50 * * * *', new Date('2026-11-07T01:50:40')), true)
})

test('未初始化时状态里能看出「没启动」', () => {
  const status = schedulerStatus()
  assert.equal(status.initialized, false)
  assert.equal(status.lastTickAt, null)
  assert.ok(Array.isArray(status.items))
  assert.equal(status.tickIntervalSeconds, 20)
})


// 任务文件损坏时绝不能当成「没有任务」——那样 initScheduler 里紧跟的 persist()
// 会把空数组写回去，用户的任务就静默消失了。真出过一次「定时任务空了」。
test('任务文件能解析出任务，running 一律清掉', () => {
  const text = JSON.stringify([
    { id: 'sched-a', cron: '50 * * * *', prompt: '报天气', enabled: true, running: true },
    { id: 'sched-b', cron: '0 8 * * *', prompt: '早报', enabled: false },
  ])
  const tasks = parseSchedules(text)

  assert.equal(tasks.length, 2)
  assert.equal(tasks[0].running, false, '重启后不能还标着 running')
  assert.equal(tasks[1].cron, '0 8 * * *')
})

test('文件损坏时抛错，由 load 去备份而不是静默清空', () => {
  assert.throws(() => parseSchedules('{ 这不是 json'), SyntaxError)
  assert.throws(() => parseSchedules('{"tasks":[]}'), /顶层不是数组/)
  assert.throws(() => parseSchedules('null'), /顶层不是数组/)
})

test('不完整的任务记录被跳过，剩下的照常加载', () => {
  const text = JSON.stringify([
    { id: 'sched-ok', cron: '0 8 * * *', prompt: '早报' },
    { cron: '0 9 * * *' }, // 没有 id
    { id: 'sched-no-cron' }, // 没有 cron
    null,
  ])
  const tasks = parseSchedules(text)
  assert.deepEqual(
    tasks.map((task) => task.id),
    ['sched-ok'],
  )
})

// remove_schedule 是 OPEN 工具：群里任何人都能让机器人调它。
// 不验身份的话，一句「把定时任务都删了」就能清空别人建的早报。
test('删除任务要验身份：创建者或管理员', () => {
  const entry = addSchedule({
    sessionKey: 'group:g1',
    target: { type: 'group', id: 'g1' },
    cron: '30 8 * * *',
    prompt: '每天早上推早报',
    createdBy: 'user-a',
  })

  // 别人删不了
  assert.throws(
    () => removeSchedule(entry.id, 'group:g1', { actor: 'user-b' }),
    /别人建的/,
  )

  // 创建者本人可以
  assert.ok(removeSchedule(entry.id, 'group:g1', { actor: 'user-a' }))
})

test('管理员能删任何人的任务，旧任务只有管理员能删', () => {
  const mine = addSchedule({
    sessionKey: 'group:g2',
    target: { type: 'group', id: 'g2' },
    cron: '0 9 * * *',
    prompt: '每天九点推抽签',
    createdBy: 'user-a',
  })
  assert.ok(removeSchedule(mine.id, 'group:g2', { actor: 'admin', isAdmin: true }))

  // 没有 createdBy 的旧任务
  const legacy = addSchedule({
    sessionKey: 'group:g3',
    target: { type: 'group', id: 'g3' },
    cron: '0 10 * * *',
    prompt: '这是一条老任务记录',
  })
  assert.throws(() => removeSchedule(legacy.id, 'group:g3', { actor: 'user-c' }), /旧版本/)
  assert.ok(removeSchedule(legacy.id, 'group:g3', { actor: 'admin', isAdmin: true }))
})
