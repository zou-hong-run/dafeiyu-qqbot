import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { inflateRawSync } from 'node:zlib'
import { sensitiveReason } from '../ops/file-policy.js'

// 文档解析：把 PDF / Word / Excel 里的文字读出来喂给模型
// 用纯 JS 的解析库（不依赖原生 canvas），别换成会拉 15MB 原生库的那种
//
// 下面三个库都按需加载：服务器上少装一个，read_document 报错就行，
// 不能让整个内置工具服务跟着崩 —— 那样连搜索、shell、天气全都没了
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const MAX_BYTES = 20 * 1024 * 1024
const MAX_TEXT = 8000

// xlsx 是 zip，解析库会把它整个解压进内存。压缩后 20MB 的表解压后可能上 GB，
// 而内置 MCP 子进程堆上限只有 160MB，一个文件就能把全部工具打挂。
// 所以解析前先看中央目录里声明的大小；声明值可以伪造，再实测解压一遍（见 measureInflation）。
const ZIP_LIMITS = {
  maxTotalBytes: 64 * 1024 * 1024, // 解压后总量
  maxEntryBytes: 32 * 1024 * 1024, // 单条目
  maxRatio: 120, // 总压缩比
}

const EOCD_SIGNATURE = 0x06054b50
const ENTRY_SIGNATURE = 0x02014b50
const LOCAL_SIGNATURE = 0x04034b50
const EOCD_MIN = 22
const METHOD_STORED = 0
const METHOD_DEFLATE = 8

// backups/ 是 data/ 的副本、logs/ 是命令输出、tmp/ 是沙箱脚本，和 data/ 一样不该进模型上下文
// 黑名单统一在 ops/file-policy.js，和 send_file 共用一份，免得一边补了另一边漏

function resolvePath(input) {
  const raw = String(input ?? '').trim()
  if (!raw) throw new Error('缺少文件路径')

  const cleaned = raw.replace(/^\.\//, '').replace(/^[/\\]+/, '')
  const full = path.resolve(projectRoot, cleaned)

  if (full !== projectRoot && !full.startsWith(projectRoot + path.sep)) {
    throw new Error('只能读项目目录内的文件')
  }

  const rel = path.relative(projectRoot, full).split(path.sep).join('/')
  const reason = sensitiveReason(rel)
  if (reason) {
    throw new Error(`这个路径不开放（${rel}）：${reason}`)
  }

  if (!fs.existsSync(full)) throw new Error(`文件不存在：${rel}`)
  return full
}

// 可选依赖：加载失败就记下来，工具被调用时再明确报「缺哪个包」
const optionalLibs = new Map()

async function loadLib(name) {
  if (optionalLibs.has(name)) return optionalLibs.get(name)

  try {
    const lib = await import(name)
    optionalLibs.set(name, lib)
    return lib
  } catch {
    // 失败不要缓存：以前存了 null，装上包也得重启才能用，白折腾一轮
    return null
  }
}

async function requireLib(name, what) {
  const lib = await loadLib(name)
  if (!lib) {
    throw new Error(`服务器上没装 ${name}，${what}读不了。在项目目录跑一次 pnpm install 再试`)
  }
  return lib
}

async function readPdf(buffer) {
  const unpdf = await requireLib('unpdf', 'PDF')
  const pdf = await unpdf.getDocumentProxy(new Uint8Array(buffer))
  const { text, totalPages } = await unpdf.extractText(pdf, { mergePages: true })
  const value = Array.isArray(text) ? text.join('\n') : String(text ?? '')
  return { text: value, pages: totalPages, format: 'PDF' }
}

async function readDocx(buffer) {
  const lib = await requireLib('mammoth', 'Word')
  const mammoth = lib.default ?? lib
  const { value } = await mammoth.extractRawText({ buffer })
  return { text: String(value ?? ''), format: 'Word' }
}

/**
 * 读 zip 中央目录，返回每个条目的元信息。
 * 只取结构字段，不信其中的大小声明——声明值是攻击者可控的。
 */
function zipEntries(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < EOCD_MIN) {
    throw new Error('文件太小，不是有效的 xlsx')
  }

  // EOCD 在末尾，最大后面跟 65535 字节注释
  const searchFrom = Math.max(0, buffer.length - EOCD_MIN - 65535)
  let eocd = -1
  for (let i = buffer.length - EOCD_MIN; i >= searchFrom; i -= 1) {
    if (buffer.readUInt32LE(i) === EOCD_SIGNATURE) {
      eocd = i
      break
    }
  }
  if (eocd < 0) throw new Error('不是有效的 xlsx（找不到 zip 目录）')

  const count = buffer.readUInt16LE(eocd + 10)
  let offset = buffer.readUInt32LE(eocd + 16)
  const list = []

  for (let index = 0; index < count; index += 1) {
    if (offset + 46 > buffer.length || buffer.readUInt32LE(offset) !== ENTRY_SIGNATURE) {
      throw new Error('xlsx 目录结构损坏')
    }

    const method = buffer.readUInt16LE(offset + 10)
    const packed = buffer.readUInt32LE(offset + 20)
    const size = buffer.readUInt32LE(offset + 24)
    const nameLen = buffer.readUInt16LE(offset + 28)
    const extraLen = buffer.readUInt16LE(offset + 30)
    const commentLen = buffer.readUInt16LE(offset + 32)
    const localOffset = buffer.readUInt32LE(offset + 42)
    const nameEnd = offset + 46 + nameLen
    const name = nameEnd <= buffer.length ? buffer.toString('utf8', offset + 46, nameEnd) : ''

    list.push({ name, method, packed, size, localOffset })

    offset += 46 + nameLen + extraLen + commentLen
  }

  return list
}

/** 本地文件头 → 压缩数据起始位置（中央目录里的偏移指向这里） */
function localDataStart(buffer, localOffset) {
  if (localOffset + 30 > buffer.length || buffer.readUInt32LE(localOffset) !== LOCAL_SIGNATURE) {
    throw new Error('xlsx 条目头损坏或偏移被伪造，不解析')
  }
  const nameLen = buffer.readUInt16LE(localOffset + 26)
  const extraLen = buffer.readUInt16LE(localOffset + 28)
  const start = localOffset + 30 + nameLen + extraLen
  if (start > buffer.length) throw new Error('xlsx 条目偏移越界，不解析')
  return start
}

/**
 * 汇总中央目录里声明的大小。只用于快速失败，不能当作安全依据。
 */
export function inspectZip(buffer) {
  const entries = zipEntries(buffer)

  let totalBytes = 0
  let totalPacked = 0
  let maxEntryBytes = 0

  for (const entry of entries) {
    totalBytes += entry.size
    totalPacked += entry.packed
    maxEntryBytes = Math.max(maxEntryBytes, entry.size)
  }

  return {
    entries: entries.length,
    totalBytes,
    totalPacked,
    maxEntryBytes,
    ratio: totalPacked > 0 ? totalBytes / totalPacked : 1,
  }
}

/**
 * 实测解压：逐条目真解一遍，用 maxOutputLength 卡住单条目输出。
 *
 * 只信中央目录的声明值是不够的——8MB 重复数据能压到 8.3KB，
 * 只要把中央目录里的 uncompressedSize 改写成 100，声明检查就一路放行，
 * 而 deflate 流照样解出 8MB。防御不能建立在「攻击者会诚实填 size」上。
 *
 * 解出来的内容用完即弃，不驻留内存；累计超过总量上限立刻停。
 */
export function measureInflation(buffer, limits = ZIP_LIMITS) {
  const entries = zipEntries(buffer)
  const entryCap = Math.max(1, limits.maxEntryBytes)
  const totalCap = Math.max(1, limits.maxTotalBytes)

  let totalBytes = 0
  let maxEntryBytes = 0

  for (const entry of entries) {
    const start = localDataStart(buffer, entry.localOffset)
    let actual = 0

    if (entry.method === METHOD_STORED) {
      // 不压缩：文件里有多少字节就是多少，不可能超过文件本身
      actual = Math.min(entry.packed, buffer.length - start)
    } else if (entry.method === METHOD_DEFLATE) {
      if (entry.packed === 0) continue
      try {
        actual = inflateRawSync(buffer.subarray(start), { maxOutputLength: entryCap }).length
      } catch (error) {
        if (error?.code === 'ERR_BUFFER_TOO_LARGE') {
          throw new Error(
            `表格里单个条目实际解压超过 ${Math.round(entryCap / 1048576)}MB 上限，疑似解压炸弹，不解析`,
          )
        }
        throw new Error(`xlsx 条目解压失败（${entry.name || '未知条目'}）：文件损坏或伪造，不解析`)
      }
    } else {
      throw new Error(`xlsx 里有不支持的压缩方式（method ${entry.method}），不解析`)
    }

    totalBytes += actual
    maxEntryBytes = Math.max(maxEntryBytes, actual)

    if (totalBytes > totalCap) {
      throw new Error(
        `表格实际解压超过 ${Math.round(totalCap / 1048576)}MB 上限，疑似解压炸弹，不解析`,
      )
    }
  }

  return {
    entries: entries.length,
    totalBytes,
    totalPacked: buffer.length,
    maxEntryBytes,
    ratio: buffer.length > 0 ? totalBytes / buffer.length : 1,
  }
}

/**
 * 解压炸弹前置检查：先看声明值（便宜），再实测（可信）。
 * 超限就别交给解析库——炸弹在 load() 阶段才爆，那时子进程已经挂了。
 */
export function assertZipSafe(buffer, limits = ZIP_LIMITS) {
  const declared = inspectZip(buffer)

  if (declared.totalBytes > limits.maxTotalBytes) {
    throw new Error(
      `这个表格解压后有 ${(declared.totalBytes / 1048576).toFixed(0)}MB，超过 ${limits.maxTotalBytes / 1048576}MB 上限，不解析`,
    )
  }
  if (declared.maxEntryBytes > limits.maxEntryBytes) {
    throw new Error(
      `表格里单个条目解压后有 ${(declared.maxEntryBytes / 1048576).toFixed(0)}MB，超过上限，不解析`,
    )
  }
  if (declared.ratio > limits.maxRatio) {
    throw new Error(
      `压缩比 ${declared.ratio.toFixed(0)}:1 异常（正常表格不会超过 100:1），疑似解压炸弹，不解析`,
    )
  }

  // 声明值过关也可能是伪造的，实测一遍才算数
  const actual = measureInflation(buffer, limits)
  if (actual.ratio > limits.maxRatio) {
    // 用实测解压量对比文件实际大小算的压缩比，这个伪造不了
    throw new Error(
      `实测压缩比 ${actual.ratio.toFixed(0)}:1 异常（正常表格不会超过 100:1），疑似解压炸弹，不解析`,
    )
  }
  return actual
}

// Excel 单元格的值可能是数字、日期、富文本、公式、超链接，统一转成可读字符串
function cellText(value) {
  if (value == null) return ''
  if (value instanceof Date) return value.toISOString().slice(0, 10)
  if (typeof value !== 'object') return String(value)

  if (Array.isArray(value.richText)) return value.richText.map((item) => item.text ?? '').join('')
  if (value.text !== undefined) return String(value.text)
  if (value.result !== undefined) return String(value.result)
  if (value.hyperlink) return String(value.hyperlink)
  return ''
}

async function readSpreadsheet(buffer, ext) {
  // .csv 本身就是文本，不用解析库，直接读前 200 行
  if (ext === '.csv') {
    const lines = buffer.toString('utf8').split(/\r?\n/).filter(Boolean).slice(0, 200)
    return { text: lines.join('\n'), format: 'CSV' }
  }

  if (ext === '.xls') {
    throw new Error('老版 Excel（.xls）解析不了，另存为 .xlsx 再发')
  }

  const lib = await requireLib('exceljs', 'Excel')
  const ExcelJS = lib.default ?? lib

  // 先看 zip 声明的大小，再交给解析库——解压炸弹在 load() 阶段才爆，那时已经来不及
  assertZipSafe(buffer)

  const workbook = new ExcelJS.Workbook()
  await workbook.xlsx.load(buffer)

  const parts = []
  for (const sheet of workbook.worksheets.slice(0, 5)) {
    const rows = []
    sheet.eachRow((row) => {
      const cells = []
      row.eachCell({ includeEmpty: false }, (cell) => {
        const text = cellText(cell.value)
        if (text) cells.push(text)
      })
      if (cells.length > 0) rows.push(cells.join(','))
    })
    if (rows.length > 0) parts.push(`【${sheet.name}】\n${rows.join('\n')}`)
  }

  return {
    text: parts.join('\n\n'),
    format: 'Excel',
    sheets: workbook.worksheets.length,
  }
}

async function readPlain(buffer) {
  return { text: buffer.toString('utf8'), format: '纯文本' }
}

async function readDocument(input) {
  const file = resolvePath(input)
  const stat = fs.statSync(file)

  if (stat.size > MAX_BYTES) {
    throw new Error(`文件 ${(stat.size / 1048576).toFixed(1)}MB，超过 ${MAX_BYTES / 1048576}MB 上限`)
  }

  const ext = path.extname(file).toLowerCase()
  const buffer = fs.readFileSync(file)
  const rel = path.relative(projectRoot, file).split(path.sep).join('/')

  let result
  if (ext === '.pdf') result = await readPdf(buffer)
  else if (ext === '.docx') result = await readDocx(buffer)
  else if (ext === '.xlsx' || ext === '.xls' || ext === '.csv') result = await readSpreadsheet(buffer, ext)
  else if (['.txt', '.md', '.json', '.log', '.js', '.py', '.html', '.xml', '.yml', '.yaml'].includes(ext)) {
    result = await readPlain(buffer)
  } else if (ext === '.doc') {
    throw new Error('老版 .doc 读不了，另存成 .docx 再试')
  } else {
    throw new Error(`不支持的格式：${ext || '无扩展名'}。支持 pdf / docx / xlsx / csv / 常见文本（老版 .xls 请另存为 .xlsx）`)
  }

  const text = String(result.text ?? '').replace(/\r/g, '').replace(/\n{3,}/g, '\n\n').trim()
  if (!text) {
    return `读到了 ${rel}（${result.format}），但里面没有可提取的文字——可能是扫描件或纯图片文档。`
  }

  const clipped = text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT)}\n…（原文 ${text.length} 字，已截断）` : text

  const meta = [`${result.format}${result.pages ? ` ${result.pages} 页` : ''}${result.sheets ? ` ${result.sheets} 个工作表` : ''}`, `${text.length} 字`]

  return `=== ${rel}（${meta.join('，')}）===\n${clipped}`
}

export const DOC_TOOLS = [
  {
    name: 'read_document',
    type: 'tool',
    description:
      '读文档内容：PDF、Word(.docx)、Excel(.xlsx/.csv) 和常见文本文件，提取文字给模型看；老版 .xls 会提示另存为 .xlsx。' +
      '文件要放在项目目录里（downloads/ 或项目根），20MB 以内，正文截断到 8000 字。' +
      '扫描版 PDF 提取不出文字时会明确告诉你。',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '相对项目根的文件路径，如 downloads/报告.pdf' },
      },
      required: ['path'],
    },
  },
]

export const DOC_HANDLERS = { read_document: readDocument }
