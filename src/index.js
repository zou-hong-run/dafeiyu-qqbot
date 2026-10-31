import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { env } from './env.js'
import { Bot, ReceiverMode, segment } from 'qq-official-bot'
import { chat, summarizeGroup, judgeRelevance } from './deepseek.js'
import { startMcp, getTools, syncRegistry, toDeepSeekTools, callTool, stopMcp } from './mcp/client.js'
import { filterTools, describePolicy } from './policy.js'
import { ensureSkillsDir } from './skills.js'
import { reset, stats, flush } from './memory.js'
import * as groupLog from './group-log.js'

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const dataDir = path.join(projectRoot, 'data')
const auditFile = path.join(dataDir, 'audit.log')
const AUDITED_TOOLS = new Set(['write_skill', 'add_mcp', 'install_package', 'shell'])
const SUMMARY_CMD = /^(?:\/)?(?:总结|复盘)/

fs.mkdirSync(dataDir, { recursive: true })
fs.mkdirSync(path.join(projectRoot, 'logs'), { recursive: true })
fs.mkdirSync(path.join(projectRoot, 'downloads'), { recursive: true })

const bot = new Bot({
  appid: env.appId,
  secret: env.appSecret,
  intents: ['GROUP_AND_C2C_EVENT'],
  mode: ReceiverMode.WEBSOCKET,
  removeAt: true,
  logLevel: env.logLevel,
})

function audit(sessionKey, tool, args, result) {
  const line = [
    new Date().toISOString(),
    sessionKey,
    tool,
    JSON.stringify(args ?? {}).slice(0, 300),
    String(result ?? '').replace(/\s+/g, ' ').slice(0, 200),
  ].join('\t')

  fs.appendFile(auditFile, `${line}\n`, (error) => {
    if (error) console.error('[审计] 写入失败：', error?.message ?? error)
  })
}

function toolsForScope(scope) {
  if (!env.toolsEnabled) return []
  if (scope === 'group' && !env.groupToolsEnabled) return []
  return toDeepSeekTools(filterTools(getTools(), scope))
}

function sessionKeyOf(event) {
  return event.message_type === 'group' ? `group:${event.group_id}` : `user:${event.user_id}`
}

function clip(text) {
  if (text.length <= env.replyMaxChars) return text
  return `${text.slice(0, env.replyMaxChars - 16)}……\n\n（内容过长，已截断）`
}

const chains = new Map()

function enqueue(key, task) {
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

function claim(msgId, kind) {
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

function markReplied(msgId) {
  if (!msgId) return
  repliedIds.add(msgId)
  repliedOrder.push(msgId)
  if (repliedOrder.length > 1000) {
    for (const id of repliedOrder.splice(0, 500)) repliedIds.delete(id)
  }
}

const lastFire = new Map()

function coolingDown(key, windowMs) {
  if (windowMs <= 0) return false
  return Date.now() - (lastFire.get(key) ?? 0) < windowMs
}

function touch(key) {
  lastFire.set(key, Date.now())
}

function mentionsBot(text) {
  return env.botAliases.some((alias) => text.includes(alias))
}

const judgeSlots = new Map()
const judgeCounters = new Map()

function worthJudging(text) {
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

function scheduleJudge(event) {
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

  if (repliedIds.has(event.message_id)) return

  touch(cooldownKey)
  markReplied(event.message_id)
  console.log(`[群判断] 插话（${verdict.urgency}）：${verdict.reason}`)
  await handleMessage(event, 'judge')
}

function recordGroupMessage(event, text) {
  if (!text) return
  if (!claim(event.message_id, 'log')) return

  groupLog.record(event.group_id, {
    t: Date.now(),
    u: event.user_id,
    n: event.sender?.user_name,
    c: text.slice(0, 500),
    id: event.message_id,
  })
}

function imageSenderFor(event) {
  const downloadDir = path.join(projectRoot, 'downloads')

  return async (input) => {
    const target = String(input ?? '').trim()
    if (!target) throw new Error('缺少图片路径')

    if (/^https?:\/\//i.test(target)) {
      await event.reply(segment.image(target))
      return target
    }

    const resolved = path.resolve(downloadDir, target)
    if (!resolved.startsWith(downloadDir + path.sep)) {
      throw new Error('只能发送 downloads 目录下的文件')
    }
    if (!/\.(jpe?g|png|gif|webp|bmp)$/i.test(resolved)) {
      throw new Error('只能发送图片（jpg/png/gif/webp/bmp），其他文件类型 QQ 平台不支持')
    }
    if (!fs.existsSync(resolved)) {
      throw new Error(`文件不存在：${path.basename(resolved)}`)
    }

    const size = fs.statSync(resolved).size
    if (size > 10 * 1024 * 1024) {
      throw new Error(`图片 ${(size / 1048576).toFixed(1)}MB，超过 10MB 平台传不上去`)
    }

    await event.reply(segment.image(resolved))
    return path.basename(resolved)
  }
}

async function handleMessage(event, trigger = 'at') {
  const text = (event.content ?? '').trim()
  if (!text) return

  const key = sessionKeyOf(event)
  const scope = event.message_type === 'group' ? 'group' : 'private'

  if (text === '/reset' || text === '重置对话') {
    reset(key)
    await event.reply('记忆已清空，我们重新开始吧。')
    return
  }

  if (text === '/memory' || text === '记忆状态') {
    const current = stats(key)
    await event.reply(
      `短期记忆：${current.shortTerm} 轮对话\n` +
        `中期记忆：${current.midTermChars} 字摘要\n` +
        `长期记忆：${current.longTerm} 条事实`,
    )
    return
  }

  if (text.length > env.maxInputChars) {
    await event.reply(`消息太长了，请压缩到 ${env.maxInputChars} 字以内再发给我。`)
    return
  }

  try {
    await syncRegistry()
  } catch (error) {
    console.error('[mcp] 同步注册表失败：', error?.message ?? error)
  }

  try {
    const answer = await chat(key, text, {
      scope,
      trigger,
      tools: toolsForScope(scope),
      sendImage: imageSenderFor(event),
      callTool: async (name, args) => {
        const result = await callTool(name, args, env.toolTimeoutMs)
        if (AUDITED_TOOLS.has(name)) audit(key, name, args, result)
        return result
      },
    })
    await event.reply(clip(answer))
  } catch (error) {
    console.error(`[模型调用失败] ${key}:`, error?.message ?? error)
    await event.reply('抱歉，我这边暂时无法回答，请稍后再试。').catch(() => {})
  }
}

async function handleSummary(event) {
  const groupId = event.group_id
  const cooldownKey = `summary:${groupId}`

  if (coolingDown(cooldownKey, env.summaryCooldown)) {
    await event.reply('刚总结过，过一会儿再说吧。')
    return
  }

  const entries = groupLog.recent(groupId, env.summaryLimit)
  if (entries.length < 5) {
    await event.reply(
      `这个群我只攒到 ${entries.length} 条记录，还不够总结。\n` +
        '如果群里没把「机器人可获取的群聊消息范围」设成「获取群内全部消息」，我只能看到 @ 我的消息。',
    )
    return
  }

  touch(cooldownKey)

  try {
    await event.reply(`翻记录中，一共 ${entries.length} 条，稍等…`)
    const transcript = groupLog.formatForSummary(entries)
    const summary = await summarizeGroup(transcript, '')
    await event.reply(clip(summary))
  } catch (error) {
    console.error('[总结失败]', error?.message ?? error)
    await event.reply('总结没成功，可能记录太多，等会儿再试。').catch(() => {})
  }
}

async function handleGroupAll(event) {
  const text = (event.content ?? '').trim()
  recordGroupMessage(event, text)
  if (!text) return

  if (SUMMARY_CMD.test(text) && text.length <= 20) {
    if (repliedIds.has(event.message_id)) return
    markReplied(event.message_id)
    await handleSummary(event)
    return
  }

  if (env.groupAutoReply && mentionsBot(text)) {
    if (repliedIds.has(event.message_id)) return

    const cooldownKey = `trigger:${event.group_id}`
    if (coolingDown(cooldownKey, env.groupTriggerCooldown)) {
      console.log(`[群触发] 冷却中，跳过：${event.group_id}`)
      return
    }

    touch(cooldownKey)
    markReplied(event.message_id)
    console.log(`[群触发] ${event.group_id} 提到名字，开始回复`)
    await handleMessage(event, 'name')
    return
  }

  if (env.groupJudge && worthJudging(text)) {
    scheduleJudge(event)
  }
}

async function handleGroupAt(event) {
  const text = (event.content ?? '').trim()
  recordGroupMessage(event, text)
  if (!text) return

  if (repliedIds.has(event.message_id)) return
  markReplied(event.message_id)

  if (SUMMARY_CMD.test(text) && text.length <= 20) {
    await handleSummary(event)
    return
  }

  await handleMessage(event, 'at')
}

bot.on('message.private.friend', (event) => {
  enqueue(sessionKeyOf(event), () => handleMessage(event, 'private'))
})

bot.on('message.group.at', (event) => {
  enqueue(sessionKeyOf(event), () => handleGroupAt(event))
})

bot.on('message.group', (event) => {
  enqueue(sessionKeyOf(event), () => handleGroupAll(event))
})

let shuttingDown = false

function withTimeout(task, ms) {
  return Promise.race([
    Promise.resolve(task).catch(() => {}),
    new Promise((resolve) => setTimeout(resolve, ms).unref()),
  ])
}

async function shutdown(signal) {
  if (shuttingDown) return
  shuttingDown = true

  console.log(`\n[退出] 收到 ${signal}，正在落盘记忆并断开连接...`)
  try {
    flush()
  } catch (error) {
    console.error('[退出] 记忆落盘失败：', error?.message ?? error)
  }

  await withTimeout(stopMcp(), 5000)
  await withTimeout(bot.stop(), 5000)

  console.log('[退出] 已清理完毕')
  process.exit(0)
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    shutdown(signal)
  })
}

process.on('uncaughtException', (error) => {
  console.error('[未捕获异常]', error)
  shutdown('uncaughtException')
})

process.on('unhandledRejection', (reason) => {
  console.error('[未处理的 Promise 拒绝]', reason)
})

ensureSkillsDir()

if (env.toolsEnabled) {
  try {
    await startMcp({ apiKey: env.apiKey, baseURL: env.baseURL })
    console.log(`[启动] 工具: ${describePolicy(getTools().map((tool) => tool.name))}`)
  } catch (error) {
    console.error('[启动] 工具服务启动失败，降级为纯聊天：', error?.message ?? error)
  }
} else {
  console.log('[启动] 工具已关闭（ENABLE_TOOLS=false）')
}

console.log(`[启动] 正在连接 QQ 开放平台（AppID: ${env.appId}）...`)

try {
  await bot.start()
  console.log('[启动] 已连接。私聊直接发消息，群聊 @ 我即可对话。')
  console.log(`[启动] 人格: ${env.personaName}，模型: ${env.model}，记忆: 短期 ${env.historyTurns} 轮 / 中期摘要 / 长期事实`)
  console.log(
    `[启动] 群聊：${env.groupAutoReply ? `提到「${env.botAliases.join('/')}」必回（冷却 ${env.groupTriggerCooldown / 1000}s）` : '名字触发已关'}；` +
      `${env.groupJudge ? `自动判断是否插话（每小时上限 ${env.judgeHourlyLimit} 次，回复后冷却 ${env.judgeCooldown / 1000}s）` : '自动判断已关'}；` +
      `「/总结」复盘最近 ${env.summaryLimit} 条`,
  )

  if (process.send) process.send('ready')
} catch (error) {
  console.error('[启动] 连接失败：', error?.message ?? error)
  console.error('       请检查 .env 中的 QQ_APP_ID / QQ_APP_SECRET 是否正确，以及开放平台沙箱配置是否已添加测试成员。')
  await withTimeout(stopMcp(), 3000)
  process.exit(1)
}
