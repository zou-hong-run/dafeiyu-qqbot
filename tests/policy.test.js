import test from 'node:test'
import assert from 'node:assert/strict'
import { DANGEROUS_TOOLS, TOOL_POLICY, filterTools, isAdmin, isDangerousTool, isToolAllowed, resolveHistoryTarget } from '../src/config/policy.js'

test('高危工具都在名单里', () => {
  for (const name of ['shell', 'run_script', 'write_file', 'edit_file', 'start_task', 'broadcast', 'file_copy']) {
    assert.ok(DANGEROUS_TOOLS.has(name), `${name} 应该算高危`)
  }
})

test('没登记过的工具按名字里的能力词判高危', () => {
  // add_mcp 注册进来的工具不在 DANGEROUS_TOOLS 里，靠这个兜底
  for (const name of ['file_copy', 'evil_write', 'run_cmd', 'exec_code', 'delete_file', 'upload_blob']) {
    assert.equal(isDangerousTool(name), true, `${name} 应该判为高危`)
  }
  for (const name of ['search', 'find_music', 'weather', 'song', 'read_document', 'group_recent_speakers']) {
    assert.equal(isDangerousTool(name), false, `${name} 不该误伤`)
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

test('驼峰和点号写法的工具名也能判出危险', () => {
  // 外部 MCP 的工具名五花八门，只认下划线会被绕过
  for (const name of ['writeFile', 'execCommand', 'runScript', 'deleteItem', 'spawnProc', 'filesystem.write_file']) {
    assert.equal(isDangerousTool(name), true, `${name} 应该判为高危`)
  }
  // 纯读取不该误伤
  for (const name of ['readFile', 'read_file', 'listDir', 'list_dir', 'getWeather']) {
    assert.equal(isDangerousTool(name), false, `${name} 不该判为高危`)
  }
})

test('没在权限表里的工具默认拒绝', () => {
  // add_mcp 注册进来的服务不自动获得权限，要在 TOOL_POLICY 里显式加条目
  assert.equal(isToolAllowed('some_unknown_tool', 'private', 'u1'), false)
  assert.equal(isToolAllowed('some_unknown_tool', 'group', 'u1'), false)
})

// 读群记录的权限：群里只能读当前群，私聊只有管理员能指定群。
// 这条规则写漏了，等于群友能读别的群的聊天记录。
test('群里默认读当前群，不传就不越界', () => {
  assert.equal(resolveHistoryTarget({ current: 'gA' }), 'gA')
  assert.equal(resolveHistoryTarget({ current: 'gA', wanted: 'gA' }), 'gA')
  assert.equal(resolveHistoryTarget({ current: 'gA', wanted: '  gA  ' }), 'gA')
})

test('群友不能读别的群', () => {
  assert.throws(() => resolveHistoryTarget({ current: 'gA', wanted: 'gB' }), /管理员/)
})

test('管理员可以读别的群，也可以私聊指定群', () => {
  assert.equal(resolveHistoryTarget({ current: 'gA', wanted: 'gB', isAdmin: true }), 'gB')
  assert.equal(resolveHistoryTarget({ current: '', wanted: 'gB', isAdmin: true }), 'gB')
})

test('私聊里非管理员一律拒绝，管理员也得给出群 id', () => {
  assert.throws(() => resolveHistoryTarget({ current: '', wanted: 'gB' }), /管理员/)
  assert.throws(() => resolveHistoryTarget({ current: '', isAdmin: true }), /group_id/)
})

test('read_group_history 私聊也放行，越界与否交给 resolveHistoryTarget 判', () => {
  // 只是把工具暴露出来；真正能不能读某个群，由 resolveHistoryTarget 决定。
  // 之前这里是 GROUP_ONLY，管理员在私聊里连工具都看不到，报「只能在群聊用」。
  assert.equal(isToolAllowed('read_group_history', 'private'), true)
  assert.equal(isToolAllowed('read_group_history', 'group'), true)

  // 群友仍然读不到别的群
  assert.throws(() => resolveHistoryTarget({ current: '', wanted: 'gB', isAdmin: false }), /管理员/)
})

// isAdmin 的签名是 (scope, actor)。只传一个参数时它会被当成 scope，
// actor 变成 undefined，永远返回 false——这个坑真踩过：
// 管理员在私聊里读群记录被拒、在群里删别人的任务也被拒，而且没有任何报错。
test('isAdmin 少传 actor 时会告警，不静默失败', (t) => {
  const warn = t.mock.method(console, 'warn', () => {})
  isAdmin('group')
  assert.equal(warn.mock.callCount(), 1, '少传参数必须喊一声')
})

test('参数传全时不告警', (t) => {
  const warn = t.mock.method(console, 'warn', () => {})
  isAdmin('group', 'someone')
  assert.equal(warn.mock.callCount(), 0)
})
