import test from 'node:test'
import assert from 'node:assert/strict'
import { recallMessages } from '../src/channel/recall.js'

// 撤回只能动当前会话。跨群撤回是真实漏洞：
// 群里任何人传一个群 openid，就能把机器人发在别的群的消息撤掉，
// 还能从报错里探出「我在那个群发过话没有」。
// 这些断言都停在发请求之前，不会真的调接口。

const groupEvent = { message_type: 'group', group_id: 'GROUP_A' }

test('非管理员指定别的群：直接拒，不发请求', async () => {
  const result = await recallMessages({ event: groupEvent, groupId: 'GROUP_B' })
  assert.match(result, /只能撤回当前会话/)
})

test('非管理员指定别的群 + 伪造 messageId：一样拒', async () => {
  const result = await recallMessages({
    event: groupEvent,
    messageId: 'fake-id-123',
    groupId: 'GROUP_B',
  })
  assert.match(result, /只能撤回当前会话/)
})

test('当前会话里台账没有这条：拒绝，不拿它去发请求', async () => {
  const result = await recallMessages({ event: groupEvent, messageId: 'not-in-ledger' })
  assert.match(result, /台账里没有这条记录/)
})

test('管理员可以跨群（放行到台账校验那一步）', async () => {
  const result = await recallMessages({
    event: groupEvent,
    groupId: 'GROUP_B',
    allowCross: true,
  })
  // 台账里当然没有 GROUP_B 的记录，所以停在这里——说明已经被放行了
  assert.match(result, /没有发出去的消息记录/)
  assert.doesNotMatch(result, /只能撤回当前会话/)
})
