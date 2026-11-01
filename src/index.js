import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { env } from './env.js'
import { chat, summarizeGroup, runTaskAgent } from './deepseek.js'
import { startTask as launchTask, taskStatus, describeTool, killTask, submitInput, takeInterruptedTasks } from './task-runner.js'
import { initScheduler, addSchedule, listSchedules, removeSchedule } from './scheduler.js'
import { cleanWorkspace, workspaceStats } from './workspace.js'
import { startMcp, getTools, syncRegistry, toDeepSeekTools, callTool, stopMcp } from './mcp/client.js'
import { filterTools, isAdmin, isToolAllowed, describePolicy, describeAdminPolicy } from './policy.js'
import { ensureSkillsDir } from './skills.js'
import { reset, stats, flush } from './memory.js'
import { flushTickets } from './ticket.js'
import { startWatchdog, stopWatchdog } from './watchdog.js'
import * as groupLog from './group-log.js'
import * as observe from './observe.js'
import { bot } from './bot.js'
import { clip, sendReply } from './sender.js'
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
const AUDITED_TOOLS = new Set(['write_skill', 'add_mcp', 'install_package', 'shell', 'run_script', 'restart_self'])
const SUMMARY_CMD = /^(?:\/)?(?:总结|复盘)/

// 让内置 MCP 子进程知道自己在 pm2 里、应用叫什么，restart_self 要用
process.env.PM2_MANAGED = process.env.pm_id !== undefined ? '1' : '0'
process.env.PM2_APP_NAME = process.env.name?.trim() || process.env.PM2_APP_NAME?.trim() || 'dafeiyu'

fs.mkdirSync(dataDir, { recursive: true })
fs.mkdirSync(path.join(projectRoot, 'logs'), { recursive: true })
fs.mkdirSync(path.join(projectRoot, 'downloads'), { recursive: true })
fs.mkdirSync(path.join(projectRoot, 'tmp'), { recursive: true })

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

function sessionKeyOf(event) {
  return event.message_type === 'group' ? `group:${event.group_id}` : `user:${event.user_id}`
}

async function runScheduledTask(task) {
  const scope = task.target.type === 'group' ? 'group' : 'private'

  try {
    await syncRegistry()
  } catch (error) {
    console.error('[定时] 同步工具注册表失败：', error?.message ?? error)
  }

  return runTaskAgent({
    taskPrompt: task.prompt,
    scope,
    actor: 'scheduler',
    tools: toolsForScope(scope, 'scheduler'),
    callTool: (name, args) => callTool(name, args, env.toolTimeoutMs),
    sendImage: async () => {
      throw new Error('定时任务里不能发图片，请把结果写成文字')
    },
    audioSender: async () => {
      throw new Error('定时任务里不能发音频')
    },
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

function schedulerFor(event) {
  const sessionKey = sessionKeyOf(event)
  const isGroup = event.message_type === 'group'
  const target = {
    type: isGroup ? 'group' : 'user',
    id: isGroup ? event.group_id : event.user_id,
  }

  return {
    add: ({ cron, prompt }) => addSchedule({ sessionKey, target, cron, prompt }),
    list: () => listSchedules(sessionKey),
    remove: (id) => removeSchedule(id, sessionKey),
  }
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
  if (!text) return

  // 只有自动插话才引用原消息；被 @、被点名、私聊都不加引用气泡
  if (trigger === 'judge') markQuote(event)

  const key = sessionKeyOf(event)
  const scope = event.message_type === 'group' ? 'group' : 'private'

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

  if (text === '/observe' || text.startsWith('/observe ')) {
    if (!isAdmin(scope, event.user_id ?? '')) {
      await sendReply(event, '观察记录只对管理员开放。')
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

  if (text === '/reset' || text === '重置对话') {
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
      await sendReply(event, '后台任务只对管理员开放，你的 openid 不在白名单里。')
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
        callTool: (name, args) => callTool(name, args, env.toolTimeoutMs),
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
    const answer = await chat(key, text, {
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
      scheduler: schedulerFor(event),
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
    await sendReply(event, clip(answer))
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
    await sendReply(event, clip(summary))
  } catch (error) {
    console.error('[总结失败]', error?.message ?? error)
    await sendReply(event, '总结没成功，可能记录太多，等会儿再试。').catch(() => {})
  }
}

async function handleGroupAll(event) {
  const text = (event.content ?? '').trim()
  recordGroupMessage(event, text)
  if (!text) return

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
  recordGroupMessage(event, text)
  if (!text) return

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
  } catch (error) {
    console.error('[退出] 落盘失败：', error?.message ?? error)
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
      const body = clip(text)
      if (target.type === 'group') await bot.group(target.id).send(body)
      else await bot.user(target.id).send(body)
    },
    runTask: runScheduledTask,
  })

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

  if (process.send) process.send('ready')
} catch (error) {
  console.error('[启动] 连接失败：', error?.message ?? error)
  console.error('       请检查 .env 中的 QQ_APP_ID / QQ_APP_SECRET 是否正确，以及开放平台沙箱配置是否已添加测试成员。')
  await withTimeout(stopMcp(), 3000)
  process.exit(1)
}
