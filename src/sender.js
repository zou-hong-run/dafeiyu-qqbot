import { env } from './env.js'
import { bot } from './bot.js'
import { addPending } from './pending.js'

// 发送层：被动回复配额、引用气泡、Markdown 降级都收在这里
// 对外只暴露 clip / sendReply / deliver / postMessage
let markdownState = null

export function clip(text) {
  if (text.length <= env.replyMaxChars) return text
  return `${text.slice(0, env.replyMaxChars - 16)}……\n\n（内容过长，已截断）`
}

function isStaleMessage(event, ttlMs = 4 * 60_000) {
  const ts = Number(event?.timestamp) * 1000
  if (!Number.isFinite(ts) || ts <= 0) return false
  return Date.now() - ts > ttlMs
}

function endpointOf(event) {
  const isGroup = event.message_type === 'group'
  const id = isGroup ? event.group_id : event.user_id
  return {
    isGroup,
    id,
    apiPath: isGroup ? `/v2/groups/${id}/messages` : `/v2/users/${id}/messages`,
  }
}

// 引用回复要用 msg_idx（形如 REFIDX_xxx），官方只放在 message_scene.ext 里
// 默认整体关闭（QUOTE_REPLY 未设置即 false）；开成 judge 时，只有「群里冷场后我插一句」才引用
const quotedMessages = new Set()
const lastSpokeAt = new Map()

function groupKeyOf(event) {
  return event?.group_id ?? 'private'
}

function markQuote(event) {
  const id = event?.message_id
  if (!id) return

  // 3 分钟内这个群我刚说过话，说明还在对话中，不盖引用气泡
  const since = Date.now() - (lastSpokeAt.get(groupKeyOf(event)) ?? 0)
  if (since < env.quoteWindowMs) return

  quotedMessages.add(id)
  if (quotedMessages.size > 500) {
    for (const key of [...quotedMessages].slice(0, 250)) quotedMessages.delete(key)
  }
}

function noteSpoke(event) {
  lastSpokeAt.set(groupKeyOf(event), Date.now())

  if (lastSpokeAt.size > 500) {
    for (const key of [...lastSpokeAt.keys()].slice(0, 250)) lastSpokeAt.delete(key)
  }
}

function shouldQuote(event) {
  if (!env.quoteReply) return false
  if (env.quoteReply === 'always') return true
  return quotedMessages.has(event?.message_id)
}

// 从 message_scene.ext 里取本条消息的 msg_idx（形如 REFIDX_xxx），引用索引靠它对齐
export function extractMsgIdx(event) {
  const ext = event?.message_scene?.ext
  if (!ext) return ''

  for (const item of Array.isArray(ext) ? ext : [ext]) {
    if (typeof item === 'string') {
      const matched = item.match(/msg_idx=([^\s&]+)/)
      if (matched) return matched[1]
    } else if (item && typeof item === 'object' && item.msg_idx) {
      return String(item.msg_idx)
    }
  }

  return ''
}

function quoteRefOf(event) {
  if (!shouldQuote(event)) return null
  return extractMsgIdx(event) || null
}

const passiveUsed = new Map()
const MAX_PASSIVE_PER_MESSAGE = 4

export function passiveCountOf(event) {
  return passiveUsed.get(event?.message_id) ?? 0
}

function canUsePassive(event) {
  if (!event?.message_id) return false
  if (isStaleMessage(event)) return false
  return passiveCountOf(event) < MAX_PASSIVE_PER_MESSAGE
}

function notePassive(event) {
  const id = event?.message_id
  if (!id) return

  passiveUsed.set(id, passiveCountOf(event) + 1)

  if (passiveUsed.size > 500) {
    for (const key of [...passiveUsed.keys()].slice(0, 250)) passiveUsed.delete(key)
  }
}

export async function deliver(event, payload) {
  console.log(`[发送诊断] deliver passive=${canUsePassive(event)} reply=${typeof event?.reply}`)
  if (canUsePassive(event)) {
    try {
      await event.reply.call(event, payload)
      notePassive(event)
      return
    } catch (error) {
      const message = String(error?.message ?? error)
      if (!/40034128|40034005|过期|超限|超过限制/.test(message)) throw error
      console.warn(`[回复] 被动回复不可用（${message.slice(0, 40)}），改主动消息`)
    }
  }

  if (event.message_type === 'group') await bot.group(event.group_id).send(payload)
  else await bot.user(event.user_id).send(payload)
}

export async function postMessage(event, body, { reference = true } = {}) {
  const { apiPath } = endpointOf(event)
  const usePassive = canUsePassive(event)

  // 引用只能挂在被动回复上：主动消息没有可引用的会话上下文
  const ref = usePassive && reference ? quoteRefOf(event) : null
  if (ref) body.message_reference = { message_id: ref }

  if (ref) {
    if (env.toolDebug) console.log(`[引用] REFIDX ${ref.slice(0, 18)}…`)
  } else if (shouldQuote(event) && env.toolDebug) {
    console.log('[引用] 本轮该引用但没取到 msg_idx，本条不带引用')
  }

  if (usePassive) {
    body.msg_id = event.message_id
    body.msg_seq = passiveCountOf(event) + 1
  }

  try {
    await bot.request.post(apiPath, body)
    if (usePassive) notePassive(event)
  } catch (error) {
    const message = String(error?.message ?? error)
    if (!usePassive || !/40034128|40034005|过期|超限|超过限制/.test(message)) throw error

    console.warn(`[回复] 被动回复不可用（${message.slice(0, 40)}），改主动消息`)
    delete body.msg_id
    delete body.msg_seq
    delete body.message_reference
    await bot.request.post(apiPath, body)
  }
}

async function sendMarkdownMessage(event, content) {
  try {
    await postMessage(event, { msg_type: 2, markdown: { content } })
    return true
  } catch (error) {
    const message = String(error?.message ?? error)

    if (/304036|40034127|markdown 模板权限|无markdown/i.test(message)) {
      markdownState = false
      console.warn('[Markdown] 平台未开放 Markdown 权限，永久降级为纯文本')
      return false
    }

    if (/40034008|40034124|40034011/.test(message)) {
      console.warn(`[Markdown] 参数被拒（${message.slice(0, 60)}），本次改用纯文本`)
      return false
    }

    throw error
  }
}


// 长文本切分：优先在换行 / 句末 / 逗号处断开，尽量不切断词句
export function chunkText(text, limit = Math.max(200, env.replyMaxChars)) {
  const raw = String(text ?? '').trim()
  if (!raw) return []
  if (raw.length <= limit) return [raw]

  const parts = []
  let buf = ''
  const flush = () => {
    const piece = buf.trim()
    if (piece) parts.push(piece)
    buf = ''
  }

  for (const line of raw.split('\n')) {
    let rest = `${line}\n`
    while (rest.length > 0) {
      const room = limit - buf.length
      if (rest.length <= room) {
        buf += rest
        break
      }
      const win = rest.slice(0, room)
      let cut = Math.max(
        win.lastIndexOf('\n'),
        win.lastIndexOf('。'), win.lastIndexOf('！'), win.lastIndexOf('？'), win.lastIndexOf('；'),
        win.lastIndexOf('. '), win.lastIndexOf('，'), win.lastIndexOf(' '),
      )
      cut = cut > room * 0.35 ? cut + 1 : room
      buf += rest.slice(0, cut)
      flush()
      rest = rest.slice(cut)
    }
  }
  flush()
  return parts
}

// 超长回复拆成多条发，不再截断
export async function sendLongReply(event, text, { maxParts = 6, gapMs = 600 } = {}) {
  const parts = chunkText(text)
  if (parts.length === 0) return
  if (parts.length === 1) {
    await sendReply(event, parts[0])
    return
  }

  let list = parts
  if (parts.length > maxParts) {
    list = parts.slice(0, maxParts)
    const rest = parts.slice(maxParts)
    addPending(event, rest)
    list[maxParts - 1] += `\n\n（还有 ${rest.length} 段，说「接着发」我继续）`
  }

  for (let i = 0; i < list.length; i += 1) {
    if (i > 0) await new Promise((resolve) => setTimeout(resolve, gapMs))
    try {
      await sendReply(event, list[i])
    } catch (error) {
      console.warn(`[发送] 第 ${i + 1}/${list.length} 段失败：`, error?.message ?? error)
    }
  }
}

export async function sendReply(event, text) {
  const body = clip(String(text ?? '').trim())
  if (!body) return

  try {
    if (env.markdownReply && markdownState !== false) {
      const sent = await sendMarkdownMessage(event, body)
      if (sent) return
    }

    if (quoteRefOf(event)) {
      try {
        await postMessage(event, { msg_type: 0, content: body })
        return
      } catch (error) {
        console.warn(`[引用] 引用回复失败（${String(error?.message ?? error).slice(0, 60)}），改普通回复`)
      }
    }

    await deliver(event, body)
  } finally {
    noteSpoke(event)
  }
}
