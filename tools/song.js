#!/usr/bin/env node
// 点歌工具（song search）
// 数据源：iTunes Search API（免 key）。失败时回退到 Deezer 公开搜索接口。

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'

// ── 1. 工具清单 ──────────────────────────────────────────────
const TOOLS = [
  {
    // 不能叫 search：内置的联网搜索已经占了这个名字，撞名会被跳过
    name: 'song',
    description:
      '点歌/搜歌：输入歌名，或「歌名 歌手」，返回候选歌曲的歌名、歌手、专辑、可点击播放链接、30 秒试听链接(previewUrl)和封面图(artworkUrl 300x300)。结果里会给出前几条候选，可以再把封面/试听用 send_card 或 send_audio 发到群里。',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '歌名，或「歌名 歌手」，例如「晴天 周杰伦」' },
        limit: { type: 'number', description: '返回候选数量，默认 5，最多 10' },
      },
      required: ['query'],
    },
  },
]

// ── 2. 数据源 ────────────────────────────────────────────────
const UA = 'Mozilla/5.0 (compatible; KunBot/1.0)'

async function fetchJson(url, timeoutMs = 8000) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': UA, Accept: 'application/json' },
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    return await res.json()
  } finally {
    clearTimeout(timer)
  }
}

function upscaleArtwork(url) {
  if (!url) return ''
  return String(url).replace(/100x100bb/, '300x300bb').replace(/\/(\d+)x\1bb\//, '/300x300bb/')
}

async function searchItunes(q, limit) {
  const url = `https://itunes.apple.com/search?term=${encodeURIComponent(q)}&media=music&limit=${limit}`
  const data = await fetchJson(url)
  const results = Array.isArray(data?.results) ? data.results : []
  return results
    .filter((r) => r.kind === 'song' || r.wrapperType === 'track' || r.trackName)
    .map((r) => ({
      title: r.trackName || '',
      artist: r.artistName || '',
      album: r.collectionName || '',
      link: r.trackViewUrl || '',
      previewUrl: r.previewUrl || '',
      artwork: upscaleArtwork(r.artworkUrl100 || r.artworkUrl60 || ''),
      source: 'iTunes',
    }))
}

async function searchDeezer(q, limit) {
  const url = `https://api.deezer.com/search?q=${encodeURIComponent(q)}&limit=${limit}`
  const data = await fetchJson(url)
  const results = Array.isArray(data?.data) ? data.data : []
  return results.map((r) => ({
    title: r.title || '',
    artist: r.artist?.name || '',
    album: r.album?.title || '',
    link: r.link || '',
    previewUrl: r.preview || '',
    artwork: r.album?.cover_xl || r.album?.cover_big || r.album?.cover_medium || '',
    source: 'Deezer',
  }))
}

// ── 3. 实现 ──────────────────────────────────────────────────
const HANDLERS = {
  async search({ query, limit }) {
    const q = String(query ?? '').trim()
    if (!q) throw new Error('请提供歌名，或「歌名 歌手」')
    const n = Math.min(Math.max(Number(limit) || 5, 1), 10)

    let songs = []
    let err = null
    const errors = []

    try {
      songs = await searchItunes(q, n)
    } catch (e) {
      errors.push(`iTunes 失败：${e?.message ?? e}`)
    }

    if (!songs.length) {
      try {
        songs = await searchDeezer(q, n)
      } catch (e) {
        errors.push(`Deezer 失败：${e?.message ?? e}`)
      }
    }

    if (!songs.length) {
      err = errors.join('；') || '没有找到结果'
      return `没搜到「${q}」的歌曲。${err ? `（接口情况：${err}）` : ''}换个别名、少写点字，或者只写歌名再试试。`
    }

    const lines = []
    lines.push(`搜到「${q}」的候选歌曲（来源 ${songs[0].source}）：`)
    lines.push('')
    songs.forEach((s, i) => {
      lines.push(`${i + 1}. ${s.title} — ${s.artist}`)
      lines.push(`   专辑：${s.album || '未知'}`)
      lines.push(`   播放链接：${s.link || '无'}`)
      lines.push(`   30 秒试听：${s.previewUrl || '无'}`)
      lines.push(`   封面(300x300)：${s.artwork || '无'}`)
      lines.push('')
    })
    lines.push('提示：可以把封面和播放链接用 send_card 发成卡片（pic_url 填 artwork，url 填播放链接）；')
    lines.push('或者用 send_audio 把 previewUrl 的 30 秒试听发到群里。如果用户要完整歌曲，就只给播放链接。')

    return lines.join('\n')
  },
}

// ── 4. 协议装配 ──────────────────────────────────────────────
const server = new Server({ name: 'song-search', version: '1.0.0' }, { capabilities: { tools: {} } })

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }))

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args = {} } = request.params
  const handler = HANDLERS[name]
  if (!handler) {
    return { content: [{ type: 'text', text: `未知工具: ${name}` }], isError: true }
  }
  try {
    const result = await handler(args)
    return { content: [{ type: 'text', text: String(result) }] }
  } catch (error) {
    return {
      content: [{ type: 'text', text: `${name} 调用失败：${error?.message ?? error}` }],
      isError: true,
    }
  }
})

await server.connect(new StdioServerTransport())
console.error(`[song-search] 已就绪，工具：${TOOLS.map((t) => t.name).join(', ')}`)
