import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// 定时任务推送台账。
// 为什么要单独一份：定时任务走主动消息，不经过回复链路，
// 补跑 / 自愈重试 / 重启补跑 这三条路都可能把同一条内容再推一遍。
// 发之前先查这里，命中就不发；发完把 message_id 记下来，发错了能撤。
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const dataDir = path.join(projectRoot, 'data')
const outboxFile = path.join(dataDir, 'outbox.json')

const MAX_KEEP = 300
// 默认去重窗口 20 小时：覆盖「昨晚没跑成、今天早上补跑」这种情况
const DUP_WINDOW_MS = 20 * 60 * 60 * 1000

let entries = null

function load() {
  if (entries) return entries
  entries = []
  try {
    const raw = JSON.parse(fs.readFileSync(outboxFile, 'utf8'))
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
    const tmp = `${outboxFile}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(list, null, 2))
    fs.renameSync(tmp, outboxFile)
  } catch (error) {
    console.error('[推送台账] 写出失败：', error?.message ?? error)
  }
}

// 内容指纹：归一化空白后做 djb2，加上长度，足够区分「同一条早报」和「新一天的早报」
export function fingerprint(text) {
  const raw = String(text ?? '').replace(/\s+/g, ' ').trim()
  let hash = 5381
  for (let i = 0; i < raw.length; i += 1) {
    hash = ((hash << 5) + hash + raw.charCodeAt(i)) | 0
  }
  return `${(hash >>> 0).toString(36)}-${raw.length}`
}

function targetKey(target) {
  const type = target?.type === 'group' ? 'group' : 'user'
  return `${type}:${target?.id ?? ''}`
}

/**
 * 发之前查重。
 * @param {object} params
 * @param {string} params.taskId
 * @param {object} params.target
 * @param {string} params.text 打算发的内容
 * @param {boolean} params.catchUp 这次是不是补跑
 * @param {number} params.windowMs
 * @returns {null | { reason: string, at: number, preview: string }}
 */
export function checkDuplicate({
  taskId,
  target,
  text,
  catchUp = false,
  windowMs = DUP_WINDOW_MS,
} = {}) {
  const list = load()
  if (list.length === 0) return null

  const now = Date.now()
  const key = targetKey(target)
  const fp = fingerprint(text)
  const recent = list.filter((item) => now - item.t <= windowMs && item.target === key).reverse()

  // 1. 一模一样的内容已经在窗口内发过 —— 不管是不是补跑，都算重复
  const same = recent.find((item) => item.taskId === taskId && item.fp === fp)
  if (same) {
    return { reason: '内容与已推送的记录完全相同', at: same.t, preview: same.preview }
  }

  // 2. 补跑时更严一点：这个任务今天已经推成功过，就整个跳过（内容变了也不算新的一次）
  if (catchUp) {
    const today = recent.find((item) => item.taskId === taskId)
    if (today) {
      return { reason: '这个定时任务在窗口内已经推送成功过', at: today.t, preview: today.preview }
    }
  }

  return null
}

/**
 * 记一条推送。返回是否和窗口内已有的某条重复（并发竞态时的兜底）。
 */
export function recordSent({ taskId, target, text, ids = [], note = '' } = {}) {
  const list = load()
  const now = Date.now()
  const key = targetKey(target)
  const fp = fingerprint(text)

  const dupOf = list
    .filter((item) => item.taskId === taskId && item.target === key && item.fp === fp)
    .filter((item) => now - item.t <= DUP_WINDOW_MS)
    .slice(-1)[0]

  list.push({
    t: now,
    taskId: String(taskId ?? ''),
    target: key,
    fp,
    preview: String(text ?? '').replace(/\s+/g, ' ').slice(0, 80),
    ids: (Array.isArray(ids) ? ids : [ids]).map((id) => String(id ?? '')).filter(Boolean),
    note,
  })

  persist()

  return dupOf ? { duplicated: true, at: dupOf.t, preview: dupOf.preview } : { duplicated: false }
}

export function listOutbox(target, limit = 10) {
  const key = targetKey(target)
  return load()
    .filter((item) => item.target === key)
    .slice(-Math.max(1, limit))
    .reverse()
}

export function formatOutbox(target, limit = 10) {
  const list = listOutbox(target, limit)
  if (list.length === 0) return '这个会话没有定时任务推送记录。'
  return list
    .map((item) => {
      const time = new Date(item.t).toLocaleString('zh-CN', { hour12: false })
      return `${time} ${item.taskId}｜${item.preview || '（无预览）'}`
    })
    .join('\n')
}
