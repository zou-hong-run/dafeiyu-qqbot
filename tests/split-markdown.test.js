import test from 'node:test'
import assert from 'node:assert/strict'
import { splitMarkdown } from '../src/channel/sender.js'

// 定时任务的日报分段：markdown 不能按句子切，否则列表和引用会被劈开

test('按空行切，每段是完整的块', () => {
  const text = '# 日报\n\n- 第一项\n- 第二项\n\n> 一句引用\n\n收尾'
  const parts = splitMarkdown(text, 20)

  assert.ok(parts.length >= 2)
  for (const part of parts) {
    assert.ok(part.length <= 20, `每段不超限：${part.length}`)
  }
  // 列表不能被拆成两段
  const listPart = parts.find((part) => part.includes('第一项'))
  assert.ok(listPart.includes('第二项'), '列表项应该在同一段里')
})

test('单个块本身超长时硬切', () => {
  const text = 'A'.repeat(100)
  const parts = splitMarkdown(text, 30)
  assert.equal(parts.length, 4)
  assert.equal(parts.join(''), text)
})

test('空输入返回空数组', () => {
  assert.deepEqual(splitMarkdown(''), [])
  assert.deepEqual(splitMarkdown('   '), [])
  assert.deepEqual(splitMarkdown(null), [])
})

test('没有空行的连续列表保持连续', () => {
  const text = '- 一\n- 二\n- 三'
  const parts = splitMarkdown(text, 100)
  assert.equal(parts.length, 1)
  assert.equal(parts[0], text)
})
