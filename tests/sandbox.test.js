import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { shieldArgs, SHIELDED_PATHS } from '../src/mcp-server/sandbox.js'

// bwrap 参数构造：Windows 上跑不了 bwrap，只测纯参数生成

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

test('存在的路径生成一对遮蔽参数', () => {
  const file = path.join(os.tmpdir(), `sbx-${process.pid}-${Date.now()}.txt`)
  fs.writeFileSync(file, 'x')
  try {
    assert.deepEqual(shieldArgs([file]), ['--ro-bind-try', '/dev/null', file])
  } finally {
    fs.rmSync(file, { force: true })
  }
})

test('不存在的路径必须跳过', () => {
  // bwrap 的 --ro-bind-try 只忽略源不存在；目标不存在时会去创建挂载点，
  // 根是只读的，创建失败整条命令起不来。所以这里必须提前筛掉。
  const missing = path.join(os.tmpdir(), `sbx-missing-${process.pid}`, 'nope')
  assert.equal(shieldArgs([missing]).length, 0)
})

test('遮蔽名单覆盖密钥文件和 SSH 私钥', () => {
  assert.ok(SHIELDED_PATHS.some((item) => item.endsWith('.env')), '项目根 .env')
  for (const name of ['id_rsa', 'id_ed25519', 'id_ecdsa']) {
    assert.ok(SHIELDED_PATHS.some((item) => item.endsWith(name)), `${name} 要遮蔽`)
  }
  assert.ok(SHIELDED_PATHS.includes('/etc/dafeiyu/env'), '外部密钥文件')
})

test('项目根 .env 在默认名单里且是绝对路径', () => {
  const target = path.join(projectRoot, '.env')
  assert.ok(SHIELDED_PATHS.includes(target))
  assert.ok(path.isAbsolute(target))
})
