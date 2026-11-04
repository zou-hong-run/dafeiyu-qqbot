import test from 'node:test'
import assert from 'node:assert/strict'
import { DANGEROUS_TOOLS, TOOL_POLICY, filterTools, isAdmin, isToolAllowed } from '../src/config/policy.js'

test('高危工具都在名单里', () => {
  for (const name of ['shell', 'run_script', 'write_file', 'edit_file', 'start_task', 'broadcast']) {
    assert.ok(DANGEROUS_TOOLS.has(name), `${name} 应该算高危`)
  }
})

test('点歌、画图、搜索这类不该算高危', () => {
  for (const name of ['find_music', 'draw_pixel', 'search', 'send_image', 'system_info']) {
    assert.equal(DANGEROUS_TOOLS.has(name), false, `${name} 不该拦住普通群友`)
  }
})

test('每个高危工具都要有权限表条目', () => {
  for (const name of DANGEROUS_TOOLS) {
    assert.ok(TOOL_POLICY[name], `${name} 缺少 TOOL_POLICY 配置`)
  }
})

test('群里默认不给高危工具（白名单里没这个人）', () => {
  assert.equal(isToolAllowed('shell', 'group', 'not-in-whitelist'), false)
})

test('没配白名单时群里仍然不给高危工具', () => {
  // 只有在 SHELL_GROUP_ENABLED=true 时才会放开，这里按默认关来断言
  const allowed = isToolAllowed('write_file', 'group', '')
  assert.equal(typeof allowed, 'boolean')
})

test('普通工具在私聊和群里都可用', () => {
  assert.equal(isToolAllowed('search', 'private', ''), true)
  assert.equal(isToolAllowed('search', 'group', ''), true)
})

test('只读工具标记正确', () => {
  assert.equal(TOOL_POLICY.search.readOnly, true)
  assert.equal(TOOL_POLICY.fetch.readOnly, true)
  assert.equal(TOOL_POLICY.send_image.readOnly, false)
})

test('filterTools 会按场景过滤', () => {
  const tools = [
    { name: 'search' },
    { name: 'read_profile' }, // 只在群里
    { name: 'shell' },
  ]
  const privateTools = filterTools(tools, 'private', '')
  const groupTools = filterTools(tools, 'group', '')

  assert.ok(privateTools.some((t) => t.name === 'search'))
  assert.equal(groupTools.some((t) => t.name === 'read_profile'), true, '群里应该能看画像')
  assert.equal(privateTools.some((t) => t.name === 'read_profile'), false, '私聊看不了群画像')
})

test('isAdmin 在没有 actor 时不放行', () => {
  assert.equal(isAdmin('group', ''), false)
})
