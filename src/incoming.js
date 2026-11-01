import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// 入站附件：SDK 会把 attachments 解析成 event.message 里的 image / voice / video / file 元素
// 我们之前完全忽略它们，用户发语音、发图，机器人等于什么都收不到
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const incomingDir = path.join(projectRoot, 'downloads', 'incoming')

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

export function extractInbound(event) {
  const items = []

  for (const elem of event?.message ?? []) {
    const type = elem?.type
    if (!KIND_LABEL[type]) continue

    const url = elem.data?.url
    if (!url) continue

    items.push({
      type,
      url: String(url).startsWith('http') ? String(url) : `https://${url}`,
      name: String(elem.data?.name ?? '').slice(0, 80),
      size: Number(elem.data?.size) || 0,
    })

    if (items.length >= MAX_ITEMS) break
  }

  return items
}

function safeName(item, index) {
  const raw = item.name || ''
  const ext = path.extname(raw).slice(0, 6)
  const base = raw.replace(/\.[^.]+$/, '').replace(/[^\w\u4e00-\u9fa5-]/g, '').slice(0, 20)
  return `${Date.now()}-${index}-${base || item.type}${ext || ''}`
}

async function downloadOne(item, index) {
  if (item.size > MAX_BYTES) {
    return { ...item, error: `超过 ${MAX_BYTES / 1048576}MB，没有下载` }
  }

  try {
    fs.mkdirSync(incomingDir, { recursive: true })

    const response = await fetch(item.url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) })
    if (!response.ok) return { ...item, error: `下载失败 HTTP ${response.status}` }

    const buffer = Buffer.from(await response.arrayBuffer())
    if (buffer.length > MAX_BYTES) return { ...item, error: '下载后超过大小上限' }

    const file = path.join(incomingDir, safeName(item, index))
    fs.writeFileSync(file, buffer)

    return { ...item, file: path.relative(projectRoot, file).split(path.sep).join('/') }
  } catch (error) {
    return { ...item, error: String(error?.message ?? error).slice(0, 80) }
  }
}

// 把附件整理成一段给模型看的说明，拼在用户输入后面
export async function describeInbound(items) {
  if (items.length === 0) return ''

  const downloaded = await Promise.all(items.map((item, index) => downloadOne(item, index)))
  const lines = []

  for (const item of downloaded) {
    const label = KIND_LABEL[item.type] ?? item.type

    if (item.file) {
      lines.push(
        `[${label}] 已存到 ${item.file}${item.size ? `（${(item.size / 1024).toFixed(0)} KB）` : ''}`,
      )
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

export function clearIncoming() {
  try {
    fs.rmSync(incomingDir, { recursive: true, force: true })
  } catch {
    // 目录不存在或删不掉都不影响
  }
}
