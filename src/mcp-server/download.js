import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const downloadDir = path.join(projectRoot, 'downloads')

const MAX_BYTES = 50 * 1024 * 1024
const KEEP_FILES = 50
// 单次调用的下载预算。MCP 工具整体超时是 60 秒，这里留出余量：
// 下不完不要紧，进度留在 .part 里，下次调用用 Range 接着下。
const DEFAULT_BUDGET_SECONDS = 40
const MAX_BUDGET_SECONDS = 50

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

/** 看文件头判断真实类型：网上不少链接点开是网页，存下来体积也像文件 */
function sniffFile(filePath) {
  try {
    const fd = fs.openSync(filePath, 'r')
    const buf = Buffer.alloc(12)
    const read = fs.readSync(fd, buf, 0, 12, 0)
    fs.closeSync(fd)
    const head = buf.subarray(0, read)

    if (head.subarray(0, 8).toString('hex') === '89504e470d0a1a0a') return { type: 'image/png', ok: true }
    if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return { type: 'image/jpeg', ok: true }
    if (head.subarray(0, 4).toString() === 'GIF8') return { type: 'image/gif', ok: true }
    if (head.subarray(0, 4).toString() === 'RIFF' && head.subarray(8, 12).toString() === 'WEBP') {
      return { type: 'image/webp', ok: true }
    }
    if (head.subarray(0, 3).toString() === 'ID3') return { type: 'audio/mpeg', ok: true }
    if (head[0] === 0xff && (head[1] & 0xe0) === 0xe0) return { type: 'audio/mpeg', ok: true }
    if (head.subarray(0, 4).toString() === 'OggS') return { type: 'audio/ogg', ok: true }
    if (head.subarray(0, 4).toString() === 'RIFF') return { type: 'audio/wav', ok: true }
    if (head.subarray(0, 4).toString() === 'fLaC') return { type: 'audio/flac', ok: true }
    // m4a / mp4：第 4-8 字节是 'ftyp'
    if (head.subarray(4, 8).toString() === 'ftyp') return { type: 'audio/mp4', ok: true }
    if (head.subarray(0, 4).toString() === 'PK\u0003\u0004') return { type: 'application/zip', ok: true }
    if (head.subarray(0, 4).toString() === '%PDF') return { type: 'application/pdf', ok: true }
    if (/^\s*<(!doctype|html|head|body|\?xml)/i.test(head.toString('utf8'))) {
      return { type: 'text/html', ok: false }
    }
    return { type: '未知', ok: true }
  } catch {
    return { type: '未知', ok: true }
  }
}

function pruneOldFiles() {
  try {
    const files = fs
      .readdirSync(downloadDir)
      .filter((file) => !file.endsWith('.part'))
      .map((file) => ({ file, mtime: fs.statSync(path.join(downloadDir, file)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime)

    for (const item of files.slice(KEEP_FILES)) {
      fs.rmSync(path.join(downloadDir, item.file), { force: true })
    }
  } catch {
    return
  }
}

function describeProgress(have, total) {
  const mb = (value) => (value / 1048576).toFixed(2)
  if (total > 0) return `${mb(have)} / ${mb(total)} MB（${Math.floor((have / total) * 100)}%）`
  return `${mb(have)} MB（总大小未知）`
}

async function download({ url, filename, seconds }) {
  const target = assertPublicUrl(url)
  fs.mkdirSync(downloadDir, { recursive: true })

  const name = safeFileName(filename || nameFromUrl(target))
  const finalPath = path.join(downloadDir, name)
  const partPath = `${finalPath}.part`

  // 已经完整下过：直接告诉他，不重复下
  if (fs.existsSync(finalPath)) {
    const size = fs.statSync(finalPath).size
    const kind = sniffFile(finalPath)
    return [
      `已经在服务器上了：${path.basename(finalPath)}`,
      `大小：${(size / 1024).toFixed(0)} KB｜实际类型：${kind.type}`,
      `路径：${finalPath}`,
      '要重新下载就先删掉它。',
    ].join('\n')
  }

  const have = fs.existsSync(partPath) ? fs.statSync(partPath).size : 0
  const budget =
    Math.min(Math.max(Math.floor(Number(seconds) || DEFAULT_BUDGET_SECONDS), 5), MAX_BUDGET_SECONDS) * 1000

  const headers = { 'User-Agent': 'Mozilla/5.0 (compatible; qq-bot/1.0)' }
  if (have > 0) headers.Range = `bytes=${have}-`

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), budget)

  let response
  try {
    response = await fetch(target, { redirect: 'follow', headers, signal: controller.signal })
  } catch (error) {
    clearTimeout(timer)
    if (controller.signal.aborted) {
      return `这次 ${Math.round(budget / 1000)} 秒没下到新内容，已有 ${describeProgress(have, 0)}。再调一次同样的 url 接着下。`
    }
    throw error
  }

  if (!response.ok && response.status !== 206) {
    clearTimeout(timer)
    throw new Error(`下载失败，HTTP ${response.status}`)
  }

  // 服务端不支持断点续传会回 200 并从头发，那就把已下的丢掉重来
  let start = have
  if (response.status === 200 && have > 0) {
    start = 0
    fs.rmSync(partPath, { force: true })
  }

  const range = response.headers.get('content-range')
  const totalFromRange = range ? Number(range.split('/')[1]) : 0
  const declared = Number(response.headers.get('content-length') ?? 0)
  const total = totalFromRange || (declared > 0 ? start + declared : 0)

  if (total > MAX_BYTES) {
    clearTimeout(timer)
    throw new Error(`文件太大（${(total / 1048576).toFixed(1)} MB），上限 50 MB`)
  }

  const stream = fs.createWriteStream(partPath, { flags: start > 0 ? 'a' : 'w' })
  let written = start

  try {
    for await (const chunk of response.body) {
      written += chunk.length
      if (written > MAX_BYTES) throw new Error('文件超过 50 MB，已中止下载')
      if (!stream.write(chunk)) {
        await new Promise((resolve) => stream.once('drain', resolve))
      }
    }
  } catch (error) {
    await new Promise((resolve) => stream.end(resolve))
    clearTimeout(timer)

    if (controller.signal.aborted || error?.name === 'AbortError') {
      const done = describeProgress(written, total)
      return [
        `这次下了 ${Math.round(budget / 1000)} 秒，进度 ${done}。`,
        `还没下完，再调一次同样的 url 和 filename 会从断点继续，不会从头开始。`,
        `如果多次都下不动，说明这个源太慢，换个地址。`,
      ].join('\n')
    }

    if (/50 MB/.test(String(error?.message ?? ''))) throw error
    throw new Error(`下载中断：${error?.message ?? error}（已下 ${describeProgress(written, total)}，可重试续传）`)
  }

  await new Promise((resolve) => stream.end(resolve))
  clearTimeout(timer)

  fs.rmSync(finalPath, { force: true })
  fs.renameSync(partPath, finalPath)

  const kind = sniffFile(finalPath)

  // 存下来是网页：多半是错误页、登录页或者防盗链，别当成文件给人
  if (!kind.ok) {
    fs.rmSync(finalPath, { force: true })
    throw new Error(
      '这个链接返回的是网页（HTML），不是文件本身。' +
        '要读网页内容请用 fetch；要下载图片/音乐/文档，需要找到真正的直链（通常以 .jpg/.mp3/.pdf 结尾）。',
    )
  }

  pruneOldFiles()

  const finished = total > 0 && written >= total
  return [
    `已下载完成：${path.basename(finalPath)}`,
    `大小：${(written / 1024).toFixed(0)} KB${total > 0 ? `（${describeProgress(written, total)}）` : ''}`,
    `实际类型：${kind.type}（按文件头判断，比网址后缀可靠）`,
    `路径：${finalPath}`,
    finished ? '' : '注意：服务端没给总大小，无法确认是否完整，用之前先看一下文件能不能打开。',
  ]
    .filter(Boolean)
    .join('\n')
}

export const DOWNLOAD_HANDLERS = { download }

export const DOWNLOAD_TOOLS = [
  {
    name: 'download',
    description:
      '把一个网络文件下载到服务器本地（图片、音乐、文档、压缩包等）。' +
      '支持断点续传：单次最多下 40 秒，没下完会返回「进度 X/Y，再调一次继续」，' +
      '再调一次同样的 url 和 filename 就从断点接着下，不会从头开始——大文件（比如几 MB 的歌）必须这样循环调几次。' +
      '下完会按文件头校验类型，如果发现是网页会报错并删除，说明链接不是直链。' +
      '单个文件上限 50MB。',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: '要下载的完整 http/https 直链' },
        filename: {
          type: 'string',
          description: '保存的文件名（可选）。续传时必须和上一次传的一样，否则会当成新文件',
        },
        seconds: {
          type: 'integer',
          minimum: 5,
          maximum: 50,
          description: '本次最多下多少秒，默认 40。网速慢时不用调大，多调几次就行',
        },
      },
      required: ['url'],
    },
  },
]
