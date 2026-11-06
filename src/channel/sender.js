import { env } from '../config/env.js'
import { sendGroup, sendPrivate, openPrivateStream, postRaw } from '../bot.js'
import { sanitizeText } from './qq.js'
import { addPending } from '../chat/pending.js'
import { noteSent } from './recall.js'

// 发送层：被动回复配额、引用气泡、Markdown 降级都收在这里
// 对外只暴露 clip / sendReply / deliver / postMessage
let markdownState = null

// 平台明确说「不支持 markdown」的错误码。命中就不再尝试，避免每条消息都白跑一次。
const MARKDOWN_UNAVAILABLE = /304036|40034127|markdown\s*(模板)?\s*权限|无\s*markdown/i

// 撤回要 message_id，而发送接口的返回值以前被直接丢掉了，这里统一捞一次。
// 不同接口返回结构不完全一致：可能是 { id }、{ data: { id } }，取不到就返回空串，不影响发送。
export function pickMessageId(result) {
  const candidates = [
    result?.id,
    result?.data?.id,
    result?.message_id,
    result?.data?.message_id,
  ]
  for (const item of candidates) {
    const id = String(item ?? '').trim()
    if (id) return id
  }
  return ''
}

function textOf(payload) {
  if (typeof payload === 'string') return payload
  const raw = payload?.content ?? payload?.markdown?.content ?? payload?.text ?? ''
  return typeof raw === 'string' ? raw : ''
}

function kindOf(payload) {
  if (typeof payload === 'string') return 'text'
  if (payload?.image) return 'image'
  if (payload?.voice) return 'audio'
  if (payload?.video) return 'video'
  if (payload?.file) return 'file'
  return 'text'
}

function rememberSent(event, result, payload) {
  const id = pickMessageId(result)
  if (!id) {
    if (env.toolDebug) console.log('[撤回] 这条没拿到 message_id，未记录')
    return
  }
  noteSent(event, id, textOf(payload), kindOf(payload))
}

export function clip(text) {
  if (text.length <= env.replyMaxChars) return text
  return `${text.slice(0, env.replyMaxChars - 16)}……\n\n（内容过长，已截断）`
}

export function isStaleMessage(event, ttlMs = 4 * 60_000) {
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

export function markQuote(event) {
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

// 同一条消息还能被动回复几条。QQ 官方限制一条消息最多回 4 条，
// 超了就只能发主动消息，而群里主动消息基本发不出去——所以长回复要按这个余量切
function passiveRemaining(event) {
  if (!event?.message_id || isStaleMessage(event)) return 0
  return Math.max(0, MAX_PASSIVE_PER_MESSAGE - passiveCountOf(event))
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

// QQ 接口会限流（发太快）、偶尔 5xx。这类错误重试一次通常就好了，
// 不重试的话表现就是「用户看到一句没头没尾的回复」或者「什么都没发出来」
const RATE_LIMIT_PATTERN = /429|频率|频繁|rate limit|too many|too frequent/i
const TRANSIENT_PATTERN = /50\d|server error|bad gateway|timed? ?out|ECONNRESET|ETIMEDOUT|socket hang up|fetch failed/i

export async function withSendRetry(task, label = '发送') {
  try {
    return await task()
  } catch (error) {
    const message = String(error?.message ?? error)
    const rateLimited = RATE_LIMIT_PATTERN.test(message)
    const transient = TRANSIENT_PATTERN.test(message)
    if (!rateLimited && !transient) throw error

    const wait = rateLimited ? 1500 : 800
    console.warn(
      `[发送] ${label}失败（${rateLimited ? '被限流' : '临时错误'}），${wait}ms 后重试一次：${message.slice(0, 60)}`,
    )
    await new Promise((resolve) => setTimeout(resolve, wait))
    return task()
  }
}

export async function deliver(event, payload) {
  if (canUsePassive(event)) {
    try {
      const result = await withSendRetry(() => event.reply.call(event, payload), '被动回复')
      notePassive(event)
      rememberSent(event, result, payload)
      return
    } catch (error) {
      const message = String(error?.message ?? error)
      if (!/40034128|40034005|过期|超限|超过限制/.test(message)) throw error
      console.warn(`[回复] 被动回复不可用（${message.slice(0, 40)}），改主动消息`)
    }
  }

  if (event.message_type === 'group') {
    const result = await withSendRetry(() => sendGroup(event.group_id, payload), '群消息')
    rememberSent(event, result, payload)
  } else {
    const result = await withSendRetry(() => sendPrivate(event.user_id, payload), '私聊消息')
    rememberSent(event, result, payload)
  }
}

export async function postMessage(event, body, { reference = true } = {}) {
  const { apiPath } = endpointOf(event)
  const usePassive = canUsePassive(event)

  // 出站最后一道：用户原文里的 <qqbot-at-user> / <qqbot-at-everyone> / <emoji:1>
  // 被平台当真标签解析。这条路（markdown 回复、引用回复、媒体卡片）不经过
  // qq.js 的 flatten()，所以在这里统一剥一遍。
  // 合法的 @ 标签由 flatten() 生成、走 dispatch()，不受影响。
  if (typeof body?.content === 'string') body.content = sanitizeText(body.content)
  if (typeof body?.markdown?.content === 'string') {
    body.markdown.content = sanitizeText(body.markdown.content)
  }

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
    const result = await withSendRetry(() => postRaw(event.message_type === 'group' ? 'group' : 'c2c', endpointOf(event).id, body), '接口发送')
    rememberSent(event, result, body)
    if (usePassive) notePassive(event)
  } catch (error) {
    const message = String(error?.message ?? error)
    if (!usePassive || !/40034128|40034005|过期|超限|超过限制/.test(message)) throw error

    console.warn(`[回复] 被动回复不可用（${message.slice(0, 40)}），改主动消息`)
    delete body.msg_id
    delete body.msg_seq
    delete body.message_reference
    const fallback = await withSendRetry(() => postRaw(event.message_type === 'group' ? 'group' : 'c2c', endpointOf(event).id, body), '主动发送')
    rememberSent(event, fallback, body)
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
/**
 * 按「块」切分 markdown 文本。
 *
 * 不能用 chunkText：它按行和句子切，会把列表、引用、加粗符号从中间劈开，
 * 结果就是一条消息里出现半截 ** 和断掉的列表。
 * 这里以空行（段落边界）为最小单位，尽量让每段是完整的 markdown 结构。
 */
export function splitMarkdown(text, limit = Math.max(200, env.replyMaxChars)) {
  const blocks = String(text ?? '')
    .split(/\n{2,}/)
    .map((block) => block.trim())
    .filter(Boolean)

  if (blocks.length === 0) return []

  const parts = []
  let current = ''

  for (const block of blocks) {
    const candidate = current ? `${current}\n\n${block}` : block
    if (current && candidate.length > limit) {
      parts.push(current)
      current = block
    } else {
      current = candidate
    }
  }
  if (current) parts.push(current)

  // 某一块本身就超长（比如一大段没有空行的文字），只能硬切
  return parts.flatMap((part) => {
    if (part.length <= limit) return [part]
    const chunks = []
    for (let i = 0; i < part.length; i += limit) chunks.push(part.slice(i, i + limit))
    return chunks
  })
}

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
        win.lastIndexOf('。'),
        win.lastIndexOf('！'),
        win.lastIndexOf('？'),
        win.lastIndexOf('；'),
        win.lastIndexOf('. '),
        win.lastIndexOf('，'),
        win.lastIndexOf(' '),
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

// 超长回复拆成多条发，不再截断；超出的段存起来，等用户说「接着发」
export async function sendLongReply(event, text, { maxParts = 6, gapMs = 600 } = {}) {
  const parts = chunkText(text)
  if (parts.length === 0) return
  if (parts.length === 1) {
    // 私聊单条长回复走流式接口：内容一小截一小截出现，不用干等一整块
    if (await sendStreamReply(event, parts[0])) return
    await sendReply(event, parts[0])
    return
  }

  // 一条消息最多被动回复 4 次，前面进度提示已经用掉一些；留 1 条余量给「还有 N 段」那句
  const budget = passiveRemaining(event)
  const limit = Math.max(1, Math.min(maxParts, budget > 0 ? budget - 1 : 1))

  if (budget === 0) {
    console.warn('[发送] 这条消息的被动回复额度已经用尽，只发第一段，剩下的存起来等「接着发」')
  }

  let list = parts
  if (parts.length > limit) {
    list = parts.slice(0, limit)
    const rest = parts.slice(limit)
    addPending(event, rest)
    list[limit - 1] += `\n\n（还有 ${rest.length} 段，说「接着发」我继续）`
  }

  for (let i = 0; i < list.length; i += 1) {
    if (i > 0) await new Promise((resolve) => setTimeout(resolve, gapMs))
    try {
      await sendReply(event, list[i])
    } catch (error) {
      // 这一段没发出去：后面的段也别硬发了，存起来让用户自己取
      const left = list.slice(i)
      addPending(event, left)
      console.warn(
        `[发送] 第 ${i + 1}/${list.length} 段失败，剩余 ${left.length} 段已存起：`,
        error?.message ?? error,
      )
      return
    }
  }
}

// 私聊流式：调 QQ 的单聊流式接口，内容一截一截下发，界面上是逐段长出来的
// QQ 的 /stream_messages 需要单独申请权限，没开通时每次都会失败一次，
// 所以默认关，而且只要失败过一次就整个进程内不再尝试。
let streamState = null // null = 还没试过，false = 已知平台不支持

const STREAM_UNAVAILABLE = /stream_messages|404|not found|无权限|权限不足|不支持|not support|3040/i

async function sendStreamReply(event, text, { chunkSize = 36, gapMs = 320 } = {}) {
  const body = String(text ?? '').trim()
  if (event?.message_type !== 'private' || !event?.user_id) return false
  if (!env.streamReply) return false
  if (streamState === false) return false
  if (body.length < 120) return false

  let stream
  try {
    stream = openPrivateStream(event.user_id, event.message_id)
  } catch (error) {
    console.warn('[流式] 创建流失败，改普通发送：', String(error?.message ?? error).slice(0, 60))
    return false
  }

  let sent = 0
  try {
    // 官方接口是「同一条消息原地改写」，每次传截至目前的全文，不是增量
    for (let i = 0; i < body.length; i += chunkSize) {
      const shown = body.slice(0, Math.min(i + chunkSize, body.length))
      await stream.update(shown)
      sent += 1
      if (gapMs > 0 && i + chunkSize < body.length) {
        await new Promise((resolve) => setTimeout(resolve, gapMs))
      }
    }
    await stream.complete()
    return true
  } catch (error) {
    const message = String(error?.message ?? error)

    // 一段都没发出去：这条消息还没到用户手里，必须让调用方回落成普通发送
    if (sent === 0) {
      if (STREAM_UNAVAILABLE.test(message)) {
        streamState = false
        console.warn(
          `[流式] 平台没开通这个接口，本次进程内不再尝试流式（要用去开放平台申请权限，再设 STREAM_REPLY=true）：${message.slice(0, 60)}`,
        )
      } else {
        console.warn('[流式] 第一段就没发出去，改普通发送：', message.slice(0, 80))
      }
      return false
    }

    // 已经发出去一部分了，别再整条重发，否则用户看到两遍开头
    console.warn(`[流式] 发到第 ${sent} 段中断，后半截没发出去：`, message.slice(0, 80))
    return true
  }
}

/**
 * 主动推送一条 markdown 消息（定时任务、对外通报用）。
 * 没开 markdown 或发送失败就返回 null，调用方自己回退纯文本。
 *
 * @param {{type:'group'|'private', id:string}} target
 */
export async function sendMarkdownTo(target, text) {
  const body = String(text ?? '').trim()
  if (!body) return null
  if (!env.markdownReply || markdownState === false) return null

  try {
    const send = target.type === 'group' ? sendGroup : sendPrivate
    return await send(target.id, body, { markdown: true })
  } catch (error) {
    const message = String(error?.message ?? error)
    if (MARKDOWN_UNAVAILABLE.test(message)) {
      markdownState = false
      console.warn(`[Markdown] 平台拒绝 markdown，本次进程内改用纯文本：${message.slice(0, 80)}`)
    } else {
      console.warn('[Markdown] 主动推送失败：', message.slice(0, 80))
    }
    return null
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
