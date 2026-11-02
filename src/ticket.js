import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// 工单：Super-agent 架构里 Router 和 Worker 之间的唯一契约
// 一项工作从「谁来提的、授权依据是什么」到「做到哪一步、交付了什么」都记在这里，落盘可恢复
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const dataDir = path.join(projectRoot, 'data')
const ticketFile = path.join(dataDir, 'tickets.json')

export const STATUS = {
  pending: 'pending',
  running: 'running',
  awaiting: 'awaiting',
  done: 'done',
  failed: 'failed',
  cancelled: 'cancelled',
  interrupted: 'interrupted',
}

const ACTIVE = new Set([STATUS.pending, STATUS.running, STATUS.awaiting])

const tickets = new Map()
let seq = 0
let saveTimer = null

function load() {
  try {
    if (!fs.existsSync(ticketFile)) return
    const raw = JSON.parse(fs.readFileSync(ticketFile, 'utf8'))
    if (!Array.isArray(raw)) return

    for (const item of raw) {
      if (!item?.id) continue
      tickets.set(item.id, item)
      const number = Number(String(item.id).replace(/^t-/, ''))
      if (Number.isFinite(number) && number > seq) seq = number
    }
  } catch (error) {
    console.error('[工单] 读取失败，从空档案开始：', error?.message ?? error)
  }
}

function persistNow() {
  try {
    fs.mkdirSync(dataDir, { recursive: true })
    const list = [...tickets.values()].sort((a, b) => a.createdAt - b.createdAt).slice(-200)
    const tmp = `${ticketFile}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(list, null, 2))
    fs.renameSync(tmp, ticketFile)
  } catch (error) {
    console.error('[工单] 落盘失败：', error?.message ?? error)
  }
}

function scheduleSave() {
  clearTimeout(saveTimer)
  saveTimer = setTimeout(persistNow, 300)
  saveTimer.unref?.()
}

load()

export function createTicket({ sessionKey, target, goal, actor = '', scope = 'group', source = 'im' }) {
  const id = `t-${++seq}`
  const now = Date.now()
  const ticket = {
    id,
    sessionKey,
    target,
    goal: String(goal ?? '').slice(0, 2000),
    actor,
    scope,
    source,
    status: STATUS.pending,
    step: 0,
    reports: 0,
    attempts: 0,
    progress: { at: now, signature: '', streak: 0 },
    deliveries: [],
    createdAt: now,
    updatedAt: now,
    error: '',
  }

  tickets.set(id, ticket)
  scheduleSave()
  return ticket
}

export function getTicket(id) {
  return tickets.get(String(id ?? '').trim()) ?? null
}

export function updateTicket(id, patch = {}) {
  const ticket = getTicket(id)
  if (!ticket) return null

  Object.assign(ticket, patch, { updatedAt: Date.now() })
  scheduleSave()
  return ticket
}

function touchProgress(ticket, step, toolName) {
  const signature = String(toolName ?? '')
  const same = signature && signature === ticket.progress.signature

  ticket.step = step
  ticket.progress = {
    at: Date.now(),
    signature,
    // 连续两次同样的工具算一次「无效循环」计数，由 watchdog 判读
    streak: same ? ticket.progress.streak + 1 : 0,
  }
  ticket.updatedAt = Date.now()
  scheduleSave()
}

export function noteStep(id, step, toolName) {
  const ticket = getTicket(id)
  if (!ticket) return null
  touchProgress(ticket, step, toolName)
  return ticket
}

// 一轮结束、有实质产出时调用：清空「连续同一工具」的计数
export function markProgress(id) {
  const ticket = getTicket(id)
  if (!ticket) return null

  ticket.progress = { at: Date.now(), signature: '', streak: 0 }
  ticket.updatedAt = Date.now()
  scheduleSave()
  return ticket
}

export function noteDelivery(id, text) {
  const ticket = getTicket(id)
  if (!ticket) return null

  ticket.deliveries.push({ at: Date.now(), text: String(text ?? '').slice(0, 500) })
  if (ticket.deliveries.length > 20) ticket.deliveries.splice(0, ticket.deliveries.length - 20)
  ticket.updatedAt = Date.now()
  scheduleSave()
  return ticket
}

export function finishTicket(id, { status, answer = '', error = '' }) {
  const ticket = getTicket(id)
  if (!ticket) return null

  ticket.status = status
  ticket.answer = String(answer ?? '').slice(0, 4000)
  ticket.error = String(error ?? '').slice(0, 500)
  ticket.updatedAt = Date.now()
  ticket.finishedAt = ticket.updatedAt
  scheduleSave()
  return ticket
}

export function listTickets({ status, sessionKey, limit = 20 } = {}) {
  return [...tickets.values()]
    .filter((ticket) => (status ? ticket.status === status : true))
    .filter((ticket) => (sessionKey ? ticket.sessionKey === sessionKey : true))
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, limit)
}

export function activeTickets(sessionKey) {
  return [...tickets.values()].filter(
    (ticket) => ACTIVE.has(ticket.status) && (!sessionKey || ticket.sessionKey === sessionKey),
  )
}

// 启动时把上次没跑完的工单标成 interrupted，交给 Router 决定是重开还是放弃
export function recoverTickets() {
  const recovered = []

  for (const ticket of tickets.values()) {
    if (!ACTIVE.has(ticket.status)) continue

    ticket.status = STATUS.interrupted
    ticket.updatedAt = Date.now()
    ticket.error = '进程重启时任务还没结束'
    recovered.push(ticket)
  }

  if (recovered.length > 0) scheduleSave()
  return recovered
}

export function describeTicket(ticket) {
  const elapsed = Math.round(((ticket.finishedAt ?? Date.now()) - ticket.createdAt) / 1000)
  const idle = Math.round((Date.now() - (ticket.progress?.at ?? ticket.createdAt)) / 1000)

  return [
    `${ticket.id} [${ticket.status}] ${ticket.goal.slice(0, 60)}`,
    `  步数 ${ticket.step}｜已跑 ${elapsed}s｜空闲 ${idle}s｜第 ${ticket.attempts} 轮`,
    ticket.error ? `  错误：${ticket.error}` : '',
  ]
    .filter(Boolean)
    .join('\n')
}

export function flushTickets() {
  clearTimeout(saveTimer)
  persistNow()
}
