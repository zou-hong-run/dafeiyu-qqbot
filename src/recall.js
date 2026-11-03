import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { bot } from './bot.js'

// 撤回：先把「我发出去的消息」记下来（QQ 撤回要 message_id，事后拿不到），
// 再按 id 调官方 DELETE 接口。只撤自己发的，别人的动不了。
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const dataDir = path.join(projectRoot, 'data')
const logFile = path.join(dataDir, 'sent-messages.jsonl')
const MAX_KEEP = 200

let entries = []
let loaded = false

function ensureLoaded() {
  if (loaded) return
  loaded = true
  try {
    const raw = fs.readFileSync(logFile, 'utf8')
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue
      try {
        entries.push(JSON.parse(line))
      } catch {
        /* 半行坏数据跳过 */
      }
    }
  } catch {
    /* 第一次跑还没有文件 */
  }
  if (entries.length > MAX_KEEP) entries = entries.slice(-MAX_KEEP)
}

function persist() {
  try {
    fs.mkdirSync(dataDir, { recursive: true })
    fs.writeFileSync(logFile, `${entries.map((item) => JSON.stringify(item)).join('\n')}\n`)
  } catch (error) {
    console.warn('[撤回] 记录写出失败：', error?.message ?? error)
  }
}

function endpointOfEvent(event) {
  const isGroup = event?.message_type === 'group'
  return { isGroup, target: (isGroup ? event?.group_id : event?.user_id) ?? '' }
}

// 每发出一条消息都调一次；拿不到 id 就跳过，不影响发送本身
export function noteSent(event, messageId, text, kind = 'text') {
  const id = String(messageId ?? '').trim()
  if (!id) return

  const { isGroup, target } = endpointOfEvent(event)
  if (!target) return

  ensureLoaded()
  entries.push({
    t: Date.now(),
    kind: isGroup ? 'group' : 'user',
    target,
    messageId: id,
    media: kind,
    preview: String(text ?? '').replace(/\s+/g, ' ').slice(0, 60),
    recalled: false,
  })
  if (entries.length > MAX_KEEP) entries = entries.slice(-MAX_KEEP)
  persist()
}

// 主动发到别的群时没有 event，单独记一条：群消息，target 就是群 openid
export function noteSentToGroup(groupId, messageId, text, kind = 'text') {
  const id = String(messageId ?? '').trim()
  const target = String(groupId ?? '').trim()
  if (!id || !target) return
  noteSent({ message_type: 'group', group_id: target }, id, text, kind)
}

// groupId 传了就按那个群算，不传就看当前会话
function endpointOf(event, groupId = '') {
  const gid = String(groupId ?? '').trim()
  if (gid) return { isGroup: true, target: gid }
  return endpointOfEvent(event)
}

function poolOf(event, limit = 5, groupId = '') {
  ensureLoaded()
  const { isGroup, target } = endpointOf(event, groupId)
  const kind = isGroup ? 'group' : 'user'
  return entries
    .filter((item) => item.kind === kind && item.target === target)
    .slice(-Math.max(1, limit))
    .reverse()
}

export function listSent(event, limit = 5) {
  return poolOf(event, limit)
}

async function recallOne(entry) {
  if (entry.kind === 'group') return bot.recallGroupMessage(entry.target, entry.messageId)
  return bot.recallPrivateMessage(entry.target, entry.messageId)
}

function describe(item) {
  const time = new Date(item.t).toLocaleTimeString('zh-CN', { hour12: false })
  return `${time} ${item.media === 'text' ? '' : `[${item.media}]`}${item.preview || '（无预览）'}`
}

// 不传 messageId 就撤最近的 count 条（默认撤最后一条）
// groupId 用来撤「我主动发到别的群」的那条：当前会话不是那个群时也能定位
export async function recallMessages({ event, messageId = '', count = 1, groupId = '' } = {}) {
  ensureLoaded()

  const queue = []
  const wanted = String(messageId ?? '').trim()
  const { isGroup, target } = endpointOf(event, groupId)

  if (wanted) {
    const hit = entries.find((item) => item.messageId === wanted)
    queue.push(
      hit ?? {
        t: Date.now(),
        kind: isGroup ? 'group' : 'user',
        target,
        messageId: wanted,
        media: 'text',
        preview: '',
        recalled: false,
      },
    )
  } else {
    if (!target) {
      return '没拿到要撤的会话或群 id，撤不了。如果是在别的群发的，把 group_id 一起给我。'
    }
    const pool = poolOf(event, 20, groupId).filter((item) => !item.recalled)
    if (pool.length === 0) {
      return groupId
        ? `我在群 ${groupId} 没有发出去的消息记录，撤不了。记录只保留最近 200 条。`
        : '这个会话里没有我发出去的消息记录，撤不了。记录只保留最近 200 条，重启也不丢。'
    }
    const n = Math.max(1, Math.min(5, Number(count) || 1))
    queue.push(...pool.slice(0, n))
  }

  const done = []
  const failed = []

  for (const item of queue) {
    try {
      await recallOne(item)
      item.recalled = true
      done.push(describe(item))
    } catch (error) {
      failed.push(`${describe(item)} → ${error?.message ?? error}`)
    }
  }

  if (done.length > 0) persist()

  const lines = []
  if (done.length > 0) lines.push(`撤回成功 ${done.length} 条：\n${done.join('\n')}`)
  if (failed.length > 0) {
    lines.push(`撤回失败 ${failed.length} 条：\n${failed.join('\n')}`)
    lines.push('失败常见原因：超过平台允许的撤回时间、这条不是我发的、或者接口没给这个权限。')
  }
  return lines.join('\n\n') || '没有可撤回的消息。'
}
