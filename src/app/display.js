import { getTools } from '../mcp/client.js'
import { env } from '../config/env.js'
import { listBackups } from '../ops/backup.js'
import { caps, describePlatform, memoryInfo } from '../ops/platform.js'
import { sandboxSelfTest } from '../mcp-server/sandbox.js'
import { budgetFor } from '../ops/budget.js'

// /config：把当前生效的配置列出来，不配 .env 时也能看清自己在跑什么
export function configSummary() {
  const tools = getTools()
  const mem = (() => {
    const info = memoryInfo()
    if (!info?.totalMB) return '读不到（非 Linux 且没有系统信息）'
    return `总 ${Math.round(info.totalMB)}MB / 可用 ${Math.round(info.availableMB)}MB`
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
export function helpText(scope, admin) {
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


// 2C2G 小机器：启动时把内存账算清楚，出问题好对照
export function reportMemory() {
  try {
    const info = memoryInfo()
    const budget = budgetFor(info.totalMB)
    const total = Math.round(info.totalMB)
    const available = Math.round(info.availableMB)
    const swap = Math.round(info.swapTotalMB ?? 0)
    if (!total) return

    console.log(
      `[内存] 总计 ${(total / 1024).toFixed(1)}G｜可用 ${available}MB｜swap ${(swap / 1024).toFixed(1)}G` +
        `${info.precise ? '' : '（非 Linux，用系统余量估算）'}`,
    )
    console.log(`[平台] ${describePlatform(sandboxSelfTest())}`)
    console.log(
      `[内存] 预算（${budget.profile} 档）：主进程堆 ${process.env.MAIN_HEAP_MB || budget.mainHeapMB}MB + MCP ${process.env.MCP_HEAP_MB || budget.mcpHeapMB}MB，` +
        `${caps.canUlimit ? `单条命令上限 ${process.env.SHELL_ULIMIT_MB || 512}MB` : '不限制单条命令内存（该平台无 ulimit）'}，命令预估安全线 ${Math.max(120, Math.floor(available * 0.75))}MB，` +
        `同时最多 ${env.taskConcurrency} 个工单`,
    )

    if (available < 300) {
      console.warn(`[内存] 可用只剩 ${available}MB：低于 300MB 时所有 shell 命令都会被拒绝，只剩救援命令`)
    } else if (available < 500) {
      console.warn(`[内存] 可用 ${available}MB，偏紧：重命令会被预估拦截，先腾内存或加 swap`)
    }
    if (swap < 512 && caps.canUlimit) {
      // 只有 Linux 才有这套 swap 玩法，macOS/Windows 用系统自己的虚拟内存
      console.warn(
        '[内存] 没有 swap，一个大命令就可能把整机 OOM 掉。建议：' +
          'fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile',
      )
    }
  } catch {
    // 非 Linux 或读不到，跳过
  }
}
