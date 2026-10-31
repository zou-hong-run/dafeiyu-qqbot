import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { config } from 'dotenv'
import { personaName, personaPrompt } from './persona.js'

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
config({ path: path.join(projectRoot, '.env'), quiet: true })

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

const customPrompt = process.env.SYSTEM_PROMPT?.trim()

export const env = {
  appId,
  appSecret,

  apiKey,
  baseURL: process.env.DEEPSEEK_BASE_URL?.trim() || 'https://api.deepseek.com',
  model: process.env.DEEPSEEK_MODEL?.trim() || 'deepseek-chat',

  personaName: customPrompt ? '自定义' : personaName,
  systemPrompt: customPrompt || personaPrompt,

  toolsEnabled: process.env.ENABLE_TOOLS !== 'false',
  groupToolsEnabled: process.env.GROUP_TOOLS !== 'false',
  shellGroupEnabled: process.env.SHELL_GROUP_ENABLED !== 'false',
  maxToolRounds: Math.floor(positiveNumber('MAX_TOOL_ROUNDS', 3)),
  toolTimeoutMs: positiveNumber('TOOL_TIMEOUT_SECONDS', 30) * 1000,

  historyTurns: Math.floor(positiveNumber('HISTORY_TURNS', 8)),
  maxInputChars: Math.floor(positiveNumber('MAX_INPUT_CHARS', 1000)),
  replyMaxChars: Math.floor(positiveNumber('REPLY_MAX_CHARS', 900)),
  sessionTtlMs: positiveNumber('SESSION_TTL_MINUTES', 30) * 60 * 1000,
  botAliases: (process.env.BOT_ALIASES?.trim() || '大肥鱼,鱼鱼,万能大肥鱼')
    .split(',')
    .map((alias) => alias.trim())
    .filter(Boolean),
  groupAutoReply: process.env.GROUP_AUTO_REPLY !== 'false',
  groupTriggerCooldown: nonNegativeNumber('GROUP_TRIGGER_COOLDOWN', 0) * 1000,

  groupJudge: process.env.GROUP_JUDGE !== 'false',
  judgeDebounceMs: positiveNumber('JUDGE_DEBOUNCE_MS', 3000),
  judgeMaxWaitMs: positiveNumber('JUDGE_MAX_WAIT_MS', 10000),
  judgeContextSize: Math.floor(positiveNumber('JUDGE_CONTEXT_SIZE', 10)),
  judgeCooldown: nonNegativeNumber('JUDGE_COOLDOWN', 0) * 1000,
  judgeMinLength: Math.floor(positiveNumber('JUDGE_MIN_LENGTH', 2)),
  judgeHourlyLimit: Math.floor(positiveNumber('JUDGE_HOURLY_LIMIT', 120)),

  groupLogLimit: Math.floor(positiveNumber('GROUP_LOG_LIMIT', 600)),
  summaryLimit: Math.floor(positiveNumber('SUMMARY_LIMIT', 200)),
  summaryCooldown: nonNegativeNumber('SUMMARY_COOLDOWN', 0) * 1000,

  logLevel: process.env.LOG_LEVEL?.trim() || 'info',
}
