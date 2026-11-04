import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { assertMcpCommand, isValidRegistryEntry } from '../src/mcp/mcp-guard.js'

// MCP 服务启动白名单：add_mcp 和注册表热加载共用这一份

const project = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-guard-'))

function fakeInstalled(name) {
  const dir = path.join(project, 'node_modules', name)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'package.json'), '{"name":"' + name + '"}')
}

const ok = (cmd, args, opts) =>
  assert.doesNotThrow(() => assertMcpCommand(cmd, args, { projectRoot: project, ...opts }))

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

test('node 跑项目外的脚本拦住', () => {
  blocked('node', ['../../etc/passwd'], /只能启动项目内/)
  blocked('node', ['src/index.js'], /只能启动项目内/)
  blocked('node', ['/qq/tools/x.js'], /只能启动项目内/)
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

test('注册表条目被篡改时能识别', () => {
  assert.equal(isValidRegistryEntry({ name: 'a', command: 'node', args: ['tools/a.js'] }, project), true)
  assert.equal(isValidRegistryEntry({ name: 'b', command: 'bash', args: ['-c', 'id'] }, project), false)
  assert.equal(isValidRegistryEntry({ name: 'c', command: 'node', args: ['/etc/passwd'] }, project), false)
  assert.equal(isValidRegistryEntry({ name: '', command: 'node' }, project), false)
  assert.equal(isValidRegistryEntry({ name: 'd' }, project), false)
  assert.equal(isValidRegistryEntry(null, project), false)
})
