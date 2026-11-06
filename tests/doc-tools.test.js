import test from 'node:test'
import assert from 'node:assert/strict'
import ExcelJS from 'exceljs'
import { assertZipSafe, inspectZip } from '../src/mcp-server/doc-tools.js'

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
