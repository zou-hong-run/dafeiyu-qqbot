import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { CronExpressionParser } from 'cron-parser'
import { checkDuplicate, recordSent } from './outbox.js'
import { canHeal, errorSignature, markHeal } from './heal.js'

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
let dataDir = path.join(projectRoot, 'data')
let scheduleFile = path.join(dataDir, 'schedules.json')

/**
 * 测试用：把任务文件指到临时目录。
 *
 * 不加这个的话，单测里调 addSchedule 会写到真实的 data/schedules.json——
 * 在有任务的机器上跑一次 pnpm test 就能把用户的定时任务清空。
 */
export function useSchedulesDir(dir) {
  dataDir = dir
  scheduleFile = path.join(dir, 'schedules.json')
  tasks = []
  state().lastTickAt = 0
  state().startedAt = 0
}

const MAX_PER_SESSION = 5
const MAX_TOTAL = 20
// 启动补跑：只补最近 6 小时内错过的，太久的不补（避免关机一整天后一次性轰炸）
const CATCHUP_MAX_AGE_MS = 6 * 60 * 60 * 1000
const CATCHUP_DELAY_MS = 20_000
// 自愈修完之后隔多久重试
const RETRY_DELAY_MS = 4_000

let tasks = []
let deps = { sendMessage: null, runTask: null, selfHeal: null, recallSent: null, requestRestart: null }
let lastTickKey = ''

// 运行状态挂在 globalThis 上：万一这个模块被加载成两份实例（热重载、路径别名），
// /diag 读到的也是真正在跑的那一份，而不是一个从未初始化的副本
function state() {
  if (!globalThis.__schedulerState) {
    globalThis.__schedulerState = { timer: null, lastTickAt: 0, startedAt: 0 }
  }
  return globalThis.__schedulerState
}

// 20 秒一次：足够覆盖每分钟 cron，又不会太频繁
const TICK_INTERVAL_MS = 20_000

/**
 * 解析任务文件内容。
 *
 * 必须和「文件不存在」分开：文件不存在是第一次启动、本来就该是空的；
 * 文件读到了但内容不可用（JSON 坏了、顶层不是数组）是数据出了问题，
 * 当成空任务处理会把用户的任务静默清空。
 */
export function parseSchedules(text) {
  const raw = JSON.parse(text)
  if (!Array.isArray(raw)) throw new Error('顶层不是数组')

  const tasks = []
  for (const item of raw) {
    if (!item || typeof item !== 'object' || !item.id || !item.cron) {
      console.warn('[定时] 跳过一条不完整的任务记录：', JSON.stringify(item).slice(0, 120))
      continue
    }
    // running 是内存态：重启后一律清掉，否则会永远被当成「正在跑」跳过
    tasks.push({ ...item, running: false })
  }
  return tasks
}

function load() {
  let text
  try {
    text = fs.readFileSync(scheduleFile, 'utf8')
  } catch {
    return [] // 文件不存在：第一次启动，本来就该是空的
  }

  try {
    return parseSchedules(text)
  } catch (error) {
    // 损坏绝不能当成「没有任务」然后 persist 覆盖——那是静默清空用户的数据。
    // 先把原文件改名留档，人工还能捞回来。
    const backup = `${scheduleFile}.broken-${Date.now()}`
    try {
      fs.renameSync(scheduleFile, backup)
      console.error(
        `[定时] 任务文件损坏（${error?.message ?? error}），已备份为 ${path.basename(backup)}，本次按空任务启动`,
      )
    } catch (renameError) {
      console.error(`[定时] 任务文件损坏（${error?.message ?? error}），备份也失败：`, renameError?.message)
    }
    return []
  }
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
function previousMatch(cronExpr, from = new Date()) {
  const raw = String(cronExpr ?? '').trim()
  if (raw.split(/\s+/).length !== 5) return null

  try {
    return CronExpressionParser.parse(raw, { currentDate: from }).prev().toDate().getTime()
  } catch {
    return null
  }
}

function validateCron(expr) {
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

export function addSchedule({ sessionKey, target, cron, prompt, createdBy = '' }) {
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
    // 记创建者：删除时要验身份，否则群里任何人说「删掉定时任务」就能清空别人的早报
    createdBy: String(createdBy ?? ''),
  }

  tasks.push(task)
  persist()

  return {
    id: task.id,
    cron: task.cron,
      when: describeCron(task.cron),
    when: describeCron(task.cron),
    prompt: task.prompt,
  }
}

/**
 * 列出定时任务。
 *
 * 默认只看当前会话——群友不该看到别的群有什么任务。
 * all=true 是给管理员的：「所有群的定时任务是不是正常」这种问题，
 * 只按 sessionKey 过滤根本答不了。
 */
export function listSchedules(sessionKey, { all = false } = {}) {
  const scoped = all ? tasks : tasks.filter((task) => task.sessionKey === sessionKey)

  return scoped.map((task) => ({
    id: task.id,
    when: describeCron(task.cron),
    cron: task.cron,
    prompt: task.prompt,
    enabled: task.enabled,
    lastRunAt: task.lastRunAt,
    lastStatus: task.lastStatus,
    createdBy: task.createdBy ?? '',
    // 全局视图里要标明这条属于哪个会话，否则分不清是群还是私聊
    sessionKey: all ? task.sessionKey : undefined,
    target: all ? task.target : undefined,
    nextAt: nextMatchOf(task.cron),
  }))
}

/**
 * 删除任务。remove_schedule 是 OPEN 工具——群里任何人都能调，
 * 所以这里要验身份：只有创建者本人或管理员能删。
 *
 * 旧任务没有 createdBy（这一版之前建的），一律按「只有管理员能删」处理：
 * 宁可让管理员多动一下手，也不能让群友一句话清空别人的日程。
 */
export function removeSchedule(id, sessionKey, { actor = '', isAdmin = false } = {}) {
  let index = tasks.findIndex((task) => task.id === id && task.sessionKey === sessionKey)
  // 管理员在任何一个会话里都能删任何任务：不用先跑去那个群再说一遍
  if (index < 0 && isAdmin) index = tasks.findIndex((task) => task.id === id)
  if (index < 0) throw new Error(`找不到定时任务 ${id}`)

  const target = tasks[index]
  if (!isAdmin) {
    if (!target.createdBy) {
      throw new Error('这条是旧版本建的任务，没有创建者记录，只有管理员能删')
    }
    if (target.createdBy !== String(actor ?? '')) {
      throw new Error('这个任务是别人建的，只有他本人或管理员能删')
    }
  }

  const [removed] = tasks.splice(index, 1)
  persist()
  return removed
}

// 群被解散/机器人被踢出去后，QQ 会一直回 11255，这种重试和自愈都没意义，直接停用任务
const TARGET_GONE_RE = /code\(11255\)|用户\/群已注销|请求的资源不存在/

function isTargetGone(error) {
  const message = String(error?.message ?? error ?? '')
  return TARGET_GONE_RE.test(message)
}

// 推送前查台账：同一条内容发过就不再发，补跑时更是整个任务当天只发一次
async function deliver(task, text, options) {
  const dup = checkDuplicate({
    taskId: task.id,
    target: task.target,
    text,
    catchUp: Boolean(options.catchUp),
  })

  if (dup) {
    console.log(`[定时] ${task.id} 跳过推送：${dup.reason}（${new Date(dup.at).toLocaleString('zh-CN', { hour12: false })}）`)
    return { skipped: dup.reason }
  }

  let ids
  try {
    ids = await deps.sendMessage(task.target, text)
  } catch (error) {
    // 目标群已经不存在，这条任务再也不会成功：自动停用，别再每天报警
    if (isTargetGone(error)) {
      task.enabled = false
      const reason = String(error?.message ?? error).slice(0, 100)
      console.log(`[定时] ${task.id} 目标群不可用，已自动停用：${reason}`)
      persist()
      return { skipped: '目标群不可用，任务已自动停用', disabled: true, reason }
    }
    throw error
  }

  const idList = (Array.isArray(ids) ? ids : [ids]).map((id) => String(id ?? '')).filter(Boolean)

  const kept = recordSent({
    taskId: task.id,
    target: task.target,
    text,
    ids: idList,
    note: options.retry ? 'retry' : options.catchUp ? 'catchup' : '',
  })

  // 并发兜底：刚发出去才发现窗口里已经有一条一样的，把这条撤回来
  if (kept.duplicated) {
    let note = '状态显示这条重复了，但没拿到 message_id，撤不回来'
    if (idList.length > 0 && typeof deps.recallSent === 'function') {
      try {
        await deps.recallSent(task.target, idList)
        note = '已自动撤回重复的那条'
      } catch (error) {
        note = `自动撤回失败：${error?.message ?? error}`
      }
    }
    console.log(`[定时] ${task.id} 重复推送，${note}`)
    return { skipped: `重复推送，${note}` }
  }

  return { sent: true, ids: idList }
}

// 失败后的自愈：先过限流，再交给 index 注入的修复 agent
async function runHeal(task, error, options) {
  if (options.retry) return { retry: false, note: '（这次是自愈后的重试，不再重复自愈）' }
  if (typeof deps.selfHeal !== 'function') return { retry: false, note: '' }

  const signature = errorSignature(error)
  const gate = canHeal(task.id, signature)
  if (!gate.ok) {
    return { retry: false, note: `（没自动修：${gate.reason}）` }
  }

  try {
    const result = await deps.selfHeal({ task, error, signature, catchUp: Boolean(options.catchUp) })
    const healed = Boolean(result?.healed)
    markHeal(task.id, signature, {
      ok: healed,
      note: String(result?.note ?? '').slice(0, 180),
    })

    if (healed && result?.needRestart) {
      if (typeof deps.requestRestart === 'function') {
        await deps.requestRestart(`定时任务 ${task.id} 自愈后需要重启`).catch(() => {})
        return {
          retry: false,
          note: `（代码已修：${result?.note ?? ''}；已安排重启，起来后会自动补跑）`,
        }
      }
      return { retry: false, note: `（代码已修：${result?.note ?? ''}，但要重启才生效）` }
    }

    if (healed) {
      return { retry: true, note: `（已自愈：${result?.note ?? ''}，马上重试一次）` }
    }

    return { retry: false, note: `（自愈没成功：${result?.note ?? '没定位到原因'}）` }
  } catch (healError) {
    const message = String(healError?.message ?? healError)
    markHeal(task.id, signature, { ok: false, note: `自愈过程出错：${message}`.slice(0, 180) })
    return { retry: false, note: `（自愈过程出错：${message}）` }
  }
}

async function fire(task, options = {}) {
  if (task.running) return
  const prevLastRunAt = task.lastRunAt
  task.running = true
  task.lastRunAt = Date.now()

  const catchUpNote = options.catchUp
    ? `｜补发（原定 ${new Date(options.plannedAt).toLocaleString('zh-CN', { hour12: false })}）`
    : ''
  const retryNote = options.retry ? '｜自愈后重试' : ''

  try {
    console.log(`[定时] 触发 ${task.id}（${describeCron(task.cron)}）${catchUpNote}${retryNote}`)
    const result = await deps.runTask(task)

    task.lastStatus = options.catchUp ? 'ok:catchup' : 'ok'
    persist()

    if (result) {
      // 结果里只留正文：把「定时任务 id｜cron」这种内部前缀去掉，别让它出现在群聊里
      const text = String(result).trim()

      // 约定：任务无事可说时回空串或 SILENT（可带括号），调度层直接吞掉不推送
      if (!text || /^[\[【(（]?\s*silent\s*[\]】)）]?$/i.test(text)) {
        task.lastStatus = `${task.lastStatus}（静默：无变化未推送）`.slice(0, 160)
        persist()
        return
      }

      const outcome = await deliver(task, text, options)
      if (outcome.skipped) {
        task.lastStatus = outcome.disabled
          ? `已自动停用：${outcome.reason ?? outcome.skipped}`.slice(0, 160)
          : `${task.lastStatus}（跳过推送：${outcome.skipped}）`.slice(0, 160)
        persist()
      }
    }
  } catch (error) {
    const message = String(error?.message ?? error)
    task.lastStatus = `failed: ${message}`.slice(0, 120)
    // 失败不算跑完：退回上一次成功的时间，重启后的补跑逻辑才会认这次
    task.lastRunAt = prevLastRunAt

    // 群没了就没必要自愈也没必要重试：直接停用这条任务
    if (isTargetGone(error)) {
      task.enabled = false
      console.log(`[定时] ${task.id} 目标群不可用，已自动停用：${message.slice(0, 100)}`)
      persist()
      return
    }

    persist()

    const heal = await runHeal(task, error, options)

    if (heal?.retry) {
      console.log(`[定时] ${task.id} ${RETRY_DELAY_MS}ms 后重试一次`)
      const timer = setTimeout(() => {
        fire(task, { ...options, retry: true }).catch((err) =>
          console.error('[定时] 重试异常：', err?.message ?? err),
        )
      }, RETRY_DELAY_MS)
      timer.unref?.()
      return
    }

    const extra = heal?.note ? `\n${heal.note}` : ''
    await deps
      .sendMessage(task.target, `定时任务 ${task.id} 执行失败：${message}${extra}`)
      .catch(() => {})
  } finally {
    task.running = false
    persist()
  }
}

// 启动时补跑：上次该跑的时刻没跑（进程当时没在跑），就补一次。
//
// 原来只在启动后 20 秒跑一次，结果「到点了没触发」只能等下一个 cron 周期（一小时）。
// 现在每次 tick 都会走一遍：只要发现某个任务的上次触发时刻没跑过、且不超过 6 小时，
// 就补上。同一个时间点只补一次，避免失败后每 20 秒重试轰炸。
const catchUpTried = new Set()

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

    const key = `${task.id}@${plannedAt}`
    if (catchUpTried.has(key)) continue
    catchUpTried.add(key)
    if (catchUpTried.size > 200) catchUpTried.clear()

    console.log(`[定时] 补跑 ${task.id}，错过 ${new Date(plannedAt).toLocaleString('zh-CN', { hour12: false })}`)
    await fire(task, { catchUp: true, plannedAt })
  }
}

function tick() {
  const now = new Date()
  state().lastTickAt = now.getTime()
  const key = `${now.getFullYear()}-${now.getMonth()}-${now.getDate()}-${now.getHours()}-${now.getMinutes()}`
  if (key === lastTickKey) return
  lastTickKey = key

  for (const task of tasks) {
    if (!task.enabled) continue
    if (task.running) continue
    if (!cronMatches(task.cron, now)) continue
    fire(task).catch((error) => console.error('[定时] 执行异常：', error?.message ?? error))
  }

  // 命中失败也别干等一小时：这一分钟里没跑成的，下一轮补上
  catchUpMissed().catch((error) => console.error('[定时] 补跑异常：', error?.message ?? error))
}

/** 下一次该跑的时刻，用来判断 cron 到底是没解析对还是调度器没在跑 */
export function nextMatchOf(expr, from = new Date()) {
  const raw = String(expr ?? '').trim()
  if (raw.split(/\s+/).length !== 5) return null

  try {
    return CronExpressionParser.parse(raw, { currentDate: from })
      .next()
      .toDate()
      .toLocaleString('zh-CN', { hour12: false })
  } catch {
    return null
  }
}

/**
 * 调度器实时状态。`/diag` 会原样打出来。
 *
 * 为什么要有这个：出过「到点了没触发」，然后只能靠猜——是 cron 写错了、
 * 还是调度器压根没启动、还是任务被停用了。三个都能从这几个数字里直接看出来。
 */
export function schedulerStatus() {
  const now = Date.now()
  return {
    initialized: Boolean(state().timer),
    tickIntervalSeconds: TICK_INTERVAL_MS / 1000,
    pid: process.pid,
    uptimeSeconds: Math.round(process.uptime()),
    startedAt: state().startedAt || null,
    lastTickAt: state().lastTickAt || null,
    tickAgeSeconds: state().lastTickAt ? Math.round((now - state().lastTickAt) / 1000) : null,
    total: tasks.length,
    enabled: tasks.filter((task) => task.enabled).length,
    items: tasks.map((task) => ({
      id: task.id,
      cron: task.cron,
      enabled: Boolean(task.enabled),
      running: Boolean(task.running),
      nextAt: nextMatchOf(task.cron),
      lastRunAt: task.lastRunAt,
      lastStatus: task.lastStatus,
    })),
  }
}

export function initScheduler({ sendMessage, runTask, selfHeal, recallSent, requestRestart }) {
  deps = { sendMessage, runTask, selfHeal, recallSent, requestRestart }
  tasks = load()
  persist() // 把清干净的 running 写回磁盘

  const shared = state()
  shared.timer = setInterval(tick, TICK_INTERVAL_MS)
  shared.startedAt = Date.now()
  shared.lastTickAt = Date.now()

  const active = tasks.filter((task) => task.enabled).length
  console.log(`[定时] 已加载 ${tasks.length} 个任务（启用 ${active} 个），每 ${TICK_INTERVAL_MS / 1000} 秒检查一次`)
  // 把每个任务的下次触发时间打出来：cron 写错或没解析上，启动时就能看见
  for (const task of tasks.filter((item) => item.enabled)) {
    console.log(`[定时]   ${task.id} ${task.cron} → 下次 ${nextMatchOf(task.cron) ?? '解析失败'}`)
  }

  // 等网关和依赖就绪后再补跑，避免启动瞬间发不出去
  setTimeout(() => {
    catchUpMissed().catch((error) => console.error('[定时] 补跑异常：', error?.message ?? error))
  }, CATCHUP_DELAY_MS).unref?.()
}

