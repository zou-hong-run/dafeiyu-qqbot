import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import { config } from 'dotenv'
import { personaName, personaPrompt } from '../chat/persona.js'
import { budgetFor } from '../ops/budget.js'
import { defaultEnvFile } from '../ops/platform.js'

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

// 密钥文件优先从项目外读（Linux 是 /etc/dafeiyu/env，macOS/Windows 各有默认位置），
// 项目根的 .env 只做兜底。这样即使有人拿到项目目录的读写权限，也读不到密钥。
const EXTERNAL_ENV = process.env.APP_ENV_FILE?.trim() || defaultEnvFile()
config({ path: [EXTERNAL_ENV, path.join(projectRoot, '.env')], quiet: true })

function pick(...names) {
  for (const name of names) {
    const value = process.env[name]?.trim()
    if (value) return value
  }
  return ''
}

function positiveNumber(name, fallback) {
  const value = Number(process.env[name])
  return Number.isFinite(value) && value > 0 ? value : fallback
}

function nonNegativeNumber(name, fallback) {
  const raw = process.env[name]?.trim()
  if (raw === undefined || raw === '') return fallback
  const value = Number(raw)
  return Number.isFinite(value) && value >= 0 ? value : fallback
}

const apiKey = pick('DEEP_SEEK_API_KEY', 'DEEPSEEK_API_KEY', 'API_KEY')
const appId = pick('QQ_APP_ID', 'QQBOT_APP_ID')
const appSecret = pick('QQ_APP_SECRET', 'QQBOT_APP_SECRET')

const missing = []
if (!apiKey) missing.push('DEEP_SEEK_API_KEY')
if (!appId) missing.push('QQ_APP_ID')
if (!appSecret) missing.push('QQ_APP_SECRET')

if (missing.length > 0) {
  console.error(`[配置] 缺少环境变量：${missing.join('、')}`)
  console.error('       请在 .env 中补齐后重新启动。')
  process.exit(1)
}

if (appSecret.length < 16) {
  console.error(`[配置] QQ_APP_SECRET 只有 ${appSecret.length} 个字符，看起来没复制完整。`)
  console.error('       QQ 开放平台的 AppSecret 是 32 位字符，请回到「开发管理」重新复制。')
  process.exit(1)
}

const budget = budgetFor()

const customPrompt = process.env.SYSTEM_PROMPT?.trim()

export const env = {
  appId,
  appSecret,

  apiKey,
  baseURL: process.env.DEEPSEEK_BASE_URL?.trim() || 'https://api.deepseek.com',
  // deepseek-flash = V4.1-Flash，原生支持图片理解；老模型不认识图片，发图会自动降级
  model: process.env.DEEPSEEK_MODEL?.trim() || 'deepseek-flash',

  personaName: customPrompt ? '自定义' : personaName,
  systemPrompt: customPrompt || personaPrompt,

  toolsEnabled: process.env.ENABLE_TOOLS !== 'false',
  groupToolsEnabled: process.env.GROUP_TOOLS !== 'false',
  // 高危工具（shell / run_script / write_file / install_package / add_mcp）的白名单
  // 配了就只有这些 openid 能用（私聊和群聊都算）；不配则群里禁用、私聊放开
  adminOpenIds: (process.env.ADMIN_OPENIDS ?? '')
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean),
  // 兜底开关：白名单为空时，把它设成 true 才会允许群里用高危工具（默认关）
  shellGroupEnabled: process.env.SHELL_GROUP_ENABLED === 'true',
  // 详细日志默认关：每一轮工具调用都会打参数和返回，长期开日志会长得很快
  toolDebug: process.env.TOOL_DEBUG === 'true',

  taskMaxRounds: Math.floor(positiveNumber('TASK_MAX_ROUNDS', 20)),
  // 允许设成 0：关掉验收不过时的自动续跑
  taskMaxContinuations: Math.floor(nonNegativeNumber('TASK_MAX_CONTINUATIONS', 3)),
  taskStallMs: positiveNumber('TASK_STALL_SECONDS', 300) * 1000,
  taskReportInterval: positiveNumber('TASK_REPORT_INTERVAL', 60) * 1000,
  taskMaxReports: Math.floor(positiveNumber('TASK_MAX_REPORTS', 3)),
  // 2G 内存：每个 Worker 都是一个跑着 ReAct 循环的会话，同时开太多会直接 OOM
  taskConcurrency: Math.floor(positiveNumber('TASK_CONCURRENCY', budget.taskConcurrency)),
  // 一轮对话最多调几轮工具。默认 12 够用；设太大在 2G 机器上会把内存和额度一起吃穿
  maxToolRounds: Math.floor(positiveNumber('MAX_TOOL_ROUNDS', 12)),
  maxOutputTokens: Math.floor(positiveNumber('MAX_OUTPUT_TOKENS', 8192)),
  progressInterval: positiveNumber('PROGRESS_INTERVAL', 25) * 1000,
  progressMax: Math.floor(positiveNumber('PROGRESS_MAX', 3)),
  toolTimeoutMs: positiveNumber('TOOL_TIMEOUT_SECONDS', 60) * 1000,

  historyTurns: Math.floor(positiveNumber('HISTORY_TURNS', 8)),
  // DeepSeek 的上下文窗口是 128K，默认按它算预算；换模型时改这里
  contextWindowTokens: Math.floor(positiveNumber('CONTEXT_WINDOW_TOKENS', 128000)),
  contextBudgetRatio: positiveNumber('CONTEXT_BUDGET_RATIO', 0.6),
  maxInputChars: Math.floor(positiveNumber('MAX_INPUT_CHARS', 1000)),
  replyMaxChars: Math.floor(positiveNumber('REPLY_MAX_CHARS', 900)),
  markdownReply: process.env.MARKDOWN_REPLY === 'true',
  // 私聊流式默认关：QQ 的 /stream_messages 要单独申请权限，没开通时每次都会失败一次
  streamReply: process.env.STREAM_REPLY === 'true',
  // false=从不引用（默认）；judge=只在真正插话时引用；always=每条都引用
  quoteReply: (() => {
    const raw = (process.env.QUOTE_REPLY ?? '').trim().toLowerCase()
    if (!raw || ['false', 'off', '0', 'no'].includes(raw)) return false
    if (['always', 'true', '1', 'yes', 'on'].includes(raw)) return 'always'
    return 'judge'
  })(),
  // judge 模式下，跟同一个人 N 秒内已经来回过，就不再加引用气泡
  quoteWindowMs: nonNegativeNumber('QUOTE_WINDOW_SECONDS', 180) * 1000,
  sessionTtlMs: positiveNumber('SESSION_TTL_MINUTES', 30) * 60 * 1000,
  botAliases: (process.env.BOT_ALIASES?.trim() || '大肥鱼,鱼鱼,万能大肥鱼')
    .split(',')
    .map((alias) => alias.trim())
    .filter(Boolean),
  groupAutoReply: process.env.GROUP_AUTO_REPLY !== 'false',
  groupTriggerCooldown: nonNegativeNumber('GROUP_TRIGGER_COOLDOWN', 0) * 1000,

  // 是否自动判断该不该插话：off / observe（只看不动）/ auto
  // 旧变量 GROUP_JUDGE=true 等价 auto；新变量 JUDGE_MODE 优先
  judgeMode: (() => {
    const raw = (process.env.JUDGE_MODE ?? '').trim().toLowerCase()
    if (['off', 'observe', 'auto'].includes(raw)) return raw
    return process.env.GROUP_JUDGE === 'true' ? 'auto' : 'off'
  })(),
  groupJudge: (() => {
    const raw = (process.env.JUDGE_MODE ?? '').trim().toLowerCase()
    if (['off', 'observe', 'auto'].includes(raw)) return raw !== 'off'
    return process.env.GROUP_JUDGE === 'true'
  })(),
  judgeDebounceMs: positiveNumber('JUDGE_DEBOUNCE_MS', 3000),
  judgeMaxWaitMs: positiveNumber('JUDGE_MAX_WAIT_MS', 10000),
  judgeContextSize: Math.floor(positiveNumber('JUDGE_CONTEXT_SIZE', 10)),
  judgeCooldown: nonNegativeNumber('JUDGE_COOLDOWN', 0) * 1000,
  judgeMinLength: Math.floor(positiveNumber('JUDGE_MIN_LENGTH', 2)),
  judgeHourlyLimit: Math.floor(positiveNumber('JUDGE_HOURLY_LIMIT', 120)),

  // 连发合并窗口：同一个人连着发的几句合成一次理解，0 = 关闭（逐条处理）
  mergeWindowMs: nonNegativeNumber('MERGE_WINDOW_MS', 2500),

  // 退出前自动把改过的代码提交回仓库（「自己进化」靠它）；间隔 0 = 只靠退出时提交
  autoSyncOnExit: process.env.AUTO_SYNC_ON_EXIT !== 'false',
  autoSyncIntervalMinutes: nonNegativeNumber('AUTO_SYNC_INTERVAL_MINUTES', 30),
  // 收到的图片/语音/文件留多久（小时），到点自动删
  mediaTtlHours: positiveNumber('MEDIA_TTL_HOURS', 24),

  groupLogLimit: Math.floor(positiveNumber('GROUP_LOG_LIMIT', 600)),
  summaryLimit: Math.floor(positiveNumber('SUMMARY_LIMIT', 200)),
  summaryCooldown: nonNegativeNumber('SUMMARY_COOLDOWN', 0) * 1000,

  // 下面几组原来散在各个文件里读 process.env，默认值也散着写。
  // 收到这里统一给默认，启动时打一份摘要，不配也知道自己在跑什么。
  proactive: {
    enabled: process.env.PROACTIVE_ENABLED !== 'false',
    intervalMinutes: positiveNumber('PROACTIVE_INTERVAL_MINUTES', 5),
    maxPerHour: Math.floor(positiveNumber('PROACTIVE_MAX_PER_HOUR', 2)),
    cooldownMinutes: nonNegativeNumber('PROACTIVE_COOLDOWN_MINUTES', 20),
    quietStart: Math.floor(nonNegativeNumber('PROACTIVE_QUIET_START', 23)),
    quietEnd: Math.floor(nonNegativeNumber('PROACTIVE_QUIET_END', 8)),
  },
  followup: {
    enabled: process.env.FOLLOWUP_ENABLED !== 'false',
    intervalMinutes: positiveNumber('FOLLOWUP_INTERVAL_MINUTES', 60),
    minAgeHours: positiveNumber('FOLLOWUP_MIN_AGE_HOURS', 6),
    quietStart: Math.floor(nonNegativeNumber('FOLLOWUP_QUIET_START', 23)),
    quietEnd: Math.floor(nonNegativeNumber('FOLLOWUP_QUIET_END', 8)),
  },
  hotTake: {
    enabled: process.env.HOT_TAKE_ENABLED === 'true',
    cron: process.env.HOT_TAKE_CRON?.trim() || '0 12,20 * * *',
    target: process.env.HOT_TAKE_TARGET?.trim() || '',
  },

  logLevel: process.env.LOG_LEVEL?.trim() || 'info',
}
