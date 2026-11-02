import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// 观察态：只在「本来会去接话」的时候记一笔，不真的回复
// 用来回答一个问题：如果放开主动性，它到底会插手哪些消息
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const dataDir = path.join(projectRoot, 'data')
const obsFile = path.join(dataDir, 'observations.json')
const MAX = 300

let list = []
let saveTimer = null

try {
  if (fs.existsSync(obsFile)) {
    const raw = JSON.parse(fs.readFileSync(obsFile, 'utf8'))
    if (Array.isArray(raw)) list = raw.slice(-MAX)
  }
} catch (error) {
  console.error('[观察] 读取失败：', error?.message ?? error)
}

function scheduleSave() {
  clearTimeout(saveTimer)
  saveTimer = setTimeout(() => {
    try {
      fs.mkdirSync(dataDir, { recursive: true })
      const tmp = `${obsFile}.tmp`
      fs.writeFileSync(tmp, JSON.stringify(list, null, 2))
      fs.renameSync(tmp, obsFile)
    } catch (error) {
      console.error('[观察] 落盘失败：', error?.message ?? error)
    }
  }, 300)
  saveTimer.unref?.()
}

export function record({ groupId, userId, userName, text, urgency, reason }) {
  list.push({
    t: Date.now(),
    groupId,
    userId,
    userName: String(userName ?? '').slice(0, 40),
    text: String(text ?? '').slice(0, 120),
    urgency: urgency ?? '',
    reason: String(reason ?? '').slice(0, 120),
  })

  if (list.length > MAX) list.splice(0, list.length - MAX)
  scheduleSave()
}

export function recent(groupId, limit = 10) {
  return list
    .filter((item) => !groupId || item.groupId === groupId)
    .slice(-limit)
    .reverse()
}

export function stats(groupId) {
  const scoped = groupId ? list.filter((item) => item.groupId === groupId) : list
  return {
    total: scoped.length,
    today: scoped.filter((item) => Date.now() - item.t < 86_400_000).length,
    lastAt: scoped[scoped.length - 1]?.t ?? 0,
  }
}

export function clear(groupId) {
  list = groupId ? list.filter((item) => item.groupId !== groupId) : []
  scheduleSave()
}
