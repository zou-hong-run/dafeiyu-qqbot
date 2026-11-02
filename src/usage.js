import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// token 用量统计：每次模型调用记一笔，按天和按会话聚合，落盘 data/usage.json
// 价格按 DeepSeek V4.1-Flash 非高峰档（美元 / 百万 token），高峰时段实际翻倍
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const dataDir = path.join(projectRoot, 'data')
const usageFile = path.join(dataDir, 'usage.json')

const PRICE = {
  input: Number(process.env.PRICE_INPUT_PER_M || 0.15),
  output: Number(process.env.PRICE_OUTPUT_PER_M || 0.6),
}

const MAX_DAYS = 60
const MAX_SESSIONS = 200

let state = { days: {}, sessions: {}, total: emptyBucket() }
let saveTimer = null

function emptyBucket() {
  return { calls: 0, prompt: 0, completion: 0, cost: 0 }
}

function load() {
  try {
    if (!fs.existsSync(usageFile)) return
    const raw = JSON.parse(fs.readFileSync(usageFile, 'utf8'))
    if (raw && typeof raw === 'object') {
      state = {
        days: raw.days ?? {},
        sessions: raw.sessions ?? {},
        total: raw.total ?? emptyBucket(),
      }
    }
  } catch (error) {
    console.error('[用量] 读取失败，从空开始：', error?.message ?? error)
  }
}

function persist() {
  try {
    fs.mkdirSync(dataDir, { recursive: true })

    // 只留最近 MAX_DAYS 天、MAX_SESSIONS 个会话，别让文件无限长
    const dayKeys = Object.keys(state.days).sort()
    for (const key of dayKeys.slice(0, Math.max(0, dayKeys.length - MAX_DAYS))) delete state.days[key]

    const sessionKeys = Object.keys(state.sessions).sort(
      (a, b) => (state.sessions[a].updatedAt ?? 0) - (state.sessions[b].updatedAt ?? 0),
    )
    for (const key of sessionKeys.slice(0, Math.max(0, sessionKeys.length - MAX_SESSIONS))) {
      delete state.sessions[key]
    }

    const tmp = `${usageFile}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(state))
    fs.renameSync(tmp, usageFile)
  } catch (error) {
    console.error('[用量] 落盘失败：', error?.message ?? error)
  }
}

function scheduleSave() {
  clearTimeout(saveTimer)
  saveTimer = setTimeout(persist, 1000)
  saveTimer.unref?.()
}

function dayKey(date = new Date()) {
  const pad = (value) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

function addInto(bucket, prompt, completion, cost) {
  bucket.calls += 1
  bucket.prompt += prompt
  bucket.completion += completion
  bucket.cost += cost
}

export function recordUsage({ sessionKey = 'unknown', promptTokens = 0, completionTokens = 0 } = {}) {
  const prompt = Math.max(0, Number(promptTokens) || 0)
  const completion = Math.max(0, Number(completionTokens) || 0)
  if (prompt === 0 && completion === 0) return null

  const cost = (prompt / 1e6) * PRICE.input + (completion / 1e6) * PRICE.output
  const today = dayKey()

  state.days[today] = state.days[today] ?? emptyBucket()
  addInto(state.days[today], prompt, completion, cost)

  state.sessions[sessionKey] = state.sessions[sessionKey] ?? { ...emptyBucket(), updatedAt: 0 }
  addInto(state.sessions[sessionKey], prompt, completion, cost)
  state.sessions[sessionKey].updatedAt = Date.now()

  addInto(state.total, prompt, completion, cost)
  scheduleSave()

  return { cost, prompt, completion }
}

function sumDays(days) {
  const buckets = Object.entries(state.days)
    .filter(([key]) => days <= 0 || Object.keys(state.days).sort().slice(-days).includes(key))
    .map(([, bucket]) => bucket)

  return buckets.reduce(
    (acc, bucket) => {
      acc.calls += bucket.calls
      acc.prompt += bucket.prompt
      acc.completion += bucket.completion
      acc.cost += bucket.cost
      return acc
    },
    emptyBucket(),
  )
}

export function usageSummary(days = 7) {
  const today = state.days[dayKey()] ?? emptyBucket()
  const period = sumDays(days)

  const topSessions = Object.entries(state.sessions)
    .map(([key, bucket]) => ({ key, ...bucket }))
    .sort((a, b) => b.cost - a.cost)
    .slice(0, 5)

  return {
    today,
    period: { ...period, days },
    total: state.total,
    topSessions,
    price: PRICE,
  }
}

function money(value) {
  if (!value) return '$0'
  if (value < 0.01) return `$${value.toFixed(4)}`
  return `$${value.toFixed(2)}`
}

function tokens(count) {
  if (count < 1000) return String(count)
  if (count < 1e6) return `${(count / 1000).toFixed(1)}k`
  return `${(count / 1e6).toFixed(2)}M`
}

export function formatUsage(days = 7) {
  const summary = usageSummary(days)
  const { today, period, total, topSessions, price } = summary

  const lines = [
    `今天：${today.calls} 次调用｜输入 ${tokens(today.prompt)} / 输出 ${tokens(today.completion)}｜${money(today.cost)}`,
    `近 ${days} 天：${period.calls} 次｜输入 ${tokens(period.prompt)} / 输出 ${tokens(period.completion)}｜${money(period.cost)}`,
    `累计：${total.calls} 次｜${money(total.cost)}`,
    '',
    `计价：输入 $${price.input}/M，输出 $${price.output}/M（非高峰档，高峰翻倍）`,
  ]

  if (topSessions.length > 0) {
    lines.push('', '最费钱的会话：')
    for (const item of topSessions) {
      const name = item.key.length > 28 ? `${item.key.slice(0, 28)}…` : item.key
      lines.push(`  ${name}｜${item.calls} 次｜${money(item.cost)}`)
    }
  }

  return lines.join('\n')
}

export function flushUsage() {
  clearTimeout(saveTimer)
  persist()
}

load()
