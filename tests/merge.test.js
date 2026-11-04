import test from 'node:test'
import assert from 'node:assert/strict'
import { mergeMessage, clearMerged, flushMerged } from '../src/chat/merge.js'

// 连发合并：同一个人连着发的几句要合成一次理解。
// 这里用短窗口测，避免测试跑太久。

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const ev = (id, text) => ({ message_id: id, content: text })

function collect() {
  const batches = []
  return { batches, handler: (batch) => batches.push(batch) }
}

test('窗口内连发三条合成一次', async () => {
  const { batches, handler } = collect()

  mergeMessage({ sessionKey: 'test:merge-a', userId: 'u1', text: '帮我查一下', event: ev('a1'), windowMs: 120 }, handler)
  await sleep(40)
  mergeMessage({ sessionKey: 'test:merge-a', userId: 'u1', text: '北京天气', event: ev('a2'), windowMs: 120 }, handler)
  await sleep(40)
  mergeMessage({ sessionKey: 'test:merge-a', userId: 'u1', text: '要带伞吗', event: ev('a3'), windowMs: 120 }, handler)
  await sleep(300)

  assert.equal(batches.length, 1, '应该只处理一批')
  assert.equal(batches[0].events.length, 3)
  assert.equal(batches[0].text, '帮我查一下\n北京天气\n要带伞吗')
})

test('不同用户互不合并', async () => {
  const { batches, handler } = collect()

  mergeMessage({ sessionKey: 'test:merge-b', userId: 'u1', text: 'A 说话', event: ev('b1'), windowMs: 100 }, handler)
  mergeMessage({ sessionKey: 'test:merge-b', userId: 'u2', text: 'B 说话', event: ev('b2'), windowMs: 100 }, handler)
  await sleep(250)

  assert.equal(batches.length, 2)
  assert.deepEqual(batches.map((b) => b.text).sort(), ['A 说话', 'B 说话'])
})

test('命令不合并，立即处理', async () => {
  const { batches, handler } = collect()

  mergeMessage({ sessionKey: 'test:merge-c', userId: 'u1', text: '普通一句', event: ev('c1'), windowMs: 5000 }, handler)
  mergeMessage({ sessionKey: 'test:merge-c', userId: 'u1', text: '/id', event: ev('c2'), windowMs: 5000 }, handler)
  await sleep(50)

  assert.equal(batches.length, 2, '命令要立刻冲出，不能等窗口')
  assert.equal(batches[0].text, '普通一句')
  assert.equal(batches[1].text, '/id')
})

test('带附件的消息立即处理', async () => {
  const { batches, handler } = collect()

  mergeMessage({ sessionKey: 'test:merge-d', userId: 'u1', text: '一张图', event: ev('d1'), windowMs: 5000 }, handler)
  mergeMessage({
    sessionKey: 'test:merge-d',
    userId: 'u1',
    text: '看图',
    event: ev('d2'),
    windowMs: 5000,
    immediate: true,
  }, handler)
  await sleep(50)

  assert.equal(batches.length, 2)
})

test('攒满 6 条提前冲出', async () => {
  const { batches, handler } = collect()

  for (let i = 0; i < 7; i += 1) {
    mergeMessage({ sessionKey: 'test:merge-e', userId: 'u1', text: `第${i}句`, event: ev(`e${i}`), windowMs: 5000 }, handler)
  }
  await sleep(50)

  assert.equal(batches[0].events.length, 6, '满 6 条就先发一批')
  clearMerged('test:merge-e') // 第 7 条还在槽里，清掉免得影响后面的用例
})

test('clearMerged 清掉待处理批次', async () => {
  const { batches, handler } = collect()

  mergeMessage({ sessionKey: 'test:merge-f', userId: 'u1', text: '等一下', event: ev('f1'), windowMs: 5000 }, handler)
  const removed = clearMerged('test:merge-f')
  await sleep(80)

  assert.equal(removed, 1)
  assert.equal(batches.length, 0, '清掉之后不应该再回调')
})

test('flushMerged 把攒着的立刻交出去', async () => {
  const { batches, handler } = collect()

  mergeMessage({ sessionKey: 'test:merge-g', userId: 'u1', text: '最后一句', event: ev('g1'), windowMs: 5000 }, handler)
  flushMerged(handler)

  // flushMerged 是全局的，可能顺带冲出别的用例残留，所以只断言这一句在里面
  assert.ok(batches.some((b) => b.text === '最后一句'), '攒着的应该被立刻交出去')
})
