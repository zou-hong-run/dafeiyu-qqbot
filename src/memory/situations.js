import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// 情绪记忆：记下「谁在为什么事发愁 / 期待 / 卡住」
// 和长期记忆的区别：长期记忆记事实（叫什么、做什么），这里记「正在进行中的事」，有始有终
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const dataDir = path.join(projectRoot, 'data')
const situationFile = path.join(dataDir, 'situations.json')

const MAX_PER_SESSION = 12
const MAX_SESSIONS = 60
const PROMPT_LIMIT = 3

let state = {}
let saveTimer = null
let seq = 0

function load() {
  try {
    if (!fs.existsSync(situationFile)) return
    const raw = JSON.parse(fs.readFileSync(situationFile, 'utf8'))
    if (raw && typeof raw === 'object') state = raw

    for (const list of Object.values(state)) {
      for (const item of list) {
        const number = Number(String(item.id ?? '').replace(/^s-/, ''))
        if (Number.isFinite(number) && number > seq) seq = number
      }
    }
  } catch (error) {
    console.error('[情绪] 读取失败：', error?.message ?? error)
  }
}

function persist() {
  try {
    fs.mkdirSync(dataDir, { recursive: true })

    const keys = Object.keys(state)
      .sort((a, b) => (Math.max(...state[a].map((i) => i.at)) || 0) - (Math.max(...state[b].map((i) => i.at)) || 0))
      .slice(-MAX_SESSIONS)

    const trimmed = Object.fromEntries(keys.map((key) => [key, state[key]]))
    const tmp = `${situationFile}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(trimmed))
    fs.renameSync(tmp, situationFile)
  } catch (error) {
    console.error('[情绪] 落盘失败：', error?.message ?? error)
  }
}

function scheduleSave() {
  clearTimeout(saveTimer)
  saveTimer = setTimeout(persist, 500)
  saveTimer.unref?.()
}

function normalize(text) {
  return String(text ?? '').replace(/\s+/g, ' ').trim()
}

/**
 * 记一件「正在发生的事」
 * @param {string} sessionKey
 * @param {{ person?: string, topic: string, mood?: string }} input
 */
export function noteSituation(sessionKey, { person = '', topic = '', mood = '' } = {}) {
  const text = normalize(topic)
  if (!text) throw new Error('缺少要记的事情')

  const list = state[sessionKey] ?? []

  // 同一件事别重复记：40 字内相似就当同一条
  const duplicated = list.find(
    (item) => !item.resolved && (item.topic.includes(text.slice(0, 20)) || text.includes(item.topic.slice(0, 20))),
  )
  if (duplicated) {
    duplicated.at = Date.now()
    duplicated.mood = mood || duplicated.mood
    scheduleSave()
    return { duplicated: true, item: duplicated }
  }

  const item = {
    id: `s-${++seq}`,
    person: normalize(person).slice(0, 20),
    topic: text.slice(0, 120),
    mood: normalize(mood).slice(0, 12),
    at: Date.now(),
    resolved: false,
    followUpAt: 0,
  }

  list.push(item)
  state[sessionKey] = list.slice(-MAX_PER_SESSION)
  scheduleSave()
  return { duplicated: false, item }
}

export function pendingSituations(sessionKey, limit = PROMPT_LIMIT) {
  const list = state[sessionKey] ?? []
  return list.filter((item) => !item.resolved).slice(-limit).reverse()
}

export function allPending(limit = 20) {
  const result = []
  for (const [sessionKey, list] of Object.entries(state)) {
    for (const item of list) {
      if (!item.resolved) result.push({ sessionKey, ...item })
    }
  }
  return result.sort((a, b) => b.at - a.at).slice(0, limit)
}

export function resolveSituation(sessionKey, id) {
  const list = state[sessionKey] ?? []
  const target = id
    ? list.find((item) => item.id === id)
    : list.filter((item) => !item.resolved).slice(-1)[0]

  if (!target) return null
  target.resolved = true
  target.at = Date.now()
  scheduleSave()
  return target
}

/** 拣出该回访的：超过 N 小时还没解决、也没回访过 */
export function dueFollowUps({ minAgeMs = 6 * 3600_000, limit = 2 } = {}) {
  const now = Date.now()
  const due = []

  for (const [sessionKey, list] of Object.entries(state)) {
    for (const item of list) {
      if (item.resolved || item.followUpAt) continue
      if (now - item.at < minAgeMs) continue
      due.push({ sessionKey, ...item })
    }
  }

  return due.sort((a, b) => a.at - b.at).slice(0, limit)
}

export function markFollowedUp(sessionKey, id) {
  const list = state[sessionKey] ?? []
  const target = list.find((item) => item.id === id)
  if (!target) return null
  target.followUpAt = Date.now()
  scheduleSave()
  return target
}

/** 注入提示词用的短摘要 */
export function situationPrompt(sessionKey) {
  const list = pendingSituations(sessionKey)
  if (list.length === 0) return ''

  const lines = list.map((item) => {
    const when = new Date(item.at).toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit' })
    const who = item.person || '对方'
    const mood = item.mood ? `（${item.mood}）` : ''
    return `- ${who} ${when}${mood}：${item.topic}`
  })

  return `【还在进行中的事】\n${lines.join('\n')}\n（有下文就顺手提一句，别每次都问）`
}

export function formatSituations(sessionKey) {
  const list = state[sessionKey] ?? []
  if (list.length === 0) return '还没记下什么正在进行的事。'

  return list
    .slice()
    .reverse()
    .map((item) => {
      const flag = item.resolved ? '已解决' : item.followUpAt ? '已回访' : '进行中'
      const who = item.person || '对方'
      return `${item.id}｜${flag}｜${who}：${item.topic}`
    })
    .join('\n')
}

export function flushSituations() {
  clearTimeout(saveTimer)
  persist()
}

load()
