import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { QQBot } from '@tencent-connect/qqbot-nodejs'
import { env } from '../config/env.js'

// 官方 SDK 的适配层。
//
// 目的：业务代码不直接依赖 SDK。所有差异——事件形状、消息段拼装、
// 媒体上传、撤回、流式——都收在这一个文件里，换 SDK 只改这里。

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const SESSION_FILE = path.join(projectRoot, 'data', 'qq-session.json')

// 把 sessionId / lastSeq 落盘：进程重启后先试 RESUME，不用重新 IDENTIFY，
// 也少丢几条消息（QQ 没有历史补拉接口，能续上就是赚）。
const sessionPersistence = {
  load() {
    try {
      return JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8'))
    } catch {
      return null
    }
  },
  save(state) {
    try {
      fs.mkdirSync(path.dirname(SESSION_FILE), { recursive: true })
      fs.writeFileSync(SESSION_FILE, JSON.stringify(state))
    } catch {
      // 存不下就算了，下次重新 IDENTIFY
    }
  },
  clear() {
    try {
      fs.unlinkSync(SESSION_FILE)
    } catch {
      // 本来就没有
    }
  },
}

const logger = {
  info: () => {},
  warn: (msg, meta) => console.warn(`[qq] ${msg}`, meta ?? ''),
  error: (msg, meta) => console.error(`[qq] ${msg}`, meta ?? ''),
  debug: () => {},
}

export const bot = new QQBot({
  appId: env.appId,
  appSecret: env.appSecret,
  // 我们的机器人没有 markdown 权限，开着会被服务端拒；要用时单独走 sendMarkdown
  markdownSupport: false,
  logger,
  sessionPersistence,
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

/** C2C 的「输入中」提示，只在私聊有效 */
export function sendTyping(userId, msgId, seconds = 30) {
  if (!userId) return Promise.resolve(null)
  return bot
    .sendTyping({ scope: 'c2c', targetId: String(userId), msgId: msgId ? String(msgId) : undefined }, seconds)
    .catch(() => null)
}

/** 发 Markdown。需要平台给权限，没权限会抛 ApiError，调用方自己降级 */
export function sendMarkdown(target, content, opts = {}) {
  return bot.sendMarkdown({ ...target }, content, opts)
}

/** 带按钮的文本。按钮点击会走 interaction 事件 */
export function sendWithKeyboard(target, content, keyboard) {
  return bot.sendTextWithKeyboard({ ...target }, content, keyboard)
}

/** C2C 唤醒消息：用户主动聊过之后 30 天内可以再敲一次，有频率限制 */
export function sendWakeup(userId, content) {
  return bot.sendWakeup({ scope: 'c2c', targetId: String(userId) }, content)
}

/** 按钮点击要 5 秒内回执，code: 0 成功 / 1 失败 / 2 频繁 / 3 重复 / 4 无权限 / 5 仅管理员 */
export function acknowledgeInteraction(id, code = 0) {
  return bot.acknowledgeInteraction(String(id), code).catch(() => null)
}

/** 按钮/交互回调 */
export function onInteraction(handler) {
  bot.on('interaction', (ctx, event) => {
    Promise.resolve(handler(event)).catch((error) => {
      console.error('[qq] 处理交互失败：', error?.message ?? error)
    })
  })
}

/** 连接生命周期：接日志和重启播报到这儿 */
export function onLifecycle({ ready, resumed, disconnected, error } = {}) {
  if (ready) bot.on('ready', (data) => ready(data))
  if (resumed) bot.on('resumed', (data) => resumed(data))
  if (disconnected) bot.on('disconnected', (info) => disconnected(info))
  if (error) bot.on('error', (err) => error(err))
}

/** token 状态，/diag 里用 */
export function tokenStatus() {
  try {
    return bot.tokenManager.getStatus(env.appId.trim())
  } catch {
    return null
  }
}

/** 自检信息：自己是谁、有哪些权限位 */
export async function selfInfo() {
  try {
    return await bot.getSelfInfo()
  } catch {
    return null
  }
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

