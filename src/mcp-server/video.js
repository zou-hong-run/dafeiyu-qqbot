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
// 有的站对服务器 IP 有风控（B 站常见 412），带上浏览器导出的 cookies 就能过。
// 文件放 data/cookies.txt（Netscape 格式），有就用，没有就直连。
const cookieFile = path.join(projectRoot, 'data', 'cookies.txt')

function commonArgs(url) {
  const args = ['--no-warnings', '--no-progress', '--retries', '2', '--socket-timeout', '20']
  if (fs.existsSync(cookieFile)) args.push('--cookies', cookieFile)
  if (/bilibili\.com/i.test(String(url ?? ''))) {
    args.push('--add-header', 'Referer:https://www.bilibili.com/')
  }

  // 有的站点按 TLS 指纹认爬虫（B 站就是这样，光有 cookies 也 412）。
  // 设 YTDLP_IMPERSONATE=chrome 让 yt-dlp 伪装成真浏览器，需要额外装 curl_cffi
  const impersonate = process.env.YTDLP_IMPERSONATE?.trim()
  if (impersonate) args.push('--impersonate', impersonate)

  return args
}

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
      ['-J', ...commonArgs(link), link],
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

function assertPublicLink(raw) {
  let parsed
  try {
    parsed = new URL(String(raw ?? '').trim())
  } catch {
    throw new Error('链接格式不对，需要完整的 http:// 或 https://')
  }
  if (!/^https?:$/.test(parsed.protocol)) throw new Error('只支持 http/https 链接')

  const host = parsed.hostname.toLowerCase()
  const blocked =
    host === 'localhost' ||
    host.endsWith('.local') ||
    host.endsWith('.internal') ||
    /^(10|127)\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host) ||
    /^169\.254\./.test(host)

  if (blocked) throw new Error('不允许解析内网地址')
  return parsed
}

/**
 * 下载视频的一段（不是整部）。整部电影几百 MB，这台机器下不动；
 * 十几秒的片段只有几百 KB，几十秒就能下完。
 */
async function fetchVideo({ url = '', seconds = 10, startAt = 0, maxHeight = 360, fileName = '' } = {}) {
  assertPublicLink(url)
  if (!(await checkYtdlp())) {
    throw new Error('服务器上没装 yt-dlp。让管理员在项目目录跑一次 pip3 install yt-dlp，重启后就能用')
  }

  const start = Math.max(0, Number(startAt) || 0)
  const span = Math.min(Math.max(Math.floor(Number(seconds) || 10), 3), 30)
  const end = start + span
  const height = Math.min(Math.max(Math.floor(Number(maxHeight) || 360), 144), 720)

  const safeName = String(fileName ?? '').trim().replace(/[^\w.\-]/g, '') || `clip-${Date.now()}.mp4`
  const outFile = path.join(projectRoot, 'downloads', safeName.endsWith('.mp4') ? safeName : `${safeName}.mp4`)

  const args = [
    ...commonArgs(url),
    // 别写死 height<=N：有的站点没有低清格式会直接报「format not available」，
    // 用 -S 排序更稳（有低清就选低清，没有就退到次优）
    '-f', 'bv*+ba/b',
    '-S', `res:${height},ext:mp4:m4a`,
    '--merge-output-format', 'mp4',
    '--download-sections', `*${start}-${end}`,
    '--force-keyframes-at-cuts',
    '-o', outFile,
    url,
  ]

  let stderr = ''
  try {
    const result = await run(YTDLP, args, { timeout: 45_000, maxBuffer: 8 * 1024 * 1024 })
    stderr = result.stderr || ''
  } catch (error) {
    stderr = String(error?.stderr || error?.message || error)

    // 超时：文件可能只写了一半，删掉别留垃圾
    if (error?.killed || /timed? ?out|ETIMEDOUT/i.test(stderr)) {
      try {
        fs.rmSync(outFile, { force: true })
      } catch {
        // 删不掉就算了
      }
      throw new Error(
        `下了 45 秒还没完（多半是这台机器带宽只有十几 KB/s）。` +
          '把片段再缩短一点（seconds 改成 5 或 8），或者把 maxHeight 降到 240，再试一次。',
      )
    }

    if (/login|cookie|Sign in/i.test(stderr)) {
      throw new Error('这个视频需要登录（会员内容或抖音），没有 cookies 下不了。让对方把片段直接发给我')
    }
    if (/Unsupported URL/i.test(stderr)) {
      throw new Error('这个站不支持解析。B 站、YouTube 这类可以；小众站和需要登录的解析不了')
    }
    // 单个视频解析不了：已删除、要会员、仅登录可见、直播回放过期之类。
    // 这和「整站风控」要分开说，否则容易误判成 IP 被封然后放弃。
    if (/Unable to extract|No video formats|This video is (unavailable|private)|premium|会员/i.test(stderr)) {
      throw new Error(
        '这个视频本身解析不了——可能已删除、需要会员、或者只对登录用户开放。' +
          '换一个视频（别的 BV 号）再试；同一个链接别反复重试。',
      )
    }
    if (/412|403|风控|risk|blocked|Failed to extract play info/i.test(stderr)) {
      throw new Error(
        '站点把服务器拦了（412 / Failed to extract play info），光有 cookies 不够，' +
          '它还在按 TLS 指纹认爬虫。可以让管理员做两件事：\n' +
          '1) pip3 install -U yt-dlp curl_cffi\n' +
          '2) .env 里加一行 YTDLP_IMPERSONATE=chrome，然后 pm2 restart dafeiyu\n' +
          '做完还不行，就是 IP 段被封了，让对方直接把视频发过来。',
      )
    }
    throw new Error(`下载失败：${stderr.slice(0, 200)}`)
  }

  if (!fs.existsSync(outFile)) throw new Error('yt-dlp 跑完了但没有产出文件，可能被站点限制，换一个视频试试')

  const stat = fs.statSync(outFile)
  if (stat.size < 10 * 1024) {
    fs.rmSync(outFile, { force: true })
    throw new Error('产出的文件太小，可能是解析到了错误页，换个视频或换个片段起点')
  }

  const sizeMB = (stat.size / 1048576).toFixed(2)
  const relative = path.relative(projectRoot, outFile).split(path.sep).join('/')

  return [
    `已截取 ${span} 秒（从第 ${start} 秒开始）存到 ${relative}`,
    `大小 ${sizeMB}MB｜清晰度 ${height}p 以内`,
    '直接用 send_video 传这个文件名就能发出去。',
    '如果对方还想要别的片段，改 startAt 再调一次。',
  ].join('\n')
}

export const VIDEO_HANDLERS = { find_video: findVideo, fetch_video: fetchVideo }

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
  {
    name: 'fetch_video',
    type: 'tool',
    description:
      '截取并下载视频的一段（不是整部），自动合并成 mp4 存到 downloads，然后用 send_video 发出去。' +
      '整部电影几百 MB 这台机器下不动，但 10 秒的片段只有几百 KB，几十秒就能下完。' +
      '单次最多跑 45 秒，超时会提示你缩短片段。' +
      '用户说「发一段 XX 的视频」「截个片段给我」时用它；只要链接和大概位置。',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: '视频链接（B 站 / YouTube 等）' },
        seconds: {
          type: 'integer',
          minimum: 3,
          maximum: 30,
          description: '截多长（秒），默认 10。带宽慢就调小，5 到 8 秒最稳',
        },
        startAt: {
          type: 'integer',
          minimum: 0,
          description: '从第几秒开始截，默认 0（开头）',
        },
        maxHeight: {
          type: 'integer',
          minimum: 144,
          maximum: 720,
          description: '清晰度上限，默认 360。调低下载更快',
        },
        fileName: { type: 'string', description: '保存的文件名（可选）' },
      },
      required: ['url'],
    },
  },
]

// 读视频字幕：yt-dlp 把字幕扒下来，转成带时间戳的纯文本。
// 比截片段有用得多——能看到「视频里讲了什么」，而不是只有几帧画面。
function parseVtt(raw) {
  const cues = []
  const blocks = String(raw ?? '').replace(/\r/g, '').split(/\n{2,}/)

  for (const block of blocks) {
    const lines = block.split('\n').map((line) => line.trim()).filter(Boolean)
    if (lines.length === 0) continue

    const timeLine = lines.find((line) => line.includes('-->'))
    if (!timeLine) continue

    const matched = timeLine.match(/(\d{1,2}):(\d{2}):(\d{2})[.,](\d{1,3})/)
    const seconds = matched
      ? Number(matched[1]) * 3600 + Number(matched[2]) * 60 + Number(matched[3])
      : 0

    const text = lines
      .filter((line) => !line.includes('-->') && !/^(WEBVTT|NOTE|STYLE|REGION|Kind:|Language:)/.test(line))
      .join(' ')
      .replace(/<[^>]+>/g, '')
      .replace(/\s+/g, ' ')
      .trim()

    if (text) cues.push({ at: seconds, text })
  }

  return cues
}

// 自动字幕常见「滚动重复」：后一条包含前一条。合并掉，否则读起来全是复读
function mergeCues(cues) {
  const out = []
  for (const cue of cues) {
    const last = out[out.length - 1]
    if (!last) {
      out.push({ ...cue })
      continue
    }
    if (cue.text === last.text) continue
    if (cue.text.startsWith(last.text)) {
      last.text = cue.text
      continue
    }
    if (last.text.endsWith(cue.text)) continue
    out.push({ ...cue })
  }
  return out
}

function stamp(seconds) {
  const total = Math.max(0, Math.round(Number(seconds) || 0))
  const m = Math.floor(total / 60)
  const s = total % 60
  return `${m}:${String(s).padStart(2, '0')}`
}

async function readVideoSubtitle({ url = '', lang = 'zh-Hans,zh-CN,zh,en', startAt = 0, endAt = 0, maxChars = 6000 } = {}) {
  assertPublicLink(url)
  if (!(await checkYtdlp())) {
    throw new Error('服务器上没装 yt-dlp。让管理员跑一次 pipx install yt-dlp（或 pip3 install yt-dlp）')
  }

  const workDir = path.join(projectRoot, 'tmp', 'subs', `s-${Date.now().toString(36)}`)
  fs.mkdirSync(workDir, { recursive: true })

  const args = [
    ...commonArgs(url),
    '--skip-download',
    '--write-subs',
    '--write-auto-subs',
    '--sub-langs', String(lang),
    '--sub-format', 'vtt',
    '--no-write-playlist-metafiles',
    '-o', path.join(workDir, '%(id)s'),
    url,
  ]

  let stderr = ''
  try {
    const result = await run(YTDLP, args, { timeout: 50_000, maxBuffer: 8 * 1024 * 1024 })
    stderr = result.stderr || ''
  } catch (error) {
    stderr = String(error?.stderr || '')
    const message = String(error?.stderr || error?.message || error)
    fs.rmSync(workDir, { recursive: true, force: true })

    if (/412|403|Failed to extract play info/i.test(message)) {
      throw new Error('解析这个视频时被站点拦了（412）。先查 cookies、YTDLP_IMPERSONATE 和 yt-dlp 版本')
    }
    if (/Unable to extract|This video is unavailable/i.test(message)) {
      throw new Error('这个视频解析不了（可能已删、要会员或仅登录可见），换一个链接')
    }
    throw new Error(`取字幕失败：${message.slice(0, 200)}`)
  }

  let files = []
  try {
    files = fs.readdirSync(workDir).filter((name) => /\.(vtt|srt)$/i.test(name))
  } catch {
    files = []
  }

  if (files.length === 0) {
    fs.rmSync(workDir, { recursive: true, force: true })

    // B 站的字幕只有登录态才给，没 cookies 会静默跳过
    if (/Subtitles are only available when logged in/i.test(stderr)) {
      throw new Error(
        'B 站的字幕要登录才给，服务器上缺 cookies。把浏览器导出的 cookies.txt 放到 data/cookies.txt 再试；' +
          '在那之前只能截片段看画面。',
      )
    }
    throw new Error(
      '没拿到字幕。两个常见原因：\n' +
        '1) B 站的字幕只有登录态才给 —— 确认 data/cookies.txt 在；\n' +
        '2) 这条视频本身没有 CC 字幕，也没有自动字幕。\n' +
        '可以改 lang 试试（如 "en"），或者退回截片段看画面。',
    )
  }

  // 优先中文，其次按文件名顺序
  files.sort((a, b) => {
    const zh = (name) => (/zh/i.test(name) ? 0 : 1)
    return zh(a) - zh(b)
  })

  const picked = path.join(workDir, files[0])
  const raw = fs.readFileSync(picked, 'utf8')
  fs.rmSync(workDir, { recursive: true, force: true })

  let cues = mergeCues(parseVtt(raw))
  if (cues.length === 0) throw new Error('字幕文件是空的，可能这个视频只有画面没有台词')

  const from = Math.max(0, Number(startAt) || 0)
  const to = Number(endAt) > 0 ? Number(endAt) : Infinity
  const total = cues.length
  if (from > 0 || to !== Infinity) cues = cues.filter((cue) => cue.at >= from && cue.at <= to)

  if (cues.length === 0) throw new Error(`这个时间段（${stamp(from)} 之后）没有台词`)

  const limit = Math.min(Math.max(Number(maxChars) || 6000, 500), 12_000)
  const lines = []
  let used = 0
  let cut = false

  for (const cue of cues) {
    const line = `[${stamp(cue.at)}] ${cue.text}`
    if (used + line.length > limit) {
      cut = true
      break
    }
    lines.push(line)
    used += line.length + 1
  }

  const head = [
    `字幕已取到（共 ${total} 条，本次输出 ${lines.length} 条，语言 ${files[0].replace(/^.*\./, '').replace(/\.vtt$/i, '') || '未知'}）`,
    cut ? `后面还有内容，要看就传 startAt=${cues[lines.length]?.at ?? ''} 继续` : '',
    '',
  ]
    .filter(Boolean)
    .join('\n')

  return `${head}${lines.join('\n')}`
}

export const VIDEO_HANDLERS_EXTRA = { read_video_subtitle: readVideoSubtitle }

export const VIDEO_TOOLS_EXTRA = [
  {
    name: 'read_video_subtitle',
    type: 'tool',
    description:
      '读视频的字幕全文（带时间戳），用来看「这个视频讲了什么」。' +
      '比截片段有用：能总结内容、找某个话题在哪一分钟、回答「视频里有没有提到 X」。' +
      '默认取中文自动字幕，没有就退回英文；视频完全没字幕会明确报错。' +
      '太长会截断，用 startAt 接着往后来。',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: '视频链接（B 站 / YouTube 等）' },
        lang: {
          type: 'string',
          description: '字幕语言，逗号分隔，默认 "zh-Hans,zh-CN,zh,en"',
        },
        startAt: { type: 'integer', minimum: 0, description: '从第几秒开始，默认 0' },
        endAt: { type: 'integer', minimum: 0, description: '到第几秒结束，默认到最后' },
        maxChars: {
          type: 'integer',
          minimum: 500,
          maximum: 12000,
          description: '最多返回多少字，默认 6000',
        },
      },
      required: ['url'],
    },
  },
]
