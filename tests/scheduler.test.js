import test from 'node:test'
import assert from 'node:assert/strict'
import { cronMatches, nextMatchOf, schedulerStatus } from '../src/tasks/scheduler.js'

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

