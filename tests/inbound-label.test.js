import test from 'node:test'
import assert from 'node:assert/strict'
import { extractInbound, labelInbound } from '../src/channel/incoming.js'

// 群记录里原来只有一个笼统的 [附件]，事后翻记录不知道当时发的是什么。
// 这层把「发了什么」写清楚，语音还把平台的识别文字留下来。

test('语音：平台给了识别文字就带上，没给就说未转写', () => {
  const spoken = {
    message: [{ type: 'voice', data: { url: 'https://x/a.mp3', asr_text: '今晚吃什么' } }],
  }
  assert.equal(labelInbound(spoken), '[语音] 今晚吃什么')

  const deaf = { message: [{ type: 'voice', data: { url: 'https://x/a.mp3' } }] }
  assert.equal(labelInbound(deaf), '[语音] 未转写')
})

test('语音只有识别文字、没有直链，也算一条内容', () => {
  const event = { message: [{ type: 'voice', data: { asr_text: '帮我看看这个' } }] }
  const items = extractInbound(event)
  assert.equal(items.length, 1)
  assert.equal(items[0].asrText, '帮我看看这个')
  assert.equal(items[0].url, '', '没有直链就是空，不要拼出个假地址')
})

test('文件和图片按类型标注，文件名带上', () => {
  const event = {
    message: [
      { type: 'image', data: { url: 'https://x/a.png' } },
      { type: 'file', data: { url: 'https://x/b.pdf', name: '报告.pdf' } },
    ],
  }
  const label = labelInbound(event)
  assert.match(label, /\[图片\]/)
  assert.match(label, /报告\.pdf/)
})

test('没有附件时返回空串，调用方好退回 [附件]', () => {
  assert.equal(labelInbound({ message: [] }), '')
  assert.equal(labelInbound({}), '')
  assert.equal(labelInbound(null), '')
})

test('空内容不进列表', () => {
  assert.deepEqual(extractInbound({ message: [{ type: 'image', data: {} }] }), [])
})
