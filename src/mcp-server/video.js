import fs from 'node:fs'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'

const run = promisify(execFile)

// 短视频：解析 B 站 / YouTube / 抖音 这类分享链接，拿到能直接播的 mp4。
//
// 关键取舍：
//   - 这些平台的直链带时效、有的校验 Referer，QQ 平台去拉不一定成，所以先试直发、失败再下载
//   - 这台机器带宽十几 KB/s，4MB 的视频要下四五分钟，所以默认只挑小体积的版本
//   - 解析用 yt-dlp（业界标准，别自己写），没装就明确报错让人装
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const YTDLP = process.env.YTDLP_PATH?.trim() || 'yt-dlp'
const PARSE_TIMEOUT_MS = 60_000
const DEFAULT_MAX_MB = 15

let ytdlpAvailable = null

async function checkYtdlp() {
  if (ytdlpAvailable !== null) return ytdlpAvailable
  try {
    await run(YTDLP, ['--version'], { timeout: 10_000 })
    ytdlpAvailable = true
  } catch {
    ytdlpAvailable = false
  }
  return ytdlpAvailable
}

function sizeOf(format) {
  return Number(format.filesize) || Number(format.filesize_approx) || 0
}

function formatDuration(seconds) {
  const total = Math.round(Number(seconds) || 0)
  const m = Math.floor(total / 60)
  const s = total % 60
  return m > 0 ? `${m} 分 ${String(s).padStart(2, '0')} 秒` : `${s} 秒`
}

async function findVideo({ url = '', maxSizeMB = DEFAULT_MAX_MB } = {}) {
  const link = String(url ?? '').trim()
  if (!/^https?:\/\//i.test(link)) throw new Error('需要一个完整的 http/https 链接')

  if (!(await checkYtdlp())) {
    throw new Error(
      `服务器上没装 yt-dlp，解析不了视频链接。在项目目录跑一次 pip install yt-dlp（或 apt install yt-dlp）再试。`,
    )
  }

  const capMB = Math.min(Math.max(Number(maxSizeMB) || DEFAULT_MAX_MB, 2), 60)

  let stdout = ''
  try {
    const result = await run(
      YTDLP,
      ['-J', '--no-warnings', '--no-playlist', '--no-progress', link],
      { timeout: PARSE_TIMEOUT_MS, maxBuffer: 24 * 1024 * 1024 },
    )
    stdout = result.stdout
  } catch (error) {
    const message = String(error?.stderr || error?.message || error)
    // 常见的几种失败原因，直接说清楚，别让模型瞎猜
    if (/Unsupported URL/i.test(message)) {
      throw new Error('这个站不支持解析。目前支持 B 站、YouTube、抖音等 yt-dlp 认识的站点；小众站或需要登录的解析不了')
    }
    if (/login|cookie|Sign in/i.test(message)) {
      throw new Error('这个视频需要登录才能看（比如抖音、会员内容），没 cookies 解析不了。让用户直接把 mp4 发给我')
    }
    throw new Error(`解析失败：${message.slice(0, 200)}`)
  }

  let data
  try {
    data = JSON.parse(stdout)
  } catch {
    throw new Error('解析返回的内容看不懂，可能站点改版了，过一阵再试或换 yt-dlp 版本')
  }

  const all = Array.isArray(data?.formats) ? data.formats : []
  const hasAudio = (item) => item && item.acodec && item.acodec !== 'none'
  const hasVideo = (item) => item && item.vcodec && item.vcodec !== 'none'

  // 必须是「单文件同时带音视频」才能直接发；B 站这类站点是分离流，
  // 直接拿视频轨会是无声片，必须下载后合并
  const formats = all
    .filter((item) => item && item.url && item.ext === 'mp4' && hasAudio(item) && hasVideo(item))
    .map((item) => ({
      id: item.format_id,
      height: Number(item.height) || 0,
      size: sizeOf(item),
      url: item.url,
    }))
    .filter((item) => item.size > 0)

  if (formats.length === 0) {
    // 没有单文件格式：把「视频轨 + 音频轨」的合计体积估出来，告诉模型要走下载合并
    const videoOnly = all
      .filter((item) => item && hasVideo(item) && !hasAudio(item))
      .sort((x, y) => sizeOf(x) - sizeOf(y))[0]
    const audioOnly = all
      .filter((item) => item && hasAudio(item) && !hasVideo(item))
      .sort((x, y) => sizeOf(x) - sizeOf(y))[0]
    const totalBytes = (videoOnly ? sizeOf(videoOnly) : 0) + (audioOnly ? sizeOf(audioOnly) : 0)
    const approxMB = totalBytes > 0 ? (totalBytes / 1048576).toFixed(1) : '未知'
    const minutes = totalBytes > 0 ? Math.max(1, Math.round(totalBytes / 1024 / 15 / 60)) : 0

    throw new Error(
      `这个站给的是分离的音视频流（B 站都是这样），没有能直接播的单文件 mp4，直链发出去会是无声的。\n` +
        `合计约 ${approxMB}MB${minutes ? `，按 15KB/s 下载加合并大约要 ${minutes} 分钟` : ''}。\n` +
        '要走这条：用 shell 跑 yt-dlp 下载（它会自动合并，需要 ffmpeg），命令示例：\n' +
        `yt-dlp -f "bv*[height<=480]+ba/b[height<=480]" --merge-output-format mp4 -o "downloads/%(id)s.%(ext)s" "${link}"\n` +
        '下完再用 send_video 发 downloads 里的 mp4。只有管理员能跑 shell；群友的话让他直接把视频文件发过来。',
    )
  }

  // 体积最小的优先：带宽就这么点，能看清就行
  formats.sort((a, b) => a.size - b.size)
  const pickable = formats.filter((item) => item.size <= capMB * 1024 * 1024)

  if (pickable.length === 0) {
    const smallest = formats[0]
    throw new Error(
      `最清晰的版本也要 ${(smallest.size / 1048576).toFixed(1)}MB，超过这次的上限 ${capMB}MB。` +
      '这台机器带宽只有十几 KB/s，几十 MB 的视频要下十几分钟。要么换更短的视频，要么把 maxSizeMB 调大（但会很慢）。',
    )
  }

  const chosen = pickable[0]
  const title = String(data.title ?? '').trim().slice(0, 80) || '未命名视频'
  const duration = formatDuration(data.duration)
  const sizeMB = (chosen.size / 1048576).toFixed(1)

  // 按 15KB/s 粗算下载耗时，让模型能提前告诉用户要等多久
  const minutes = Math.max(1, Math.round(chosen.size / 1024 / 15 / 60))

  return [
    `解析成功：${title}`,
    `时长 ${duration}｜清晰度 ${chosen.height ? `${chosen.height}p` : '未知'}｜大小 ${sizeMB}MB`,
    `直链 ${chosen.url}`,
    '',
    '怎么发：',
    '1. 先把直链传给 send_video，让 QQ 平台自己去拉（可能失败——这些平台的直链有时效和防盗链）。',
    '2. 报错就 download 下到本地（支持续传，可能要调几次），再用 send_video 发本地文件名。',
    `3. 下载大约 ${minutes} 分钟（按 15KB/s 估）。先告诉用户要等多久，别让人干等。`,
  ].join('\n')
}

export const VIDEO_HANDLERS = { find_video: findVideo }

export const VIDEO_TOOLS = [
  {
    name: 'find_video',
    type: 'tool',
    description:
      '解析短视频分享链接（B 站 / YouTube / 抖音等 yt-dlp 支持的站点），返回标题、时长、体积和 mp4 直链。' +
      '默认只挑 15MB 以内的版本——这台机器带宽十几 KB/s，大视频要下很久。' +
      '拿到直链先试 send_video 直发；失败再 download 到本地发。' +
      'B 站这类站点是分离音视频流，会直接报错并给出 yt-dlp 下载合并的命令。' +
      '用户发来「这个视频发群里」这类链接时用它；需要登录的视频（抖音多数情况）会明确报错。',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: '视频分享链接，如 B 站 https://www.bilibili.com/video/BVxxx' },
        maxSizeMB: {
          type: 'integer',
          minimum: 2,
          maximum: 60,
          description: '允许的最大体积（MB），默认 15。调大意味着下载更久',
        },
      },
      required: ['url'],
    },
  },
]
