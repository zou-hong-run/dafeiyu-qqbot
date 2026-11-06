import test from 'node:test'
import assert from 'node:assert/strict'
import { cronMatches, nextMatchOf, parseSchedules, schedulerStatus } from '../src/tasks/scheduler.js'

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
