import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const logDir = path.join(projectRoot, 'data', 'groups')

const MAX_MEMORY = 600
const MAX_FILE_LINES = 2000

const memory = new Map()
const lineCounts = new Map()

function fileOf(groupId) {
  const safe = String(groupId ?? '').replace(/[^a-zA-Z0-9_-]/g, '')
  return path.join(logDir, `${safe}.jsonl`)
}

function load(groupId) {
  const cached = memory.get(groupId)
  if (cached) return cached

  const entries = []
  try {
    const lines = fs.readFileSync(fileOf(groupId), 'utf8').split('\n').filter(Boolean)
    for (const line of lines.slice(-MAX_MEMORY)) {
      try {
        entries.push(JSON.parse(line))
      } catch {
        continue
      }
    }
    lineCounts.set(groupId, lines.length)
  } catch {
    lineCounts.set(groupId, 0)
  }

  memory.set(groupId, entries)
  return entries
}

function trim(groupId) {
  const entries = memory.get(groupId) ?? []
  try {
    fs.mkdirSync(logDir, { recursive: true })
    fs.writeFileSync(fileOf(groupId), entries.map((entry) => JSON.stringify(entry)).join('\n') + '\n')
    lineCounts.set(groupId, entries.length)
  } catch (error) {
    console.error('[群记录] 裁剪失败：', error?.message ?? error)
  }
}

export function record(groupId, entry) {
  const entries = load(groupId)
  entries.push(entry)
  if (entries.length > MAX_MEMORY) entries.splice(0, entries.length - MAX_MEMORY)

  try {
    fs.mkdirSync(logDir, { recursive: true })
    fs.appendFileSync(fileOf(groupId), `${JSON.stringify(entry)}\n`)
    const count = (lineCounts.get(groupId) ?? 0) + 1
    lineCounts.set(groupId, count)
    if (count > MAX_FILE_LINES) trim(groupId)
  } catch (error) {
    console.error('[群记录] 写入失败：', error?.message ?? error)
  }
}

export function recent(groupId, limit = 200) {
  return load(groupId).slice(-limit)
}

export function statsOf(groupId) {
  const entries = load(groupId)
  const first = entries[0]?.t
  const last = entries[entries.length - 1]?.t
  return {
    count: entries.length,
    from: first ? new Date(first).toLocaleString('zh-CN') : null,
    to: last ? new Date(last).toLocaleString('zh-CN') : null,
  }
}

export function clear(groupId) {
  memory.delete(groupId)
  lineCounts.delete(groupId)
  try {
    fs.rmSync(fileOf(groupId), { force: true })
  } catch {
    return false
  }
  return true
}

export function formatForSummary(entries) {
  return entries
    .map((entry) => {
      const time = new Date(entry.t).toLocaleTimeString('zh-CN', { hour12: false })
      const who = entry.n || `用户${String(entry.u ?? '').slice(-4)}`
      return `${time} ${who}：${entry.c}`
    })
    .join('\n')
}
