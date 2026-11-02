import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const downloadDir = path.join(projectRoot, 'downloads')

const MAX_BYTES = 50 * 1024 * 1024
const KEEP_FILES = 50
const TIMEOUT_MS = 60_000

function assertPublicUrl(raw) {
  let url
  try {
    url = new URL(String(raw ?? '').trim())
  } catch {
    throw new Error('网址格式不对，需要完整的 http:// 或 https:// 链接')
  }

  if (!/^https?:$/.test(url.protocol)) throw new Error('只支持 http 和 https 链接')

  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '')
  const blockedNames = ['localhost', 'metadata.google.internal', 'metadata']

  if (blockedNames.includes(host) || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) {
    throw new Error('不允许访问内网或云元数据地址')
  }

  const ipv4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/)
  if (ipv4) {
    const a = Number(ipv4[1])
    const b = Number(ipv4[2])
    const blocked =
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127)

    if (blocked) throw new Error('不允许访问内网或云元数据地址')
  }

  if (host === '::1' || host.startsWith('fe80:') || host.startsWith('fc') || host.startsWith('fd')) {
    throw new Error('不允许访问内网或云元数据地址')
  }

  return url
}

function safeFileName(name) {
  const base = path
    .basename(String(name ?? ''))
    .replace(/[\\/:*?"<>|\s]+/g, '_')
    .replace(/^\.+/, '')
    .slice(0, 80)
  return base || 'download.bin'
}

function nameFromUrl(url) {
  try {
    const last = decodeURIComponent(url.pathname.split('/').filter(Boolean).pop() ?? '')
    return last || 'download.bin'
  } catch {
    return 'download.bin'
  }
}

function pruneOldFiles() {
  try {
    const files = fs
      .readdirSync(downloadDir)
      .map((file) => ({ file, mtime: fs.statSync(path.join(downloadDir, file)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime)

    for (const item of files.slice(KEEP_FILES)) {
      fs.rmSync(path.join(downloadDir, item.file), { force: true })
    }
  } catch {
    return
  }
}

async function download({ url, filename }) {
  const target = assertPublicUrl(url)
  fs.mkdirSync(downloadDir, { recursive: true })

  const response = await fetch(target, {
    redirect: 'follow',
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; qq-bot/1.0)' },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  })

  if (!response.ok) throw new Error(`下载失败，HTTP ${response.status}`)

  const declared = Number(response.headers.get('content-length') ?? 0)
  if (declared > MAX_BYTES) {
    throw new Error(`文件太大（${(declared / 1048576).toFixed(1)} MB），上限 50 MB`)
  }

  const chunks = []
  let total = 0

  for await (const chunk of response.body) {
    total += chunk.length
    if (total > MAX_BYTES) throw new Error('文件超过 50 MB，已中止下载')
    chunks.push(chunk)
  }

  const name = safeFileName(filename || nameFromUrl(target))
  const filePath = path.join(downloadDir, `${Date.now()}-${name}`)
  fs.writeFileSync(filePath, Buffer.concat(chunks))
  pruneOldFiles()

  const type = response.headers.get('content-type')?.split(';')[0] || '未知类型'
  return [
    `已下载并保存到服务器：${path.basename(filePath)}`,
    `大小：${(total / 1024).toFixed(1)} KB`,
    `类型：${type}`,
    `路径：${filePath}`,
    '注意：QQ 官方机器人不能直接往群里发文件，只能告诉你保存位置。',
  ].join('\n')
}

export const DOWNLOAD_HANDLERS = { download }

export const DOWNLOAD_TOOLS = [
  {
    name: 'download',
    description:
      '把一个网络文件下载到服务器本地（图片、文档、压缩包等）。' +
      '用户给出链接让你保存/下载时使用。支持 http/https，单个文件上限 50MB，超时会中止。' +
      '注意：下载后无法直接发到 QQ 群里，只能说明保存路径。',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: '要下载的完整 http/https 链接' },
        filename: { type: 'string', description: '保存的文件名（可选），不填就从链接里推断' },
      },
      required: ['url'],
    },
  },
]
