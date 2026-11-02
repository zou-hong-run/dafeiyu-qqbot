import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// 降噪。群里最容易被嫌弃的不是「答得不好」，是「话太多」。
// 这里管两件事：
//   1. 同一类消息在一个群里多久才能再发一条（oncePer）
//   2. 群友喊「安静」之后，那个群除了 @ 我之外全部闭嘴（mute）
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const dataDir = path.join(projectRoot, 'data')
const quietFile = path.join(dataDir, 'quiet.json')

const DEFAULT_MUTE_MINUTES = 60

const lastAt = new Map()
let muted = {}
let saveTimer = null

function load() {
  try {
    if (!fs.existsSync(quietFile)) return
    const raw = JSON.parse(fs.readFileSync(quietFile, 'utf8'))
    if (raw && typeof raw === 'object') muted = raw
  } catch (error) {
    console.error('[静音] 读取失败：', error?.message ?? error)
  }
}

function persist() {
  try {
    fs.mkdirSync(dataDir, { recursive: true })
    fs.writeFileSync(quietFile, JSON.stringify(muted))
  } catch (error) {
    console.error('[静音] 落盘失败：', error?.message ?? error)
  }
}

function saveSoon() {
  clearTimeout(saveTimer)
  saveTimer = setTimeout(persist, 500)
  saveTimer.unref?.()
}

/** 同一类消息在同一个 key 上，ms 内只放行一次。ms <= 0 表示不限 */
export function oncePer(key, ms) {
  if (!ms || ms <= 0) return true

  const now = Date.now()
  const prev = lastAt.get(key) ?? 0
  if (now - prev < ms) return false

  lastAt.set(key, now)
  if (lastAt.size > 2000) {
    for (const item of [...lastAt.keys()].slice(0, 1000)) lastAt.delete(item)
  }
  return true
}

/** 常见消息类型的节流时长（毫秒）。群里用，私聊不套 */
export const QUIET_MS = {
  progress: 45_000,
  report: 30_000,
  apology: 10 * 60_000,
  announce: 12 * 3600_000,
  proactive: 30 * 60_000,
  hotTake: 6 * 3600_000,
  followUp: 6 * 3600_000,
  emptyAt: 60_000,
}

export function isMuted(groupId) {
  const until = muted[String(groupId ?? '')] ?? 0
  if (!until) return false

  if (Date.now() > until) {
    delete muted[String(groupId)]
    saveSoon()
    return false
  }
  return true
}

export function muteGroup(groupId, minutes = DEFAULT_MUTE_MINUTES) {
  const span = Math.max(1, Math.min(24 * 60, Math.floor(minutes || DEFAULT_MUTE_MINUTES)))
  const until = Date.now() + span * 60_000
  muted[String(groupId)] = until
  saveSoon()
  return { minutes: span, until }
}

export function unmuteGroup(groupId) {
  const key = String(groupId ?? '')
  const existed = Boolean(muted[key])
  delete muted[key]
  saveSoon()
  return existed
}

export function muteRemainingMinutes(groupId) {
  const until = muted[String(groupId ?? '')] ?? 0
  if (!until || Date.now() > until) return 0
  return Math.ceil((until - Date.now()) / 60_000)
}

/** 「安静 / 别吵」这类指令：返回要静音的分钟数，不是这类指令就返回 0 */
export function parseMuteCommand(text) {
  const body = String(text ?? '').trim()
  if (!body || body.length > 20) return 0
  if (!/(安静|别吵|闭嘴|静音|小点声|少说点)/.test(body)) return 0

  const matched = body.match(/(\d{1,3})\s*(分钟|分|小时|时|h|m)?/i)
  if (!matched) return DEFAULT_MUTE_MINUTES

  const value = Number(matched[1])
  if (!Number.isFinite(value) || value <= 0) return DEFAULT_MUTE_MINUTES

  const unit = String(matched[2] ?? '').toLowerCase()
  const minutes = unit.startsWith('小时') || unit === 'h' || unit === '时' ? value * 60 : value
  return Math.max(1, Math.min(24 * 60, minutes))
}

export function isUnmuteCommand(text) {
  const body = String(text ?? '').trim()
  if (!body || body.length > 20) return false
  return /(说话吧|可以说话|别静音|取消静音|解除静音|恢复说话|不吵了)/.test(body)
}

export function flushQuiet() {
  clearTimeout(saveTimer)
  persist()
}

load()
