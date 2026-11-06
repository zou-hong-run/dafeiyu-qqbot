import test from 'node:test'
import assert from 'node:assert/strict'
import { isLikelyAd, pickAdReply, resetAdGuard, takeWarnSlot } from '../src/engage/ad-guard.js'

// 广告检测：误伤一个正常群友，比放过十条广告更糟。
// 所以判定要求「联系方式 + 广告词/拉人动作」，宁可漏，不可冤。

test('明显的广告会被认出来', () => {
  for (const text of [
    '【招聘】在家兼职，日入 300+，加微信 abc12345 详聊',
    '特价代购，全场折扣，联系我 13800138000',
    '秒杀活动，戳我头像进群',
    '扫码进群领资料',
    '加微信 shop2024',
    '一手货源批发，加我 vx: shop2024',
    '免费领资料，https://promo.example.com/abc',
  ]) {
    assert.equal(isLikelyAd(text), true, `应该判为广告：${text}`)
  }
})

test('正常聊天不会被冤枉', () => {
  for (const text of [
    '今天这波优惠力度还挺大的',
    '有人加微信吗，拉个群聊',
    '我电话 13800138000，有事打给我',
    '我的qq 123456789 有事找我',
    '这个视频不错 https://b23.tv/abcd',
    '优惠券用完了，明天再买',
    '周末去哪玩',
    '推荐个 github 仓库 https://github.com/a/b',
    '短句',
  ]) {
    assert.equal(isLikelyAd(text), false, `不该判为广告：${text}`)
  }
})

test('太短的消息不判', () => {
  assert.equal(isLikelyAd('优惠'), false)
  assert.equal(isLikelyAd(''), false)
  assert.equal(isLikelyAd(null), false)
})

test('提醒文案随机取，不重复训人', () => {
  const seen = new Set()
  for (let i = 0; i < 8; i += 1) seen.add(pickAdReply(i))
  assert.ok(seen.size >= 2, '文案池应该有多种说法')
  for (const line of seen) {
    assert.doesNotMatch(line, /违规|封禁|踢出/, `别用训人的口气：${line}`)
  }
})

test('同一个人 24 小时内只提醒一次', () => {
  resetAdGuard()
  const now = Date.now()
  assert.equal(takeWarnSlot('g1', 'u1', now), true)
  assert.equal(takeWarnSlot('g1', 'u1', now + 60_000), false, '一分钟内不该再提醒')
  assert.equal(takeWarnSlot('g1', 'u1', now + 23 * 3600_000), false, '不到 24 小时')
  assert.equal(takeWarnSlot('g1', 'u1', now + 25 * 3600_000), true, '过了 24 小时可以再提醒')
})

test('同一个群一小时最多三次，不同人不同群互不影响', () => {
  resetAdGuard()
  const now = Date.now()
  assert.equal(takeWarnSlot('g2', 'a', now), true)
  assert.equal(takeWarnSlot('g2', 'b', now), true)
  assert.equal(takeWarnSlot('g2', 'c', now), true)
  assert.equal(takeWarnSlot('g2', 'd', now), false, '第四次该被群级上限挡住')
  assert.equal(takeWarnSlot('g3', 'd', now), true, '换个群不受影响')

  // 一小时窗口过后重新开放
  assert.equal(takeWarnSlot('g2', 'e', now + 61 * 60_000), true)
})
