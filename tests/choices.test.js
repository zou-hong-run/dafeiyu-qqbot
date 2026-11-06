import test from 'node:test'
import assert from 'node:assert/strict'
import { choiceKeyboard, putChoice, resolveChoiceById } from '../src/chat/choices.js'

// 选择题的两条路：按钮点击（按 id 找回）和回数字（按会话找回）

test('按钮点击按 id 找回原题', () => {
  const entry = putChoice('test:btn-1', { question: '选哪个', options: ['甲', '乙', '丙'] })
  const picked = resolveChoiceById(entry.id, 1)

  assert.equal(picked.choice, '乙')
  assert.equal(picked.question, '选哪个')
  assert.equal(picked.sessionKey, 'test:btn-1')
})

test('选过一次之后不能重复选', () => {
  const entry = putChoice('test:btn-2', { question: 'q', options: ['甲', '乙'] })
  assert.ok(resolveChoiceById(entry.id, 0))
  assert.equal(resolveChoiceById(entry.id, 0), null)
})

test('不存在的 id 返回 null', () => {
  assert.equal(resolveChoiceById('c_not_exist', 0), null)
})

test('按钮布局带上全部选项和回调数据', () => {
  const entry = putChoice('test:btn-3', { question: 'q', options: ['甲', '乙', '丙'] })
  const buttons = choiceKeyboard(entry).content.rows[0].buttons

  assert.equal(buttons.length, 3)
  assert.equal(buttons[0].action.type, 1, '回调按钮')
  assert.equal(buttons[0].action.permission.type, 2, '所有人可点')
  assert.equal(buttons[2].action.data, `choice:${entry.id}:2`)
})

test('少于两个选项时不创建', () => {
  assert.equal(putChoice('test:btn-4', { question: 'q', options: ['只有一个'] }), null)
})
