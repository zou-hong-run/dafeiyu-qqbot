import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// 找可直链播放的免费音乐。
// 服务器带宽只有十几 KB/s，下载一首 7MB 的歌要七八分钟还会超时；
// 但 QQ 的语音消息支持传网络地址，由平台自己去拉——所以这里只负责「找到直链」，
// 拿到之后直接交给 send_audio，服务器一个字节都不用下。
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const cacheFile = path.join(projectRoot, 'data', 'music-cache.json')

const API = 'https://api.audius.co'
const APP_NAME = 'dafeiyu-qqbot'
const TIMEOUT_MS = 12_000
const MAX_RESULTS = 5

// 曲库里长曲占绝大多数，短曲得靠这些关键词捞
const SHORT_FRIENDLY = ['lofi', 'jazz', 'chill', 'ambient', 'piano', 'beats']

function readCache() {
  try {
    const raw = JSON.parse(fs.readFileSync(cacheFile, 'utf8'))
    return raw && typeof raw === 'object' ? raw : {}
  } catch {
    return {}
  }
}

async function getJson(url) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { Accept: 'application/json', 'User-Agent': `qq-bot/1.0 (${APP_NAME})` },
    })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    return await response.json()
  } finally {
    clearTimeout(timer)
  }
}

function streamUrl(trackId) {
  return `${API}/v1/tracks/${encodeURIComponent(trackId)}/stream?app_name=${APP_NAME}`
}

function formatDuration(seconds) {
  const total = Math.round(Number(seconds) || 0)
  const m = Math.floor(total / 60)
  const s = total % 60
  return m > 0 ? `${m} 分 ${String(s).padStart(2, '0')} 秒` : `${s} 秒`
}

function apiUrl(query) {
  const keyword = String(query ?? '').trim()
  return keyword
    ? `${API}/v1/tracks/search?query=${encodeURIComponent(keyword)}&limit=25&app_name=${APP_NAME}`
    : `${API}/v1/tracks/trending?limit=25&app_name=${APP_NAME}`
}

function normalize(track) {
  return {
    id: track.id,
    title: String(track.title ?? '').trim() || '未命名',
    artist: String(track.user?.name ?? track.user?.handle ?? '').trim(),
    duration: Number(track.duration) || 0,
    genre: String(track.genre ?? '').trim(),
    url: streamUrl(track.id),
  }
}

async function findMusic({ query = '', maxDuration = 60, limit = 3 } = {}) {
  const cap = Math.min(Math.max(Math.floor(Number(maxDuration) || 60), 10), 600)
  const want = Math.min(Math.max(Math.floor(Number(limit) || 3), 1), MAX_RESULTS)

  const pool = new Map()
  let tried = 0
  let lastError = ''

  const load = async (keyword) => {
    tried += 1
    try {
      const payload = await getJson(apiUrl(keyword))
      for (const track of Array.isArray(payload?.data) ? payload.data : []) {
        if (!track?.id || track.is_streamable === false) continue
        const item = normalize(track)
        if (item.duration > 0 && item.duration <= cap) pool.set(item.id, item)
      }
    } catch (error) {
      lastError = String(error?.message ?? error)
    }
  }

  // 先按用户的词/热门搜
  await load(query)

  // 不够就换短曲多的关键词，最多再试 3 个，别把工具超时耗光
  if (pool.size < want) {
    for (const keyword of SHORT_FRIENDLY) {
      if (pool.size >= want) break
      if (String(query ?? '').toLowerCase() === keyword) continue
      if (tried >= 4) break
      await load(keyword)
    }
  }

  const picked = [...pool.values()].sort((a, b) => a.duration - b.duration).slice(0, want)

  if (picked.length === 0) {
    if (lastError && tried > 0 && pool.size === 0) {
      return `这次没找到：${lastError}。过一会儿再试，或者换个更常见的关键词（如 lofi / piano / jazz）。`
    }
    return (
      `没找到 ${cap} 秒以内的曲子。这个曲库里短曲少，可以：\n` +
      `1. 把 maxDuration 调到 180 或 300 试试更长一点的\n` +
      `2. 换个关键词（lofi / jazz / piano / chill）\n` +
      `3. 或者直接从用户给的链接下载（用 download，支持续传）`
    )
  }

  // 记一下最近给过的，方便下次换点别的
  try {
    const cache = readCache()
    for (const track of picked) cache[track.id] = Date.now()
    fs.mkdirSync(path.dirname(cacheFile), { recursive: true })
    fs.writeFileSync(cacheFile, JSON.stringify(Object.fromEntries(Object.entries(cache).slice(-80))))
  } catch {
    // 缓存失败不影响找歌
  }

  const lines = [`找到 ${picked.length} 首（上限 ${cap} 秒）：`, '']

  picked.forEach((track, index) => {
    lines.push(`${index + 1}. ${track.title}${track.artist ? ` — ${track.artist}` : ''}`)
    lines.push(`   时长 ${formatDuration(track.duration)}${track.genre ? `｜${track.genre}` : ''}`)
    lines.push(`   直链 ${track.url}`)
  })

  lines.push('')
  lines.push('用法：把直链原样传给 send_audio 发出去，QQ 平台自己会去拉，服务器不用下载。')
  lines.push('不要先 download 再发本地文件——这台机器带宽只有十几 KB/s，那是下下策。')

  return lines.join('\n')
}

export const MUSIC_HANDLERS = { find_music: findMusic }

export const MUSIC_TOOLS = [
  {
    name: 'find_music',
    type: 'tool',
    description:
      '找能直接播放的免费音乐（艺术家授权上传的曲库），返回标题、时长和直链。' +
      '拿到直链直接交给 send_audio 发出去，QQ 平台会自己去拉，服务器不需要下载。' +
      '默认只找 60 秒以内的——超过 60 秒的语音在 QQ 里可能发不出去或被当成文件。' +
      '用户说「来首歌」「放点轻音乐」「找首 lofi」时用它；找不到短曲会自动换几个关键词再捞。',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: '歌名、艺人或风格关键词（如 lofi / jazz / piano）。不填就取当前热门',
        },
        maxDuration: {
          type: 'integer',
          minimum: 10,
          maximum: 600,
          description: '最长时长（秒），默认 60。想发整首歌再调大，但要接受可能变成文件',
        },
        limit: {
          type: 'integer',
          minimum: 1,
          maximum: 5,
          description: '返回几首，默认 3',
        },
      },
    },
  },
]
