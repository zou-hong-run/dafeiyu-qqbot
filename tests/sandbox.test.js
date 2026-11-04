import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { shieldArgs } from '../src/mcp-server/sandbox.js'

// bwrap 参数构造：Windows 上跑不了 bwrap，所以只测纯参数生成

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

test('遮蔽参数成对出现，源一律是 /dev/null', () => {
  const args = shieldArgs()
  assert.ok(args.length > 0)
  assert.equal(args.length % 3, 0, '每个遮蔽项占三个位置')

  for (let i = 0; i < args.length; i += 3) {
    assert.equal(args[i], '--ro-bind-try', '用 try 版本，文件不存在时不报错')
    assert.equal(args[i + 1], '/dev/null', '盖成空设备，读出来是空的')
    assert.ok(path.isAbsolute(args[i + 2]), '被遮蔽的必须是绝对路径')
  }
})

test('项目根的 .env 在遮蔽列表里', () => {
  const args = shieldArgs()
  const targets = args.filter((_, i) => i % 3 === 2)
  assert.ok(targets.includes(path.join(projectRoot, '.env')))
})

test('SSH 私钥在遮蔽列表里', () => {
  const targets = shieldArgs().filter((_, i) => i % 3 === 2)
  for (const name of ['id_rsa', 'id_ed25519', 'id_ecdsa']) {
    assert.ok(
      targets.some((item) => item.endsWith(name)),
      `${name} 必须被遮蔽`,
    )
  }
})
