import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { env } from '../config/env.js'

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
let dataDir = path.join(projectRoot, 'data')
let memoryFile = path.join(dataDir, 'memory.json')

/**
 * 测试用：把记忆文件指到临时目录。
 * 不加这个的话，单测里 appendTurn 会往真实的 data/memory.json 里写测试会话。
 */
export function useMemoryDir(dir) {
  dataDir = dir
  memoryFile = path.join(dir, 'memory.json')
  state = { sessions: {} }
}

const SHORT_TERM_LIMIT = Math.max(env.historyTurns, 1) * 2
const LONG_TERM_LIMIT = 60
const MID_TERM_LIMIT = 2000
const TOOL_MARKUP = /[｜|]{2}\s*DSML/i

let state = { sessions: {} }
let saveTimer = null

try {
  if (fs.existsSync(memoryFile)) {
    const raw = JSON.parse(fs.readFileSync(memoryFile, 'utf8'))
    if (raw && typeof raw === 'object' && raw.sessions) state = raw
  }
} catch (error) {
  console.error('[记忆] 读取失败，从空档案开始：', error?.message ?? error)
}

function cleanContent(text) {
  const raw = String(text ?? '').trim()
  if (!TOOL_MARKUP.test(raw)) return raw

  const cut = raw.search(TOOL_MARKUP)
  if (cut < 0) return raw
  if (cut === 0) return ''
  return raw.slice(0, cut).trim()
}

/**
 * 溢出内容留档。
 *
 * 压缩是就地改历史：那批原文压进摘要之后，除了这里就没有第二份了。
 * 摘要写歪了（漏事实、把没定的写成定了）的时候，这是唯一能翻回去核对的地方。
 * 只写不读——需要时人工去看，不给模型开读取口子。
 */
function archiveOverflow(key, messages) {
  try {
    // 跟着 dataDir 走：测试把记忆指到临时目录时，归档也跟着过去
    const archiveDir = path.join(dataDir, 'memory-archive')
    fs.mkdirSync(archiveDir, { recursive: true })
    const safeKey = String(key).replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 80)
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')
    const file = path.join(archiveDir, `${stamp}-${safeKey}.jsonl`)
    const lines = messages.map((message) =>
      JSON.stringify({ at: Date.now(), key, role: message.role, name: message.name ?? '', content: message.content }),
    )
    fs.appendFileSync(file, `${lines.join('\n')}\n`)
  } catch (error) {
    console.error('[记忆] 溢出留档失败：', error?.message ?? error)
  }
}

/** 这段历史之外，还有多少轮已经被压进摘要了 */
export function elisionInfo(key) {
  const entry = getSession(key)
  const rounds = Number(entry.elidedRounds) || 0
  const tokens = Number(entry.elidedTokens) || 0
  return rounds > 0 ? { rounds, tokens } : null
}

function persist() {
  try {
    fs.mkdirSync(dataDir, { recursive: true })
    const tmp = `${memoryFile}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2))
    fs.renameSync(tmp, memoryFile)
  } catch (error) {
    console.error('[记忆] 写入失败：', error?.message ?? error)
  }
}

function scheduleSave() {
  clearTimeout(saveTimer)
  saveTimer = setTimeout(persist, 400)
  saveTimer.unref?.()
}

function blank() {
  return { shortTerm: [], midTerm: '', longTerm: [], updatedAt: Date.now() }
}

function getSession(key) {
  let session = state.sessions[key]
  if (!session) {
    session = blank()
    state.sessions[key] = session
  }
  return session
}

/**
 * 追加一轮对话。
 *
 * name 是说话人昵称：群里所有人共用一个 sessionKey，不记名字的话
 * 历史里就是一串分不清是谁的「用户：……」，翻两轮之后就认不出人了。
 */
export function appendTurn(key, userText, assistantText, { name = '' } = {}) {
  const session = getSession(key)
  const answer = cleanContent(assistantText)
  if (!answer) return

  const who = String(name ?? '').trim().slice(0, 20)
  const userMessage = { role: 'user', content: String(userText ?? '').trim() }
  if (who) userMessage.name = who

  session.shortTerm.push(userMessage, { role: 'assistant', content: answer })
  session.updatedAt = Date.now()
  scheduleSave()
}

function estimateTokens(text) {
  const value = String(text ?? '')
  if (!value) return 0

  const cjk = (value.match(/[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]/g) ?? []).length
  return Math.ceil(cjk / 1.5 + (value.length - cjk) / 4)
}

export function historyTokens(key) {
  return getSession(key).shortTerm.reduce((sum, message) => sum + estimateTokens(message.content), 0)
}

/**
 * 最早的一轮对话永不参与溢出。
 *
 * 只留最近 N 轮的话，"一开始要干什么"会被冲掉——用户说了半天需求，
 * 聊到后面机器人只记得最近的闲聊，忘了正题。留一条 user + 一条 assistant
 * 当锚点，代价是最近几轮少留一条。
 */
const HEAD_KEEP_MESSAGES = 2

/** 从「头部保留区」之后取走最旧的一条 */
function shiftOverflowable(session) {
  if (session.shortTerm.length <= HEAD_KEEP_MESSAGES) return null
  return session.shortTerm.splice(HEAD_KEEP_MESSAGES, 1)[0] ?? null
}

/**
 * 把溢出的内容还回去。
 *
 * 摘要生成失败时用它回滚——原来那批消息已经被移出短期记忆，
 * 摘要又没写成，内容就永久丢了，用户只能重说一遍。
 */
export function restoreOverflow(key, messages) {
  const list = Array.isArray(messages) ? messages.filter(Boolean) : []
  if (list.length === 0) return

  const session = getSession(key)
  session.shortTerm.splice(HEAD_KEEP_MESSAGES, 0, ...list)
  scheduleSave()
}

export function takeOverflow(key, budgetTokens = Number.POSITIVE_INFINITY) {
  const session = getSession(key)

  // 两道上限，谁的触发条件先满足都算溢出：
  // 1) 轮数上限（HISTORY_TURNS）——短期记忆就只该保留这么多轮
  // 2) token 上限——超长内容即使轮数不多也要压摘要
  if (session.shortTerm.length <= SHORT_TERM_LIMIT) {
    const totalTokens = session.shortTerm.reduce(
      (sum, message) => sum + estimateTokens(message.content),
      0,
    )
    if (totalTokens <= budgetTokens) return null
  }

  const target = Math.floor(budgetTokens * 0.7)
  const overflow = []

  // 先按轮数裁：保留最近 SHORT_TERM_LIMIT 条，但头部那几条锚点不动
  while (session.shortTerm.length > SHORT_TERM_LIMIT) {
    const message = shiftOverflowable(session)
    if (!message) break
    overflow.push(message)
  }

  // 再按 token 裁：轮数没超但内容太长时继续丢中间的
  let total = session.shortTerm.reduce((sum, message) => sum + estimateTokens(message.content), 0)
  while (total > target && session.shortTerm.length > HEAD_KEEP_MESSAGES + 2) {
    const message = shiftOverflowable(session)
    if (!message) break
    total -= estimateTokens(message.content)
    overflow.push(message)
  }

  if (overflow.length === 0) return null

  const elidedTokens = overflow.reduce((sum, message) => sum + estimateTokens(message.content), 0)
  session.elidedRounds = (Number(session.elidedRounds) || 0) + Math.ceil(overflow.length / 2)
  session.elidedTokens = (Number(session.elidedTokens) || 0) + elidedTokens

  archiveOverflow(key, overflow)
  scheduleSave()
  return overflow
}

export function setMidTerm(key, summary) {
  const session = getSession(key)
  session.midTerm = cleanContent(summary).slice(0, MID_TERM_LIMIT)
  session.updatedAt = Date.now()
  scheduleSave()
}

function bigrams(text) {
  const clean = String(text ?? '').toLowerCase().replace(/\s+/g, '')
  const grams = new Set()
  for (let i = 0; i < clean.length - 1; i += 1) grams.add(clean.slice(i, i + 2))
  return grams
}

function relevance(queryGrams, text, createdAt) {
  const grams = bigrams(text)
  let hits = 0
  for (const gram of queryGrams) if (grams.has(gram)) hits += 1
  const base = queryGrams.size === 0 ? 0 : hits / queryGrams.size

  const days = (Date.now() - (createdAt ?? 0)) / 86_400_000
  const freshness = 1 / (1 + days / 30)

  return base * 0.75 + freshness * 0.25
}

export function addLongTerm(key, text) {
  const clean = cleanContent(text).slice(0, 500)
  if (!clean) return false

  const session = getSession(key)
  if (session.longTerm.some((item) => item.text === clean)) return false

  session.longTerm.push({
    id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    text: clean,
    createdAt: Date.now(),
  })

  if (session.longTerm.length > LONG_TERM_LIMIT) {
    session.longTerm.splice(0, session.longTerm.length - LONG_TERM_LIMIT)
  }

  session.updatedAt = Date.now()
  scheduleSave()
  return true
}

export function recallLongTerm(key, query, limit = 6) {
  const session = getSession(key)
  if (session.longTerm.length === 0) return []

  const queryGrams = bigrams(query)
  return session.longTerm
    .map((item) => ({ ...item, score: relevance(queryGrams, item.text, item.createdAt) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .filter((item) => item.score > 0.1 && !TOOL_MARKUP.test(item.text))
}
export function history(key) {
  const list = getSession(key).shortTerm
  const inGroup = String(key).startsWith('group:')
  const result = []

  for (let i = 0; i + 1 < list.length; i += 2) {
    const user = list[i]
    const assistant = list[i + 1]
    if (!user || !assistant) break
    if (TOOL_MARKUP.test(user.content ?? '') || TOOL_MARKUP.test(assistant.content ?? '')) continue

    // 群聊历史前面带上昵称，翻回去也知道那句是谁说的；私聊不加，纯噪音
    const named =
      inGroup && user.name ? { role: 'user', content: `${user.name}：${user.content}` } : user
    result.push(named, assistant)
  }

  return result
}

export function midTerm(key) {
  return cleanContent(getSession(key).midTerm)
}

// 闲置会话回收：短期/中期是「这次聊天」，隔太久就该忘；
// 长期事实（remember 写的）永远保留，不受闲置影响
export function evictIdleSessions(ttlMs) {
  if (!(ttlMs > 0)) return { cleared: 0, removed: 0 }

  const now = Date.now()
  let cleared = 0
  let removed = 0

  for (const [key, session] of Object.entries(state.sessions)) {
    const idle = now - (session.updatedAt ?? 0)
    if (idle <= ttlMs) continue

    const hasLongTerm = Array.isArray(session.longTerm) && session.longTerm.length > 0
    const hasShortTerm = session.shortTerm.length > 0 || Boolean(session.midTerm)

    if (!hasShortTerm && !hasLongTerm) {
      delete state.sessions[key]
      removed += 1
      continue
    }

    if (hasShortTerm) {
      session.shortTerm = []
      session.midTerm = ''
      session.updatedAt = now
      cleared += 1
    }
  }

  if (cleared > 0 || removed > 0) scheduleSave()
  return { cleared, removed }
}

// 列出最近有活动的会话，重启播报要用
export function recentSessions(withinMs = 30 * 60_000) {
  const now = Date.now()
  return Object.entries(state.sessions)
    .filter(([, session]) => now - (session.updatedAt ?? 0) <= withinMs)
    .map(([key, session]) => ({
      key,
      updatedAt: session.updatedAt ?? 0,
      shortTerm: session.shortTerm.length / 2,
      longTerm: Array.isArray(session.longTerm) ? session.longTerm.length : 0,
    }))
    .sort((a, b) => b.updatedAt - a.updatedAt)
}

export function reset(key) {
  state.sessions[key] = blank()
  scheduleSave()
}

/**
 * 精准忘掉几条：从长期记忆里删掉包含关键词的条目，不动别的。
 * @returns {string[]} 被删掉的条目原文
 */
export function forget(key, keyword) {
  const word = String(keyword ?? '').trim()
  if (!word) return []

  const session = getSession(key)
  const removed = []
  session.longTerm = session.longTerm.filter((item) => {
    if (!String(item.text ?? '').includes(word)) return true
    removed.push(item.text)
    return false
  })

  if (removed.length > 0) {
    session.updatedAt = Date.now()
    scheduleSave()
  }
  return removed
}

export function listLongTerm(key, limit = 20) {
  const session = getSession(key)
  return session.longTerm.slice(-limit).map((item) => item.text)
}

export function stats(key) {
  const session = getSession(key)
  return {
    shortTerm: session.shortTerm.length / 2,
    midTermChars: session.midTerm.length,
    longTerm: session.longTerm.length,
    historyTokens: session.shortTerm.reduce((sum, message) => sum + estimateTokens(message.content), 0),
  }
}

export function flush() {
  clearTimeout(saveTimer)
  persist()
}
