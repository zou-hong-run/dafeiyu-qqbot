import test from 'node:test'
import assert from 'node:assert/strict'
import { flatten, sanitizeText } from '../src/channel/qq.js'

// 出站内容拼装：@ 和表情在 QQ 协议里是 content 里的特殊标签，
// 所以「谁的内容」必须分清——我们拼的是指令，用户给的只能当文本。

test('普通文本原样保留', () => {
  assert.equal(flatten('你好呀').text, '你好呀')
  assert.equal(flatten({ type: 'text', data: { text: '在' } }).text, '在')
})

test('@ 全体和正常 openid', () => {
  assert.equal(flatten({ type: 'at', data: { user_id: 'all' } }).text, '<qqbot-at-everyone />')
  assert.equal(
    flatten({ type: 'at', data: { user_id: 'D51C979833FA4F3EEFFB65E50B50EB06' } }).text,
    '<qqbot-at-user id="D51C979833FA4F3EEFFB65E50B50EB06" />',
  )
})

test('带引号的 openid 会被拦，没法伪造额外标签', () => {
  assert.throws(
    () => flatten({ type: 'at', data: { user_id: 'x" /><qqbot-at-everyone /><qqbot-at-user id="y' } }),
    /openid 不合法/,
  )
})

test('文本里的协议标签会被剥掉', () => {
  // 用户原文里带标签，发出去不能被平台当成 @ 或表情
  assert.equal(flatten('开会了<qqbot-at-everyone />').text, '开会了')
  assert.equal(flatten('<emoji:118>好开心').text, '好开心')
  assert.equal(flatten('看这个 <qqbot-at-user id="abc" /> 是谁').text, '看这个  是谁')
})

test('sanitizeText 不误伤代码里的尖括号', () => {
  assert.equal(sanitizeText('if (a < b && c > d)'), 'if (a < b && c > d)')
  assert.equal(sanitizeText('用 <div> 包一层'), '用 <div> 包一层')
  assert.equal(sanitizeText('<qqbot-at-user id="x" />'), '')
})

test('表情 id 超范围直接丢弃', () => {
  assert.equal(flatten({ type: 'face', data: { id: 118 } }).text, '<emoji:118>')
  assert.equal(flatten({ type: 'face', data: { id: 9999 } }).text, '')
  assert.equal(flatten({ type: 'face', data: { id: -1 } }).text, '')
})

test('媒体段单独收集，不进 content', () => {
  const result = flatten([
    { type: 'text', data: { text: '看这张' } },
    { type: 'image', data: { file: '/tmp/a.png' } },
  ])
  assert.equal(result.text, '看这张')
  assert.equal(result.media.length, 1)
  assert.equal(result.media[0].type, 'image')
})
