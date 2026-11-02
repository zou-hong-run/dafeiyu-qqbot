import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { CronExpressionParser } from 'cron-parser'

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const dataDir = path.join(projectRoot, 'data')
const scheduleFile = path.join(dataDir, 'schedules.json')

const MAX_PER_SESSION = 5
const MAX_TOTAL = 20
// 启动补跑：只补最近 6 小时内错过的，太久的不补（避免关机一整天后一次性轰炸）
const CATCHUP_MAX_AGE_MS = 6 * 60 * 60 * 1000
const CATCHUP_DELAY_MS = 20_000

let tasks = []
let deps = { sendMessage: null, runTask: null }
let lastTickKey = ''

function load() {
  try {
    const raw = JSON.parse(fs.readFileSync(scheduleFile, 'utf8'))
    // running 是内存态：重启后从磁盘读回来一律清掉，否则会永远被当成「正在跑」跳过
    if (Array.isArray(raw)) return raw.map((task) => ({ ...task, running: false }))
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

// cron 解析交给 cron-parser：手写实现容易在 */n、范围、跨月这些地方翻车
export function cronMatches(expr, date = new Date()) {
  const raw = String(expr ?? '').trim()
  if (raw.split(/\s+/).length !== 5) return false

  try {
    // 以「前一分钟」为基准取 next()，落在当前这一分钟就算命中
    const from = new Date(date.getTime() - 60_000)
    const next = CronExpressionParser.parse(raw, { currentDate: from }).next().toDate()
    return Math.floor(next.getTime() / 60_000) === Math.floor(date.getTime() / 60_000)
  } catch {
    return false
  }
}

// 上一次命中 cron 的时刻，找不到返回 null
export function previousMatch(cronExpr, from = new Date()) {
  const raw = String(cronExpr ?? '').trim()
  if (raw.split(/\s+/).length !== 5) return null

  try {
    return CronExpressionParser.parse(raw, { currentDate: from }).prev().toDate().getTime()
  } catch {
    return null
  }
}

export function validateCron(expr) {
  const raw = String(expr ?? '').trim()
  if (!raw) return 'cron 不能为空'

  if (raw.split(/\s+/).length !== 5) {
    return 'cron 必须是 5 段：分 时 日 月 周，例如 30 8 * * * 表示每天 8:30'
  }

  try {
    CronExpressionParser.parse(raw)
    return null
  } catch (error) {
    return `cron 表达式不合法：${String(error?.message ?? error).slice(0, 80)}`
  }
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

async function fire(task, options = {}) {
  if (task.running) return
  task.running = true
  task.lastRunAt = Date.now()

  const catchUpNote = options.catchUp
    ? `｜补发（原定 ${new Date(options.plannedAt).toLocaleString('zh-CN', { hour12: false })}）`
    : ''

  try {
    console.log(`[定时] 触发 ${task.id}（${describeCron(task.cron)}）${catchUpNote}`)
    const result = await deps.runTask(task)

    task.lastStatus = options.catchUp ? 'ok:catchup' : 'ok'
    persist()

    if (result) {
      await deps.sendMessage(
        task.target,
        `定时任务 ${task.id}｜${describeCron(task.cron)}${catchUpNote}\n\n${result}`,
      )
    }
  } catch (error) {
    task.lastStatus = `failed: ${error?.message ?? error}`.slice(0, 120)
    persist()
    await deps
      .sendMessage(task.target, `定时任务 ${task.id} 执行失败：${error?.message ?? error}`)
      .catch(() => {})
  } finally {
    task.running = false
    persist()
  }
}

// 启动时补跑：上次该跑的时刻没跑（进程当时没在跑），就补一次
async function catchUpMissed() {
  const now = Date.now()
  for (const task of tasks) {
    if (!task.enabled || task.running) continue

    const plannedAt = previousMatch(task.cron, new Date(now))
    if (!plannedAt) continue
    if (now - plannedAt > CATCHUP_MAX_AGE_MS) continue

    // 任务本身是触发时刻之后才创建的，说明那会儿还不存在，不算错过
    const anchor = Math.max(Number(task.lastRunAt) || 0, Number(task.createdAt) || 0)
    if (anchor >= plannedAt) continue

    console.log(`[定时] 补跑 ${task.id}，错过 ${new Date(plannedAt).toLocaleString('zh-CN')}`)
    await fire(task, { catchUp: true, plannedAt })
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
  persist() // 把清干净的 running 写回磁盘

  const timer = setInterval(tick, 20_000)
  timer.unref?.()

  const active = tasks.filter((task) => task.enabled).length
  console.log(`[定时] 已加载 ${tasks.length} 个任务（启用 ${active} 个）`)

  // 等网关和依赖就绪后再补跑，避免启动瞬间发不出去
  setTimeout(() => {
    catchUpMissed().catch((error) => console.error('[定时] 补跑异常：', error?.message ?? error))
  }, CATCHUP_DELAY_MS).unref?.()
}

export function schedulerStats() {
  return {
    total: tasks.length,
    enabled: tasks.filter((task) => task.enabled).length,
  }
}
