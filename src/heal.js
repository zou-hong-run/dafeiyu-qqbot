import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// 自愈节流：定时任务挂了自己去查去改，但不能无限次改。
// 规则：同一个任务 + 同一种报错 24 小时内只自愈一次；
//       同一个任务 1 小时内最多自愈 2 次；同一任务连续自愈失败 3 次就停手，等人工。
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const dataDir = path.join(projectRoot, 'data')
const healFile = path.join(dataDir, 'heals.json')

const SIG_WINDOW_MS = 24 * 60 * 60 * 1000
const TASK_WINDOW_MS = 60 * 60 * 1000
const TASK_MAX_PER_WINDOW = 2
const MAX_KEEP = 200

let entries = null

function load() {
  if (entries) return entries
  entries = []
  try {
    const raw = JSON.parse(fs.readFileSync(healFile, 'utf8'))
    if (Array.isArray(raw)) entries = raw.filter((item) => item && item.t)
  } catch {
    entries = []
  }
  return entries
}

function persist() {
  try {
    fs.mkdirSync(dataDir, { recursive: true })
    const list = load().slice(-MAX_KEEP)
    entries = list
    const tmp = `${healFile}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(list, null, 2))
    fs.renameSync(tmp, healFile)
  } catch (error) {
    console.error('[自愈] 记录写出失败：', error?.message ?? error)
  }
}

// 把报错压成一个签名：去掉数字和十六进制地址，避免同一个 bug 每次算出不同的钥匙
export function errorSignature(error) {
  const raw = String(error?.message ?? error ?? '').trim()
  const firstLine = raw.split('\n').find((line) => line.trim()) ?? ''
  return firstLine
    .replace(/0x[0-9a-f]+/gi, '0xX')
    .replace(/\d+/g, 'N')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 160) || '未知错误'
}

/**
 * 这次失败能不能自愈。
 * @returns {{ ok: boolean, reason?: string }}
 */
export function canHeal(taskId, signature) {
  const list = load()
  const now = Date.now()
  const id = String(taskId ?? '')
  const sig = String(signature ?? '')

  const sameSig = list.find(
    (item) => item.taskId === id && item.sig === sig && now - item.t <= SIG_WINDOW_MS,
  )
  if (sameSig) {
    return { ok: false, reason: '这种报错 24 小时内已经自愈过一次了，不重复折腾' }
  }

  const recent = list.filter((item) => item.taskId === id && now - item.t <= TASK_WINDOW_MS)
  if (recent.length >= TASK_MAX_PER_WINDOW) {
    return { ok: false, reason: `这个任务一小时内已经自愈过 ${recent.length} 次，先停手` }
  }

  const lastThree = list.filter((item) => item.taskId === id).slice(-3)
  if (lastThree.length === 3 && lastThree.every((item) => item.ok === false)) {
    return { ok: false, reason: '这个任务连续自愈失败 3 次，需要人工看' }
  }

  return { ok: true }
}

export function markHeal(taskId, signature, { ok = false, note = '', attempt = '' } = {}) {
  const list = load()
  list.push({
    t: Date.now(),
    taskId: String(taskId ?? ''),
    sig: String(signature ?? ''),
    ok: Boolean(ok),
    note: String(note ?? '').slice(0, 200),
    attempt: String(attempt ?? '').slice(0, 20),
  })
  persist()
}

export function recentHeals(limit = 10) {
  return load().slice(-limit).reverse()
}

export function formatHeals(limit = 10) {
  const list = recentHeals(limit)
  if (list.length === 0) return '还没有自愈记录。'
  return list
    .map((item) => {
      const time = new Date(item.t).toLocaleString('zh-CN', { hour12: false })
      const flag = item.ok ? '修好' : '没修好'
      return `${time} ${item.taskId} ${flag}｜${item.sig}${item.note ? `｜${item.note}` : ''}`
    })
    .join('\n')
}
