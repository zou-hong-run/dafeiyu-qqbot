import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { env } from './config/env.js'
import { chat, proactiveReply, summarizeGroup, runTaskAgent, testVision, followUpMessage } from './chat/deepseek.js'
import { startTask as launchTask, taskStatus, describeTool, killTask, submitInput, takeInterruptedTasks } from './tasks/task-runner.js'
import { initScheduler, addSchedule, listSchedules, removeSchedule, cronMatches } from './tasks/scheduler.js'
import { cleanWorkspace, workspaceStats } from './ops/workspace.js'
import { startMcp, getTools, syncRegistry, toDeepSeekTools, callTool, stopMcp } from './mcp/client.js'
import { filterTools, isAdmin, isToolAllowed, describePolicy, describeAdminPolicy } from './config/policy.js'
import { ensureSkillsDir } from './skills/skills.js'
import { evictIdleSessions, forget, listLongTerm, recentSessions, stats, flush } from './memory/memory.js'
import { flushTickets } from './tasks/ticket.js'
import { startWatchdog, stopWatchdog } from './tasks/watchdog.js'
import { commitAndPush, describeStatus, pullLatest } from './ops/sync.js'
import { noteSent, noteSentToGroup, recallMessages } from './channel/recall.js'
import { flushUsage, formatUsage } from './ops/usage.js'
import * as groupLog from './memory/group-log.js'
import * as observe from './channel/observe.js'
import { formatProfile } from './memory/profiles.js'
import { flushKnowledge, knowledgePrompt, rebuildAll } from './memory/knowledge.js'
import { findCandidates, formatCandidates, noteProactive, shouldProactive } from './engage/proactive.js'
import { dueFollowUps, flushSituations, markFollowedUp } from './memory/situations.js'
import { generateHotTake } from './engage/hot-takes.js'
import { listBackups, runBackup } from './ops/backup.js'
import { flushTodos } from './chat/todos.js'
import { cleanupIncoming, describeInbound, extractInbound } from './channel/incoming.js'
import { putChoice, resolveChoice, choiceText } from './chat/choices.js'
import { mergeMessage } from './chat/merge.js'
import { resetSession } from './chat/session-reset.js'
import {
  QUIET_MS,
  flushQuiet,
  isMuted,
  isUnmuteCommand,
  muteGroup,
  oncePer,
  parseMuteCommand,
  unmuteGroup,
} from './engage/quiet.js'
import { bot } from './bot.js'
import {
  chunkText,
  clip,
  isStaleMessage,
  markQuote,
  passiveCountOf,
  pickMessageId,
  sendLongReply,
  sendReply,
  withSendRetry,
} from './channel/sender.js'
import { pendingCount, takePending } from './chat/pending.js'
import {
  audioSenderFor,
  cardSenderFor,
  fileSenderFor,
  imageSenderFor,
  speakSenderFor,
  videoSenderFor,
} from './channel/media.js'
import {
  claim,
  coolingDown,
  enqueue,
  hasReplied,
  initTrigger,
  markReplied,
  mentionsBot,
  recordGroupMessage,
  scheduleJudge,
  touch,
  worthJudging,
} from './channel/trigger.js'

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const dataDir = path.join(projectRoot, 'data')
const auditFile = path.join(dataDir, 'audit.log')
const AUDITED_TOOLS = new Set([
  'write_skill',
  'add_mcp',
  'install_package',
  'shell',
  'run_script',
  'restart_self',
  'broadcast',
  'send_to_group',
])
const SUMMARY_CMD = /^(?:\/)?(?:总结|复盘)/

// 让内置 MCP 子进程知道自己在 pm2 里、应用叫什么，restart_self 要用
process.env.PM2_MANAGED = process.env.pm_id !== undefined ? '1' : '0'
process.env.PM2_APP_NAME = process.env.name?.trim() || process.env.PM2_APP_NAME?.trim() || 'dafeiyu'

fs.mkdirSync(dataDir, { recursive: true })
fs.mkdirSync(path.join(projectRoot, 'logs'), { recursive: true })
fs.mkdirSync(path.join(projectRoot, 'downloads'), { recursive: true })
fs.mkdirSync(path.join(projectRoot, 'tmp'), { recursive: true })

function auditKeyOf(event) {
  if (!event) return 'scheduler'
  return event.message_type === 'group' ? `group:${event.group_id}` : `user:${event.user_id}`
}

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

function toolsForScope(scope, actor = '') {
  if (!env.toolsEnabled) return []
  if (scope === 'group' && !env.groupToolsEnabled) return []
  return toDeepSeekTools(filterTools(getTools(), scope, actor))
}

// 「大肥鱼 /reset」「/reset 大肥鱼」这类写法，先剥掉别名再判断是不是命令
function stripBotAlias(text) {
  let value = String(text ?? '').trim()

  for (const alias of env.botAliases) {
    if (!value.startsWith(alias)) continue
    value = value.slice(alias.length).replace(/^[，,、:：\s]+/, '').trim()
    break
  }

  return value
}

// 用户引用了某条消息时，把被引用的原文找出来拼进输入
function referencedContext(event) {
  const groupId = event?.group_id
  if (!groupId) return ''

  for (const elem of event?.message ?? []) {
    if (elem?.type !== 'reply') continue

    const refId = elem.data?.id
    if (!refId) continue

    const found = groupLog.findByRef(groupId, refId)
    if (found) {
      const who = found.n || `用户${String(found.u ?? '').slice(-4)}`
      const quoted = String(found.c ?? '').slice(0, 120)
      return '\n\n（这句是在回复 ' + who + ' 的这条消息：「' + quoted + '」）'
    }

    return '\n\n（这句引用了某条消息，但那条不在我的本地记录里，可能是我加入之前的）'
  }

  return ''
}

// 让模型自己把改动提交回仓库，或者拉取最新代码
function gitSyncFor() {
  return async ({ mode = 'status', reason = '' } = {}) => {
    const action = String(mode).toLowerCase()

    if (action === 'status') return describeStatus()

    if (action === 'push') {
      const result = await commitAndPush(
        reason ? `auto sync: ${String(reason).slice(0, 60)}` : 'auto sync: 手动推送',
      )
      if (result.skipped) return `没有需要同步的改动（${result.reason}）`
      if (result.pushed) return `已提交并推送 ${result.files} 个文件到 ${result.branch}`
      return `已本地提交 ${result.files} 个文件，但推送失败：${result.reason}`
    }

    if (action === 'pull') {
      const result = await pullLatest()
      if (!result.ok) throw new Error(result.reason)
      const detail = result.output ? `：\n${result.output}` : ''
      return `已拉取 ${result.branch} 的最新代码${detail}\n改完记得重启才生效`
    }

    throw new Error(`不认识的 mode：${mode}，只能是 status / push / pull`)
  }
}

// 主动往别的群发消息：私聊里也能把话送到指定的群
function groupSenderFor(event) {
  const currentGroup = event?.group_id

  return async (input) => {
    const target = String(input?.groupId ?? '').trim()
    const text = String(input?.text ?? '').trim()

    if (!text) throw new Error('缺少要发送的内容')
    if (text.length > 2000) throw new Error(`内容 ${text.length} 字，太长了，压到 2000 字以内`)

    const groupId = !target || target === 'current' ? currentGroup : target
    if (!groupId) throw new Error('没指定群，也没法确定当前群：私聊里要传 groupId')

    const result = await bot.group(groupId).send(clip(text))
    noteSentToGroup(groupId, result?.id, text, 'text')
    console.log(`[主动发送] 已发往群 ${groupId.slice(0, 12)}…（${text.length} 字）`)

    audit(auditKeyOf(event), 'send_to_group', { groupId, chars: text.length }, `已发送 ${text.length} 字`)

    return { groupId, chars: text.length, messageId: result?.id ?? '' }
  }
}

// 全服通报：把同一条消息推给所有待过的群，默认跳过当前群
function broadcastSenderFor(event) {
  const currentGroup = event?.group_id

  return async (input) => {
    const text = String(input?.text ?? '').trim()
    if (!text) throw new Error('缺少要通报的内容')
    if (text.length > 2000) throw new Error(`内容 ${text.length} 字，太长了，压到 2000 字以内`)

    let ids = []
    try {
      ids = fs
        .readdirSync(path.join(dataDir, 'groups'))
        .filter((name) => name.endsWith('.jsonl'))
        .map((name) => name.slice(0, -6))
    } catch {
      ids = []
    }

    const only = Array.isArray(input?.targets) ? input.targets.map(String) : []
    if (only.length > 0) ids = ids.filter((id) => only.includes(id))
    if (!input?.includeCurrent && currentGroup) ids = ids.filter((id) => id !== currentGroup)

    if (ids.length === 0) return { total: 0, sent: [], failed: [] }
    if (input?.dryRun) return { total: ids.length, sent: [], failed: [], dryRun: true, targets: ids }

    // 群多的时候强制先预演一次：全服通报发错很难收回
    const needConfirm = ids.length > 3 && input?.confirm !== true
    if (needConfirm) {
      return { total: ids.length, sent: [], failed: [], dryRun: true, targets: ids, needConfirm: true }
    }

    // 通报正文可能超过单条上限，按句子边界切开逐段发，别用 clip 截断
    const parts = chunkText(text).slice(0, 3)
    const sent = []
    const failed = []

    for (const groupId of ids) {
      try {
        for (let i = 0; i < parts.length; i += 1) {
          if (i > 0) await new Promise((resolve) => setTimeout(resolve, 600))
          await bot.group(groupId).send(parts[i])
        }
        sent.push(groupId)
      } catch (error) {
        failed.push(`${groupId}：${error?.message ?? error}`)
      }
      await new Promise((resolve) => setTimeout(resolve, 900))
    }

    console.log(`[全服通报] 成功 ${sent.length}/${ids.length} 个群，每个 ${parts.length} 段`)

    audit(
      auditKeyOf(event),
      'broadcast',
      { targets: ids.length, chars: text.length, parts: parts.length },
      `成功 ${sent.length}/${ids.length}${failed.length ? `，失败 ${failed.length}` : ''}`,
    )

    return { total: ids.length, sent, failed, parts: parts.length }
  }
}

// 列出机器人待过的群，模型用它找 groupId


function groupsReaderFor() {
  return async () => {
    let ids = []
    try {
      ids = fs
        .readdirSync(path.join(dataDir, 'groups'))
        .filter((name) => name.endsWith('.jsonl'))
        .map((name) => name.slice(0, -6))
    } catch {
      ids = []
    }

    if (ids.length === 0) return '还没有群聊记录，等群里有消息进来才有。'

    const lines = ids.map((groupId) => {
      const info = groupLog.statsOf(groupId)
      const last = info.to ?? '-'
      return `${groupId}｜${info.count} 条｜最近 ${last}`
    })

    return (
      `待过的群（${ids.length} 个）：\n${lines.join('\n')}\n\n` +
      '发消息用 send_to_group，groupId 传上面那串。'
    )
  }
}

// 给模型读当前群聊记录用：只读本群，不跨群
function historyReaderForGroup(groupId) {
  if (!groupId) return null

  return async (limit, mode) => {
    const count = Math.min(Math.max(Number(limit) || 30, 5), 200)
    const entries = groupLog.recent(groupId, count)

    if (entries.length === 0) {
      return (
        '这个群还没有任何聊天记录。' +
        '如果刚拉我进来，可能是群没开「机器人可获取的群聊消息范围 = 获取群内全部消息」，' +
        '那种情况下我只能看到 @ 我的消息。'
      )
    }

    const info = groupLog.statsOf(groupId)

    if (String(mode) === 'people') {
      const people = new Map()
      for (const entry of entries) {
        const name = entry.n || `用户${String(entry.u ?? '').slice(-4)}`
        people.set(name, (people.get(name) ?? 0) + 1)
      }

      const list = [...people.entries()].sort((a, b) => b[1] - a[1])
      const lines = list.map(([name, times], index) => `${index + 1}. ${name}（${times} 条）`)
      return `当前群最近 ${entries.length} 条记录里出现过 ${list.length} 个人：\n${lines.join('\n')}`
    }

    return (
      `当前群最近 ${entries.length} 条（库里共 ${info.count} 条，最早 ${info.from ?? '-'}）：\n` +
      groupLog.formatForSummary(entries)
    )
  }
}

// 群成员画像：只能看当前群
function profileReaderFor(event) {
  const groupId = event?.group_id ?? event?.target?.id ?? ''
  if (!groupId) return null

  return async (member) => formatProfile(String(groupId), member ?? '')
}

// 按 target 主动发消息（定时任务、跨群播报都用它，不依赖 event）
function sendToTarget(target, payload) {
  if (target?.type === 'group') {
    return withSendRetry(() => bot.group(target.id).send(payload), '主动群消息')
  }
  return withSendRetry(() => bot.user(target.id).send(payload), '主动私聊消息')
}

// 主对话用：从 event 取群 id
function historyReaderFor(event) {
  return historyReaderForGroup(event?.group_id)
}

function sessionKeyOf(event) {
  return event.message_type === 'group' ? `group:${event.group_id}` : `user:${event.user_id}`
}

// 群里被 @ 的判定。QQ 给过来的 mentions 有两种形态：
//   数组 [{ id, user_openid, ... }]，或对象 { bot: true, is_you: true, username }
// 只看 openid 比对会漏掉后一种，导致「@ 了但被当闲聊丢掉」
function atMe(event) {
  const raw = event?.mentions
  if (!raw) return false

  const items = Array.isArray(raw) ? raw : [raw]
  const selfId = String(bot.self_id ?? process.env.QQ_APP_ID ?? '')
  const appId = String(env.appId ?? '')

  return items.some((item) => {
    if (!item || typeof item !== 'object') return false
    if (item.is_you === true) return true
    if (item.bot === true) return true

    const candidates = [item.id, item.user_openid, item.member_openid, item.user_id]
      .filter(Boolean)
      .map(String)

    return candidates.some((value) => value === selfId || value === appId)
  })
}

async function runScheduledTask(task) {
  const scope = task.target.type === 'group' ? 'group' : 'private'

  try {
    await syncRegistry()
  } catch (error) {
    console.error('[定时] 同步工具注册表失败：', error?.message ?? error)
  }

  // 定时任务没有 event，所有发送走主动消息
  const send = (payload) => sendToTarget(task.target, payload)
  const sessionKey = `${task.target.type}:${task.target.id}`
  // 让 send_to_group 知道「当前群」是哪个：没有它就传 current 会报「没指定群」
  const currentEvent = task.target.type === 'group' ? { group_id: task.target.id } : null

  return runTaskAgent({
    taskPrompt: task.prompt,
    scope,
    actor: 'scheduler',
    tools: toolsForScope(scope, 'scheduler'),
    callTool: (name, args) => callTool(name, args, env.toolTimeoutMs),
    sendImage: imageSenderFor(null, send),
    audioSender: audioSenderFor(null, send),
    videoSender: videoSenderFor(null, send),
    speakSender: speakSenderFor(null, send),
    scheduler: schedulerForTarget(sessionKey, task.target),
    historyReader: historyReaderForGroup(task.target.type === 'group' ? task.target.id : ''),
    profileReader: profileReaderFor({ target: task.target }),
    groupSender: groupSenderFor(currentEvent),
    broadcastSender: broadcastSenderFor(currentEvent),
    groupsReader: groupsReaderFor(),
    gitSync: gitSyncFor(),
  })
}

function progressReporter(event) {
  const notify = notifierFor(event)
  const isGroup = event.message_type === 'group'
  const groupId = event.group_id
  let lastAt = Date.now()
  let count = 0

  return async ({ round, tool }) => {
    if (round < 1) return

    // 群里「还在处理」最招人烦：一轮最多一条，而且是卡了 45 秒才说一句
    const max = isGroup ? 1 : env.progressMax
    if (count >= max) return
    if (isGroup && !oncePer(`progress:${groupId}`, QUIET_MS.progress)) return
    if (Date.now() - lastAt < env.progressInterval) return

    lastAt = Date.now()
    count += 1
    await notify(
      isGroup ? `还在弄，稍等（正在${describeTool(tool)}）` : `还在处理｜第 ${round + 1} 步：${describeTool(tool)}`,
    )
  }
}

// 主动扫描：没人叫它的时候，自己去翻群记录，看有没有值得接的问题
async function runProactiveScan() {
  if (!env.proactive.enabled) return

  let ids = []
  try {
    ids = fs
      .readdirSync(path.join(dataDir, 'groups'))
      .filter((name) => name.endsWith('.jsonl'))
      .map((name) => name.slice(0, -6))
  } catch {
    return
  }

  for (const groupId of ids) {
    try {
      if (isMuted(groupId)) continue
      if (!oncePer(`proactive:${groupId}`, QUIET_MS.proactive)) continue

      const candidates = findCandidates(groupId)
      const decision = shouldProactive(groupId, candidates)
      if (!decision.ok) continue

      const answer = await proactiveReply({
        transcript: formatCandidates(candidates),
        knowledge: knowledgePrompt(groupId),
        personaName: env.personaName,
      })

      if (!answer) continue

      noteProactive(groupId, candidates[candidates.length - 1].c)
      await sendToTarget({ type: 'group', id: groupId }, answer)

      groupLog.record(groupId, {
        t: Date.now(),
        u: 'bot',
        n: env.personaName,
        c: answer.replace(/\s+/g, ' ').slice(0, 200),
        id: `bot-${Date.now()}`,
      })

      console.log(`[主动] ${groupId.slice(0, 12)}… 插了一句：${answer.slice(0, 40)}`)
    } catch (error) {
      console.warn(`[主动] ${groupId.slice(0, 12)}… 失败：`, error?.message ?? error)
    }
  }
}

// 回访：之前记下的「还在进行中的事」，隔几小时主动问一句
async function runFollowUps() {
  if (!env.followup.enabled) return

  const hour = new Date().getHours()
  const quietStart = env.followup.quietStart
  const quietEnd = env.followup.quietEnd
  if (quietStart > quietEnd ? hour >= quietStart || hour < quietEnd : hour >= quietStart && hour < quietEnd) return

  const minAgeHours = env.followup.minAgeHours
  const due = dueFollowUps({ minAgeMs: minAgeHours * 3600_000, limit: 1 })
  if (due.length === 0) return

  for (const item of due) {
    try {
      const [type, ...rest] = item.sessionKey.split(':')
      const id = rest.join(':')
      if (!id) continue

      // 被喊安静了的群，回访也先停：人家不想被打扰
      if (type === 'group' && isMuted(id)) {
        markFollowedUp(item.sessionKey, item.id)
        continue
      }

      const text = await followUpMessage({
        person: item.person,
        topic: item.topic,
        mood: item.mood,
        since: `${Math.round((Date.now() - item.at) / 3600_000)} 小时前`,
        personaName: env.personaName,
      })

      // 生成了空串就是判断不该提，标记掉别每次都重算
      markFollowedUp(item.sessionKey, item.id)
      if (!text) continue

      await sendToTarget({ type: type === 'group' ? 'group' : 'user', id }, text)

      if (type === 'group') {
        groupLog.record(id, {
          t: Date.now(),
          u: 'bot',
          n: env.personaName,
          c: text.replace(/\s+/g, ' ').slice(0, 200),
          id: `bot-${Date.now()}`,
        })
      }

      console.log(`[回访] ${item.sessionKey.slice(0, 16)}… 提起「${item.topic.slice(0, 20)}」：${text.slice(0, 40)}`)
    } catch (error) {
      console.warn('[回访] 失败：', error?.message ?? error)
    }
  }
}

// 选择题：QQ 官方按钮要开放平台预建模板，机器人自己造不出来，
// 所以用「编号选项 + 回数字」实现同样的交互
function choiceSenderFor(event) {
  const sessionKey = sessionKeyOf(event)
  return async ({ question, options } = {}) => {
    const entry = putChoice(sessionKey, { question, options })
    if (!entry) throw new Error('至少给 2 个选项，最多 5 个')

    const text = choiceText(entry)
    await sendReply(event, text)
    return { count: entry.options.length, text }
  }
}

// 热点吐槽：自己去搜当天新闻，挑一条在群里说两句
function pickActiveGroup() {
  if (env.hotTake.target) return env.hotTake.target

  try {
    const dir = path.join(dataDir, 'groups')
    const files = fs
      .readdirSync(dir)
      .filter((name) => name.endsWith('.jsonl'))
      .map((name) => ({ id: name.slice(0, -6), mtime: fs.statSync(path.join(dir, name)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime)

    // 太久的群不提，说明没人说话了
    if (files.length === 0) return ''
    if (Date.now() - files[0].mtime > 7 * 86400_000) return ''
    return files[0].id
  } catch {
    return ''
  }
}

async function runHotTake() {
  if (!env.hotTake.enabled) return

  const groupId = pickActiveGroup()
  if (!groupId) {
    console.log('[热点] 找不到活跃的群，跳过')
    return
  }

  if (isMuted(groupId)) {
    console.log('[热点] 那个群被喊安静了，跳过')
    return
  }
  if (!oncePer(`hot-take:${groupId}`, QUIET_MS.hotTake)) return

  const take = await generateHotTake({ personaName: env.personaName })
  if (!take) return

  try {
    await sendToTarget({ type: 'group', id: groupId }, take.text)

    groupLog.record(groupId, {
      t: Date.now(),
      u: 'bot',
      n: env.personaName,
      c: take.text.replace(/\s+/g, ' ').slice(0, 200),
      id: `bot-${Date.now()}`,
    })

    console.log(`[热点] ${groupId.slice(0, 12)}… 吐槽「${take.topic}」：${take.text.slice(0, 40)}`)
  } catch (error) {
    console.warn('[热点] 发送失败：', error?.message ?? error)
  }
}

function schedulerForTarget(sessionKey, target) {
  return {
    add: ({ cron, prompt }) => addSchedule({ sessionKey, target, cron, prompt }),
    list: () => listSchedules(sessionKey),
    remove: (id) => removeSchedule(id, sessionKey),
  }
}

function schedulerFor(event) {
  const sessionKey = sessionKeyOf(event)
  const isGroup = event.message_type === 'group'
  const target = {
    type: isGroup ? 'group' : 'user',
    id: isGroup ? event.group_id : event.user_id,
  }

  return schedulerForTarget(sessionKey, target)
}

function notifierFor(event) {
  const startedAt = Date.now()
  const isGroup = event.message_type === 'group'
  const groupId = event.group_id
  const userId = event.user_id
  let passiveUsed = 0

  return async (text) => {
    const body = clip(text)
    const canPassive = Date.now() - startedAt < 4 * 60_000 && passiveUsed < 3

    if (canPassive) {
      passiveUsed += 1
      try {
        await sendReply(event, body)
        return
      } catch (error) {
        console.warn('[任务通知] 被动回复失败，改用主动消息：', error?.message ?? error)
      }
    }

    try {
      if (isGroup) await bot.group(groupId).send(body)
      else await bot.user(userId).send(body)
    } catch (error) {
      console.error('[任务通知] 主动发送也失败：', error?.message ?? error)
    }
  }
}

// /config：把当前生效的配置列出来，不配 .env 时也能看清自己在跑什么
function configSummary() {
  const tools = getTools()
  const mem = (() => {
    try {
      const lines = fs.readFileSync('/proc/meminfo', 'utf8')
      const total = Number(lines.match(/MemTotal:\s+(\d+)/)?.[1] ?? 0) / 1024
      const available = Number(lines.match(/MemAvailable:\s+(\d+)/)?.[1] ?? 0) / 1024
      return `总 ${Math.round(total)}MB / 可用 ${Math.round(available)}MB`
    } catch {
      return '读不到（非 Linux）'
    }
  })()

  const backups = listBackups(3)
  const backupText =
    backups.length === 0 ? '还没备份' : backups.map((item) => `${item.name}(${(item.size / 1024).toFixed(0)}KB)`).join(' ')

  return [
    `模型：${env.model}｜上下文 ${Math.round(env.contextWindowTokens / 1000)}K（预算 ${Math.round(env.contextBudgetRatio * 100)}%）`,
    `记忆：短期 ${env.historyTurns} 轮｜会话闲置 ${Math.round(env.sessionTtlMs / 60000)} 分钟清空`,
    `工具：${env.toolsEnabled ? '开' : '关'}（已加载 ${tools.length} 个）｜最多 ${env.maxToolRounds} 轮｜单次超时 ${Math.round(env.toolTimeoutMs / 1000)}s`,
    `高危工具：${env.adminOpenIds.length > 0 ? `白名单 ${env.adminOpenIds.length} 人` : `私聊放开、群里${env.shellGroupEnabled ? '放开' : '禁用'}`}`,
    `群聊：名字触发${env.groupAutoReply ? '开' : '关'}（冷却 ${env.groupTriggerCooldown / 1000}s）｜自动判断 ${env.judgeMode}（冷却 ${env.judgeCooldown / 1000}s，每群每小时≤${env.judgeHourlyLimit}）`,
    `主动：接话${env.proactive.enabled ? `开 ${env.proactive.intervalMinutes} 分钟` : '关'}｜回访${env.followup.enabled ? `开 ≥${env.followup.minAgeHours}h` : '关'}｜热点${env.hotTake.enabled ? `开 ${env.hotTake.cron}` : '关'}`,
    `输出：单条输入 ≤${env.maxInputChars} 字｜回复 ≤${env.replyMaxChars} 字/条｜连发合并 ${env.mergeWindowMs}ms｜流式${env.streamReply ? '开' : '关'}｜Markdown${env.markdownReply ? '开' : '关'}｜引用 ${env.quoteReply || '关'}`,
    `日志：详细${env.toolDebug ? '开' : '关'}｜级别 ${env.logLevel}`,
    `内存：${mem}｜主进程堆 ${process.env.MAIN_HEAP_MB || 320}MB｜MCP ${process.env.MCP_HEAP_MB || 160}MB`,
    `备份：${backupText}`,
  ].join('\n')
}

// 命令清单：群友只需要知道常用的，管理员再多一段
function helpText(scope, admin) {
  const common = [
    '记忆',
    '  /reset 清空当前会话（长期事实也清）',
    '  /memory 看记忆用量',
    '  /memory list 看长期记忆都记了什么',
    '  /forget 关键词 只删含这个词的那几条',
    '  /id 查自己的 openid',
  ]

  const chat = ['日常', '  接着发 把上一条没发完的长内容补出来', '  /help 就是这份清单']

  const group = ['群聊', '  /总结 复盘最近一段聊天', '  安静 30 让我闭嘴 30 分钟（这段时间只有 @ 才回）', '  可以说话了 恢复']

  const adminPart = [
    '管理员',
    '  /task 目标 建工单交给后台跑',
    '  /tasks 看正在跑的工单，/kill 工单号 终止',
    '  /cost [天数] 看 token 花销',
    '  /diag 发送自检（/diag vision 测读图）',
    '  /observe 看插话判断记录',
    '  /clean [all] 清临时文件，加 all 连下载目录一起清',
  ]

  if (scope === 'group') {
    const lines = [...group, ...chat]
    if (admin) lines.push('', ...adminPart, '', '记忆那几个命令（/reset /memory /forget）在群里只给管理员用。')
    else lines.push('', '记忆管理和高危操作（跑命令、改文件、建后台任务）只有管理员能用。')
    return lines.join('\n')
  }

  const lines = [...common, '', ...chat]
  if (admin) lines.push('', ...adminPart)
  return lines.join('\n')
}

async function handleMessage(event, trigger = 'at', overrideText = '') {
  let text = (overrideText || event.content || '').trim()
  const inbound = extractInbound(event)
  if (!text && inbound.length === 0) return

  // 消息太老就别答了：被动回复窗口过了，主动消息在群里基本发不出去，
  // 硬发只会「用户看到一半突然没声」，不如记一行日志，让人能查
  if (isStaleMessage(event)) {
    console.warn(
      `[过期] ${sessionKeyOf(event)} 消息已超过 4 分钟才轮到处理，跳过（队列积压或进程刚重启）`,
    )
    return
  }

  // 「大肥鱼 /reset」这种带名字的命令也要认：只有剥掉别名后确实以 / 开头才替换
  const stripped = stripBotAlias(text).replace(/[@＠]\S+$/, '').trim()
  if (stripped.startsWith('/')) text = stripped

  // 只有自动插话才引用原消息；被 @、被点名、私聊都不加引用气泡
  if (trigger === 'judge') markQuote(event)

  const key = sessionKeyOf(event)
  const scope = event.message_type === 'group' ? 'group' : 'private'

  // 「接着发」：把上一条超长内容没发完的尾巴补出去
  if (
    text.length <= 12 &&
    !text.startsWith('/') &&
    /接着发|继续发|继续吧|剩下的|补发|没发完|后面的段|后面那些/.test(text) &&
    pendingCount(event) > 0
  ) {
    const { parts, rest } = takePending(event, 6)

    for (let i = 0; i < parts.length; i += 1) {
      if (i > 0) await new Promise((resolve) => setTimeout(resolve, 600))
      try {
        await sendReply(event, parts[i])
      } catch (error) {
        console.warn(`[补发] 第 ${i + 1}/${parts.length} 段失败：`, error?.message ?? error)
      }
    }

    if (rest > 0) await sendReply(event, `还剩 ${rest} 段，再说一次「接着发」我继续。`)
    return
  }

  if (text === '/id' || text === '我的id' || text === '我的ID') {
    const admin = env.adminOpenIds.includes(String(event.user_id))
    await sendReply(
      event,
      `你的 openid：${event.user_id}\n` +
        `会话：${key}\n` +
        `群：${event.group_id ?? '（私聊）'}\n` +
        `管理员权限：${admin ? '有' : '无'}\n\n` +
        '要开高危工具（执行命令、写文件、装包、加 MCP）就把上面这串 openid 填进 .env 的 ADMIN_OPENIDS，逗号分隔。',
    )
    return
  }

  if (text === '/cost' || text.startsWith('/cost ')) {
    if (!isAdmin(scope, event.user_id ?? '')) {
      await sendReply(event, `用量统计只对管理员开放。你的 openid：${event.user_id ?? '未知'}。`)
      return
    }

    const days = Math.min(Math.max(Number(text.split(' ')[1]) || 7, 1), 60)
    await sendReply(event, formatUsage(days))
    return
  }

  if (text === '/diag vision') {
    if (!isAdmin(scope, event.user_id ?? '')) {
      await sendReply(event, `视觉自检只对管理员开放。你的 openid：${event.user_id ?? '未知'}。`)
      return
    }

    // 现场画一张纯红方块，用它测「能不能真的读到图」
    const probe = path.join(projectRoot, 'downloads', 'vision-probe.png')
    try {
      const { DRAW_HANDLERS } = await import('./mcp-server/draw-pixel.js')
      await DRAW_HANDLERS.draw_pixel({
        pattern: ['######', '######', '######', '######'],
        colors: ['#e53935'],
        scale: 16,
      })
      const latest = fs
        .readdirSync(path.join(projectRoot, 'downloads'))
        .filter((name) => name.startsWith('draw-'))
        .sort()
        .pop()

      if (!latest) throw new Error('生成测试图失败')
      fs.copyFileSync(path.join(projectRoot, 'downloads', latest), probe)
      fs.rmSync(path.join(projectRoot, 'downloads', latest), { force: true })
    } catch (error) {
      await sendReply(event, `视觉自检失败：生成测试图出错 ${error?.message ?? error}`)
      return
    }

    const result = await testVision('downloads/vision-probe.png')

    if (result.ok && result.answer) {
      const usage = result.usage ? `用量：${result.usage}\n` : ''
      await sendReply(
        event,
        `视觉通道正常。\n模型：${result.model}\n读图结果：「${result.answer}」（测试图是纯红色）\n${usage}` +
          '图片识别没问题，正常发图我就能看。',
      )
    } else if (result.ok) {
      const usage = result.usage ? `用量：${result.usage}\n` : ''
      const thought = result.reasoning ? `思维链片段：${result.reasoning}\n` : ''
      await sendReply(
        event,
        `模型调用成功，但返回了空内容，视觉可能没真正生效。\n` +
          `模型：${result.model}\n结束原因：${result.finish || '未知'}\n${usage}${thought}\n` +
          '如果是 finish=length，说明 token 还是不够；如果是 stop 但内容为空，' +
          '多半是这个模型/账号还不支持图片输入，可以先把 DEEPSEEK_MODEL 退回 deepseek-chat 用纯文本。',
      )
    } else if (result.stage === 'read') {
      await sendReply(event, `视觉自检失败在「读图」这一步：${result.reason}`)
    } else {
      await sendReply(
        event,
        `视觉自检失败在「模型调用」这一步（模型 ${result.model}）：\n${result.reason}\n\n` +
          '大概率是这个账号还没开通 deepseek-flash 的图片输入，或者模型名要用你控制台里能看到的那个。',
      )
    }
    return
  }

  if (text === '/diag' || text === '/diag send') {
    if (!isAdmin(scope, event.user_id ?? '')) {
      await sendReply(
        event,
        `自检只对管理员开放，因为要往群里发测试图。你的 openid：${event.user_id ?? '未知'}。` +
          '把它填进服务器 .env 的 ADMIN_OPENIDS（逗号分隔多个），重启后群里就能用；' +
          '不想改配置就先私聊我发 /diag。',
      )
      return
    }

    const lines = []
    const pngPath = path.join(projectRoot, 'downloads', 'diag.png')

    try {
      // 1x1 透明 PNG，够用来验证上传和发送链路
      fs.writeFileSync(
        pngPath,
        Buffer.from(
          'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
          'base64',
        ),
      )
      const size = fs.statSync(pngPath).size
      lines.push(`测试图已生成：downloads/diag.png（${size} 字节）`)
    } catch (error) {
      await sendReply(event, `自检失败：生成测试图出错 ${error?.message ?? error}`)
      return
    }

    try {
      const sent = await imageSenderFor(event)('diag.png')
      lines.push(`send_image：成功（${sent}）`)
    } catch (error) {
      lines.push(`send_image：失败 → ${error?.message ?? error}`)
    }

    try {
      const sent = await fileSenderFor(event)('diag.png')
      lines.push(`send_file：成功（${sent}）`)
    } catch (error) {
      lines.push(`send_file：失败 → ${error?.message ?? error}`)
    }

    lines.push(`被动回复剩余额度：${Math.max(0, 4 - passiveCountOf(event))} / 4`)

    await sendReply(event, `自检结果：\n${lines.join('\n')}`)
    return
  }

  if (text === '/observe' || text.startsWith('/observe ')) {
    if (!isAdmin(scope, event.user_id ?? '')) {
      await sendReply(
        event,
        `观察记录只对管理员开放（里面会有群友的对话原文）。你的 openid：${event.user_id ?? '未知'}。` +
          '填进服务器 .env 的 ADMIN_OPENIDS 后重启即可。',
      )
      return
    }

    const groupId = event.group_id ?? ''

    if (text.includes('clear')) {
      observe.clear(groupId)
      await sendReply(event, '观察记录已清空。')
      return
    }

    const info = observe.stats(groupId)
    const items = observe.recent(groupId, 10)

    if (items.length === 0) {
      await sendReply(
        event,
        `还没有观察记录（累计 ${info.total} 条）。\n` +
          '把 .env 设成 JUDGE_MODE=observe 后，机器人会在「本来想接话」时只记一笔、不回复，' +
          '你隔天用 /observe 就能看出它会插手哪些消息。',
      )
      return
    }

    const lines = items.map((item) => {
      const time = new Date(item.t).toLocaleTimeString('zh-CN', { hour12: false })
      return `${time} ${item.userName || '某人'}（${item.urgency}）：${item.reason}\n  「${item.text}」`
    })

    await sendReply(
      event,
      `观察记录：今天 ${info.today} 条 / 累计 ${info.total} 条\n\n${lines.join('\n')}\n\n` +
        '想让它在这些时候真的接话，就把 JUDGE_MODE 改成 auto。',
    )
    return
  }

  // 记忆类命令在群里只给管理员：群友不该能清掉整个群的上下文
  const denyNonAdmin = async () => {
    if (isAdmin(scope, event.user_id ?? '')) return false
    await sendReply(event, '这个命令只有管理员能用（openid 要写进 .env 的 ADMIN_OPENIDS）。')
    return true
  }

  if (text === '/reset' || text === '重置对话' || text === '清空记忆' || text === '重新开始') {
    if (await denyNonAdmin()) return
    resetSession(key)
    await sendReply(event, '记忆、任务清单、待选状态都清空了，我们重新开始吧。')
    return
  }

  if (text === '/memory' || text === '记忆状态') {
    if (await denyNonAdmin()) return
    const current = stats(key)
    await sendReply(event, 
      `短期记忆：${current.shortTerm} 轮对话（约 ${current.historyTokens} tokens）\n` +
        `中期记忆：${current.midTermChars} 字摘要\n` +
        `长期记忆：${current.longTerm} 条事实\n` +
        `上下文预算：${Math.floor((env.contextWindowTokens * env.contextBudgetRatio) / 1000)}K tokens（窗口 ${Math.floor(env.contextWindowTokens / 1000)}K）`,
    )
    return
  }

  if (text === '/memory list' || text === '/记忆列表') {
    if (await denyNonAdmin()) return
    const items = listLongTerm(key, 20)
    if (items.length === 0) {
      await sendReply(event, '长期记忆还是空的，聊到值得记的事我会自己记。')
      return
    }
    await sendReply(
      event,
      `长期记忆（最近 ${items.length} 条）：\n${items.map((item, index) => `${index + 1}. ${item}`).join('\n')}\n\n` +
        '要删某一条就发 /forget 关键词',
    )
    return
  }

  if (text.startsWith('/forget ') || text.startsWith('忘掉 ')) {
    if (await denyNonAdmin()) return
    const keyword = text.replace(/^(\/forget\s+|忘掉\s+)/, '').trim()
    if (!keyword) {
      await sendReply(event, '用法：/forget 关键词，会把长期记忆里含这个词的条目删掉')
      return
    }

    const removed = forget(key, keyword)
    await sendReply(
      event,
      removed.length === 0
        ? `长期记忆里没有含「${keyword}」的条目。发 /memory list 看现在都记了什么。`
        : `已忘掉 ${removed.length} 条：\n${removed.map((item) => `- ${item}`).join('\n')}`,
    )
    return
  }

  if (text === '/help' || text === '/帮助' || text === '帮助') {
    await sendReply(event, helpText(scope, isAdmin(scope, event.user_id ?? '')))
    return
  }

  if (text === '/config' || text === '/配置') {
    if (await denyNonAdmin()) return
    await sendReply(event, configSummary())
    return
  }

  if (text.startsWith('/task ') || text.startsWith('后台任务 ')) {
    const goal = text.replace(/^(\/task\s+|后台任务\s+)/, '').trim()

    if (goal.length < 5) {
      await sendReply(event, '用法：/task 目标描述，写清楚要产出什么、什么算完成')
      return
    }

    if (!isToolAllowed('start_task', scope, event.user_id ?? '')) {
      await sendReply(
        event,
        `后台任务只对管理员开放。你的 openid：${event.user_id ?? '未知'}。` +
          '填进服务器 .env 的 ADMIN_OPENIDS 后重启即可。',
      )
      return
    }

    try {
      const { id } = launchTask({
        sessionKey: key,
        scope,
        actor: event.user_id ?? '',
        goal,
        notify: notifierFor(event),
        tools: toolsForScope(scope, event.user_id ?? ''),
        sendImage: imageSenderFor(event),
        audioSender: audioSenderFor(event),
        videoSender: videoSenderFor(event),
        groupSender: groupSenderFor(event),
        groupsReader: groupsReaderFor(),
        gitSync: gitSyncFor(),
        callTool: (name, args) => callTool(name, args, env.toolTimeoutMs),
        broadcastSender: broadcastSenderFor(event),
      })

      await sendReply(event, `已建工单 ${id}：${goal}\n进度会自动推过来，随时发 /tasks 查状态。`)
    } catch (error) {
      await sendReply(event, `启动失败：${error?.message ?? error}`)
    }
    return
  }

  if (text === '/tasks' || text === '任务状态') {
    const running = taskStatus()
    if (running.length === 0) {
      await sendReply(event, '当前没有正在跑的工单。')
      return
    }

    const lines = running.map(
      (task) =>
        `${task.id}｜第 ${task.step} 步｜已跑 ${task.elapsed} 秒｜${task.idle} 秒无新动作`,
    )
    await sendReply(event, `正在跑 ${running.length} 个工单：\n${lines.join('\n')}\n\n发 /kill <工单号> 可以终止。`)
    return
  }

  if (text === '/clean' || text === '/clean all') {
    const includeDownloads = text === '/clean all'

    try {
      const result = cleanWorkspace({ includeDownloads })

      if (result.removed.length === 0) {
        const stats = workspaceStats()
          .map((item) => `${item.name}/：${item.count} 项，${(item.size / 1024).toFixed(1)} KB`)
          .join('\n')
        await sendReply(event, `没有需要清理的临时文件。\n\n当前占用：\n${stats}`)
        return
      }

      const kb = (result.freed / 1024).toFixed(1)
      const preview = result.removed.slice(0, 12).map((item) => `  ${item}`).join('\n')
      const more = result.removed.length > 12 ? `\n  …还有 ${result.removed.length - 12} 项` : ''

      await sendReply(event, 
        `清理完成：删掉 ${result.removed.length} 项，释放 ${kb} KB\n${preview}${more}` +
          (includeDownloads ? '' : '\n\n（downloads 里的交付物保留了，要一起清就发 /clean all）'),
      )
    } catch (error) {
      await sendReply(event, `清理失败：${error?.message ?? error}`)
    }
    return
  }

  if (text.startsWith('/kill ')) {
    const id = text.slice(6).trim()

    try {
      killTask(id)
      await sendReply(event, `已请求终止 ${id}，它会在下一个步骤检查时停下。`)
    } catch (error) {
      await sendReply(event, `终止失败：${error?.message ?? error}`)
    }
    return
  }

  // 太长的消息不拒收：截断后照样回答，只是告诉模型前面被砍了一截
  let truncated = ''
  if (text.length > env.maxInputChars) {
    truncated = `\n\n（对方这条消息 ${text.length} 字，超过 ${env.maxInputChars} 字上限，只送进了前 ${env.maxInputChars} 字）`
    text = text.slice(0, env.maxInputChars)
  }

  // 订阅直通：这个会话已经有工单在跑，新消息直接投给那个 Worker，不再另开一轮对话
  // 想绕过它单独聊天，就发 /chat 开头
  const bypassTicket = text.startsWith('/chat ')
  if (bypassTicket) text = text.slice(6).trim()

  const runningTicket = bypassTicket ? null : submitInput(key, text)
  if (runningTicket) {
    await sendReply(
      event,
      `已经转给正在跑的工单 ${runningTicket}，它下一步就会看到。\n想单独聊别的事就发 /chat 开头。`,
    )
    return
  }

  try {
    await withTimeout(syncRegistry(), 5000)
  } catch (error) {
    console.error('[mcp] 同步注册表失败：', error?.message ?? error)
  }

  try {
    const actor = event.user_id ?? ''

    // 上一条发了选择题、这条回数字：当成选中，翻成明确的话再交给模型
    const picked = resolveChoice(key, text)
    if (picked) {
      text = `${picked.choice}\n（对方刚在「${picked.question}」这道选择题里选了这一项）`
    }

    // 语音/图片/文件：下载后在输入里附一段说明，图片还会直接喂给多模态模型
    let input = `${text}${truncated}${referencedContext(event)}`
    let images = []

    if (inbound.length > 0) {
      try {
        const described = await describeInbound(inbound, key)
        input = `${input}${described.text}`.trim()
        images = described.images
      } catch (error) {
        console.warn('[附件] 处理失败：', error?.message ?? error)
        input = `${input}

（对方发了 ${inbound.length} 个附件，但下载失败了：${error?.message ?? error}）`
      }
    }

    const answer = await chat(key, input || '（只发了附件，没有文字）', {
      images,
      scope,
      actor,
      trigger,
      tools: toolsForScope(scope, actor),
      sendImage: imageSenderFor(event),
      audioSender: audioSenderFor(event),
      videoSender: videoSenderFor(event),
      fileSender: fileSenderFor(event),
      cardSender: cardSenderFor(event),
      speakSender: speakSenderFor(event),
      choiceSender: choiceSenderFor(event),
      historyReader: historyReaderFor(event),
      profileReader: profileReaderFor(event),
      groupSender: groupSenderFor(event),
      groupsReader: groupsReaderFor(),
      gitSync: gitSyncFor(),
      scheduler: schedulerFor(event),
      recallMessages: (options) => recallMessages({ event, ...(options ?? {}) }),
      broadcastSender: broadcastSenderFor(event),

      onStep: progressReporter(event),
      startTask: (goal) =>
        launchTask({
          sessionKey: key,
          scope,
          actor,
          goal,
          notify: notifierFor(event),
          tools: toolsForScope(scope, actor),
          sendImage: imageSenderFor(event),
          audioSender: audioSenderFor(event),
          videoSender: videoSenderFor(event),
          fileSender: fileSenderFor(event),
          cardSender: cardSenderFor(event),
          speakSender: speakSenderFor(event),
          callTool: async (name, args) => {
            const result = await callTool(name, args, env.toolTimeoutMs)
            if (AUDITED_TOOLS.has(name)) audit(key, name, args, result)
            return result
          },
        }),
      callTool: async (name, args) => {
        const result = await callTool(name, args, env.toolTimeoutMs)
        if (AUDITED_TOOLS.has(name)) audit(key, name, args, result)
        return result
      },
    })
    await sendLongReply(event, answer)

    if (event.message_type === 'group' && answer) {
      groupLog.record(event.group_id, {
        t: Date.now(),
        u: 'bot',
        n: env.personaName,
        c: String(answer).replace(/\s+/g, ' ').slice(0, 200),
        id: `bot-${Date.now()}`,
      })
    }
  } catch (error) {
    console.error(`[模型调用失败] ${key}:`, error?.message ?? error)
    // 兜底话术别连着刷：同一个群/同一个私聊 10 分钟最多一次
    if (trigger === 'private' || oncePer(`apology:${key}`, QUIET_MS.apology)) {
      await sendReply(event, '抱歉，我这边暂时无法回答，请稍后再试。').catch(() => {})
    }
  }
}

async function handleSummary(event) {
  const groupId = event.group_id
  const cooldownKey = `summary:${groupId}`

  if (coolingDown(cooldownKey, env.summaryCooldown)) {
    await sendReply(event, '刚总结过，过一会儿再说吧。')
    return
  }

  const entries = groupLog.recent(groupId, env.summaryLimit)
  if (entries.length < 5) {
    await sendReply(event, 
      `这个群我只攒到 ${entries.length} 条记录，还不够总结。\n` +
        '如果群里没把「机器人可获取的群聊消息范围」设成「获取群内全部消息」，我只能看到 @ 我的消息。',
    )
    return
  }

  touch(cooldownKey)

  try {
    await sendReply(event, `翻记录中，一共 ${entries.length} 条，稍等…`)
    const transcript = groupLog.formatForSummary(entries)
    const summary = await summarizeGroup(transcript, '')
    await sendLongReply(event, summary)
  } catch (error) {
    console.error('[总结失败]', error?.message ?? error)
    await sendReply(event, '总结没成功，可能记录太多，等会儿再试。').catch(() => {})
  }
}

// 「安静 / 别吵」这类群内自治指令：任何人说一句就能让它闭嘴，@ 它仍然有反应
async function handleQuietCommand(event, text) {
  const minutes = parseMuteCommand(text)
  if (minutes > 0) {
    const info = muteGroup(event.group_id, minutes)
    await sendReply(
      event,
      `好，我安静 ${info.minutes >= 60 ? `${Math.round(info.minutes / 60)} 小时` : `${info.minutes} 分钟`}。` +
        '有事 @ 我，或者发「可以说话了」。',
    ).catch(() => {})
    return true
  }

  if (isUnmuteCommand(text)) {
    const was = unmuteGroup(event.group_id)
    await sendReply(event, was ? '行，我接着说了。' : '我本来就没在静音。').catch(() => {})
    return true
  }

  return false
}

async function handleGroupAll(event) {
  const text = (event.content ?? '').trim()
  recordGroupMessage(event, text || '[附件]')
  if (!text) return

  if (await handleQuietCommand(event, text)) return

  // 之前发过选择题，这条回了个数字：当成选中，直接走对话（群里不容易被 @ 到时尤其需要）
  const picked = resolveChoice(`group:${event.group_id}`, text)
  if (picked) {
    if (hasReplied(event.message_id)) return
    markReplied(event.message_id)
    console.log(`[选择题] ${event.group_id} 选了「${picked.choice}」`)
    await handleMessage(
      event,
      'at',
      `${picked.choice}\n（对方刚在「${picked.question}」这道选择题里选了这一项）`,
    )
    return
  }

  if (env.toolDebug && Array.isArray(event.mentions) && event.mentions.length > 0) {
    console.log(
      `[@诊断] mentions=${JSON.stringify(event.mentions).slice(0, 240)} self_id=${bot.self_id} appId=${env.appId}`,
    )
  }

  // 群开了「获取全部消息」时，@ 我的消息可能走普通群消息事件，靠 mentions 认出来
  if (atMe(event)) {
    if (hasReplied(event.message_id)) return

    markReplied(event.message_id)
    console.log(`[群触发] ${event.group_id} 在消息里 @ 了我，开始回复`)
    await handleMessage(event, 'at')
    return
  }

  if (SUMMARY_CMD.test(text) && text.length <= 20) {
    if (hasReplied(event.message_id)) return
    markReplied(event.message_id)
    await handleSummary(event)
    return
  }

  // 名字触发和自动判断：被喊安静之后都不做，只保留 @ 和 /总结
  if (isMuted(event.group_id)) return

  if (env.groupAutoReply && mentionsBot(text)) {
    if (hasReplied(event.message_id)) return

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

async function handleGroupAt(event, overrideText = '') {
  const raw = (event.content ?? '').trim()
  const text = (overrideText || raw).trim()
  recordGroupMessage(event, raw || '[附件]')

  if (await handleQuietCommand(event, text)) return

  // 只 @ 不说话、也没带附件：以前是静默丢，用户会以为坏了，这里给一句引导（每群 60 秒最多一次）
  if (!text && extractInbound(event).length === 0) {
    const key = `empty-at:${event.group_id}`
    if (!coolingDown(key, 60_000)) {
      touch(key)
      await sendReply(event, '在。说吧，要查什么、要干什么。').catch(() => {})
    }
    return
  }

  if (hasReplied(event.message_id) && !overrideText) return
  markReplied(event.message_id)

  if (SUMMARY_CMD.test(text) && text.length <= 20) {
    await handleSummary(event)
    return
  }

  await handleMessage(event, 'at')
}

// 触发层判定要接话时，回调进 Router：由 Router 决定怎么组装上下文和回复
initTrigger({
  judge: (event) => handleMessage(event, 'judge'),
})

bot.on('message.private.friend', (event) => {
  // 平台偶尔会重推同一条，没这道去重会回两遍
  if (!claim(event.message_id, 'private')) return

  const key = sessionKeyOf(event)
  const hasInbound = extractInbound(event).length > 0

  // 连发合并：连着几句合成一次理解，别只理解最后一句
  mergeMessage(
    {
      sessionKey: key,
      userId: event.user_id ?? '',
      text: event.content,
      event,
      windowMs: env.mergeWindowMs,
      immediate: hasInbound,
    },
    ({ text }) => enqueue(key, () => handleMessage(event, 'private', text)),
  )
})

bot.on('message.group.at', (event) => {
  if (env.toolDebug) console.log(`[事件] group.at mentions=${event.mentions?.length ?? 0}`)

  const key = sessionKeyOf(event)
  const hasInbound = extractInbound(event).length > 0

  mergeMessage(
    {
      sessionKey: key,
      userId: event.user_id ?? '',
      text: event.content,
      event,
      windowMs: env.mergeWindowMs,
      immediate: hasInbound,
    },
    ({ events, text }) => {
      // 同一条消息可能已经从 message.group 走过一遍，过滤掉已处理的
      const fresh = events.filter((item) => !hasReplied(item.message_id))
      if (fresh.length === 0) return

      for (const item of fresh) {
        markReplied(item.message_id)
        recordGroupMessage(item, (item.content ?? '').trim() || '[附件]')
      }

      const last = fresh[fresh.length - 1]
      const merged = fresh
        .map((item) => (item.content ?? '').trim())
        .filter(Boolean)
        .join('\n')

      if (env.toolDebug && fresh.length > 1) {
        console.log(`[合并] ${key} 连发 ${fresh.length} 条合成一次理解`)
      }

      enqueue(key, () => handleGroupAt(last, merged || text))
    },
  )
})

bot.on('message.group', (event) => {
  enqueue(sessionKeyOf(event), () => handleGroupAll(event))
})

let shuttingDown = false

// ---------- 定时任务自愈 ----------
// 失败了自己去查、去改，改完告诉调度器「要不要重启」「修没修好」。
// 节流在 src/heal.js，这里只管干活，不判断能不能干。
const SELF_HEAL_HINT = [
  '定时任务执行失败了。你的活是自己定位、自己修，别只写报告。',
  '',
].join('\n')

function parseHealVerdict(raw) {
  const m = /SELFHEAL:\s*healed=(yes|no)\s+needRestart=(yes|no)(?:\s+note=(.*))?/i.exec(String(raw ?? ''))
  if (!m) return { healed: false, needRestart: false, note: '子助手没给出结论行' }
  return {
    healed: m[1].toLowerCase() === 'yes',
    needRestart: m[2].toLowerCase() === 'yes',
    note: String(m[3] ?? '').replace(/\s+/g, ' ').trim().slice(0, 180),
  }
}

async function runSelfHeal({ task, error, signature, catchUp = false } = {}) {
  const stack = String(error?.stack ?? error?.message ?? error ?? '').slice(0, 1500)
  const prompt = [
    SELF_HEAL_HINT,
    `任务 id：${task?.id ?? '未知'}`,
    `任务目标：${String(task?.prompt ?? '').slice(0, 400)}`,
    `触发方式：${catchUp ? '启动补跑' : '按点触发'}`,
    `报错签名：${signature ?? ''}`,
    '报错原文（可能截断）：',
    stack,
    '',
    '要求：',
    '1. 先 grep 报错里出现的标识符，确认在哪个文件哪一行，别凭记忆猜。',
    '2. 读上下文，判断是漏了 import、参数没传、还是函数根本不存在，改最小必要的地方。',
    '3. 改完再 grep 一次，确认那个标识符现在有定义/有导入。机器内存小，别硬跑 node --check，OOM 会拖死整机。',
    '4. 不要自己敲 pm2 restart，重启交给上层。',
    '5. 结果里别贴大段代码。',
    '',
    '最后单独一行给结论，格式严格如下，别加别的字：',
    'SELFHEAL: healed=yes needRestart=no note=一句话说改了什么',
    '没定位到原因就写 healed=no，needRestart 照实写。',
  ].join('\n')

  const raw = await runTaskAgent({
    taskPrompt: prompt,
    scope: 'private',
    actor: 'scheduler', // 复用定时任务的授权，能读写源码
    sessionKey: `heal:${task?.id ?? 'unknown'}`,
    tools: toolsForScope('private', 'scheduler'),
    callTool: (name, args) => callTool(name, args, env.toolTimeoutMs),
    gitSync: gitSyncFor(),
  })

  const verdict = parseHealVerdict(raw)
  console.log(`[自愈] ${task?.id ?? ''} 结论：healed=${verdict.healed} needRestart=${verdict.needRestart}｜${verdict.note}`)
  return verdict
}

// 自愈改完代码需要重启：走 restart_self 工具，别在进程里直接敲 pm2
async function requestSchedulerRestart(reason) {
  const text = String(reason ?? '').slice(0, 200)
  console.warn('[自愈] 需要重启：', text)
  try {
    await callTool('restart_self', { reason: text, delay_seconds: 8 }, env.toolTimeoutMs)
  } catch (error) {
    console.error('[自愈] 重启请求失败：', error?.message ?? error)
  }
}

// 定时推送发错了要能撤：按 target + message_id 调撤回，不依赖 event
async function recallSentToTarget(target, ids) {
  const list = (Array.isArray(ids) ? ids : [ids]).map((id) => String(id ?? '')).filter(Boolean)
  if (list.length === 0) return '没有 message_id，撤不了'

  const event =
    target?.type === 'group'
      ? { message_type: 'group', group_id: target.id }
      : { message_type: 'private', user_id: target.id }

  const notes = []
  for (const id of list) {
    try {
      notes.push(await recallMessages({ event, messageId: id }))
    } catch (error) {
      notes.push(`撤 ${id} 失败：${error?.message ?? error}`)
    }
  }
  return notes.join('\n')
}

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
    flushTickets()
    flushUsage()
    flushKnowledge()
    flushSituations()
    flushQuiet()
    flushTodos()
  } catch (error) {
    console.error('[退出] 落盘失败：', error?.message ?? error)
  }

  // 机器人自己改了源码时，退出前把它提交回仓库，实现「自己进化」
  if (env.autoSyncOnExit) {
    try {
      const synced = await commitAndPush('auto sync: 退出前自动提交')
      if (synced.skipped) {
        console.log(`[同步] 跳过：${synced.reason}`)
      } else if (synced.pushed) {
        console.log(`[同步] 已提交并推送 ${synced.files} 个文件（${synced.branch}）`)
      } else {
        console.warn(`[同步] 已本地提交 ${synced.files} 个文件，但推送失败：${synced.reason}`)
      }
    } catch (error) {
      console.error('[同步] 自动提交失败（不影响退出）：', error?.message ?? error)
    }
  }

  stopWatchdog()

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

// 未处理的 Promise 拒绝：Node 22 默认会直接把进程干掉，这里只记日志，别让一条后台任务拖死整机
process.on('unhandledRejection', (reason) => {
  const message = reason instanceof Error ? `${reason.message}
${reason.stack ?? ''}` : String(reason)
  console.error('[未处理的拒绝]', message.slice(0, 800))
})

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
    console.log(`[启动] 权限: ${describeAdminPolicy()}`)
  } catch (error) {
    console.error('[启动] 工具服务启动失败，降级为纯聊天：', error?.message ?? error)
  }
} else {
  console.log('[启动] 工具已关闭（ENABLE_TOOLS=false）')
}

// 2C2G 小机器：启动时把内存账算清楚，出问题好对照
function reportMemory() {
  try {
    const raw = fs.readFileSync('/proc/meminfo', 'utf8')
    const lines = raw.split('\n')

    const pick = (key) => {
      const line = lines.find((item) => item.startsWith(`${key}:`))
      if (!line) return 0
      return Math.round(parseInt(line.split(':')[1], 10) / 1024)
    }

    const total = pick('MemTotal')
    const available = pick('MemAvailable')
    const swap = pick('SwapTotal')
    if (!total) return

    console.log(
      `[内存] 总计 ${(total / 1024).toFixed(1)}G｜可用 ${available}MB｜swap ${(swap / 1024).toFixed(1)}G`,
    )
    console.log(
      `[内存] 预算：主进程堆 ${process.env.MAIN_HEAP_MB || 320}MB + MCP ${process.env.MCP_HEAP_MB || 160}MB，` +
        `单条命令上限 ${process.env.SHELL_ULIMIT_MB || 512}MB，命令预估安全线 ${Math.max(120, Math.floor(available * 0.75))}MB，` +
        `同时最多 ${env.taskConcurrency} 个工单`,
    )

    if (available < 300) {
      console.warn(`[内存] 可用只剩 ${available}MB：低于 300MB 时所有 shell 命令都会被拒绝，只剩救援命令`)
    } else if (available < 500) {
      console.warn(`[内存] 可用 ${available}MB，偏紧：重命令会被预估拦截，先腾内存或加 swap`)
    }
    if (swap < 512) {
      console.warn(
        '[内存] 没有 swap，一个大命令就可能把整机 OOM 掉。建议：' +
          'fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile',
      )
    }
  } catch {
    // 非 Linux 或读不到，跳过
  }
}

reportMemory()

try {
  const repoLine = (await describeStatus()).split('\n')[0]
  console.log(`[同步] ${repoLine}`)
} catch (error) {
  console.error('[同步] 读仓库状态失败：', error?.message ?? error)
}

console.log(`[启动] 正在连接 QQ 开放平台（AppID: ${env.appId}）...`)

try {
  await bot.start()
  console.log('[启动] 已连接。私聊直接发消息，群聊 @ 我即可对话。')
  console.log(`[启动] 人格: ${env.personaName}，模型: ${env.model}，记忆: 短期 ${env.historyTurns} 轮 / 中期摘要 / 长期事实`)
  console.log(
    `[启动] 群聊：${env.groupAutoReply ? `提到「${env.botAliases.join('/')}」必回（冷却 ${env.groupTriggerCooldown / 1000}s）` : '名字触发已关'}；` +
      `${
        env.judgeMode === 'auto'
          ? `自动判断插话（每小时上限 ${env.judgeHourlyLimit} 次，回复后冷却 ${env.judgeCooldown / 1000}s）`
          : env.judgeMode === 'observe'
            ? '观察模式（会评估该不该接话，但只记录不回复，发 /observe 看）'
            : '自动判断已关'
      }；` +
      `「/总结」复盘最近 ${env.summaryLimit} 条`,
  )

  // 没配的项都用了什么默认，一次列出来，省得猜「为什么它不回/为什么这么吵」
  console.log(
    `[配置] 主动接话=${env.proactive.enabled ? `开（${env.proactive.intervalMinutes} 分钟一轮，每群每小时≤${env.proactive.maxPerHour} 次）` : '关'}｜` +
      `回访=${env.followup.enabled ? `开（≥${env.followup.minAgeHours} 小时）` : '关'}｜` +
      `热点吐槽=${env.hotTake.enabled ? `开（${env.hotTake.cron}）` : '关'}｜` +
      `连发合并=${env.mergeWindowMs > 0 ? `${env.mergeWindowMs}ms` : '关'}｜` +
      `私聊流式=${env.streamReply ? '开' : '关'}｜` +
      `引用=${env.quoteReply || '关'}`,
  )
  console.log(
    `[配置] 工具=${env.toolsEnabled ? '开' : '关'}｜群聊工具=${env.groupToolsEnabled ? '开' : '关'}｜` +
      `高危工具=${env.adminOpenIds.length > 0 ? `白名单 ${env.adminOpenIds.length} 人` : `私聊放开/群里${env.shellGroupEnabled ? '放开' : '禁用'}`}｜` +
      `详细日志=${env.toolDebug ? '开' : '关（排查时设 TOOL_DEBUG=true）'}｜` +
      `工具轮数上限=${env.maxToolRounds}｜单条输入上限=${env.maxInputChars} 字｜回复上限 ${env.replyMaxChars} 字/条`,
  )

  initScheduler({
    sendMessage: async (target, text) => {
      // 群里被喊安静了就先别推：定时早报也是打扰
      if (target.type === 'group' && isMuted(target.id)) {
        console.log(`[定时] ${target.id.slice(0, 12)}… 静音中，本次推送跳过`)
        return []
      }

      // 定时任务的日报可能很长：分段发，别用 clip 截断
      const parts = chunkText(text)
      const ids = []
      // 撤回要 message_id：这里把发送结果捞出来，既给调度器记账，也写进撤回台账
      const event =
        target.type === 'group'
          ? { message_type: 'group', group_id: target.id }
          : { message_type: 'private', user_id: target.id }

      for (let i = 0; i < parts.length && i < 6; i += 1) {
        if (i > 0) await new Promise((resolve) => setTimeout(resolve, 600))
        const result =
          target.type === 'group'
            ? await bot.group(target.id).send(parts[i])
            : await bot.user(target.id).send(parts[i])
        const id = pickMessageId(result)
        if (id) {
          ids.push(id)
          noteSent(event, id, parts[i], 'text')
        }
      }

      return ids
    },
    runTask: runScheduledTask,
    selfHeal: runSelfHeal,
    recallSent: recallSentToTarget,
    requestRestart: requestSchedulerRestart,
  })

  try {
    const groups = rebuildAll()
    if (groups > 0) console.log(`[知识] 已重建 ${groups} 个群的画像`)
  } catch (error) {
    console.warn('[知识] 启动重建失败：', error?.message ?? error)
  }

  // 复活播报：重启后主动说话，别让用户猜「它到底起没起来」
  const announce = async (interruptedList) => {
    const pendingFile = path.join(dataDir, 'restart-pending.json')
    const bootFile = path.join(dataDir, 'last-boot.json')

    let pending = null
    try {
      pending = JSON.parse(fs.readFileSync(pendingFile, 'utf8'))
    } catch {
      pending = null
    }
    try {
      fs.rmSync(pendingFile, { force: true })
    } catch {
      // 没有就算了
    }

    let last = null
    try {
      last = JSON.parse(fs.readFileSync(bootFile, 'utf8'))
    } catch {
      last = null
    }

    const now = Date.now()
    // 10 分钟内刚播报过就别再刷一遍（避免震荡重启时反复打扰）
    if (last?.announcedAt && now - last.announcedAt < 10 * 60_000) return

    const recent = recentSessions(30 * 60_000)
    const targets = new Map()

    for (const session of recent) {
      const [type, ...rest] = session.key.split(':')
      const id = rest.join(':')
      if ((type === 'group' || type === 'user') && id) targets.set(session.key, { type, id })
    }

    for (const task of interruptedList) {
      if (task.target?.id) {
        targets.set(`${task.target.type}:${task.target.id}`, {
          type: task.target.type,
          id: task.target.id,
        })
      }
    }

    if (targets.size === 0) {
      // 兜底：半小时内没人吭声也不能装死，退一步发给最近有过活动的会话
      const fallback = recentSessions(7 * 24 * 60 * 60_000)[0]
      if (fallback) {
        const [ftype, ...frest] = fallback.key.split(':')
        const fid = frest.join(':')
        if ((ftype === 'group' || ftype === 'user') && fid) {
          targets.set(fallback.key, { type: ftype, id: fid })
        }
      }
    }

    if (targets.size === 0) return

    const reasonText = pending?.reason ? `（${pending.reason}）` : ''
    const lines = [`我回来了，刚重启完${reasonText}。`]

    if (interruptedList.length > 0) {
      lines.push(`上次有 ${interruptedList.length} 个工单没跑完：`)
      for (const task of interruptedList.slice(0, 3)) {
        lines.push(`- ${task.id}：${String(task.goal ?? '').slice(0, 40)}`)
      }
      lines.push('要接着跑就说一声，我重新发起。')
    } else {
      lines.push('刚才的对话接着来就行。')
    }

    const text = clip(lines.join('\n'))

    for (const [key, target] of targets) {
      try {
        // 群里播报要克制：被喊过安静的不发，同一个群 12 小时最多一条
        if (target.type === 'group') {
          if (isMuted(target.id)) continue
          if (!oncePer(`announce:${target.id}`, QUIET_MS.announce)) continue
        }

        if (target.type === 'group') await bot.group(target.id).send(text)
        else await bot.user(target.id).send(text)
        console.log(`[启动] 已向 ${key} 播报复活`)
      } catch (error) {
        console.warn(`[启动] 向 ${key} 播报失败：`, error?.message ?? error)
      }
    }

    try {
      fs.writeFileSync(bootFile, JSON.stringify({ at: now, announcedAt: now, to: [...targets.keys()] }))
    } catch {
      // 写不进去就下次再播
    }
  }

  const interrupted = takeInterruptedTasks()
  for (const task of interrupted) {
    const body =
      `上次有个工单没跑完（${task.id}）：\n${String(task.goal ?? '').slice(0, 100)}\n\n` +
      '需要重跑的话发 /task 重新发起，或者直接说「继续刚才那个」。'
    try {
      if (task.target?.type === 'group') await bot.group(task.target.id).send(body)
      else if (task.target?.id) await bot.user(task.target.id).send(body)
    } catch (error) {
      console.error('[工单] 中断通知发送失败：', error?.message ?? error)
    }
  }

  if (interrupted.length > 0) {
    console.log(`[启动] 发现 ${interrupted.length} 个被中断的工单，已通知对应会话`)
  }

  // 复活播报真的得调用，不然上面那个函数就是死代码
  try {
    await announce(interrupted)
  } catch (error) {
    console.warn('[启动] 复活播报失败：', error?.message ?? error)
  }

  // 外部控制回路：只在外面看工单有没有真的在往前走，不参与执行
  startWatchdog({
    send: async (target, text) => {
      const body = clip(text)
      if (target?.type === 'group') await bot.group(target.id).send(body)
      else if (target?.id) await bot.user(target.id).send(body)
    },
    abort: (ticketId) => {
      try {
        killTask(ticketId)
        return true
      } catch {
        return false
      }
    },
  })

  // 定时把代码改动提交回仓库：不依赖「重启才提交」，改一点就留一点
  const syncMinutes = env.autoSyncIntervalMinutes
  if (syncMinutes > 0) {
    const syncTimer = setInterval(async () => {
      try {
        const result = await commitAndPush('auto sync: 定时同步')

        if (result.skipped) {
          if (env.toolDebug) console.log(`[同步] 定时检查：${result.reason}`)
          return
        }
        if (result.pushed) {
          console.log(`[同步] 定时提交并推送 ${result.files} 个文件`)
          return
        }
        console.warn(`[同步] 定时提交 ${result.files} 个文件，推送失败：${result.reason}`)
      } catch (error) {
        // 同步失败不能影响机器人本身
        console.warn('[同步] 定时同步出错：', error?.message ?? error)
      }
    }, syncMinutes * 60_000)

    syncTimer.unref?.()
    console.log(`[同步] 每 ${syncMinutes} 分钟自动提交一次（AUTO_SYNC_INTERVAL_MINUTES 可调，0 关闭）`)
  }

  // 主动扫描：每 N 分钟翻一遍群记录，看有没有「有人问但没人答」的问题
  const proactiveMinutes = env.proactive.intervalMinutes
  if (env.proactive.enabled && proactiveMinutes > 0) {
    const proactiveTimer = setInterval(() => {
      runProactiveScan().catch((error) => console.warn('[主动] 扫描异常：', error?.message ?? error))
    }, proactiveMinutes * 60_000)
    proactiveTimer.unref?.()

    console.log(
      `[主动] 每 ${proactiveMinutes} 分钟扫一遍群记录` +
        `（每群每小时最多 ${env.proactive.maxPerHour} 次，` +
        `${env.proactive.quietStart}-${env.proactive.quietEnd} 点静默）`,
    )
  }

  // 回访：隔一段时间把「还在进行中的事」拎出来问一句
  const followupMinutes = env.followup.intervalMinutes
  if (env.followup.enabled && followupMinutes > 0) {
    const followupTimer = setInterval(() => {
      runFollowUps().catch((error) => console.warn('[回访] 扫描异常：', error?.message ?? error))
    }, followupMinutes * 60_000)
    followupTimer.unref?.()

    console.log(
      `[回访] 每 ${followupMinutes} 分钟看一次手头没结的事` +
        `（至少隔 ${env.followup.minAgeHours} 小时才提，` +
        `${env.followup.quietStart}-${env.followup.quietEnd} 点静默）`,
    )
  }

  // 热点吐槽：到点自己去搜新闻，挑一条在群里说两句
  const hotTakeCron = env.hotTake.cron
  if (env.hotTake.enabled) {
    let lastHotKey = ''
    const hotTakeTimer = setInterval(() => {
      const now = new Date()
      const key = `${now.getFullYear()}${now.getMonth()}${now.getDate()}${now.getHours()}${now.getMinutes()}`
      if (key === lastHotKey) return
      if (!cronMatches(hotTakeCron, now)) return
      lastHotKey = key
      runHotTake().catch((error) => console.warn('[热点] 执行异常：', error?.message ?? error))
    }, 30_000)
    hotTakeTimer.unref?.()

    console.log(`[热点] 已开启，按 cron「${hotTakeCron}」去搜当天热点自己聊`)
  }

  // 每天把记忆和群记录备一份，机器重装不至于全丢
  const backupTimer = setInterval(() => {
    try {
      const result = runBackup()
      if (!result.skipped) {
        console.log(`[备份] ${result.stamp}：${result.files} 个文件，${(result.bytes / 1024).toFixed(1)} KB`)
      }
    } catch (error) {
      console.warn('[备份] 出错：', error?.message ?? error)
    }
  }, 6 * 60 * 60 * 1000)
  backupTimer.unref?.()

  try {
    const first = runBackup()
    if (!first.skipped) console.log(`[备份] 今天的备份已完成：${first.files} 个文件`)
  } catch (error) {
    console.warn('[备份] 启动备份失败：', error?.message ?? error)
  }

  const mediaTtlHours = env.mediaTtlHours
  const cleaner = setInterval(async () => {
    try {
      const groups = rebuildAll()
      const { cleared, removed } = evictIdleSessions(env.sessionTtlMs)
      const files = await cleanupIncoming(mediaTtlHours)
      if (cleared || removed || files) {
        console.log(
          `[清理] 群知识重建 ${groups} 个；闲置会话：清空 ${cleared} 个、删除 ${removed} 个空壳；回收附件 ${files} 个`,
        )
      }
    } catch (error) {
      console.error('[清理] 失败：', error?.message ?? error)
    }
  }, 60 * 60 * 1000)
  cleaner.unref?.()

  if (process.send) process.send('ready')
} catch (error) {
  console.error('[启动] 连接失败：', error?.message ?? error)
  console.error('       请检查 .env 中的 QQ_APP_ID / QQ_APP_SECRET 是否正确，以及开放平台沙箱配置是否已添加测试成员。')
  await withTimeout(stopMcp(), 3000)
  process.exit(1)
}
