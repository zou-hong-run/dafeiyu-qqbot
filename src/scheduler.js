import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const dataDir = path.join(projectRoot, 'data')
const scheduleFile = path.join(dataDir, 'schedules.json')

const MAX_PER_SESSION = 5
const MAX_TOTAL = 20

let tasks = []
let deps = { sendMessage: null, runTask: null }
let lastTickKey = ''

function load() {
  try {
    const raw = JSON.parse(fs.readFileSync(scheduleFile, 'utf8'))
    if (Array.isArray(raw)) return raw
  } catch {
    return []
  }
  return []
}

function persist() {
  try {
    fs.mkdirSync(dataDir, { recursive: true })
    const tmp = `${scheduleFile}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(tasks, null, 2))
    fs.renameSync(tmp, scheduleFile)
  } catch (error) {
    console.error('[定时] 保存失败：', error?.message ?? error)
  }
}

function matchField(field, value) {
  if (field === '*' || field === '?') return true

  for (const part of String(field).split(',')) {
    if (part.includes('/')) {
      const [base, stepRaw] = part.split('/')
      const step = Number(stepRaw)
      const start = base === '*' ? 0 : Number(base)
      if (!Number.isFinite(step) || step <= 0) continue
      if (value >= start && (value - start) % step === 0) return true
      continue
    }

    if (part.includes('-')) {
      const [a, b] = part.split('-').map(Number)
      if (Number.isFinite(a) && Number.isFinite(b) && value >= a && value <= b) return true
      continue
    }

    if (Number(part) === value) return true
  }

  return false
}

export function cronMatches(expr, date = new Date()) {
  const fields = String(expr ?? '').trim().split(/\s+/)
  if (fields.length !== 5) return false

  const [minute, hour, dayOfMonth, month, dayOfWeek] = fields
  return (
    matchField(minute, date.getMinutes()) &&
    matchField(hour, date.getHours()) &&
    matchField(dayOfMonth, date.getDate()) &&
    matchField(month, date.getMonth() + 1) &&
    matchField(dayOfWeek, date.getDay())
  )
}

export function validateCron(expr) {
  const fields = String(expr ?? '').trim().split(/\s+/)
  if (fields.length !== 5) {
    return 'cron 必须是 5 段：分 时 日 月 周，例如 30 8 * * * 表示每天 8:30'
  }

  const ranges = [
    [0, 59, '分钟'],
    [0, 23, '小时'],
    [1, 31, '日'],
    [1, 12, '月'],
    [0, 6, '星期'],
  ]

  for (let i = 0; i < 5; i += 1) {
    const [min, max, label] = ranges[i]
    const field = fields[i]
    if (field === '*' || field === '?') continue

    for (const part of field.split(',')) {
      const numbers = part
        .replace(/\//g, '-')
        .split('-')
        .filter((item) => item !== '' && item !== '*')
        .map(Number)

      for (const value of numbers) {
        if (!Number.isFinite(value) || value < min || value > max) {
          return `${label}字段「${part}」超出范围（${min}-${max}）`
        }
      }
    }
  }

  return null
}

function describeCron(expr) {
  const [minute, hour, dom, month, dow] = String(expr).trim().split(/\s+/)
  if (minute !== '*' && hour !== '*' && dom === '*' && month === '*' && dow === '*') {
    return `每天 ${hour.padStart(2, '0')}:${minute.padStart(2, '0')}`
  }
  if (minute !== '*' && hour === '*') return `每小时第 ${minute} 分`
  if (minute === '*' && hour === '*') return '每分钟'
  return `cron ${expr}`
}

export function addSchedule({ sessionKey, target, cron, prompt }) {
  const error = validateCron(cron)
  if (error) throw new Error(error)

  const text = String(prompt ?? '').trim()
  if (text.length < 5) throw new Error('任务描述太短，写清楚到点要做什么')

  const mine = tasks.filter((task) => task.sessionKey === sessionKey)
  if (mine.length >= MAX_PER_SESSION) {
    throw new Error(`这个会话已经有 ${mine.length} 个定时任务了，上限 ${MAX_PER_SESSION} 个`)
  }
  if (tasks.length >= MAX_TOTAL) {
    throw new Error(`系统里定时任务总数已达上限 ${MAX_TOTAL}，先删几个`)
  }

  const task = {
    id: `sched-${Date.now().toString(36)}`,
    sessionKey,
    target,
    cron: String(cron).trim(),
    prompt: text.slice(0, 1000),
    enabled: true,
    createdAt: Date.now(),
    lastRunAt: null,
    lastStatus: null,
  }

  tasks.push(task)
  persist()

  return {
    id: task.id,
    cron: task.cron,
    when: describeCron(task.cron),
    prompt: task.prompt,
  }
}

export function listSchedules(sessionKey) {
  return tasks
    .filter((task) => task.sessionKey === sessionKey)
    .map((task) => ({
      id: task.id,
      when: describeCron(task.cron),
      cron: task.cron,
      prompt: task.prompt,
      enabled: task.enabled,
      lastRunAt: task.lastRunAt,
      lastStatus: task.lastStatus,
    }))
}

export function removeSchedule(id, sessionKey) {
  const index = tasks.findIndex((task) => task.id === id && task.sessionKey === sessionKey)
  if (index < 0) throw new Error(`找不到定时任务 ${id}`)
  const [removed] = tasks.splice(index, 1)
  persist()
  return removed
}

async function fire(task) {
  if (task.running) return
  task.running = true
  task.lastRunAt = Date.now()

  try {
    console.log(`[定时] 触发 ${task.id}（${describeCron(task.cron)}）`)
    const result = await deps.runTask(task)

    task.lastStatus = 'ok'
    persist()

    if (result) {
      await deps.sendMessage(task.target, `定时任务 ${task.id}｜${describeCron(task.cron)}\n\n${result}`)
    }
  } catch (error) {
    task.lastStatus = `failed: ${error?.message ?? error}`.slice(0, 120)
    persist()
    await deps
      .sendMessage(task.target, `定时任务 ${task.id} 执行失败：${error?.message ?? error}`)
      .catch(() => {})
  } finally {
    task.running = false
  }
}

function tick() {
  const now = new Date()
  const key = `${now.getFullYear()}-${now.getMonth()}-${now.getDate()}-${now.getHours()}-${now.getMinutes()}`
  if (key === lastTickKey) return
  lastTickKey = key

  for (const task of tasks) {
    if (!task.enabled) continue
    if (task.running) continue
    if (!cronMatches(task.cron, now)) continue
    fire(task).catch((error) => console.error('[定时] 执行异常：', error?.message ?? error))
  }
}

export function initScheduler({ sendMessage, runTask }) {
  deps = { sendMessage, runTask }
  tasks = load()

  const timer = setInterval(tick, 20_000)
  timer.unref?.()

  const active = tasks.filter((task) => task.enabled).length
  console.log(`[定时] 已加载 ${tasks.length} 个任务（启用 ${active} 个）`)
}

export function schedulerStats() {
  return {
    total: tasks.length,
    enabled: tasks.filter((task) => task.enabled).length,
  }
}
