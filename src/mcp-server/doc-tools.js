import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// 文档解析：把 PDF / Word / Excel 里的文字读出来喂给模型
// 用纯 JS 的解析库（不依赖原生 canvas），别换成会拉 15MB 原生库的那种
//
// 下面三个库都按需加载：服务器上少装一个，read_document 报错就行，
// 不能让整个内置工具服务跟着崩 —— 那样连搜索、shell、天气全都没了
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const MAX_BYTES = 20 * 1024 * 1024
const MAX_TEXT = 8000

// backups/ 是 data/ 的副本、logs/ 是命令输出，和 data/ 一样不该进模型上下文
const BLOCKED = [/^\.env/, /^data\//, /^node_modules\//, /^\.git\//, /^backups\//, /^logs\//]

function resolvePath(input) {
  const raw = String(input ?? '').trim()
  if (!raw) throw new Error('缺少文件路径')

  const cleaned = raw.replace(/^\.\//, '').replace(/^[/\\]+/, '')
  const full = path.resolve(projectRoot, cleaned)

  if (full !== projectRoot && !full.startsWith(projectRoot + path.sep)) {
    throw new Error('只能读项目目录内的文件')
  }

  const rel = path.relative(projectRoot, full).split(path.sep).join('/')
  if (BLOCKED.some((pattern) => pattern.test(rel))) {
    throw new Error(`这个路径不开放（${rel}）：密钥、运行时数据和依赖目录不读`)
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
    optionalLibs.set(name, null)
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
    throw new Error(`不支持的格式：${ext || '无扩展名'}。支持 pdf / docx / xlsx / xls / csv / 常见文本`)
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
      '读文档内容：PDF、Word(.docx)、Excel(.xlsx/.xls/.csv) 和常见文本文件，提取文字给模型看。' +
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
