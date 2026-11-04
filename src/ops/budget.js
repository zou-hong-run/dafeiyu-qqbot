import fs from 'node:fs'
import os from 'node:os'
import { memoryInfo, platform } from './platform.js'

// 按机器实际内存算「能力边界」，别把 2G 机器的参数写死到所有机器上。
// 环境变量始终优先：用户显式设了就听用户的，没设才用这里按内存档位算出来的值。
const PROFILES = {
  tiny: { maxMB: 2300, mainHeapMB: 320, mcpHeapMB: 160, shellUlimitMB: 512, maxSendFileMB: 50, taskConcurrency: 2, heavyNeedMB: 450, rescueBelowMB: 300 },
  small: { maxMB: 5000, mainHeapMB: 512, mcpHeapMB: 224, shellUlimitMB: 768, maxSendFileMB: 80, taskConcurrency: 2, heavyNeedMB: 400, rescueBelowMB: 350 },
  medium: { maxMB: 11000, mainHeapMB: 768, mcpHeapMB: 320, shellUlimitMB: 1536, maxSendFileMB: 150, taskConcurrency: 3, heavyNeedMB: 600, rescueBelowMB: 450 },
  large: { maxMB: Infinity, mainHeapMB: 1024, mcpHeapMB: 384, shellUlimitMB: 2048, maxSendFileMB: 200, taskConcurrency: 4, heavyNeedMB: 800, rescueBelowMB: 600 },
}

export function profileName(totalMB) {
  for (const [name, profile] of Object.entries(PROFILES)) {
    if (totalMB < profile.maxMB) return name
  }
  return 'large'
}

/** 基于总内存的静态预算（启动时算一次就够） */
export function budgetFor(totalMB = memoryInfo().totalMB) {
  const name = profileName(totalMB)
  return { ...PROFILES[name], profile: name, totalMB: Math.round(totalMB) }
}

/** 运行时的状态判断：现在还能不能跑重活 */
export function runtimeState(availableMB = memoryInfo().availableMB, budget = budgetFor()) {
  if (availableMB < budget.rescueBelowMB) return 'blocked'
  if (availableMB < budget.heavyNeedMB) return 'light-only'
  return 'normal'
}

const STATE_LABEL = {
  blocked: '内存告急，只放行救援命令',
  'light-only': '只能跑轻命令，安装/转码这类会被拦',
  normal: '可以正常跑',
}

export function describeState(state) {
  return STATE_LABEL[state] ?? state
}

function diskFreeMB(dir = '.') {
  try {
    const stat = fs.statfsSync(dir)
    return Math.round((stat.bavail * stat.bsize) / (1024 * 1024))
  } catch {
    return null
  }
}


/** 给模型看的系统快照 */
export function systemSnapshot(dir = '.') {
  const info = memoryInfo()
  const budget = budgetFor(info.totalMB)
  const state = runtimeState(info.availableMB, budget)
  const free = diskFreeMB(dir)
  const load = os.loadavg()[0]

  return [
    `平台 ${platform}（${os.arch()}）｜CPU ${os.cpus().length} 核｜负载 ${load.toFixed(2)}`,
    `内存 总 ${Math.round(info.totalMB)}MB / 可用 ${Math.round(info.availableMB)}MB` +
      `｜swap ${Math.round(info.swapTotalMB ?? 0)}MB${info.precise ? '' : '（估算）'}`,
    `磁盘 ${free === null ? '读不到' : `剩余 ${(free / 1024).toFixed(1)}G`}`,
    `档位 ${budget.profile}：主进程堆 ${budget.mainHeapMB}MB｜MCP ${budget.mcpHeapMB}MB｜` +
      `单命令上限 ${budget.shellUlimitMB}MB｜单文件 ${budget.maxSendFileMB}MB｜并发 ${budget.taskConcurrency}`,
    `当前状态：${describeState(state)}`,
  ].join('\n')
}
