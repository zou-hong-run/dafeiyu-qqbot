import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { env } from '../config/env.js'
import { isToolAllowed } from '../config/policy.js'
import { formatUsage } from '../ops/usage.js'
import { testVision } from '../chat/deepseek.js'
import { audioSenderFor, fileSenderFor, imageSenderFor, videoSenderFor } from '../channel/media.js'
import { passiveCountOf } from '../channel/sender.js'
import * as observe from '../channel/observe.js'
import { resetSession } from '../chat/session-reset.js'
import { forget, listLongTerm, stats } from '../memory/memory.js'
import { configSummary, helpText } from './display.js'
import { killTask, startTask as launchTask, taskStatus } from '../tasks/task-runner.js'
import { cleanWorkspace, workspaceStats } from '../ops/workspace.js'
import { callTool } from '../mcp/client.js'
import { broadcastSenderFor, gitSyncFor, groupSenderFor, groupsReaderFor, notifierFor, toolsForScope } from './factories.js'

// 命令注册表：每项自己判断匹配、自己处理权限、自己回话。
// handleMessage 只负责「按顺序问一遍，谁认领谁执行」，不再堆一长串 if。
// ctx 提供：event / text / key / scope / trigger / actor / reply / isAdminNow
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

export const COMMANDS = [
  {
    name: '/id',
    match: (text) => text === '/id' || text === '我的id' || text === '我的ID',
    run: async ({ event, key, reply }) => {
      const admin = env.adminOpenIds.includes(String(event.user_id))
      await reply(
        `你的 openid：${event.user_id}\n` +
          `会话：${key}\n` +
          `群：${event.group_id ?? '（私聊）'}\n` +
          `管理员权限：${admin ? '有' : '无'}\n\n` +
          '要开高危工具（执行命令、写文件、装包、加 MCP）就把上面这串 openid 填进 .env 的 ADMIN_OPENIDS，逗号分隔。',
      )
    },
  },
  {
    name: '/cost',
    match: (text) => text === '/cost' || text.startsWith('/cost '),
    run: async ({ event, text, reply, isAdminNow }) => {
      if (!isAdminNow) {
        await reply(`用量统计只对管理员开放。你的 openid：${event.user_id ?? '未知'}。`)
        return
      }
      const days = Math.min(Math.max(Number(text.split(' ')[1]) || 7, 1), 60)
      await reply(formatUsage(days))
    },
  },
  {
    name: '/diag vision',
    match: (text) => text === '/diag vision',
    run: async ({ event, reply, isAdminNow }) => {
      if (!isAdminNow) {
        await reply(`视觉自检只对管理员开放。你的 openid：${event.user_id ?? '未知'}。`)
        return
      }

      // 现场画一张纯红方块，用它测「能不能真的读到图」
      const probe = path.join(projectRoot, 'downloads', 'vision-probe.png')
      try {
        const { DRAW_HANDLERS } = await import('../mcp-server/draw-pixel.js')
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
        await reply(`视觉自检失败：生成测试图出错 ${error?.message ?? error}`)
        return
      }

      const result = await testVision('downloads/vision-probe.png')

      if (result.ok && result.answer) {
        const usage = result.usage ? `用量：${result.usage}\n` : ''
        await reply(
          `视觉通道正常。\n模型：${result.model}\n读图结果：「${result.answer}」（测试图是纯红色）\n${usage}` +
            '图片识别没问题，正常发图我就能看。',
        )
      } else if (result.ok) {
        const usage = result.usage ? `用量：${result.usage}\n` : ''
        const thought = result.reasoning ? `思维链片段：${result.reasoning}\n` : ''
        await reply(
          `模型调用成功，但返回了空内容，视觉可能没真正生效。\n` +
            `模型：${result.model}\n结束原因：${result.finish || '未知'}\n${usage}${thought}\n` +
            '如果是 finish=length，说明 token 还是不够；如果是 stop 但内容为空，' +
            '多半是这个模型/账号还不支持图片输入，可以先把 DEEPSEEK_MODEL 退回 deepseek-chat 用纯文本。',
        )
      } else if (result.stage === 'read') {
        await reply(`视觉自检失败在「读图」这一步：${result.reason}`)
      } else {
        await reply(
          `视觉自检失败在「模型调用」这一步（模型 ${result.model}）：\n${result.reason}\n\n` +
            '大概率是这个账号还没开通 deepseek-flash 的图片输入，或者模型名要用你控制台里能看到的那个。',
        )
      }
    },
  },
  {
    name: '/diag',
    match: (text) => text === '/diag' || text === '/diag send',
    run: async ({ event, reply, isAdminNow }) => {
      if (!isAdminNow) {
        await reply(
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
        await reply(`自检失败：生成测试图出错 ${error?.message ?? error}`)
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

      await reply(`自检结果：\n${lines.join('\n')}`)
    },
  },
  {
    name: '/observe',
    match: (text) => text === '/observe' || text.startsWith('/observe '),
    run: async ({ event, text, reply, isAdminNow }) => {
      if (!isAdminNow) {
        await reply(
          `观察记录只对管理员开放（里面会有群友的对话原文）。你的 openid：${event.user_id ?? '未知'}。` +
            '填进服务器 .env 的 ADMIN_OPENIDS 后重启即可。',
        )
        return
      }

      const groupId = event.group_id ?? ''

      if (text.includes('clear')) {
        observe.clear(groupId)
        await reply('观察记录已清空。')
        return
      }

      const info = observe.stats(groupId)
      const items = observe.recent(groupId, 10)

      if (items.length === 0) {
        await reply(
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

      await reply(
        `观察记录：今天 ${info.today} 条 / 累计 ${info.total} 条\n\n${lines.join('\n')}\n\n` +
          '想让它在这些时候真的接话，就把 JUDGE_MODE 改成 auto。',
      )
    },
  },
  {
    name: '/reset',
    match: (text) => ['/reset', '重置对话', '清空记忆', '重新开始'].includes(text),
    adminOnly: true,
    run: async ({ key, reply }) => {
      resetSession(key)
      await reply('记忆、任务清单、待选状态都清空了，我们重新开始吧。')
    },
  },
  {
    name: '/memory',
    match: (text) => text === '/memory' || text === '记忆状态',
    adminOnly: true,
    run: async ({ key, reply }) => {
      const current = stats(key)
      await reply(
        `短期记忆：${current.shortTerm} 轮对话（约 ${current.historyTokens} tokens）\n` +
          `中期记忆：${current.midTermChars} 字摘要\n` +
          `长期记忆：${current.longTerm} 条事实\n` +
          `上下文预算：${Math.floor((env.contextWindowTokens * env.contextBudgetRatio) / 1000)}K tokens（窗口 ${Math.floor(env.contextWindowTokens / 1000)}K）`,
      )
    },
  },
  {
    name: '/memory list',
    match: (text) => text === '/memory list' || text === '/记忆列表',
    adminOnly: true,
    run: async ({ key, reply }) => {
      const items = listLongTerm(key, 20)
      if (items.length === 0) {
        await reply('长期记忆还是空的，聊到值得记的事我会自己记。')
        return
      }
      await reply(
        `长期记忆（最近 ${items.length} 条）：\n${items.map((item, index) => `${index + 1}. ${item}`).join('\n')}\n\n` +
          '要删某一条就发 /forget 关键词',
      )
    },
  },
  {
    name: '/forget',
    match: (text) => text.startsWith('/forget ') || text.startsWith('忘掉 '),
    adminOnly: true,
    run: async ({ key, text, reply }) => {
      const keyword = text.replace(/^(\/forget\s+|忘掉\s+)/, '').trim()
      if (!keyword) {
        await reply('用法：/forget 关键词，会把长期记忆里含这个词的条目删掉')
        return
      }

      const removed = forget(key, keyword)
      await reply(
        removed.length === 0
          ? `长期记忆里没有含「${keyword}」的条目。发 /memory list 看现在都记了什么。`
          : `已忘掉 ${removed.length} 条：\n${removed.map((item) => `- ${item}`).join('\n')}`,
      )
    },
  },
  {
    name: '/help',
    match: (text) => ['/help', '/帮助', '帮助'].includes(text),
    run: async ({ scope, reply, isAdminNow }) => {
      await reply(helpText(scope, isAdminNow))
    },
  },
  {
    name: '/config',
    match: (text) => text === '/config' || text === '/配置',
    adminOnly: true,
    run: async ({ reply }) => {
      await reply(configSummary())
    },
  },
  {
    name: '/task',
    match: (text) => text.startsWith('/task ') || text.startsWith('后台任务 '),
    run: async ({ event, text, key, scope, reply }) => {
      const goal = text.replace(/^(\/task\s+|后台任务\s+)/, '').trim()

      if (goal.length < 5) {
        await reply('用法：/task 目标描述，写清楚要产出什么、什么算完成')
        return
      }

      if (!isToolAllowed('start_task', scope, event.user_id ?? '')) {
        await reply(
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

        await reply(`已建工单 ${id}：${goal}\n进度会自动推过来，随时发 /tasks 查状态。`)
      } catch (error) {
        await reply(`启动失败：${error?.message ?? error}`)
      }
    },
  },
  {
    name: '/tasks',
    match: (text) => text === '/tasks' || text === '任务状态',
    run: async ({ reply }) => {
      const running = taskStatus()
      if (running.length === 0) {
        await reply('当前没有正在跑的工单。')
        return
      }

      const lines = running.map(
        (task) => `${task.id}｜第 ${task.step} 步｜已跑 ${task.elapsed} 秒｜${task.idle} 秒无新动作`,
      )
      await reply(`正在跑 ${running.length} 个工单：\n${lines.join('\n')}\n\n发 /kill <工单号> 可以终止。`)
    },
  },
  {
    name: '/clean',
    match: (text) => text === '/clean' || text === '/clean all',
    run: async ({ text, reply }) => {
      const includeDownloads = text === '/clean all'

      try {
        const result = cleanWorkspace({ includeDownloads })

        if (result.removed.length === 0) {
          const usage = workspaceStats()
            .map((item) => `${item.name}/：${item.count} 项，${(item.size / 1024).toFixed(1)} KB`)
            .join('\n')
          await reply(`没有需要清理的临时文件。\n\n当前占用：\n${usage}`)
          return
        }

        const kb = (result.freed / 1024).toFixed(1)
        const preview = result.removed.slice(0, 12).map((item) => `  ${item}`).join('\n')
        const more = result.removed.length > 12 ? `\n  …还有 ${result.removed.length - 12} 项` : ''

        await reply(
          `清理完成：删掉 ${result.removed.length} 项，释放 ${kb} KB\n${preview}${more}` +
            (includeDownloads ? '' : '\n\n（downloads 里的交付物保留了，要一起清就发 /clean all）'),
        )
      } catch (error) {
        await reply(`清理失败：${error?.message ?? error}`)
      }
    },
  },
  {
    name: '/kill',
    match: (text) => text.startsWith('/kill '),
    run: async ({ text, reply }) => {
      const id = text.slice(6).trim()
      try {
        killTask(id)
        await reply(`已请求终止 ${id}，它会在下一个检查点停下。`)
      } catch (error) {
        await reply(`终止失败：${error?.message ?? error}`)
      }
    },
  },
]

/** 依次问一遍，返回是否有人认领 */
export async function runCommand(text, ctx) {
  for (const command of COMMANDS) {
    if (!command.match(text)) continue

    if (command.adminOnly && !ctx.isAdminNow) {
      await ctx.reply('这个命令只有管理员能用（openid 要写进 .env 的 ADMIN_OPENIDS）。')
      return true
    }

    await command.run(ctx)
    return true
  }

  return false
}
