import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  appendTurn,
  history,
  restoreOverflow,
  takeOverflow,
  useMemoryDir,
} from '../src/memory/memory.js'

// 记忆文件指到临时目录：否则 appendTurn 会往真实 data/memory.json 里写测试会话
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mem-test-'))
useMemoryDir(tmpDir)
test.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }))

test('最早的一轮永远不参与溢出', () => {
  const key = 'test:head-keep'
  // 第一轮是「任务初衷」，后面全是闲聊
  appendTurn(key, '帮我把定时任务改到七点半', '好，已经改好了')
  for (let i = 0; i < 12; i += 1) {
    appendTurn(key, `第 ${i} 句闲聊`, `收到 ${i}`)
  }

  const before = history(key)
  assert.ok(before.length > 16, `先攒够溢出：${before.length}`)

  const overflow = takeOverflow(key)
  const after = history(key)

  // 第一轮必须还在最前面——只留最近的会把「当初要干什么」冲掉
  assert.equal(after[0].role, 'user')
  assert.match(after[0].content, /定时任务改到七点半/)
  assert.equal(after[1].role, 'assistant')
  assert.equal(after.length, 16, '轮数上限仍然是 16 条')

  // 溢出的是中间那几条，不是最早那条
  assert.ok(overflow.length > 0)
  assert.doesNotMatch(overflow[0].content, /定时任务改到七点半/)
})

test('摘要失败回滚：把内容放回原位，不丢', () => {
  const key = 'test:restore'
  appendTurn(key, '最早的需求', '好的')
  for (let i = 0; i < 12; i += 1) appendTurn(key, `闲聊 ${i}`, `回 ${i}`)

  const overflow = takeOverflow(key)
  const droppedCount = overflow.length
  assert.ok(droppedCount > 0)

  restoreOverflow(key, overflow)

  const restored = history(key)
  assert.equal(restored.length, 16 + droppedCount, '放回去之后条数应该回到原样')
  // 头部锚点还在
  assert.match(restored[0].content, /最早的需求/)
  // 放回的内容在锚点之后，顺序不能乱
  assert.match(restored[2].content, /闲聊 0/)
})

test('restoreOverflow 对空输入是安全的', () => {
  const key = 'test:restore-empty'
  appendTurn(key, '一句话', '回答')
  restoreOverflow(key, null)
  restoreOverflow(key, [])
  assert.equal(history(key).length, 2)
})

test('两次 takeOverflow 不会重复吐出同一条', () => {
  const key = 'test:idempotent'
  appendTurn(key, '锚点需求', '好')
  for (let i = 0; i < 12; i += 1) appendTurn(key, `滚动 ${i}`, `答 ${i}`)

  const first = takeOverflow(key)
  const second = takeOverflow(key)

  assert.ok(first.length > 0)
  assert.equal(second, null, '已经在上限内了，不该再溢出')
})
