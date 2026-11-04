import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { env } from './config/env.js'
import { chat, summarizeGroup, runTaskAgent } from './chat/deepseek.js'
import { startTask as launchTask, killTask, submitInput, takeInterruptedTasks } from './tasks/task-runner.js'
import { initScheduler, cronMatches } from './tasks/scheduler.js'
import { startMcp, getTools, syncRegistry, callTool, stopMcp } from './mcp/client.js'
import { isAdmin, describePolicy, describeAdminPolicy } from './config/policy.js'
import { ensureSkillsDir } from './skills/skills.js'
import { evictIdleSessions, recentSessions, flush } from './memory/memory.js'
import { flushTickets } from './tasks/ticket.js'
import { startWatchdog, stopWatchdog } from './tasks/watchdog.js'
import { commitAndPush, describeStatus } from './ops/sync.js'
import { noteSent, recallMessages } from './channel/recall.js'
import { flushUsage } from './ops/usage.js'
import * as groupLog from './memory/group-log.js'
import * as observe from './channel/observe.js'
import { flushKnowledge, rebuildAll } from './memory/knowledge.js'
import { flushSituations } from './memory/situations.js'
import { runBackup } from './ops/backup.js'
import { flushTodos } from './chat/todos.js'
import { cleanupIncoming, describeInbound, extractInbound } from './channel/incoming.js'
import { resolveChoice } from './chat/choices.js'
import { mergeMessage } from './chat/merge.js'
import { recentGroupContext } from './channel/group-context.js'
import { audit } from './app/audit.js'
import { reportMemory } from './app/display.js'
import { runCommand } from './app/commands.js'
import { progressReporter, runFollowUps, runHotTake, runProactiveScan, runScheduledTask } from './app/timers.js'
import { atMe, broadcastSenderFor, choiceSenderFor, gitSyncFor, groupSenderFor, groupsReaderFor, notifierFor, historyReaderFor, profileReaderFor, referencedContext, schedulerFor, toolsForScope, sessionKeyOf } from './app/factories.js'
import { QUIET_MS, flushQuiet, isMuted, isUnmuteCommand, muteGroup, oncePer, parseMuteCommand, unmuteGroup } from './engage/quiet.js'
import { bot } from './bot.js'
import { chunkText, clip, isStaleMessage, markQuote, pickMessageId, sendLongReply, sendReply } from './channel/sender.js'
import { pendingCount, takePending } from './chat/pending.js'
import { audioSenderFor, cardSenderFor, fileSenderFor, imageSenderFor, speakSenderFor, videoSenderFor } from './channel/media.js'
import { claim, coolingDown, enqueue, hasReplied, initTrigger, markReplied, mentionsBot, recordGroupMessage, scheduleJudge, touch, worthJudging } from './channel/trigger.js'

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
  // 能改代码、能推仓库的，同样要留痕
  'write_file',
  'edit_file',
  'git_sync',
])
const SUMMARY_CMD = /^(?:\/)?(?:总结|复盘)/

// 让内置 MCP 子进程知道自己在 pm2 里、应用叫什么，restart_self 要用
process.env.PM2_MANAGED = process.env.pm_id !== undefined ? '1' : '0'
process.env.PM2_APP_NAME = process.env.name?.trim() || process.env.PM2_APP_NAME?.trim() || 'dafeiyu'

fs.mkdirSync(dataDir, { recursive: true })
fs.mkdirSync(path.join(projectRoot, 'logs'), { recursive: true })
fs.mkdirSync(path.join(projectRoot, 'downloads'), { recursive: true })
fs.mkdirSync(path.join(projectRoot, 'tmp'), { recursive: true })

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
// 各种 xxxFor(event) 工厂在 app/factories.js，这里按需 import

// 定时任务、主动扫描、回访、热点吐槽在 app/timers.js

// 运行时展示（/config、/help、启动内存报告）在 app/display.js

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

  // 群里的普通消息不进对话上下文（只有 @ 和提到名字才进），
  // 所以被叫到时得把刚才大家说的话带上，否则模型只会回「在呢，什么事」。
  const contextPrefix =
    scope === 'group' && (trigger === 'name' || trigger === 'at') ? recentGroupContext(event) : ''

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

  // 命令自己认领：见 app/commands.js
  const commandContext = {
    event,
    text,
    key,
    scope,
    trigger,
    actor: event.user_id ?? '',
    reply: (body) => sendReply(event, body),
    isAdminNow: isAdmin(scope, event.user_id ?? ''),
  }

  if (await runCommand(text, commandContext)) return

  // 其余命令同样由 app/commands.js 认领（上面已经统一跑过一轮，这里不会再命中）

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
    let input = `${contextPrefix}${text}${truncated}${referencedContext(event)}`
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

    // 只在私聊播报：群里「我回来了」纯属打扰，群友不关心进程重启
    const recent = recentSessions(30 * 60_000)
    const targets = new Map()

    for (const session of recent) {
      const [type, ...rest] = session.key.split(':')
      const id = rest.join(':')
      if (type === 'user' && id) targets.set(session.key, { type, id })
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
        await bot.user(target.id).send(text)
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
      // 同样只在私聊说：群里的工单中断通知会变成噪音
      if (task.target?.type === 'user' && task.target?.id) {
        await bot.user(task.target.id).send(body)
      } else {
        console.log(`[工单] ${task.id} 是在群里发起的，跳过中断通知（重启后发 /tasks 能查到）`)
      }
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
