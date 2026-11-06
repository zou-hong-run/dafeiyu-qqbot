import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { shieldArgs, shieldChildren, SHIELDED_DIRS, SHIELDED_FILES } from '../src/mcp-server/sandbox.js'
import { defaultEnvFile } from '../src/ops/platform.js'

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

test('默认名单覆盖密钥目录、家目录、系统凭据', () => {
  assert.ok(SHIELDED_DIRS.includes(path.dirname(defaultEnvFile())), '外部密钥目录')
  assert.ok(SHIELDED_DIRS.includes('/root'), 'root 家目录')
  assert.ok(SHIELDED_DIRS.includes('/home'), '其他用户家目录')
  assert.ok(!SHIELDED_DIRS.includes('/www'), '不能整个 /www 都遮，否则 node 也没了')
  assert.ok(!SHIELDED_DIRS.includes('/www/server/nodejs'), 'node 目录必须留着，否则沙箱里跑不了 node')
  assert.ok(SHIELDED_FILES.includes(path.join(projectRoot, '.env')), '项目根 .env')
  assert.ok(SHIELDED_FILES.includes('/etc/shadow'), '密码哈希')
  assert.ok(SHIELDED_FILES.includes('/etc/sudoers'), 'sudo 配置')
})

test('/www 下只有 node 目录放开，兄弟目录逐个遮住', () => {
  // 开发机上没有 /www，用临时目录树复现宝塔的布局
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sbx-www-'))
  const keep = path.join(root, 'server', 'nodejs')
  try {
    for (const dir of ['wwwroot', 'backup', 'server/nodejs', 'server/mysql', 'server/panel']) {
      fs.mkdirSync(path.join(root, dir), { recursive: true })
    }

    const shielded = shieldChildren(root, [keep])

    assert.deepEqual(
      shielded.sort(),
      [
        path.join(root, 'backup'),
        path.join(root, 'server', 'mysql'),
        path.join(root, 'server', 'panel'),
        path.join(root, 'wwwroot'),
      ].sort(),
    )
    assert.ok(!shielded.includes(keep), 'node 目录不能被遮')
    assert.ok(!shielded.includes(root), '祖父目录本身不能整块遮')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('/www 不存在时遮蔽名单为空，不会造出挂不上的路径', () => {
  const root = path.join(os.tmpdir(), `sbx-nothing-${process.pid}`)
  assert.deepEqual(shieldChildren(root, [path.join(root, 'server', 'nodejs')]), [])
})
