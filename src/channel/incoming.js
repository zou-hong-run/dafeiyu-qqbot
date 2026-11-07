import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { fetchPublic } from '../mcp-server/net-guard.js'

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
    const rawUrl = String(elem.data?.url ?? '')
    // 平台会把语音识别成文字放在 asr_text：只有文字没有直链的语音也照样收，
    // 因为内容在文字里，不需要下载音频
    const asrText = String(elem.data?.asr_text ?? '').trim().slice(0, 500)
    if (!rawUrl && !asrText) continue

    const name = String(elem.data?.name ?? '').slice(0, 80)
    const fullUrl = rawUrl ? (rawUrl.startsWith('http') ? rawUrl : `https://${rawUrl}`) : ''
    const type = kindOf(elem?.type, name, fullUrl) || (asrText ? 'voice' : '')
    if (!type) continue

    items.push({
      type,
      url: fullUrl,
      name,
      size: Number(elem.data?.size) || 0,
      asrText,
    })

    if (items.length >= MAX_ITEMS) break
  }

  return items
}

// 群聊记录用的短描述：不下载、不占带宽，只把「发了什么」写清楚，
// 免得群记录里全是笼统的 [附件]——语音的识别文字在这里也顺手留下。
export function labelInbound(event) {
  const items = extractInbound(event)
  if (items.length === 0) return ''

  return items
    .map((item) => {
      const tag = `[${KIND_LABEL[item.type] ?? '附件'}]`
      if (item.asrText) return `${tag} ${item.asrText}`
      if (item.type === 'voice' || item.type === 'audio') return `${tag} 未转写`
      if (item.type === 'file' && item.name) return `${tag} ${item.name}`
      return tag
    })
    .join(' ')
}

function safeName(item, index) {
  const raw = item.name || ''
  const ext = path.extname(raw).toLowerCase().slice(0, 6)
  const base = raw.replace(/\.[^.]+$/, '').replace(/[^\w\u4e00-\u9fa5-]/g, '').slice(0, 20)
  return `${Date.now()}-${index}-${base || item.type}${ext || ''}`
}

async function downloadOne(item, index, dir) {
  // 语音一律不下载：内容只在平台的 asr_refer_text 里，本机没有识别引擎，
  // 拉下来也解不出一个字，纯粹白吃带宽和磁盘。群聊、私聊都按这条走。
  if (item.type === 'voice' || item.type === 'audio') {
    return { ...item, file: '', skipped: true }
  }

  if (item.size > MAX_BYTES) {
    return { ...item, error: `超过 ${MAX_BYTES / 1048576}MB，没有下载` }
  }

  try {
    fs.mkdirSync(dir, { recursive: true })

    // 走统一的出网校验：URL 来自 QQ 平台，理论上可信，
    // 但「所有出网都过 net-guard」这条规则不该有例外，纵深防御成本也就一行。
    const response = await fetchPublic(item.url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) })
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
    const isVoice = item.type === 'voice' || item.type === 'audio'

    // 语音只认平台转写：有文字就是对方说的话，没有就是真拿不到，别含糊
    if (isVoice) {
      lines.push(
        item.asrText
          ? `[${label}] 平台已转成文字：「${item.asrText}」`
          : `[${label}] 平台没给识别文字，这条内容我拿不到（音频不下载，本机解不出）`,
      )
      continue
    }

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
  const deafVoiceCount = downloaded.filter(
    (item) => (item.type === 'voice' || item.type === 'audio') && !item.asrText,
  ).length
  if (deafVoiceCount > 0) {
    lines.push(
      `注意：这 ${deafVoiceCount} 条语音平台没给识别文字，内容我拿不到。` +
        '直接说「没听清，你打字说一遍」就行，不要猜内容，也不要说成文件已收到。',
    )
  }

  // 必须返回对象：调用方取的是 described.text / described.images，
  // 之前这里直接 return 字符串，导致 images 永远是 undefined，图片下载了却从没喂给模型
  const text = lines.join('\n')
  return {
    text: `\n\n（对方还发了 ${items.length} 个附件）\n${text}`.slice(0, MAX_TEXT_CHARS * 4),
    images,
    voice: voiceCount,
  }
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

