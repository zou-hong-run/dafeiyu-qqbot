import fs from 'node:fs'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { segment } from 'qq-official-bot'
import { env } from './env.js'
import { bot } from './bot.js'
import { deliver, postMessage } from './sender.js'

// 媒体发送器：每个工厂函数绑一个事件，返回「给模型调用的发送函数」
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
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

export function imageSenderFor(event) {
  const downloadDir = path.join(projectRoot, 'downloads')

  return async (input) => {
    const target = String(input ?? '').trim()
    if (!target) throw new Error('缺少图片路径')

    if (/^https?:\/\//i.test(target)) {
      await deliver(event, segment.image(target))
      return target
    }

    const resolved = path.resolve(downloadDir, target)
    if (!resolved.startsWith(downloadDir + path.sep)) {
      throw new Error('只能发送 downloads 目录下的文件')
    }
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

    await deliver(event, segment.image(resolved))
    return path.basename(resolved)
  }
}

export function audioSenderFor(event) {
  const downloadDir = path.join(projectRoot, 'downloads')

  return async (input) => {
    const target = String(input ?? '').trim()
    if (!target) throw new Error('缺少音频路径')

    if (/^https?:\/\//i.test(target)) {
      await deliver(event, segment.audio(target))
      return target
    }

    const resolved = path.resolve(downloadDir, target)
    if (!resolved.startsWith(downloadDir + path.sep)) {
      throw new Error('只能发送 downloads 目录下的文件')
    }
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

    await deliver(event, segment.audio(resolved))
    return path.basename(resolved)
  }
}

const TTS_VOICE = process.env.TTS_VOICE?.trim() || 'zh-CN-XiaoxiaoNeural'
const TTS_MAX_CHARS = 500

// edge-tts 的音色名形如 zh-CN-XiaoyiNeural；只放行这个格式，别把任意字符串塞给命令行
const VOICE_PATTERN = /^[a-zA-Z]{2,3}-[a-zA-Z]{2,4}-[a-zA-Z]+Neural$/

export const TTS_VOICES = {
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

export function resolveVoice(input) {
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

export function speakSenderFor(event) {
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
      await deliver(event, segment.audio(file))
    } finally {
      fs.rm(file, { force: true }, () => {})
    }

    return { backend, chars: text.length, voice }
  }
}

export function videoSenderFor(event) {
  const downloadDir = path.join(projectRoot, 'downloads')

  return async (input) => {
    const target = String(input ?? '').trim()
    if (!target) throw new Error('缺少视频路径')

    if (/^https?:\/\//i.test(target)) {
      await deliver(event, segment.video(target))
      return target
    }

    const resolved = path.resolve(downloadDir, target)
    if (!resolved.startsWith(downloadDir + path.sep)) {
      throw new Error('只能发送 downloads 目录下的文件')
    }
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

    await deliver(event, segment.video(resolved))
    return path.basename(resolved)
  }
}

// 能发的文件范围：downloads/ 和项目根下的文件
// 密钥、记忆、依赖目录一律不发——群里任何拿不到 shell 的人也能调这个工具
const FILE_BLOCKED = ['.env', 'data/', 'node_modules/', '.git/', '.ssh/']

export function resolveSendableFile(target) {
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
    if (FILE_BLOCKED.some((prefix) => rel === prefix || rel.startsWith(prefix.replace(/\/$/, '/')))) {
      throw new Error(`这个文件不开放发送（${rel}）：密钥、记忆和依赖目录不在可发范围内`)
    }

    return resolved
  }

  return null
}

export function fileSenderFor(event) {
  const downloadDir = path.join(projectRoot, 'downloads')

  return async (input, options = {}) => {
    const target = String(input ?? '').trim()
    if (!target) throw new Error('缺少文件路径')

    const resolved = resolveSendableFile(target)
    if (!resolved) throw new Error(mediaMissingHint(downloadDir, path.resolve(downloadDir, target)))

    const stat = fs.statSync(resolved)
    if (stat.size > 200 * 1024 * 1024) {
      throw new Error(`文件 ${(stat.size / 1048576).toFixed(1)}MB，超过 200MB 硬上限`)
    }

    const isGroup = event.message_type === 'group'
    const id = isGroup ? event.group_id : event.user_id
    const entry = isGroup ? bot.group(id) : bot.user(id)
    const fileName = String(options.fileName ?? path.basename(resolved)).slice(0, 120)

    const upload = await entry.upload(fs.readFileSync(resolved), { fileType: 4, fileName })

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
