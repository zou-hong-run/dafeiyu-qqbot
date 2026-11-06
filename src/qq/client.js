import { QQBot } from '@tencent-connect/qqbot-nodejs'
import { env } from '../config/env.js'

// 官方 SDK 的适配层。
//
// 目的：业务代码不直接依赖 SDK。所有差异——事件形状、消息段拼装、
// 媒体上传、撤回、流式——都收在这一个文件里，换 SDK 只改这里。
//
// 两个关键翻译：
//   1. 入站：QQBotInboundMessage → 老的 event 形状（message_type / group_id / reply…）
//   2. 出站：{ type, data } 消息段 → 官方 SDK 的 content 字符串或媒体 API

const logger = {
  info: () => {},
  warn: (msg, meta) => console.warn(`[qq] ${msg}`, meta ?? ''),
  error: (msg, meta) => console.error(`[qq] ${msg}`, meta ?? ''),
  debug: () => {},
}

export const bot = new QQBot({
  appId: env.appId,
  appSecret: env.appSecret,
  // 我们的机器人没有 markdown 权限，开着会被服务端拒
  markdownSupport: false,
  logger,
})

/** 消息段构造：形状和旧 SDK 一致，业务代码不用改 */
export const segment = {
  text: (text) => ({ type: 'text', data: { text: String(text ?? '') } }),
  at: (id) => ({ type: 'at', data: { user_id: String(id ?? '') } }),
  face: (id, text) => ({ type: 'face', data: { id, text } }),
  image: (file) => ({ type: 'image', data: { file } }),
  audio: (file) => ({ type: 'audio', data: { file } }),
  video: (file) => ({ type: 'video', data: { file } }),
  file: (file, options = {}) => ({ type: 'file', data: { file, name: options.name } }),
}

// QQ 官方协议里，@ 和表情都是拼在 content 里的特殊标签，不是独立消息段。
// 标签格式取自平台实际收发的报文。
function flatten(payload) {
  const parts = Array.isArray(payload) ? payload : [payload]
  let text = ''
  const media = []

  for (const part of parts) {
    if (part == null) continue
    if (typeof part === 'string') {
      text += part
      continue
    }

    const type = part.type
    const data = part.data ?? {}

    if (type === 'text') {
      text += String(data.text ?? '')
    } else if (type === 'at') {
      text += data.user_id === 'all' ? '<qqbot-at-everyone />' : `<qqbot-at-user id="${data.user_id}" />`
    } else if (type === 'face') {
      text += `<emoji:${data.id}>`
    } else if (type === 'image' || type === 'audio' || type === 'video' || type === 'file') {
      media.push({ type, data })
    }
  }

  return { text, media }
}

/** 媒体来源：路径 / Buffer / http 地址，对应 SDK 的三种入参 */
function sourceOf(file) {
  if (Buffer.isBuffer(file)) return { buffer: file }
  const text = String(file ?? '')
  if (/^https?:\/\//i.test(text)) return { url: text }
  return { localPath: text }
}

const MEDIA_SEND = {
  image: (target, source, opts) => bot.sendImage(target, source, opts),
  audio: (target, source) => bot.sendVoice(target, source),
  video: (target, source) => bot.sendVideo(target, source),
  file: (target, source, opts) => bot.sendFile(target, source, opts),
}

async function dispatch(target, payload, msgId) {
  const { text, media } = flatten(payload)

  if (media.length === 0) {
    if (!text.trim()) throw new Error('消息内容为空')
    return bot.sendText({ ...target, msgId }, text)
  }

  // 有媒体：逐条发，正文作为第一条的附带文字
  let last
  for (const [index, item] of media.entries()) {
    const send = MEDIA_SEND[item.type]
    if (!send) continue

    const source = sourceOf(item.data.file)
    const opts = {}
    if (index === 0 && text.trim()) opts.content = text
    if (item.type === 'file' && item.data.name) opts.fileName = item.data.name

    const result = await send({ ...target, msgId: index === 0 ? msgId : undefined }, source, opts)
    // sendImage 这类返回 { upload, message }，只把 message 往上传，
    // 上层要拿 id 记撤回，格式得和 sendText 一致
    last = result?.message ?? result
  }

  return last
}

/** 发到群。不传 msgId 就是主动消息（受平台额度限制） */
export function sendGroup(groupId, payload, { msgId } = {}) {
  return dispatch({ scope: 'group', targetId: String(groupId) }, payload, msgId)
}

/** 发到私聊 */
export function sendPrivate(userId, payload, { msgId } = {}) {
  return dispatch({ scope: 'c2c', targetId: String(userId) }, payload, msgId)
}

export function recallGroup(groupId, messageId) {
  return bot.recallMessage({ scope: 'group', targetId: String(groupId) }, String(messageId))
}

export function recallPrivate(userId, messageId) {
  return bot.recallMessage({ scope: 'c2c', targetId: String(userId) }, String(messageId))
}

/** 只上传不发送：拿 file_info 自己拼消息体时用 */
export function uploadMedia(options) {
  return bot.uploadMedia(options)
}

/**
 * 发原始消息体（msg_type / media / message_reference 这些）。
 * 高层 API 只收文本和媒体，引用、文件卡片这类要自己拼，所以留这个口子。
 */
export async function postRaw(scope, targetId, body) {
  const token = await bot.tokenManager.getAccessToken(env.appId, env.appSecret)
  const path =
    scope === 'group' ? `/v2/groups/${targetId}/messages` : `/v2/users/${targetId}/messages`
  return bot.apiClient.request(token, 'POST', path, body)
}

/**
 * 流式输出（只有私聊支持）。官方接口是「同一条消息原地改写」，
 * 所以每次都要传截至目前的全文，不是增量。
 */
export function openPrivateStream(userId, msgId) {
  return bot.openStream({ target: { scope: 'c2c', targetId: String(userId), msgId: String(msgId) } })
}

/**
 * 把官方入站消息翻译成业务层用的 event 形状。
 * 返回 null 表示这条不处理（频道、频道私信、机器人自己的消息）。
 */
export function toLegacyEvent(msg) {
  if (!msg || (msg.kind !== 'group' && msg.kind !== 'c2c')) return null
  if (msg.senderIsBot) return null

  const isGroup = msg.kind === 'group'
  const target = msg.replyTarget
  if (!target) return null

  const event = {
    message_type: isGroup ? 'group' : 'private',
    message_id: msg.messageId,
    content: msg.content ?? '',
    timestamp: msg.timestamp,
    mentions: msg.mentions ?? [],
    message_scene: msg.messageScene,
    msg_idx: msg.msgIdx,
    ref_msg_idx: msg.refMsgIdx,
    attachments: msg.attachments ?? [],
    sender: {
      user_name: msg.senderName ?? '',
      card: msg.senderName ?? '',
    },
  }

  if (isGroup) {
    event.group_id = msg.groupOpenid
    event.group_openid = msg.groupOpenid
    event.user_id = msg.senderId
    event.member_openid = msg.senderId
  } else {
    event.user_id = msg.senderId
    event.user_openid = msg.senderId
  }

  // reply 是业务层最常用的口子：带回 msg_id 就是被动回复
  event.reply = (payload) => dispatch(target, payload, target.msgId)

  return event
}

/** 统一的事件入口：业务层只注册一次 */
export function onMessage(handler) {
  bot.on('message', async (ctx, msg) => {
    const event = toLegacyEvent(msg)
    if (!event) return
    try {
      await handler(event)
    } catch (error) {
      console.error('[qq] 处理消息失败：', error?.message ?? error)
    }
  })
}

/**
 * 机器人自己的 openid，判断「有没有 @ 我」时用。
 * 启动时拉一次缓存在内存里，atMe 这类同步判断直接读缓存。
 */
let cachedSelfId = ''

export function selfOpenid() {
  return cachedSelfId
}

async function loadSelfOpenid() {
  try {
    const info = await bot.getSelfInfo()
    const value = info?.openid ?? info?.user_openid ?? info?.id
    if (value) cachedSelfId = String(value)
  } catch {
    // 没权限或接口挂了就保持空，atMe 那边还有 is_you / bot 标记兜底
  }
}

export async function start() {
  await loadSelfOpenid()
  await bot.start()
}

export function stop() {
  bot.stop()
}

