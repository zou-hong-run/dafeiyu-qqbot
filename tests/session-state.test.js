import test from 'node:test'
import assert from 'node:assert/strict'
import { clearTodos, listTodos, noteTodoStep, todoPrompt, writeTodos } from '../src/chat/todos.js'
import { clearChoice, choiceText, putChoice, resolveChoice } from '../src/chat/choices.js'
import { isMuted, muteGroup, oncePer, unmuteGroup, muteRemainingMinutes } from '../src/engage/quiet.js'

// 会话状态类：任务清单、选择题、静音。
// 每个用例用独立的 sessionKey，测完清掉，不污染真实数据。

const KEY = 'test:state-1'

test('任务清单：写入、进度、注入提示', () => {
  writeTodos(KEY, [
    { title: '读代码', status: 'done' },
    { title: '改逻辑', status: 'in_progress' },
    { title: '跑测试', status: 'pending' },
  ])

  const items = listTodos(KEY)
  assert.equal(items.length, 3)
  assert.equal(items[0].status, 'done')

  const prompt = todoPrompt(KEY)
  assert.match(prompt, /\[x\] 读代码/)
  assert.match(prompt, /\[~\] 改逻辑/)
  assert.match(prompt, /进度 1\/3/)

  clearTodos(KEY)
  assert.equal(listTodos(KEY).length, 0)
  assert.equal(todoPrompt(KEY), '')
})

test('任务清单：非法状态归到 pending', () => {
  writeTodos(KEY, [{ title: '奇怪状态', status: 'whatever' }])
  assert.equal(listTodos(KEY)[0].status, 'pending')
  clearTodos(KEY)
})

test('任务清单：太久没更新会提醒', () => {
  writeTodos(KEY, [{ title: '一直没动', status: 'pending' }])

  let hint = ''
  for (let i = 0; i < 10; i += 1) hint = noteTodoStep(KEY) || hint

  assert.match(hint, /清单/)
  clearTodos(KEY)
})

test('任务清单：全部完成就不再提醒', () => {
  writeTodos(KEY, [{ title: '做完了', status: 'done' }])
  let hint = ''
  for (let i = 0; i < 10; i += 1) hint = noteTodoStep(KEY) || hint
  assert.equal(hint, '')
  clearTodos(KEY)
})

test('选择题：回数字选中，用过就失效', () => {
  const entry = putChoice(KEY, { question: '选哪个', options: ['白色', '银色', '深色'] })
  assert.equal(entry.options.length, 3)
  assert.match(choiceText(entry), /1\. 白色/)

  assert.deepEqual(resolveChoice(KEY, '2'), { question: '选哪个', choice: '银色' })
  assert.equal(resolveChoice(KEY, '2'), null, '同一条选择题不该能选两次')
})

test('选择题：非数字和越界都不算选中', () => {
  putChoice(KEY, { question: '选哪个', options: ['A', 'B'] })
  assert.equal(resolveChoice(KEY, '随便聊聊'), null)
  assert.equal(resolveChoice(KEY, '9'), null)
  assert.equal(resolveChoice(KEY, '1').choice, 'A', '合法的还在')
  clearChoice(KEY)
})

test('选择题：少于两个选项不建', () => {
  assert.equal(putChoice(KEY, { question: 'x', options: ['只有一个'] }), null)
})

test('oncePer 节流：窗口内只放行一次', () => {
  const key = 'test:once'
  assert.equal(oncePer(key, 5000), true)
  assert.equal(oncePer(key, 5000), false)
  assert.equal(oncePer(key, 0), true, '0 表示不限')
  assert.equal(oncePer(key, 0), true)
})

test('静音：开关生效，解除后恢复', () => {
  const group = 'test-group-quiet'
  assert.equal(isMuted(group), false)

  const info = muteGroup(group, 1)
  assert.equal(info.minutes, 1)
  assert.equal(isMuted(group), true)
  assert.ok(muteRemainingMinutes(group) > 0)

  unmuteGroup(group)
  assert.equal(isMuted(group), false)
})

test('静音：时长被夹在 1 分钟到 24 小时之间', () => {
  // 传 0 等于没传，用默认 60 分钟；超长被砍到 24 小时
  assert.equal(muteGroup('test-clamp-1', 0).minutes, 60)
  assert.equal(muteGroup('test-clamp-2', 99999).minutes, 1440)
  unmuteGroup('test-clamp-1')
  unmuteGroup('test-clamp-2')
})
