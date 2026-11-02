import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { env } from './env.js'
import { chat, proactiveReply, summarizeGroup, runTaskAgent, testVision } from './deepseek.js'
import { startTask as launchTask, taskStatus, describeTool, killTask, submitInput, takeInterruptedTasks } from './task-runner.js'
import { initScheduler, addSchedule, listSchedules, removeSchedule } from './scheduler.js'
import { cleanWorkspace, workspaceStats } from './workspace.js'
import { startMcp, getTools, syncRegistry, toDeepSeekTools, callTool, stopMcp } from './mcp/client.js'
import { filterTools, isAdmin, isToolAllowed, describePolicy, describeAdminPolicy } from './policy.js'
import { ensureSkillsDir } from './skills.js'
import { evictIdleSessions, recentSessions, reset, stats, flush } from './memory.js'
import { flushTickets } from './ticket.js'
import { startWatchdog, stopWatchdog } from './watchdog.js'
import { commitAndPush, describeStatus, pullLatest } from './sync.js'
import { flushUsage, formatUsage } from './usage.js'
import * as groupLog from './group-log.js'
import * as observe from './observe.js'
import { formatProfile } from './profiles.js'
import { flushKnowledge, knowledgePrompt, rebuildAll } from './knowledge.js'
import { findCandidates, formatCandidates, noteProactive, shouldProactive } from './proactive.js'
import { cleanupIncoming, describeInbound, extractInbound } from './incoming.js'
import { bot } from './bot.js'
import { chunkText, clip, markQuote, passiveCountOf, sendLongReply, sendReply } from './sender.js'
import { pendingCount, takePending } from './pending.js'
import {
  audioSenderFor,
  cardSenderFor,
  fileSenderFor,
  imageSenderFor,
  speakSenderFor,
  videoSenderFor,
} from './media.js'
import {
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
} from './trigger.js'

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
  if (target?.type === 'group') return bot.group(target.id).send(payload)
  return bot.user(target.id).send(payload)
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
    groupSender: groupSenderFor(null),
    broadcastSender: broadcastSenderFor(null),
    groupsReader: groupsReaderFor(),
    gitSync: gitSyncFor(),
  })
}

function progressReporter(event) {
  const notify = notifierFor(event)
  let lastAt = Date.now()
  let count = 0

  return async ({ round, tool }) => {
    if (round < 1) return
    if (count >= env.progressMax) return
    if (Date.now() - lastAt < env.progressInterval) return

    lastAt = Date.now()
    count += 1
    await notify(`还在处理｜第 ${round + 1} 步：${describeTool(tool)}`)
  }
}

// 主动扫描：没人叫它的时候，自己去翻群记录，看有没有值得接的问题
async function runProactiveScan() {
  if (process.env.PROACTIVE_ENABLED === 'false') return

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

async function handleMessage(event, trigger = 'at') {
  let text = (event.content ?? '').trim()
  const inbound = extractInbound(event)
  if (!text && inbound.length === 0) return

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

  if (text === '/reset' || text === '重置对话' || text === '清空记忆' || text === '重新开始') {
    reset(key)
    await sendReply(event, '记忆已清空，我们重新开始吧。')
    return
  }

  if (text === '/memory' || text === '记忆状态') {
    const current = stats(key)
    await sendReply(event, 
      `短期记忆：${current.shortTerm} 轮对话（约 ${current.historyTokens} tokens）\n` +
        `中期记忆：${current.midTermChars} 字摘要\n` +
        `长期记忆：${current.longTerm} 条事实\n` +
        `上下文预算：${Math.floor((env.contextWindowTokens * env.contextBudgetRatio) / 1000)}K tokens（窗口 ${Math.floor(env.contextWindowTokens / 1000)}K）`,
    )
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

  if (text.length > env.maxInputChars) {
    await sendReply(event, `消息太长了，请压缩到 ${env.maxInputChars} 字以内再发给我。`)
    return
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

    // 语音/图片/文件：下载后在输入里附一段说明，图片还会直接喂给多模态模型
    let input = `${text}${referencedContext(event)}`
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
      historyReader: historyReaderFor(event),
      profileReader: profileReaderFor(event),
      groupSender: groupSenderFor(event),
      groupsReader: groupsReaderFor(),
      gitSync: gitSyncFor(),
      scheduler: schedulerFor(event),
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
    await sendReply(event, '抱歉，我这边暂时无法回答，请稍后再试。').catch(() => {})
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

async function handleGroupAll(event) {
  const text = (event.content ?? '').trim()
  recordGroupMessage(event, text || '[附件]')
  if (!text) return

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

async function handleGroupAt(event) {
  const text = (event.content ?? '').trim()
  recordGroupMessage(event, text || '[附件]')
  if (!text && extractInbound(event).length === 0) return

  if (hasReplied(event.message_id)) return
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
  enqueue(sessionKeyOf(event), () => handleMessage(event, 'private'))
})

bot.on('message.group.at', (event) => {
  if (env.toolDebug) console.log(`[事件] group.at mentions=${event.mentions?.length ?? 0}`)
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
    flushTickets()
    flushUsage()
    flushKnowledge()
  } catch (error) {
    console.error('[退出] 落盘失败：', error?.message ?? error)
  }

  // 机器人自己改了源码时，退出前把它提交回仓库，实现「自己进化」
  if (process.env.AUTO_SYNC_ON_EXIT !== 'false') {
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

  initScheduler({
    sendMessage: async (target, text) => {
      // 定时任务的日报可能很长：分段发，别用 clip 截断
      const parts = chunkText(text)
      for (let i = 0; i < parts.length && i < 6; i += 1) {
        if (i > 0) await new Promise((resolve) => setTimeout(resolve, 600))
        if (target.type === 'group') await bot.group(target.id).send(parts[i])
        else await bot.user(target.id).send(parts[i])
      }
    },
    runTask: runScheduledTask,
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
  const syncMinutes = Number(process.env.AUTO_SYNC_INTERVAL_MINUTES ?? 30)
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
  const proactiveMinutes = Number(process.env.PROACTIVE_INTERVAL_MINUTES ?? 5)
  if (process.env.PROACTIVE_ENABLED !== 'false' && proactiveMinutes > 0) {
    const proactiveTimer = setInterval(() => {
      runProactiveScan().catch((error) => console.warn('[主动] 扫描异常：', error?.message ?? error))
    }, proactiveMinutes * 60_000)
    proactiveTimer.unref?.()

    console.log(
      `[主动] 每 ${proactiveMinutes} 分钟扫一遍群记录` +
        `（每小时最多 ${process.env.PROACTIVE_MAX_PER_HOUR || 2} 次，` +
        `${process.env.PROACTIVE_QUIET_START || 23}-${process.env.PROACTIVE_QUIET_END || 8} 点静默）`,
    )
  }

  const mediaTtlHours = Number(process.env.MEDIA_TTL_HOURS || 24)
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
