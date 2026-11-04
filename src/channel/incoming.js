import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// 入站附件：SDK 会把 attachments 解析成 event.message 里的 image / voice / video / file 元素
// 我们之前完全忽略它们，用户发语音、发图，机器人等于什么都收不到
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const incomingRoot = path.join(projectRoot, 'downloads', 'incoming')

// 群和私聊、不同群之间必须分开存：不然 A 群的图能被 B 群捞出来发
function scopeDirOf(scopeKey) {
  const safe = String(scopeKey ?? '').replace(/[^a-zA-Z0-9_-]/g, '') || 'unknown'
  return path.join(incomingRoot, safe)
}

const MAX_ITEMS = 4
const MAX_BYTES = 20 * 1024 * 1024
const MAX_TEXT_CHARS = 400
const DOWNLOAD_TIMEOUT_MS = 20_000

const KIND_LABEL = {
  image: '图片',
  voice: '语音',
  audio: '语音',
  video: '视频',
  file: '文件',
}

// QQ 发的图不一定是 <image> 元素：手机相册里选「以文件发送」、或者 webp 这类格式，
// 平台给的是 <file file_type=4001 filename="IMG_9275.WEBP">，SDK 按 content_type 切出来就是 file。
// 只信 elem.type 的话这些图永远进不了多模态，所以扩展名和文件头都得参与判断。
const IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp'])

function extOf(name) {
  const ext = path.extname(String(name ?? '')).toLowerCase()
  return IMAGE_EXTS.has(ext) ? ext : ''
}

function extFromUrl(url) {
  try {
    const pathname = new URL(url).pathname
    return extOf(decodeURIComponent(pathname.split('/').pop() ?? ''))
  } catch {
    return ''
  }
}

// 按「声明的类型 + 文件名扩展名」定最终类型，file 元素里的图会被认成 image
function kindOf(type, name, url) {
  if (type === 'image') return 'image'
  if (KIND_LABEL[type] && type !== 'file') return type

  const ext = extOf(name) || extFromUrl(url)
  if (ext) return 'image'
  return KIND_LABEL[type] ? type : ''
}

// 文件头嗅探：扩展名缺失也能认出来（QQ 偶尔给无扩展名的直链）
function sniffImageExt(buffer) {
  if (!buffer || buffer.length < 12) return ''

  if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) return '.png'
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return '.jpg'
  if (buffer[0] === 0x47 && buffer[1] === 0x49 && buffer[2] === 0x46) return '.gif'
  if (
    buffer[0] === 0x52 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x46 &&
    buffer[8] === 0x57 && buffer[9] === 0x45 && buffer[10] === 0x42 && buffer[11] === 0x50
  ) {
    return '.webp'
  }
  if (buffer[0] === 0x42 && buffer[1] === 0x4d) return '.bmp'
  return ''
}

export function extractInbound(event) {
  const items = []

  for (const elem of event?.message ?? []) {
    const url = elem.data?.url
    if (!url) continue

    const name = String(elem.data?.name ?? '').slice(0, 80)
    const fullUrl = String(url).startsWith('http') ? String(url) : `https://${url}`
    const type = kindOf(elem?.type, name, fullUrl)
    if (!type) continue

    items.push({
      type,
      url: fullUrl,
      name,
      size: Number(elem.data?.size) || 0,
    })

    if (items.length >= MAX_ITEMS) break
  }

  return items
}

function safeName(item, index) {
  const raw = item.name || ''
  const ext = path.extname(raw).toLowerCase().slice(0, 6)
  const base = raw.replace(/\.[^.]+$/, '').replace(/[^\w\u4e00-\u9fa5-]/g, '').slice(0, 20)
  return `${Date.now()}-${index}-${base || item.type}${ext || ''}`
}

async function downloadOne(item, index, dir) {
  if (item.size > MAX_BYTES) {
    return { ...item, error: `超过 ${MAX_BYTES / 1048576}MB，没有下载` }
  }

  try {
    fs.mkdirSync(dir, { recursive: true })

    const response = await fetch(item.url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) })
    if (!response.ok) return { ...item, error: `下载失败 HTTP ${response.status}` }

    const buffer = Buffer.from(await response.arrayBuffer())
    if (buffer.length > MAX_BYTES) return { ...item, error: '下载后超过大小上限' }

    // 扩展名和文件头都不像图片却声明成 image：说明对方发的是别的东西，别硬喂给模型
    let type = item.type
    const sniffed = sniffImageExt(buffer)
    if (sniffed && type !== 'image') type = 'image'
    if (!sniffed && type === 'image' && buffer.length > 0) type = 'file'

    const finalItem = { ...item, type, name: item.name || `${item.type}${sniffed || ''}` }
    const file = path.join(dir, safeName(finalItem, index))
    fs.writeFileSync(file, buffer)

    return { ...finalItem, file: path.relative(projectRoot, file).split(path.sep).join('/') }
  } catch (error) {
    return { ...item, error: String(error?.message ?? error).slice(0, 80) }
  }
}

// 把附件整理成一段给模型看的说明，拼在用户输入后面
export async function describeInbound(items, scopeKey = '') {
  if (items.length === 0) return { text: '', images: [], voice: 0 }

  const dir = scopeDirOf(scopeKey)
  const downloaded = await Promise.all(items.map((item, index) => downloadOne(item, index, dir)))
  const lines = []
  const images = []

  for (const item of downloaded) {
    const label = KIND_LABEL[item.type] ?? item.type

    if (item.file) {
      lines.push(
        `[${label}] 已存到 ${item.file}${item.size ? `（${(item.size / 1024).toFixed(0)} KB）` : ''}`,
      )
      if (item.type === 'image') images.push(item.file)
    } else {
      lines.push(`[${label}] ${item.error ?? '没有拿到下载地址'}`)
    }
  }

  const voiceCount = downloaded.filter((item) => item.type === 'voice' || item.type === 'audio').length
  if (voiceCount > 0) {
    lines.push(
      '注意：语音消息我这边没有转文字服务，听不到内容，只能看到文件。' +
        '需要的话可以告诉对方「发语音我听不了，打字说」，或者用 send_audio 把这条转发出去。',
    )
  }

  const text = lines.join('\n')
  return `\n\n（对方还发了 ${items.length} 个附件）\n${text}`.slice(0, MAX_TEXT_CHARS * 4)
}

// 入站附件按 mtime 定期清理：2G 机器磁盘也不富裕，收进来的图/语音不该永久堆积
export async function cleanupIncoming(ttlHours = 24) {
  if (!(ttlHours > 0)) return 0

  const ttlMs = ttlHours * 3600 * 1000
  const now = Date.now()
  let removed = 0

  const walk = (dir, depth = 0) => {
    if (depth > 2) return

    let entries = []
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }

    for (const entry of entries) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        walk(full, depth + 1)
        continue
      }

      try {
        const info = fs.statSync(full)
        if (now - info.mtimeMs <= ttlMs) continue
        fs.rmSync(full, { force: true })
        removed += 1
      } catch {
        // 单个文件删不掉不影响其他
      }
    }
  }

  walk(incomingRoot)
  return removed
}

export function clearIncoming() {
  try {
    fs.rmSync(incomingRoot, { recursive: true, force: true })
  } catch {
    // 目录不存在或删不掉都不影响
  }
}
