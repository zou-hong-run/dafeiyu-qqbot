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

test('选过一次之后，第二个人点会被告知已被选走', () => {
  const entry = putChoice('test:btn-2', { question: 'q', options: ['甲', '乙'] })
  assert.ok(resolveChoiceById(entry.id, 0).choice)

  const second = resolveChoiceById(entry.id, 1)
  assert.equal(second.taken, true, '应该标记为已被选过，而不是当不存在')
})

test('不存在的 id 返回 null', () => {
  assert.equal(resolveChoiceById('c_not_exist', 0), null)
})

test('按钮布局带上全部选项和回调数据', () => {
  const entry = putChoice('test:btn-3', { question: 'q', options: ['甲', '乙', '丙'] })
  const rows = choiceKeyboard(entry).content.rows
  const buttons = rows.flatMap((row) => row.buttons)

  assert.equal(buttons.length, 3)
  assert.equal(buttons[0].action.type, 1, '回调按钮')
  assert.equal(buttons[0].action.permission.type, 2, '所有人可点')
  assert.equal(buttons[2].action.data, `choice:${entry.id}:2`)
})

test('一个按钮占一行，宽度才够显示文字', () => {
  // 群里实际看到过「1. ...」和「1. 再来……」：一行塞多个按钮时平台平分宽度，
  // 中文很快被截断。独占一行才能把字显示全。
  const entry = putChoice('test:btn-5', { question: 'q', options: ['一', '二', '三', '四', '五'] })
  const rows = choiceKeyboard(entry).content.rows

  assert.equal(rows.length, 5)
  for (const row of rows) assert.equal(row.buttons.length, 1)

  assert.equal(rows[0].buttons[0].render_data.label, '1. 一')
  assert.equal(rows[3].buttons[0].render_data.label, '4. 四')
  assert.equal(rows[4].buttons[0].action.data, `choice:${entry.id}:4`)
})

test('选项文字太长时按钮上截断，回传的数据不受影响', () => {
  const long = '这个选项写得特别特别长长长长长长'
  const entry = putChoice('test:btn-6', { question: 'q', options: [long, '短'] })
  const label = choiceKeyboard(entry).content.rows[0].buttons[0].render_data.label

  assert.ok(label.length <= 10, `按钮文字不能超过 10 个字符，实际 ${label.length}`)
  // 截断只影响显示，点下去仍然是完整选项
  assert.equal(resolveChoiceById(entry.id, 0).choice, long)
})

test('少于两个选项时不创建', () => {
  assert.equal(putChoice('test:btn-4', { question: 'q', options: ['只有一个'] }), null)
})

test('没投过的题返回 null，和被选走的区分开', () => {
  assert.equal(resolveChoiceById('c_never_seen', 0), null)
})

test('第一个人选中的是哪个就是哪个', () => {
  const entry = putChoice('test:btn-5', { question: 'q', options: ['甲', '乙', '丙'] })

  const first = resolveChoiceById(entry.id, 2)
  assert.equal(first.choice, '丙')

  // 后来的人点别的，会被记为「已选走」，不会覆盖第一个人的结果
  const second = resolveChoiceById(entry.id, 0)
  assert.equal(second.taken, true)
  assert.equal(second.choice, '丙', '返回的仍是第一个人的选择')
})
