import { env } from '../config/env.js'
import { judgeRelevance } from '../chat/deepseek.js'
import * as groupLog from '../memory/group-log.js'
import * as observe from './observe.js'
import { extractMsgIdx } from './sender.js'

// 触发层：两级过滤（程序规则 → 语义判断）、插话预算、去重、观察模式
// 真正要接话时通过 onJudge 回调交给 Router，避免和 index.js 循环依赖
let handleJudge = async () => {}

export function initTrigger({ judge }) {
  if (typeof judge === 'function') handleJudge = judge
}

const chains = new Map()

export function enqueue(key, task) {
  const previous = chains.get(key) ?? Promise.resolve()
  const next = previous.then(task, task).catch((error) => {
    console.error(`[任务失败] ${key}:`, error)
  })
  chains.set(key, next)
  next.finally(() => {
    if (chains.get(key) === next) chains.delete(key)
  })
}

const seenKinds = new Map()
const repliedIds = new Set()
const repliedOrder = []

export function claim(msgId, kind) {
  if (!msgId) return true

  let kinds = seenKinds.get(msgId)
  if (!kinds) {
    kinds = new Set()
    seenKinds.set(msgId, kinds)
    if (seenKinds.size > 2000) {
      for (const key of [...seenKinds.keys()].slice(0, 1000)) seenKinds.delete(key)
    }
  }

  if (kinds.has(kind)) return false
  kinds.add(kind)
  return true
}

export function markReplied(msgId) {
  if (!msgId) return
  repliedIds.add(msgId)
  repliedOrder.push(msgId)
  if (repliedOrder.length > 1000) {
    for (const id of repliedOrder.splice(0, 500)) repliedIds.delete(id)
  }
}

const lastFire = new Map()

export function coolingDown(key, windowMs) {
  if (windowMs <= 0) return false
  return Date.now() - (lastFire.get(key) ?? 0) < windowMs
}

export function touch(key) {
  lastFire.set(key, Date.now())
}

export function mentionsBot(text) {
  return env.botAliases.some((alias) => text.includes(alias))
}

const judgeSlots = new Map()
const judgeCounters = new Map()

export function worthJudging(text) {
  if (text.length < env.judgeMinLength) return false
  if (/^[\s\p{P}\p{Extended_Pictographic}]+$/u.test(text)) return false
  if (/^https?:\/\/\S+$/i.test(text)) return false
  return true
}

function judgeBudgetOk(groupId) {
  const hour = Math.floor(Date.now() / 3_600_000)
  let counter = judgeCounters.get(groupId)

  if (!counter || counter.hour !== hour) {
    counter = { hour, count: 0 }
    judgeCounters.set(groupId, counter)
  }

  if (counter.count >= env.judgeHourlyLimit) return false
  counter.count += 1
  return true
}

export function scheduleJudge(event) {
  const groupId = event.group_id
  let slot = judgeSlots.get(groupId)

  if (!slot) {
    slot = { timer: null, event: null, firstAt: 0 }
    judgeSlots.set(groupId, slot)
  }

  slot.event = event
  if (!slot.firstAt) slot.firstAt = Date.now()

  clearTimeout(slot.timer)
  const elapsed = Date.now() - slot.firstAt
  const delay = Math.max(0, Math.min(env.judgeDebounceMs, env.judgeMaxWaitMs - elapsed))

  slot.timer = setTimeout(() => {
    judgeSlots.delete(groupId)
    const target = slot.event
    enqueue(`group:${groupId}`, () => runJudge(target))
  }, delay)
  slot.timer.unref?.()
}

async function runJudge(event) {
  const groupId = event.group_id
  const cooldownKey = `judge:${groupId}`

  if (repliedIds.has(event.message_id)) return
  if (coolingDown(cooldownKey, env.judgeCooldown)) return
  if (!judgeBudgetOk(groupId)) {
    console.log(`[群判断] ${groupId} 已达每小时上限，跳过`)
    return
  }

  const recent = groupLog.recent(groupId, env.judgeContextSize)
  if (recent.length === 0) return

  let verdict
  try {
    verdict = await judgeRelevance(groupLog.formatForSummary(recent), env.personaName)
  } catch (error) {
    console.error('[群判断] 调用失败：', error?.message ?? error)
    return
  }

  if (!verdict.reply) {
    console.log(`[群判断] 不回：${verdict.reason}`)
    return
  }

  // 观察态：记一笔「本来会接这句」，但不发消息。用来先看它会插手什么，再决定放不放开
  if (env.judgeMode === 'observe') {
    observe.record({
      groupId,
      userId: event.user_id,
      userName: event.sender?.user_name,
      text: event.content,
      urgency: verdict.urgency,
      reason: verdict.reason,
    })
    console.log(`[观察] 本来会接（${verdict.urgency}）：${verdict.reason}`)
    return
  }

  if (repliedIds.has(event.message_id)) return

  touch(cooldownKey)
  markReplied(event.message_id)
  console.log(`[群判断] 插话（${verdict.urgency}）：${verdict.reason}`)
  await handleJudge(event)
}

export function recordGroupMessage(event, text) {
  if (!text) return
  if (!claim(event.message_id, 'log')) return

  groupLog.record(event.group_id, {
    t: Date.now(),
    u: event.user_id,
    n: event.sender?.user_name,
    c: text.slice(0, 500),
    id: event.message_id,
    // 本条的 msg_idx，别人引用时要靠它反查原文
    idx: extractMsgIdx(event),
  })
}
export function hasReplied(msgId) {
  return repliedIds.has(msgId)
}
