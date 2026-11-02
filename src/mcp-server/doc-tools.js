import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { extractText, getDocumentProxy } from 'unpdf'
import mammoth from 'mammoth'
import * as XLSX from 'xlsx'

// 文档解析：把 PDF / Word / Excel 里的文字读出来喂给模型
// 用 unpdf（纯 JS，不依赖 canvas）而不是 pdf-parse，后者会拖进 15MB 原生库
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const MAX_BYTES = 20 * 1024 * 1024
const MAX_TEXT = 8000

const BLOCKED = [/^\.env/, /^data\//, /^node_modules\//, /^\.git\//]

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

async function readPdf(buffer) {
  const pdf = await getDocumentProxy(new Uint8Array(buffer))
  const { text, totalPages } = await extractText(pdf, { mergePages: true })
  const value = Array.isArray(text) ? text.join('\n') : String(text ?? '')
  return { text: value, pages: totalPages, format: 'PDF' }
}

async function readDocx(buffer) {
  const { value } = await mammoth.extractRawText({ buffer })
  return { text: String(value ?? ''), format: 'Word' }
}

function readSpreadsheet(buffer, ext) {
  const workbook = XLSX.read(buffer, { type: 'buffer' })
  const parts = []

  for (const name of workbook.SheetNames.slice(0, 5)) {
    const csv = XLSX.utils.sheet_to_csv(workbook.Sheets[name], { blankrows: false })
    if (csv.trim()) parts.push(`【${name}】\n${csv}`)
  }

  return { text: parts.join('\n\n'), format: ext === '.xls' ? 'Excel 97-2003' : 'Excel', sheets: workbook.SheetNames.length }
}

async function readPlain(buffer) {
  return { text: buffer.toString('utf8'), format: '纯文本' }
}

export async function readDocument(input) {
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
  else if (ext === '.xlsx' || ext === '.xls' || ext === '.csv') result = readSpreadsheet(buffer, ext)
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
