import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// 任务清单：模型自己拆步骤、自己打勾。
// 长任务最容易出的问题是「跑到一半忘了还剩什么」，有了清单，每轮提示词里都挂着进度，
// 模型不容易跑偏，也能在最后自查有没有漏。
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const dataDir = path.join(projectRoot, 'data')
const todoFile = path.join(dataDir, 'todos.json')

const MAX_ITEMS = 20
const MAX_TITLE = 60
const STALE_STEPS = 5
const STALE_REMIND_EVERY = 6

const STATUS = new Set(['pending', 'in_progress', 'done'])

let state = {}
let saveTimer = null

function load() {
  try {
    if (!fs.existsSync(todoFile)) return
    const raw = JSON.parse(fs.readFileSync(todoFile, 'utf8'))
    if (raw && typeof raw === 'object') state = raw
  } catch (error) {
    console.error('[清单] 读取失败：', error?.message ?? error)
  }
}

function persist() {
  try {
    fs.mkdirSync(dataDir, { recursive: true })
    const tmp = `${todoFile}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(state))
    fs.renameSync(tmp, todoFile)
  } catch (error) {
    console.error('[清单] 落盘失败：', error?.message ?? error)
  }
}

function scheduleSave() {
  clearTimeout(saveTimer)
  saveTimer = setTimeout(persist, 400)
  saveTimer.unref?.()
}

function normalize(items) {
  if (!Array.isArray(items)) throw new Error('items 必须是数组')

  return items
    .map((item) => {
      const title = String(item?.title ?? '').trim().slice(0, MAX_TITLE)
      const status = String(item?.status ?? 'pending').trim()
      if (!title) return null
      return { title, status: STATUS.has(status) ? status : 'pending' }
    })
    .filter(Boolean)
    .slice(0, MAX_ITEMS)
}

function entryOf(sessionKey) {
  let entry = state[sessionKey]
  if (!entry) {
    entry = { items: [], updatedAt: 0, stepsSinceWrite: 0, stepsSinceRemind: 0 }
    state[sessionKey] = entry
  }
  return entry
}

/** 覆盖式写入清单。模型每次给全量（不是增量），免得它自己算漏 */
export function writeTodos(sessionKey, items) {
  const list = normalize(items)
  const entry = entryOf(sessionKey)

  entry.items = list
  entry.updatedAt = Date.now()
  entry.stepsSinceWrite = 0
  entry.stepsSinceRemind = 0
  scheduleSave()

  return { items: list, progress: progressOf(list) }
}

export function progressOf(items) {
  const done = items.filter((item) => item.status === 'done').length
  const doing = items.filter((item) => item.status === 'in_progress').length
  return { total: items.length, done, doing, open: items.length - done }
}

function marker(status) {
  if (status === 'done') return '[x]'
  if (status === 'in_progress') return '[~]'
  return '[ ]'
}

export function listTodos(sessionKey) {
  return state[sessionKey]?.items ?? []
}

/** 注入提示词：有清单就挂上进度，空的就返回空串 */
export function todoPrompt(sessionKey) {
  const items = listTodos(sessionKey)
  if (items.length === 0) return ''

  const { total, done, open } = progressOf(items)
  const lines = items.map((item) => `${marker(item.status)} ${item.title}`)

  return (
    `【任务清单】\n${lines.join('\n')}\n` +
    `（进度 ${done}/${total}${open > 0 ? `，还剩 ${open} 项` : '，全部完成'}。` +
    '做完一项就用 todo_write 更新状态，别让清单和实际进度对不上；全部完成后可以清空）'
  )
}

/**
 * 每跑完一轮工具调一次。清单太久没更新、又还有没做完的，就提醒一次。
 * @returns {string} 要注入的提醒，空串表示不用提
 */
export function noteTodoStep(sessionKey) {
  const entry = state[sessionKey]
  if (!entry || entry.items.length === 0) return ''

  entry.stepsSinceWrite += 1
  entry.stepsSinceRemind += 1

  const { open, done, total } = progressOf(entry.items)
  if (open === 0) return ''
  if (entry.stepsSinceWrite < STALE_STEPS) return ''
  if (entry.stepsSinceRemind < STALE_REMIND_EVERY) return ''

  entry.stepsSinceRemind = 0

  return (
    `（系统提示）任务清单已经 ${entry.stepsSinceWrite} 步没更新了，当前 ${done}/${total} 完成。` +
    `如果还在推进，用 todo_write 更新一下状态；如果清单已经不准了，重写一份新的。` +
    '别一边说做完了、一边清单上还有没勾的项。'
  )
}

export function clearTodos(sessionKey) {
  const entry = state[sessionKey]
  if (!entry) return false
  entry.items = []
  entry.updatedAt = Date.now()
  entry.stepsSinceWrite = 0
  scheduleSave()
  return true
}

export function formatTodos(sessionKey) {
  const items = listTodos(sessionKey)
  if (items.length === 0) return '当前没有任务清单。'
  const { total, done } = progressOf(items)
  return [`进度 ${done}/${total}`, ...items.map((item) => `${marker(item.status)} ${item.title}`)].join('\n')
}

export function flushTodos() {
  clearTimeout(saveTimer)
  persist()
}

load()
