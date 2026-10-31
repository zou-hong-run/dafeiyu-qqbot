import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const dataDir = path.join(projectRoot, 'data')
const memoryFile = path.join(dataDir, 'memory.json')

const SHORT_TERM_LIMIT = 16
const LONG_TERM_LIMIT = 60
const MID_TERM_LIMIT = 2000

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

export function getSession(key) {
  let session = state.sessions[key]
  if (!session) {
    session = blank()
    state.sessions[key] = session
  }
  return session
}

export function appendTurn(key, userText, assistantText) {
  const session = getSession(key)
  session.shortTerm.push(
    { role: 'user', content: userText },
    { role: 'assistant', content: assistantText },
  )
  session.updatedAt = Date.now()
  scheduleSave()
}

export function takeOverflow(key) {
  const session = getSession(key)
  if (session.shortTerm.length <= SHORT_TERM_LIMIT * 2) return null
  const overflow = session.shortTerm.splice(0, session.shortTerm.length - SHORT_TERM_LIMIT * 2)
  scheduleSave()
  return overflow
}

export function setMidTerm(key, summary) {
  const session = getSession(key)
  session.midTerm = String(summary ?? '').slice(0, MID_TERM_LIMIT)
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
  const clean = String(text ?? '').trim()
  if (!clean) return false

  const session = getSession(key)
  if (session.longTerm.some((item) => item.text === clean)) return false

  session.longTerm.push({
    id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    text: clean.slice(0, 500),
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
    .filter((item) => item.score > 0.1)
}

export function recentLongTerm(key, limit = 5) {
  const session = getSession(key)
  return session.longTerm.slice(-limit)
}

export function history(key) {
  return getSession(key).shortTerm
}

export function midTerm(key) {
  return getSession(key).midTerm
}

export function reset(key) {
  state.sessions[key] = blank()
  scheduleSave()
}

export function stats(key) {
  const session = getSession(key)
  return {
    shortTerm: session.shortTerm.length / 2,
    midTermChars: session.midTerm.length,
    longTerm: session.longTerm.length,
  }
}

export function flush() {
  clearTimeout(saveTimer)
  persist()
}
