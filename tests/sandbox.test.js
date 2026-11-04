import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { shieldArgs, SHIELDED_DIRS, SHIELDED_FILES } from '../src/mcp-server/sandbox.js'

// bwrap 参数构造：Windows 上跑不了 bwrap，只测纯参数生成

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

function tempFile() {
  const file = path.join(os.tmpdir(), `sbx-${process.pid}-${Math.random().toString(36).slice(2)}.txt`)
  fs.writeFileSync(file, 'x')
  return file
}

test('存在的目录挂空 tmpfs', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sbx-dir-'))
  try {
    assert.deepEqual(shieldArgs({ dirs: [dir], files: [] }), ['--tmpfs', dir])
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('存在的文件盖成 /dev/null', () => {
  const file = tempFile()
  try {
    assert.deepEqual(shieldArgs({ dirs: [], files: [file] }), ['--ro-bind-try', '/dev/null', file])
  } finally {
    fs.rmSync(file, { force: true })
  }
})

test('不存在的路径必须跳过', () => {
  // --tmpfs 挂不上不存在的目录；--ro-bind-try 只忽略源不存在，
  // 目标不存在时会去只读根上创建挂载点，创建失败整条命令就起不来。
  const missing = path.join(os.tmpdir(), `sbx-missing-${process.pid}`, 'nope')
  assert.equal(shieldArgs({ dirs: [missing], files: [missing] }).length, 0)
})

test('已被目录遮住的文件不重复生成参数', () => {
  // 目录已经变成空 tmpfs，里面的文件压根不存在了，再挂一次会失败
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sbx-cov-'))
  const file = path.join(dir, 'env')
  fs.writeFileSync(file, 'x')
  try {
    assert.deepEqual(shieldArgs({ dirs: [dir], files: [file] }), ['--tmpfs', dir])
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('默认名单覆盖密钥目录、SSH 私钥、项目根 .env、pm2 快照', () => {
  assert.ok(SHIELDED_DIRS.includes('/etc/dafeiyu'), '外部密钥目录')
  assert.ok(SHIELDED_DIRS.includes('/root/.ssh'), 'SSH 私钥目录')
  assert.ok(SHIELDED_FILES.includes(path.join(projectRoot, '.env')), '项目根 .env')
  assert.ok(SHIELDED_FILES.includes('/root/.pm2/dump.pm2'), 'pm2 env 快照')
})
