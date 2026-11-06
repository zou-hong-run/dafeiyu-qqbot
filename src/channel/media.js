import fs from 'node:fs'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { env } from '../config/env.js'
import { budgetFor } from '../ops/budget.js'
import { sensitiveReason } from '../ops/file-policy.js'
import { segment, sendGroup, uploadMedia } from '../bot.js'
import { deliver, postMessage } from './sender.js'

// 媒体发送器：每个工厂函数绑一个事件，返回「给模型调用的发送函数」
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const run = promisify(execFile)


function mediaMissingHint(downloadDir, resolved) {
  const name = path.basename(resolved)
  const hits = []

  const walk = (dir, depth) => {
    if (depth > 4 || hits.length >= 5) return
    let entries = []
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) walk(full, depth + 1)
      else if (entry.name === name) hits.push(path.relative(downloadDir, full).split(path.sep).join('/'))
    }
  }

  walk(downloadDir, 0)

  const list = hits.length
    ? `\n在 downloads 下找到同名文件，可以直接传这些相对路径：\n${hits.map((item) => `  ${item}`).join('\n')}`
    : ''

  return (
    `文件不存在：${name}\n` +
    '提示：path 是相对 downloads/ 目录的。文件在 downloads/vtest/a.png 就传 "vtest/a.png"，不要带 downloads/ 前缀。' +
    list
  )
}

export function imageSenderFor(event, send = (payload) => deliver(event, payload)) {
  const downloadDir = path.join(projectRoot, 'downloads')

  return async (input) => {
    const target = String(input ?? '').trim()
    if (!target) throw new Error('缺少图片路径')

    if (/^https?:\/\//i.test(target)) {
      await send(segment.image(target))
      return target
    }

    const resolved = path.resolve(downloadDir, target)
    if (!resolved.startsWith(downloadDir + path.sep)) {
      throw new Error('只能发送 downloads 目录下的文件')
    }
    assertSameScope(resolved, event)
    if (!/\.(jpe?g|png|gif|webp|bmp)$/i.test(resolved)) {
      throw new Error('只能发送图片（jpg/png/gif/webp/bmp），其他文件类型 QQ 平台不支持')
    }
    if (!fs.existsSync(resolved)) {
      throw new Error(mediaMissingHint(downloadDir, resolved))
    }

    const size = fs.statSync(resolved).size
    if (size > 10 * 1024 * 1024) {
      throw new Error(`图片 ${(size / 1048576).toFixed(1)}MB，超过 10MB 平台传不上去`)
    }

    await send(segment.image(resolved))
    return path.basename(resolved)
  }
}

// QQ 语音不认 m4a：用 ffmpeg 转成 mp3 再发（30 秒的试听转码内存开销很小）
async function ensurePlayableAudio(filePath) {
  if (!/\.m4a$/i.test(filePath)) return filePath

  const outDir = path.join(projectRoot, 'tmp', 'audio')
  fs.mkdirSync(outDir, { recursive: true })
  const out = path.join(outDir, `conv-${Date.now()}.mp3`)

  try {
    await run(
      'ffmpeg',
      ['-y', '-threads', '1', '-i', filePath, '-vn', '-b:a', '96k', '-f', 'mp3', out],
      { timeout: 60_000 },
    )
  } catch (error) {
    throw new Error(
      `这个音频是 m4a，需要转成 mp3 才能发，但转码失败了：${String(error?.message ?? error).slice(0, 120)}。` +
        '要么让用户换个 mp3 直链，要么先确认服务器上装了 ffmpeg。',
    )
  }

  return out
}

export function audioSenderFor(event, send = (payload) => deliver(event, payload)) {
  const downloadDir = path.join(projectRoot, 'downloads')

  return async (input) => {
    const target = String(input ?? '').trim()
    if (!target) throw new Error('缺少音频路径')

    if (/^https?:\/\//i.test(target)) {
      await send(segment.audio(target))
      return target
    }

    // 提示词里给的附件路径形如 downloads/incoming/<会话>/x.mp4，
    // 这里的 resolveSendableFile 会同时按 downloads/ 和项目根两种写法去解析
    const resolved = resolveSendableFile(target)
    if (!resolved) throw new Error(mediaMissingHint(downloadDir, path.resolve(downloadDir, target)))
    assertSameScope(resolved, event)
    if (!/\.(silk|mp3|wav|ogg|flac)$/i.test(resolved)) {
      throw new Error('只接受 QQ 支持的语音格式（silk/mp3/wav/ogg/flac）')
    }
    if (!fs.existsSync(resolved)) {
      throw new Error(mediaMissingHint(downloadDir, resolved))
    }

    const size = fs.statSync(resolved).size
    if (size > 20 * 1024 * 1024) {
      throw new Error(`音频 ${(size / 1048576).toFixed(1)}MB，超过 20MB 传不上去`)
    }

    // QQ 语音只认 silk/mp3/wav/ogg/flac；Apple 的试听是 m4a，播放前先转一趟
    const playable = await ensurePlayableAudio(resolved)

    await send(segment.audio(playable))
    return path.basename(playable)
  }
}

const TTS_VOICE = process.env.TTS_VOICE?.trim() || 'zh-CN-XiaoxiaoNeural'
const TTS_MAX_CHARS = 500

// edge-tts 的音色名形如 zh-CN-XiaoyiNeural，方言音色多一段地区（zh-CN-liaoning-XiaobeiNeural）；
// 只放行字母和连字符这个格式，别把任意字符串塞给命令行
const VOICE_PATTERN = /^[a-zA-Z]{2,3}(?:-[a-zA-Z]{2,10}){1,2}-[a-zA-Z]+Neural$/

const TTS_VOICES = {
  'zh-CN-XiaoxiaoNeural': '晓晓 · 温和女声（默认）',
  'zh-CN-XiaoyiNeural': '晓伊 · 活泼少女',
  'zh-CN-YunxiNeural': '云希 · 年轻男声',
  'zh-CN-YunjianNeural': '云健 · 浑厚男声',
  'zh-CN-YunyangNeural': '云扬 · 新闻播报男声',
  'zh-CN-liaoning-XiaobeiNeural': '晓北 · 东北话女声',
  'zh-CN-shaanxi-XiaoniNeural': '晓妮 · 陕西话女声',
  'zh-TW-HsiaoChenNeural': '曉臻 · 台湾女声',
  'zh-HK-HiuGaaiNeural': '曉佳 · 粤语女声',
}

function resolveVoice(input) {
  const voice = String(input ?? '').trim()
  if (!voice || voice === 'default') return TTS_VOICE

  if (!VOICE_PATTERN.test(voice)) {
    throw new Error(
      `音色名不合法：${voice}。要形如 zh-CN-XiaoyiNeural 的值，` +
        `可选：${Object.keys(TTS_VOICES).join(' / ')}`,
    )
  }

  return voice
}

function firstLineOf(error) {
  return String(error?.stderr || error?.message || error)
    .split('\n')
    .find((line) => line.trim()) ?? '未知错误'
}

// 依次尝试 edge-tts（音质最好，需联网）→ python edge_tts → espeak-ng + ffmpeg（离线机器音）
async function synthesizeSpeech(text, voice = TTS_VOICE) {
  const tmpDir = path.join(projectRoot, 'tmp')
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
  const mp3 = path.join(tmpDir, `tts-${stamp}.mp3`)
  const wav = path.join(tmpDir, `tts-${stamp}.wav`)
  const childEnv = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    LANG: process.env.LANG ?? 'zh_CN.UTF-8',
    PYTHONIOENCODING: 'utf-8',
  }
  const attempts = []

  const usable = (file) => fs.existsSync(file) && fs.statSync(file).size > 1024

  try {
    await run(
      'edge-tts',
      ['--text', text, '--voice', voice, '--write-media', mp3],
      { timeout: 90_000, env: childEnv, maxBuffer: 4 * 1024 * 1024 },
    )
    if (usable(mp3)) return { file: mp3, backend: 'edge-tts' }
    attempts.push('edge-tts 没产出音频')
  } catch (error) {
    attempts.push(`edge-tts: ${firstLineOf(error)}`)
  }

  try {
    await run(
      'python3',
      ['-m', 'edge_tts', '--text', text, '--voice', voice, '--write-media', mp3],
      { timeout: 90_000, env: childEnv, maxBuffer: 4 * 1024 * 1024 },
    )
    if (usable(mp3)) return { file: mp3, backend: 'python edge-tts' }
    attempts.push('python edge_tts 没产出音频')
  } catch (error) {
    attempts.push(`python edge_tts: ${firstLineOf(error)}`)
  }

  try {
    await run('espeak-ng', ['-v', 'cmn', '-s', '165', '-w', wav, text], {
      timeout: 60_000,
      env: childEnv,
      maxBuffer: 4 * 1024 * 1024,
    })
    await run(
      'ffmpeg',
      ['-y', '-v', 'error', '-i', wav, '-ar', '24000', '-b:a', '48k', mp3],
      { timeout: 60_000, env: childEnv, maxBuffer: 4 * 1024 * 1024 },
    )
    fs.rmSync(wav, { force: true })
    if (usable(mp3)) return { file: mp3, backend: 'espeak-ng' }
    attempts.push('espeak-ng 没产出音频')
  } catch (error) {
    attempts.push(`espeak-ng: ${firstLineOf(error)}`)
  }

  fs.rmSync(wav, { force: true })
  throw new Error(
    '服务器上没有可用的语音合成后端，转不了语音。试过的：\n' +
      `${attempts.join('\n')}\n` +
      '修法：pip3 install edge-tts（音质最好，需要能访问外网），或 apt-get install espeak-ng（离线但机器音）',
  )
}

export function speakSenderFor(event, send) {
  return async (input) => {
    const payload = typeof input === 'string' ? { text: input } : (input ?? {})
    const text = String(payload.text ?? '').trim()

    if (!text) throw new Error('缺少要念的文本')
    if (text.length > TTS_MAX_CHARS) {
      throw new Error(`文本 ${text.length} 字，太长，压到 ${TTS_MAX_CHARS} 字以内再合成`)
    }

    const voice = resolveVoice(payload.voice)
    const { file, backend } = await synthesizeSpeech(text, voice)

    try {
      await (send ?? ((payload) => deliver(event, payload)))(segment.audio(file))
    } finally {
      fs.rm(file, { force: true }, () => {})
    }

    return { backend, chars: text.length, voice }
  }
}

export function videoSenderFor(event, send = (payload) => deliver(event, payload)) {
  const downloadDir = path.join(projectRoot, 'downloads')

  return async (input) => {
    const target = String(input ?? '').trim()
    if (!target) throw new Error('缺少视频路径')

    if (/^https?:\/\//i.test(target)) {
      await send(segment.video(target))
      return target
    }

    const resolved = resolveSendableFile(target)
    if (!resolved) throw new Error(mediaMissingHint(downloadDir, path.resolve(downloadDir, target)))
    assertSameScope(resolved, event)
    if (!/\.mp4$/i.test(resolved)) {
      throw new Error('只接受 mp4 格式，QQ 视频消息不支持其他容器')
    }
    if (!fs.existsSync(resolved)) {
      throw new Error(mediaMissingHint(downloadDir, resolved))
    }

    const size = fs.statSync(resolved).size
    if (size > 30 * 1024 * 1024) {
      throw new Error(
        `视频 ${(size / 1048576).toFixed(1)}MB，超过 30MB 会降级成文件类型；要保留视频预览请压到 30MB 以内，或用 send_file 按文件发`,
      )
    }

    await send(segment.video(resolved))
    return path.basename(resolved)
  }
}

// 上传前整个文件要读进内存（SDK 还要再复制一份），2G 内存的机器经不起 200MB
const MAX_SEND_BYTES = Number(process.env.MAX_SEND_FILE_MB || budgetFor().maxSendFileMB) * 1024 * 1024
const incomingRoot = path.join(projectRoot, 'downloads', 'incoming')

// 入站附件按会话分目录存放，发送时也要守住这个边界：
// A 群收到的图，B 群不能靠 send_image 捞出路径发出去
function scopeTagOf(event) {
  const raw = event?.message_type === 'group' ? `group:${event.group_id}` : `user:${event.user_id}`
  return String(raw ?? '').replace(/[^a-zA-Z0-9_-]/g, '') || 'unknown'
}

function assertSameScope(resolved, event) {
  // 定时任务没有会话上下文，不做跨会话校验
  if (!event) return

  const rel = path.relative(incomingRoot, resolved)
  if (rel.startsWith('..') || path.isAbsolute(rel)) return // 不在 incoming 下，与附件无关
  if (rel.split(path.sep)[0] === scopeTagOf(event)) return

  throw new Error(
    '这是别的会话收到的附件，不能从这里发出去。' +
      '要转发给当前会话，得让对方把文件发到当前会话里，或者用 send_to_group 单独发。',
  )
}

// 把收到的附件（或 downloads 里的文件）发到指定群。
// 附件默认按会话隔离，跨群发之前要把它「提升」到 downloads 根目录，
// 这一步等于解除隔离，所以上层只给管理员开放。
const IMAGE_EXT = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp'])
const VIDEO_EXT = new Set(['.mp4'])
const AUDIO_EXT = new Set(['.silk', '.mp3', '.wav', '.ogg', '.flac'])

export async function sendMediaToGroup(groupId, inputPath, options = {}) {
  const resolved = resolveSendableFile(inputPath)
  if (!resolved) throw new Error(`找不到文件：${inputPath}。路径要么相对 downloads/，要么是提示词里给的那个 attachments 路径`)

  const group = String(groupId ?? '').trim()
  if (!group) throw new Error('要指定群')

  const stat = fs.statSync(resolved)
  if (!stat.isFile()) throw new Error('这不是文件')

  // 跨会话发送：先把附件复制到 downloads 根，脱离原会话目录
  let filePath = resolved
  const inIncoming = path.relative(path.join(projectRoot, 'downloads', 'incoming'), resolved)
  if (!inIncoming.startsWith('..') && !path.isAbsolute(inIncoming)) {
    const base = `${Date.now()}-${path.basename(resolved)}`
    const promoted = path.join(projectRoot, 'downloads', base)
    fs.copyFileSync(resolved, promoted)
    filePath = promoted
  }

  const ext = path.extname(filePath).toLowerCase()
  const size = fs.statSync(filePath).size
  const mb = size / 1048576

  let payload
  let kind
  if (VIDEO_EXT.has(ext)) {
    if (mb > 30) throw new Error(`视频 ${mb.toFixed(1)}MB，超过 30MB 会降级成文件；要保预览先压小`)
    payload = segment.video(filePath)
    kind = '视频'
  } else if (IMAGE_EXT.has(ext)) {
    if (mb > 10) throw new Error(`图片 ${mb.toFixed(1)}MB，超过 10MB 发不了`)
    payload = segment.image(filePath)
    kind = '图片'
  } else if (AUDIO_EXT.has(ext)) {
    if (mb > 20) throw new Error(`音频 ${mb.toFixed(1)}MB，超过 20MB 发不上去`)
    const playable = await ensurePlayableAudio(filePath)
    payload = segment.audio(playable)
    kind = '语音'
  } else {
    if (mb > 50) throw new Error(`文件 ${mb.toFixed(1)}MB，超过 50MB 上限`)
    payload = segment.file(filePath, {
      name: ensureFileNameExtension(options.fileName ?? path.basename(filePath), filePath),
    })
    kind = '文件'
  }

  await sendGroup(group, payload)

  return { groupId: group, kind, name: path.basename(filePath), sizeMB: Number(mb.toFixed(2)) }
}

function resolveSendableFile(target) {
  const roots = [path.join(projectRoot, 'downloads'), projectRoot]
  const cleaned = String(target ?? '')
    .trim()
    .replace(/^\.[/\\]/, '')
    .replace(/^[/\\]+/, '')

  for (const root of roots) {
    const resolved = path.resolve(root, cleaned)
    if (resolved !== root && !resolved.startsWith(root + path.sep)) continue
    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) continue

    const rel = path.relative(projectRoot, resolved).split(path.sep).join('/')
    const reason = sensitiveReason(rel)
    if (reason) {
      throw new Error(`这个文件不开放发送（${rel}）：${reason}`)
    }

    return resolved
  }

  return null
}

// 发出去的文件一定要带扩展名：QQ 客户端靠它决定用什么打开，
// 没有后缀的文件对方点开是「未知类型」，还得自己猜。
function guessExtension(buffer) {
  const head = buffer.subarray(0, 8)
  if (head[0] === 0x89 && head[1] === 0x50) return '.png'
  if (head[0] === 0xff && head[1] === 0xd8) return '.jpg'
  if (head.toString('latin1', 0, 3) === 'GIF') return '.gif'
  if (head.toString('latin1', 0, 4) === '%PDF') return '.pdf'
  if (head[0] === 0x50 && head[1] === 0x4b) return '.zip'
  if (head[0] === 0x37 && head[1] === 0x7a) return '.7z' // 7z
  if (head[0] === 0x1f && head[1] === 0x8b) return '.gz'
  return '.bin'
}

/**
 * 保证文件名带扩展名。
 * 顺序：名字本身有后缀 → 用名字的；否则借源文件的后缀；再否则按文件头猜。
 */
export function ensureFileNameExtension(name, sourcePath, buffer) {
  const raw = String(name ?? '').trim() || path.basename(String(sourcePath ?? ''))
  if (path.extname(raw)) return raw.slice(0, 120)

  const sourceExt = path.extname(String(sourcePath ?? ''))
  const finalExt = sourceExt || (buffer ? guessExtension(buffer) : '.bin')
  const base = raw.slice(0, Math.max(1, 120 - finalExt.length))
  return `${base}${finalExt}`
}

export function fileSenderFor(event, options = {}) {
  const downloadDir = path.join(projectRoot, 'downloads')

  return async (input, options = {}) => {
    const target = String(input ?? '').trim()
    if (!target) throw new Error('缺少文件路径')

    const resolved = resolveSendableFile(target)
    if (!resolved) throw new Error(mediaMissingHint(downloadDir, path.resolve(downloadDir, target)))
    assertSameScope(resolved, event)

    const stat = fs.statSync(resolved)
    if (stat.size > MAX_SEND_BYTES) {
      throw new Error(
        `文件 ${(stat.size / 1048576).toFixed(1)}MB，超过 ${MAX_SEND_BYTES / 1048576}MB 上限。` +
          '这台机器只有 2G 内存，整个文件要读进内存才能上传，再大容易把它搞崩。' +
          '可以先用 shell 压缩/分割，或者用 download 直接传外链。',
      )
    }

    const isGroup = event.message_type === 'group'
    const id = isGroup ? event.group_id : event.user_id
    const replyTarget = isGroup
      ? { scope: 'group', targetId: String(id) }
      : { scope: 'c2c', targetId: String(id) }

    const buffer = fs.readFileSync(resolved)
    const fileName = ensureFileNameExtension(
      options.fileName ?? path.basename(resolved),
      resolved,
      buffer,
    )

    // 文件消息要自己传一遍拿到 file_info，再拼 msg_type=7 的消息体
    const upload = await uploadMedia({
      target: replyTarget,
      fileType: 4, // FILE
      buffer,
      fileName,
      srvSendMsg: false,
    })

    const body = {
      content: '',
      msg_type: 7,
      media: { file_info: upload.file_info },
    }

    await postMessage(event, body)

    return `${fileName}（${(stat.size / 1024).toFixed(1)} KB）`
  }
}

export function cardSenderFor(event) {
  return async (input = {}) => {
    const title = String(input.title ?? '').trim()
    const description = String(input.description ?? '').trim()
    const url = String(input.url ?? '').trim()
    const picUrl = String(input.pic_url ?? input.picUrl ?? '').trim()

    if (!title) throw new Error('缺少卡片标题 title')
    if (title.length > 50) throw new Error(`标题 ${title.length} 字，QQ 图文卡片标题上限 50 字`)
    if (!description) throw new Error('缺少卡片描述 description（5-200 字）')
    if (description.length > 200) {
      throw new Error(`描述 ${description.length} 字，QQ 图文卡片描述上限 200 字`)
    }
    if (url.length > 1024) throw new Error('链接 url 超过 1024 字符')
    if (!/^https:\/\//i.test(url)) throw new Error('卡片链接 url 必须是 https 开头的完整网址')
    if (!picUrl) throw new Error('缺少封面图 pic_url')
    if (picUrl.length > 1024) throw new Error('封面图 pic_url 超过 1024 字符')
    if (!/^https:\/\//i.test(picUrl)) {
      throw new Error(
        '封面图 pic_url 必须是 https 图片外链。本地图片请先用 send_image 发，或先传到图床拿到 https 链接',
      )
    }

    await postMessage(event, {
      msg_type: 8,
      card: {
        type: 'tuwen',
        content: { title, description, url, pic_url: picUrl },
      },
    })

    return `${title}（${url}）`
  }
}
