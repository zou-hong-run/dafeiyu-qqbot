import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { callTool } from '../mcp/client.js'
import { hotTakeReply } from '../chat/deepseek.js'

// 热点吐槽：自己去搜当天新闻，挑一条在群里损两句
// 和主动接话的区别：主动接话是「有人问了没人答」，这里是「没人问，我自己想聊」
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const dataDir = path.join(projectRoot, 'data')
const takeFile = path.join(dataDir, 'hot-takes.json')

const KEEP_TOPICS = 20

// 生成之后再兜一道：命中就整条丢掉，不发也不报错
const BLOCKLIST =
  /政治|领导人|政府|官员|选举|两会|台独|港独|新疆|西藏|战争|导弹|军演|伤亡|遇难|死亡|去世|自杀|空难|地震|洪水|矿难|性别对立|女权|地域黑|出轨|离婚|私生活|明星绯闻/

const QUERIES = [
  'AI 大模型 发布 争议',
  '科技互联网 公司 今天 新闻',
  '开源项目 新版本 发布',
  '游戏 更新 玩家 讨论',
  '数码 硬件 新品 评测',
]

let state = { recent: [], lastAt: 0 }

function load() {
  try {
    if (!fs.existsSync(takeFile)) return
    const raw = JSON.parse(fs.readFileSync(takeFile, 'utf8'))
    if (Array.isArray(raw?.recent)) state.recent = raw.recent.slice(-KEEP_TOPICS)
    if (Number.isFinite(raw?.lastAt)) state.lastAt = raw.lastAt
  } catch (error) {
    console.error('[热点] 读取历史失败：', error?.message ?? error)
  }
}

function persist() {
  try {
    fs.mkdirSync(dataDir, { recursive: true })
    fs.writeFileSync(takeFile, JSON.stringify(state))
  } catch (error) {
    console.error('[热点] 落盘失败：', error?.message ?? error)
  }
}

function dateString(daysAgo = 0) {
  return new Date(Date.now() - daysAgo * 86400_000).toISOString().slice(0, 10)
}

function pickQuery() {
  const base = QUERIES[Math.floor(Math.random() * QUERIES.length)]
  return `${base} after:${dateString(1)}`
}

/**
 * 搜一条当天热点，生成一条吐槽。
 * 返回 { topic, text }；不适合发的时候返回 null（调用方什么都不用做）
 */
export async function generateHotTake({ personaName = '' } = {}) {
  let headlines = ''
  try {
    headlines = await callTool('search', { query: pickQuery(), count: 8 }, 30_000)
  } catch (error) {
    console.warn('[热点] 搜索失败：', error?.message ?? error)
    return null
  }

  if (!headlines || headlines.length < 40) {
    console.warn('[热点] 搜索结果太少，跳过')
    return null
  }

  const take = await hotTakeReply({
    headlines: headlines.slice(0, 4000),
    recent: state.recent.slice(-6),
    personaName,
  })
  if (!take) return null

  if (BLOCKLIST.test(take.topic) || BLOCKLIST.test(take.text)) {
    console.log(`[热点] 命中黑名单，丢弃：${take.topic}`)
    return null
  }

  if (state.recent.includes(take.topic)) {
    console.log(`[热点] 话题重复，丢弃：${take.topic}`)
    return null
  }

  state.recent = [...state.recent, take.topic].slice(-KEEP_TOPICS)
  state.lastAt = Date.now()
  persist()

  return take
}

export function lastTakeAt() {
  return state.lastAt
}

export function flushHotTakes() {
  persist()
}

load()
