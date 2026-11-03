import { env } from '../config/env.js'
import * as groupLog from '../memory/group-log.js'

// 主动接话：定时扫描活跃群，找出「有人在问但没人答」的问题，判断值不值得插一句
// 和 JUDGE_MODE 的区别：那个是被动消息进来时过滤，这个是没人理它时自己去翻
const QUESTION_PATTERN = /[?？]|怎么|为什么|为啥|能不能|可不可以|有没有人|求助|请问|谁懂|求教/

const HOUR = 3600_000

// 每群状态：上次主动时间、本小时计数
const state = new Map()

function stateOf(groupId) {
  if (!state.has(groupId)) {
    state.set(groupId, { lastAt: 0, hourKey: '', hourCount: 0, lastText: '' })
  }
  return state.get(groupId)
}

function hourKeyOf(now = Date.now()) {
  return String(Math.floor(now / HOUR))
}

function normalize(text) {
  return String(text ?? '').replace(/\s+/g, '').slice(0, 60)
}

/**
 * 找出值得主动回应的候选消息
 * 条件：最后一条机器人发言之后的问题句，且还没有人接着答
 */
export function findCandidates(groupId, { window = 20, maxAgeMs = 30 * 60_000 } = {}) {
  const entries = groupLog.recent(groupId, window)
  if (entries.length === 0) return []

  // 从后往前找，遇到机器人发言就停（说明已经答过了）
  const tail = []
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const entry = entries[i]
    if (String(entry.u ?? '') === 'bot') break
    tail.unshift(entry)
  }

  if (tail.length === 0) return []

  const now = Date.now()
  const fresh = tail.filter((entry) => entry.t && now - entry.t <= maxAgeMs)
  if (fresh.length === 0) return []

  return fresh.filter((entry) => QUESTION_PATTERN.test(String(entry.c ?? '').slice(0, 120)))
}

/**
 * 判断该不该主动说话（纯规则，不花 token）
 * @returns {{ ok: boolean, reason: string }}
 */
export function shouldProactive(groupId, candidates, options = {}) {
  const {
    maxPerHour = env.proactive.maxPerHour,
    cooldownMs = env.proactive.cooldownMinutes * 60_000,
    quietStart = env.proactive.quietStart,
    quietEnd = env.proactive.quietEnd,
  } = options

  if (candidates.length === 0) return { ok: false, reason: '没有待答的问题' }

  const now = Date.now()
  const hour = new Date(now).getHours()

  // 深夜不主动插话
  const quiet = quietStart > quietEnd
    ? hour >= quietStart || hour < quietEnd
    : hour >= quietStart && hour < quietEnd
  if (quiet) return { ok: false, reason: `静默时段（${quietStart}-${quietEnd} 点）` }

  const record = stateOf(groupId)
  if (now - record.lastAt < cooldownMs) {
    return { ok: false, reason: `冷却中（${Math.round((now - record.lastAt) / 60000)} 分钟前刚说过）` }
  }

  const key = hourKeyOf(now)
  if (record.hourKey !== key) {
    record.hourKey = key
    record.hourCount = 0
  }
  if (record.hourCount >= maxPerHour) {
    return { ok: false, reason: `这一小时已经主动 ${record.hourCount} 次` }
  }

  // 同一个问题不重复插
  const signature = normalize(candidates[candidates.length - 1].c)
  if (signature && signature === record.lastText) {
    return { ok: false, reason: '同一个问题刚插过' }
  }

  return { ok: true, reason: `${candidates.length} 条待答问题` }
}

/** 记一次主动发言，用于冷却和频次控制 */
export function noteProactive(groupId, text) {
  const record = stateOf(groupId)
  const now = Date.now()
  const key = hourKeyOf(now)

  if (record.hourKey !== key) {
    record.hourKey = key
    record.hourCount = 0
  }

  record.lastAt = now
  record.hourCount += 1
  record.lastText = normalize(text)
}

/** 把候选消息拼成给判断用的上下文 */
export function formatCandidates(candidates) {
  return candidates
    .slice(-5)
    .map((entry) => {
      const time = new Date(entry.t).toLocaleTimeString('zh-CN', { hour12: false })
      const who = entry.n || `用户${String(entry.u ?? '').slice(-4)}`
      return `${time} ${who}：${String(entry.c ?? '').slice(0, 120)}`
    })
    .join('\n')
}

export function proactiveStats() {
  return [...state.entries()].map(([groupId, record]) => ({
    groupId,
    lastAt: record.lastAt,
    hourCount: record.hourCount,
  }))
}
