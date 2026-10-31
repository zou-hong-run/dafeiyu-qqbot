import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const MAX_CONTENT = 200_000

function resolveSafe(input) {
  const raw = String(input ?? '').trim()
  if (!raw) throw new Error('缺少文件路径')

  const target = path.resolve(projectRoot, raw)
  if (target !== projectRoot && !target.startsWith(projectRoot + path.sep)) {
    throw new Error('路径必须在项目目录内')
  }

  const rel = path.relative(projectRoot, target).split(path.sep).join('/')
  if (rel === '.env' || rel.startsWith('.env.') || rel === 'data' || rel.startsWith('data/')) {
    throw new Error('.env 和 data 目录不开放读写，密钥和记忆不允许通过工具改动')
  }

  return { target, rel }
}

function truncate(text, limit) {
  const value = String(text ?? '')
  return value.length <= limit ? value : `${value.slice(0, limit)}…（共 ${value.length} 字符，已截断）`
}

async function writeFile({ path: inputPath, content }) {
  const { target, rel } = resolveSafe(inputPath)
  const body = String(content ?? '')

  if (body.length === 0) throw new Error('内容为空')
  if (body.length > MAX_CONTENT) throw new Error(`内容 ${body.length} 字符，超过上限 ${MAX_CONTENT}`)

  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.writeFileSync(target, body, 'utf8')

  return `已写入 ${rel}（${body.length} 字符）`
}

async function readFile({ path: inputPath, limit }) {
  const { target, rel } = resolveSafe(inputPath)
  if (!fs.existsSync(target)) throw new Error(`文件不存在：${rel}`)

  const stat = fs.statSync(target)
  if (stat.isDirectory()) throw new Error(`${rel} 是目录，不是文件`)

  const max = Math.min(Math.max(Number(limit) || 8000, 500), 30_000)
  return `=== ${rel} ===\n${truncate(fs.readFileSync(target, 'utf8'), max)}`
}

async function listDir({ path: inputPath }) {
  const { target, rel } = resolveSafe(inputPath ?? '.')
  if (!fs.existsSync(target)) throw new Error(`目录不存在：${rel}`)

  const entries = fs.readdirSync(target, { withFileTypes: true })
  if (entries.length === 0) return `${rel} 是空目录`

  const lines = entries
    .map((entry) => {
      if (entry.isDirectory()) return `${entry.name}/`
      try {
        return `${entry.name}  (${fs.statSync(path.join(target, entry.name)).size} B)`
      } catch {
        return entry.name
      }
    })
    .sort()

  return `${rel} 下共 ${lines.length} 项：\n${lines.join('\n')}`
}

export const FS_HANDLERS = { write_file: writeFile, read_file: readFile, list_dir: listDir }

export const FS_TOOLS = [
  {
    name: 'write_file',
    description:
      '把文本内容写入项目内的文件（会覆盖原文件，目录不存在会自动创建）。' +
      '写脚本、新工具、配置用它，不要用 shell 的 heredoc——shell 命令有长度上限。' +
      '.env 和 data/ 目录不允许写入。',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '相对项目根的路径，如 tools/my-tool.js' },
        content: { type: 'string', description: '完整文件内容' },
      },
      required: ['path', 'content'],
    },
  },
  {
    name: 'read_file',
    description: '读取项目内文件的内容。查看日志、源码、配置时使用。',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '相对项目根的路径' },
        limit: { type: 'integer', description: '最多读取多少字符，默认 8000，上限 30000' },
      },
      required: ['path'],
    },
  },
  {
    name: 'list_dir',
    description: '列出项目内某个目录的文件和大小。',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '相对项目根的目录，默认项目根' },
      },
    },
  },
]
