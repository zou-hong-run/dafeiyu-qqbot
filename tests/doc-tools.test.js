import test from 'node:test'
import assert from 'node:assert/strict'
import ExcelJS from 'exceljs'
import { deflateRawSync } from 'node:zlib'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { assertZipSafe, DOC_HANDLERS, inspectZip, measureInflation } from '../src/mcp-server/doc-tools.js'

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

// 解压炸弹防护：解析前先读 zip 中央目录里声明的大小。
// 顺带验证 uuid override 到 11.x 之后 exceljs 还能正常读写。

async function buildXlsx() {
  const workbook = new ExcelJS.Workbook()
  const sheet = workbook.addWorksheet('测试')
  sheet.addRow(['名字', '数量'])
  sheet.addRow(['大鱼', 42])
  return Buffer.from(await workbook.xlsx.writeBuffer())
}

test('正常 xlsx 能读到目录结构', async () => {
  const zip = inspectZip(await buildXlsx())

  assert.ok(zip.entries > 0, '应该有目录条目')
  assert.ok(zip.totalBytes > 0, '解压后总大小应该大于 0')
  assert.ok(zip.ratio < 120, '正常表格压缩比不会夸张')
})

test('正常 xlsx 通过安全检查', async () => {
  const buffer = await buildXlsx()
  assert.doesNotThrow(() => assertZipSafe(buffer))
})

test('声明解压体积超限时拒绝', async () => {
  const buffer = await buildXlsx()
  assert.throws(
    () => assertZipSafe(buffer, { maxTotalBytes: 10, maxEntryBytes: 1024, maxRatio: 100 }),
    /解压后有 .* 超过|上限/,
  )
})

test('单条目超限时拒绝', async () => {
  const buffer = await buildXlsx()
  const zip = inspectZip(buffer)
  assert.throws(
    () =>
      assertZipSafe(buffer, {
        maxTotalBytes: zip.totalBytes + 1,
        maxEntryBytes: 1,
        maxRatio: 1000,
      }),
    /单个条目/,
  )
})

test('压缩比异常时拒绝', async () => {
  const buffer = await buildXlsx()
  assert.throws(
    () =>
      assertZipSafe(buffer, {
        maxTotalBytes: 1024 * 1024,
        maxEntryBytes: 1024 * 1024,
        maxRatio: 0.01,
      }),
    /压缩比/,
  )
})

test('不是 zip 的文件直接拒绝', () => {
  assert.throws(() => inspectZip(Buffer.from('这不是一个表格，只是一段文字而已'.repeat(5))), /zip 目录/)
})

test('文件太小直接拒绝', () => {
  assert.throws(() => inspectZip(Buffer.from('x')), /太小/)
})

// ── 伪造声明值的解压炸弹 ──
// 中央目录里的 uncompressedSize 是文件作者自己填的，改小就能骗过声明检查。
// 这里手工拼一个 zip：8MB 重复数据压成 8.3KB，声明值只写 100 字节。

function buildZip({ name = 'xl/worksheets/sheet1.xml', data, declaredSize }) {
  const deflated = deflateRawSync(data)
  const nameBuf = Buffer.from(name, 'utf8')
  const crc = 0 // 解析侧不校验 crc，留 0

  const local = Buffer.alloc(30)
  local.writeUInt32LE(0x04034b50, 0)
  local.writeUInt16LE(20, 4)
  local.writeUInt16LE(0, 6)
  local.writeUInt16LE(8, 8)
  local.writeUInt32LE(crc, 14)
  local.writeUInt32LE(deflated.length, 18)
  local.writeUInt32LE(declaredSize ?? data.length, 22)
  local.writeUInt16LE(nameBuf.length, 26)

  const central = Buffer.alloc(46)
  central.writeUInt32LE(0x02014b50, 0)
  central.writeUInt16LE(20, 4)
  central.writeUInt16LE(20, 6)
  central.writeUInt16LE(8, 10)
  central.writeUInt32LE(crc, 16)
  central.writeUInt32LE(deflated.length, 20)
  central.writeUInt32LE(declaredSize ?? data.length, 24)
  central.writeUInt16LE(nameBuf.length, 28)
  central.writeUInt32LE(0, 42)

  const localPart = Buffer.concat([local, nameBuf, deflated])
  const centralPart = Buffer.concat([central, nameBuf])

  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(1, 8)
  eocd.writeUInt16LE(1, 10)
  eocd.writeUInt32LE(centralPart.length, 12)
  eocd.writeUInt32LE(localPart.length, 16)

  return Buffer.concat([localPart, centralPart, eocd])
}

const BOMB_LIMITS = {
  maxTotalBytes: 1024 * 1024,
  maxEntryBytes: 900 * 1024,
  maxRatio: 120,
}

test('声明的解压大小被伪造时，实测解压仍然拦得住', () => {
  const data = Buffer.alloc(8 * 1024 * 1024, 'a')
  const bomb = buildZip({ data, declaredSize: 100 })

  // 声明值看起来完全正常：100 字节，压缩比还不到 0.02
  const declared = inspectZip(bomb)
  assert.equal(declared.totalBytes, 100, '声明值被改写成 100')
  assert.ok(declared.ratio < 1, '按声明值算的压缩比正常，声明检查会放行')

  // 实测解压 8MB，撞上总量上限
  assert.throws(() => assertZipSafe(bomb, BOMB_LIMITS), /实际解压超过/)
})

test('单条目实测超限时拒绝', () => {
  const data = Buffer.alloc(4 * 1024 * 1024, 'b')
  const bomb = buildZip({ data, declaredSize: 50 })

  assert.throws(
    () => assertZipSafe(bomb, { maxTotalBytes: 64 * 1024 * 1024, maxEntryBytes: 1024 * 1024, maxRatio: 120 }),
    /单个条目实际解压超过/,
  )
})

test('正常表格的实测解压量在声明值附近', async () => {
  const buffer = await buildXlsx()
  const declared = inspectZip(buffer)
  const actual = measureInflation(buffer)

  assert.equal(actual.entries, declared.entries)
  assert.ok(actual.totalBytes > 0)
  // 实测值和声明值应当基本一致（差异只来自 exceljs 生成时的一次性写法）
  assert.ok(actual.totalBytes <= declared.totalBytes * 1.5 + 4096, '实测不该远大于声明')
})

test('压缩方式不支持时拒绝，不猜', () => {
  const bomb = buildZip({ data: Buffer.from('hello'), declaredSize: 5 })
  // 把中央目录和本地头里的 method 都改成 12（bzip2）
  const centralAt = bomb.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]))
  bomb.writeUInt16LE(12, centralAt + 10)
  bomb.writeUInt16LE(12, 8)

  assert.throws(() => measureInflation(bomb), /不支持的压缩方式/)
})

test('真实 xlsx 完整走一遍 read_document（实测解压不误伤）', async () => {
  const buffer = await buildXlsx()
  const downloads = path.join(projectRoot, 'downloads')
  const name = `t-${process.pid}-${Date.now()}.xlsx`
  const file = path.join(downloads, name)
  fs.mkdirSync(downloads, { recursive: true })
  fs.writeFileSync(file, buffer)

  try {
    const output = await DOC_HANDLERS.read_document(`downloads/${name}`)
    assert.match(output, /Excel/)
    assert.match(output, /大鱼/, '表格里的内容要读出来')
  } finally {
    fs.rmSync(file, { force: true })
  }
})

test('read_document 拒绝敏感目录', async () => {
  await assert.rejects(() => DOC_HANDLERS.read_document('data/memory.json'), /不开放/)
  await assert.rejects(() => DOC_HANDLERS.read_document('logs/out.log'), /不开放/)
  await assert.rejects(() => DOC_HANDLERS.read_document('backups/20261106/memory.json'), /不开放/)
})
