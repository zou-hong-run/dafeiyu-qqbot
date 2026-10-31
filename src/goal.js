import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const dataDir = path.join(projectRoot, 'data')
const goalFile = path.join(dataDir, 'goals.json')

const MAX_CHARS = 600

let cache = null

function load() {
  if (cache) return cache

  try {
    const raw = JSON.parse(fs.readFileSync(goalFile, 'utf8'))
    cache = raw && typeof raw === 'object' ? raw : {}
  } catch {
    cache = {}
  }

  return cache
}

function persist() {
  try {
    fs.mkdirSync(dataDir, { recursive: true })
    const tmp = `${goalFile}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(cache, null, 2))
    fs.renameSync(tmp, goalFile)
  } catch (error) {
    console.error('[目标] 保存失败：', error?.message ?? error)
  }
}

export function setGoal(sessionKey, text) {
  const clean = String(text ?? '').trim().slice(0, MAX_CHARS)
  if (clean.length < 4) throw new Error('目标描述太短，写清楚要完成什么')

  const store = load()
  const now = Date.now()
  store[sessionKey] = { text: clean, createdAt: store[sessionKey]?.createdAt ?? now, updatedAt: now }
  persist()

  return store[sessionKey]
}

export function getGoal(sessionKey) {
  return load()[sessionKey] ?? null
}

export function clearGoal(sessionKey) {
  const store = load()
  const existed = Boolean(store[sessionKey])
  delete store[sessionKey]
  persist()
  return existed
}

export function goalPrompt(sessionKey) {
  const goal = getGoal(sessionKey)
  if (!goal) return ''

  const ageMinutes = Math.round((Date.now() - goal.createdAt) / 60000)
  return (
    `【未完成的目标（跨轮保留）】\n${goal.text}\n` +
    `（设定于 ${ageMinutes} 分钟前。这是长期目标：除非目标里的所有事项确实做完、产出已经交付，否则不要清除它。` +
    '单纯回答问题、汇报进度、闲聊都不算完成，不需要调用 clear。）'
  )
}
