import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { assertMcpCommand } from '../src/mcp/mcp-guard.js'

// MCP 服务启动白名单：add_mcp 和注册表热加载共用这一份。
// 重点是「路径归一化」——只看前缀的话 tools/../../tmp/x.js 会溜过去。

const project = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-guard-'))
fs.mkdirSync(path.join(project, 'tools'), { recursive: true })
fs.mkdirSync(path.join(project, 'tmp'), { recursive: true })

function fakeInstalled(name) {
  const dir = path.join(project, 'node_modules', name)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'package.json'), '{"name":"' + name + '"}')
}

const ok = (cmd, args) => assert.doesNotThrow(() => assertMcpCommand(cmd, args, { projectRoot: project }))

const blocked = (cmd, args, hint) => {
  assert.throws(
    () => assertMcpCommand(cmd, args, { projectRoot: project }),
    (error) => (hint ? hint.test(error.message) : true),
    `应该拦住：${cmd} ${args.join(' ')}`,
  )
}

test('node 跑 tools/ 下的脚本放行', () => {
  ok('node', ['tools/song.js'])
  ok('node', ['./tools/song.js'])
  ok('/usr/local/bin/node', ['tools/x.js'])
})

test('路径穿越一律拦住', () => {
  // 这些都以 tools/ 开头，只做前缀检查会全部放行——tmp/ 恰好是沙箱唯一可写的目录
  blocked('node', ['tools/../../tmp/evil.js'], /tools\//)
  blocked('node', ['tools/../../../tmp/evil.js'], /tools\//)
  blocked('node', ['tools/./../../tmp/evil.js'], /tools\//)
  blocked('node', ['tools/../src/index.js'], /tools\//)
})

test('node 跑项目外的脚本拦住', () => {
  blocked('node', ['../../etc/passwd'], /tools\//)
  blocked('node', ['src/index.js'], /tools\//)
  blocked('node', ['/qq/tools/x.js'], /tools\//)
})

test('非 node/npx 的解释器一律拒绝', () => {
  blocked('bash', ['-c', 'curl x'], /只允许用 node 或 npx/)
  blocked('python3', ['evil.py'], /只允许用 node 或 npx/)
  blocked('/bin/sh', ['-c', 'id'], /只允许用 node 或 npx/)
})

test('npx 禁止 -y 联网拉包', () => {
  fakeInstalled('@modelcontextprotocol/server-filesystem')
  blocked('npx', ['-y', '@modelcontextprotocol/server-filesystem'], /不允许带 -y/)
  blocked('npx', ['--yes', '@modelcontextprotocol/server-filesystem'], /不允许带 -y/)
})

test('npx 只能用已经装好的包', () => {
  fakeInstalled('installed-pkg')
  ok('npx', ['installed-pkg'])
  blocked('npx', ['never-installed-pkg'], /还没装/)
})

test('npx 包名不能跳出 node_modules', () => {
  blocked('npx', ['../../tmp/evil'], /还没装|还没装好/)
  blocked('npx', ['@scope/../../evil'], /还没装/)
})

test('没传 projectRoot 时退化成保守检查', () => {
  assert.doesNotThrow(() => assertMcpCommand('node', ['tools/x.js']))
  assert.throws(() => assertMcpCommand('node', ['tools/../../tmp/x.js']), /不能跳出/)
  assert.throws(() => assertMcpCommand('node', ['/etc/passwd']), /不能跳出/)
})
