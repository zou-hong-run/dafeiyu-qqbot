import test from 'node:test'
import assert from 'node:assert/strict'
import { COMMANDS, runCommand } from '../src/app/commands.js'

// 用假的 ctx 跑命令：不发消息、不碰网络，只看「认领」和「回什么」

function makeCtx(text, { admin = true } = {}) {
  const replies = []
  return {
    replies,
    ctx: {
      event: { user_id: 'test-user', message_type: 'private' },
      text,
      key: 'user:test-user',
      scope: 'private',
      trigger: 'private',
      actor: 'test-user',
      reply: async (body) => replies.push(String(body)),
      isAdminNow: admin,
    },
  }
}

test('命令表里没有重名', () => {
  const names = COMMANDS.map((c) => c.name)
  assert.equal(new Set(names).size, names.length, '命令名不该重复')
})

test('每个命令都有 match 和 run', () => {
  for (const command of COMMANDS) {
    assert.equal(typeof command.match, 'function', `${command.name} 缺少 match`)
    assert.equal(typeof command.run, 'function', `${command.name} 缺少 run`)
  }
})

test('/memory 不会吃掉 /memory list', () => {
  const memory = COMMANDS.find((c) => c.name === '/memory')
  const list = COMMANDS.find((c) => c.name === '/memory list')
  assert.equal(memory.match('/memory list'), false)
  assert.equal(list.match('/memory list'), true)
})

test('/task 不会误匹配 /tasks', () => {
  const task = COMMANDS.find((c) => c.name === '/task')
  const tasks = COMMANDS.find((c) => c.name === '/tasks')
  assert.equal(task.match('/tasks'), false, '/tasks 没有空格，不该被 /task 吃掉')
  assert.equal(tasks.match('/tasks'), true)
})

test('/id 能正常回话', async () => {
  const { ctx, replies } = makeCtx('/id')
  const hit = await runCommand('/id', ctx)
  assert.equal(hit, true)
  assert.match(replies[0], /openid/)
})

test('/help 能正常回话', async () => {
  const { ctx, replies } = makeCtx('/help')
  assert.equal(await runCommand('/help', ctx), true)
  assert.ok(replies[0].length > 20)
})

test('普通群友用不了管理员命令', async () => {
  for (const command of ['/config', '/memory', '/reset', '/forget 测试']) {
    const { ctx, replies } = makeCtx(command, { admin: false })
    const hit = await runCommand(command, ctx)
    assert.equal(hit, true, `${command} 应该被认领`)
    assert.match(replies[0], /只有管理员/, `${command} 应该被拦住`)
  }
})

test('不认识的话不认领', async () => {
  const { ctx, replies } = makeCtx('今天天气不错')
  assert.equal(await runCommand('今天天气不错', ctx), false)
  assert.equal(replies.length, 0)
})

test('/tasks 空的时候给提示', async () => {
  const { ctx, replies } = makeCtx('/tasks')
  assert.equal(await runCommand('/tasks', ctx), true)
  assert.match(replies[0], /工单/)
})

test('/cost 接受天数参数', async () => {
  const { ctx, replies } = makeCtx('/cost 3')
  assert.equal(await runCommand('/cost 3', ctx), true)
  assert.ok(replies[0].length > 0)
})
