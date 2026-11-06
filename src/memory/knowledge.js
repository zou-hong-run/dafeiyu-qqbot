import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import * as groupLog from './group-log.js'

// 群知识：把原始群记录沉淀成「这个群是什么群、谁是谁、常在什么时候聊」
// 和 read_profile 的区别：那个是临时查询，这个是落盘沉淀 + 每轮自动注入提示词
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const dataDir = path.join(projectRoot, 'data')
const knowledgeFile = path.join(dataDir, 'knowledge.json')

const WINDOW = 800
const TOP_MEMBERS = 6
const MAX_GROUPS = 30

let state = {}
let saveTimer = null

function load() {
  try {
    if (!fs.existsSync(knowledgeFile)) return
    const raw = JSON.parse(fs.readFileSync(knowledgeFile, 'utf8'))
    if (raw && typeof raw === 'object') state = raw
  } catch (error) {
    console.error('[知识] 读取失败，从空开始：', error?.message ?? error)
  }
}

function persist() {
  try {
    fs.mkdirSync(dataDir, { recursive: true })

    const keys = Object.keys(state)
      .sort((a, b) => (state[a].updatedAt ?? 0) - (state[b].updatedAt ?? 0))
      .slice(-MAX_GROUPS)

    const trimmed = Object.fromEntries(keys.map((key) => [key, state[key]]))
    const tmp = `${knowledgeFile}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(trimmed))
    fs.renameSync(tmp, knowledgeFile)
  } catch (error) {
    console.error('[知识] 落盘失败：', error?.message ?? error)
  }
}

function scheduleSave() {
  clearTimeout(saveTimer)
  saveTimer = setTimeout(persist, 500)
  saveTimer.unref?.()
}

function bandOf(hours) {
  const bucket = { 凌晨: 0, 上午: 0, 下午: 0, 晚上: 0 }
  for (const hour of hours) {
    if (hour < 6) bucket.凌晨 += 1
    else if (hour < 12) bucket.上午 += 1
    else if (hour < 18) bucket.下午 += 1
    else bucket.晚上 += 1
  }

  const top = Object.entries(bucket).sort((a, b) => b[1] - a[1])[0]
  if (!top || top[1] === 0) return ''
  return top[1] / hours.length >= 0.4 ? top[0] : ''
}

// 简单的话题倾向：数关键词出现次数，不做分词
const TOPIC_WORDS = [
  ['技术', ['代码', '报错', 'bug', 'BUG', '接口', '部署', '服务器', '脚本', '数据库', '前端', '后端', 'python', 'js', 'node']],
  ['闲聊', ['哈哈', '笑死', '吃饭', '睡', '周末', '天气', '梗', '哈哈哈']],
  ['问答', ['怎么', '为什么', '能不能', '有没有', '求助', '请问', '?' , '？']],
  ['工作', ['项目', '需求', '排期', '上线', '会议', '客户']],
]

function detectTopics(entries) {
  const scores = new Map()

  for (const [label, words] of TOPIC_WORDS) {
    let hits = 0
    for (const entry of entries) {
      const text = String(entry.c ?? '')
      if (words.some((word) => text.includes(word))) hits += 1
    }
    if (hits > 0) scores.set(label, hits)
  }

  return [...scores.entries()]
    .sort((a, b) => b[1] - a[1])
    .filter(([, hits]) => hits >= Math.max(2, entries.length * 0.05))
    .slice(0, 3)
    .map(([label]) => label)
}

function rebuildGroup(groupId, window = WINDOW) {
  const entries = groupLog.recent(groupId, window)
  if (entries.length === 0) {
    delete state[groupId]
    scheduleSave()
    return null
  }

  const people = new Map()
  for (const entry of entries) {
    const id = String(entry.u ?? '')
    if (!id || id === 'bot') continue

    if (!people.has(id)) {
      people.set(id, { userId: id, name: entry.n || `用户${id.slice(-4)}`, count: 0, hours: [], lastAt: 0 })
    }

    const person = people.get(id)
    person.count += 1
    person.hours.push(new Date(entry.t).getHours())
    person.lastAt = Math.max(person.lastAt, entry.t)
    if (entry.n) person.name = entry.n
  }

  const members = [...people.values()]
    .sort((a, b) => b.count - a.count)
    .slice(0, TOP_MEMBERS)
    .map((person) => ({
      name: person.name,
      userId: person.userId,
      count: person.count,
      share: Math.round((person.count / entries.length) * 100),
      peak: bandOf(person.hours),
      lastAt: person.lastAt,
    }))

  const times = entries.map((entry) => entry.t).filter(Boolean)
  const knowledge = {
    analyzed: entries.length,
    from: Math.min(...times),
    to: Math.max(...times),
    members,
    topics: detectTopics(entries),
    updatedAt: Date.now(),
  }

  state[groupId] = knowledge
  scheduleSave()
  return knowledge
}

export function rebuildAll() {
  let ids = []
  try {
    ids = fs
      .readdirSync(path.join(dataDir, 'groups'))
      .filter((name) => name.endsWith('.jsonl'))
      .map((name) => name.slice(0, -6))
  } catch {
    ids = []
  }

  let count = 0
  for (const id of ids) {
    if (rebuildGroup(id)) count += 1
  }
  return count
}

/**
 * 生成注入提示词用的短摘要（控制长度，别占太多上下文）
 */
export function knowledgePrompt(groupId) {
  if (!groupId) return ''
  const knowledge = state[groupId]
  if (!knowledge || knowledge.members.length === 0) return ''

  const days = Math.max(1, Math.round((knowledge.to - knowledge.from) / 86400000))
  const memberText = knowledge.members
    .slice(0, 5)
    .map((item) => `${item.name}(${item.count}条${item.peak ? `,常在${item.peak}` : ''})`)
    .join('、')

  const topicText = knowledge.topics.length > 0 ? `；话题偏向${knowledge.topics.join('/')}` : ''

  return (
    `【本群情况】最近记录 ${knowledge.analyzed} 条（约 ${days} 天），` +
    `主要发言者：${memberText}${topicText}`
  )
}
export function flushKnowledge() {
  clearTimeout(saveTimer)
  persist()
}

load()
