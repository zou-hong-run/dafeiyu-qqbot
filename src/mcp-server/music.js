import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// 找能直接播放的音乐。
//
// 关于音源：之前试过几个「开源曲库 + 音频直链」的服务，实测这台机器和 QQ 平台
// 两头都拉不动那些 CDN（send_audio 报 40093007 富媒体下载失败，本地 fetch failed）。
// 换成 iTunes 的公开搜索接口后稳定了：试听是 30 秒、约 1MB 的 m4a，放在 Apple 的
// CDN 上，本地实测 2.6MB/s，比那些曲库快几十倍，文件也小得多。
//
// 所以这里的定位是「30 秒试听」：找得到、发得出去、不占带宽。
// 要整首歌只能让用户给直链，走 download 下（这台机器带宽十几 KB/s，很慢）。
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const cacheFile = path.join(projectRoot, 'data', 'music-cache.json')

const SEARCH_API = 'https://itunes.apple.com/search'
const TIMEOUT_MS = 15_000
const MAX_RESULTS = 5
const PREVIEW_SECONDS = 30

function readCache() {
  try {
    const raw = JSON.parse(fs.readFileSync(cacheFile, 'utf8'))
    return raw && typeof raw === 'object' ? raw : {}
  } catch {
    return {}
  }
}

function writeCache(data) {
  try {
    fs.mkdirSync(path.dirname(cacheFile), { recursive: true })
    const entries = Object.entries(data).slice(-80)
    fs.writeFileSync(cacheFile, JSON.stringify(Object.fromEntries(entries)))
  } catch {
    // 缓存失败不影响找歌
  }
}

async function getJson(url) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { Accept: 'application/json', 'User-Agent': 'qq-bot/1.0' },
    })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    return await response.json()
  } finally {
    clearTimeout(timer)
  }
}

function clean(value, limit = 60) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, limit)
}

async function findMusic({ query = '', limit = 3, country = 'cn' } = {}) {
  const keyword = clean(query, 80) || 'lofi'
  const want = Math.min(Math.max(Math.floor(Number(limit) || 3), 1), MAX_RESULTS)
  const region = /^[a-z]{2}$/i.test(String(country ?? '')) ? String(country).toLowerCase() : ''

  const build = (withRegion) =>
    `${SEARCH_API}?term=${encodeURIComponent(keyword)}&media=music&entity=song` +
    `&limit=${Math.max(want * 4, 10)}` +
    (withRegion ? `&country=${withRegion}` : '')

  let payload = null
  let lastError = ''

  // 有些地区的曲库不提供试听（比如 cn），指定了却没结果就退回默认区再搜一次
  for (const attempt of region ? [build(region), build('')] : [build('')]) {
    try {
      payload = await getJson(attempt)
      if (Array.isArray(payload?.results) && payload.results.some((row) => row?.previewUrl)) break
    } catch (error) {
      lastError = String(error?.message ?? error)
      payload = null
    }
  }

  if (!payload) {
    return (
      `搜索失败了${lastError ? `（${lastError}）` : ''}。` +
      '可能这台机器临时连不上搜索接口，过一会儿再试；也可以让用户直接给一个 mp3 直链。'
    )
  }

  const rows = Array.isArray(payload?.results) ? payload.results : []
  const usable = rows
    .filter((row) => row && row.previewUrl && /^https?:\/\//i.test(row.previewUrl))
    .map((row) => ({
      title: clean(row.trackName) || '未命名',
      artist: clean(row.artistName),
      album: clean(row.collectionName, 40),
      url: row.previewUrl,
    }))
    .slice(0, want)

  if (usable.length === 0) {
    return (
      `没搜到「${keyword}」的可试听结果。换个写法试试：歌名 + 歌手（例如「晴天 周杰伦」），` +
      '或者只给风格（lofi / jazz / piano）。'
    )
  }

  // 记一下给过哪些，方便下次换点别的
  try {
    const cache = readCache()
    for (const track of usable) cache[track.url] = Date.now()
    writeCache(cache)
  } catch {
    // 忽略
  }

  const lines = [
    `找到 ${usable.length} 首（每段都是 ${PREVIEW_SECONDS} 秒试听，不是整首）：`,
    '',
  ]

  usable.forEach((track, index) => {
    lines.push(`${index + 1}. ${track.title}${track.artist ? ` — ${track.artist}` : ''}`)
    if (track.album) lines.push(`   专辑 ${track.album}`)
    lines.push(`   直链 ${track.url}`)
  })

  lines.push('')
  lines.push('怎么发：')
  lines.push('1. 先把直链原样传给 send_audio，让 QQ 平台自己去拉，服务器不用下载。')
  lines.push('2. 如果报「富媒体文件下载失败」或 40093007，说明平台拉不动，再走兜底：')
  lines.push('   download 把直链下到本地（约 1MB，可能要续传一两次），然后用 send_audio 发本地文件名。')
  lines.push('   本地文件是 .m4a 也没关系，发送时会自动转成 mp3。')

  return lines.join('\n')
}

export const MUSIC_HANDLERS = { find_music: findMusic }

export const MUSIC_TOOLS = [
  {
    name: 'find_music',
    type: 'tool',
    description:
      '搜歌，返回歌名、歌手和一段 30 秒试听的音频直链（约 1MB，Apple CDN，速度快）。' +
      '拿到直链先直接交给 send_audio（平台代拉，服务器不下载）；报「富媒体下载失败」再 download 到本地发。' +
      '注意这只是 30 秒试听，不是整首；用户要整首就让他给 mp3 直链。' +
      '用户说「来首歌」「放点轻音乐」「找首 lofi」「放首周杰伦」时用它。',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: '歌名、歌手或风格，如「晴天 周杰伦」「lofi」「piano」。不填默认 lofi',
        },
        limit: {
          type: 'integer',
          minimum: 1,
          maximum: 5,
          description: '返回几首，默认 3',
        },
        country: {
          type: 'string',
          description: '曲库地区（两位国家码，如 us / jp）。留空用默认区，一般别传——有些地区不给试听',
        },
      },
    },
  },
]
