import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { QQBot } from '@tencent-connect/qqbot-nodejs'
import { env } from '../config/env.js'
import { sensitiveReason } from '../ops/file-policy.js'
import { assertPublicUrlResolved, fetchPublic } from '../mcp-server/net-guard.js'

// 官方 SDK 的适配层。
//
// 目的：业务代码不直接依赖 SDK。所有差异——事件形状、消息段拼装、
// 媒体上传、撤回、流式——都收在这一个文件里，换 SDK 只改这里。

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const SESSION_FILE = path.join(projectRoot, 'data', 'qq-session.json')
// 未识别事件的落盘位置（表情回应等），用来排查平台到底推不推
const RAW_EVENT_LOG = path.join(projectRoot, 'data', 'raw-events.log')

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
      // sessionId 落到磁盘，权限收到只有属主能读
      fs.writeFileSync(SESSION_FILE, JSON.stringify(state), { mode: 0o600 })
      fs.chmodSync(SESSION_FILE, 0o600)
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
  // 保持 false：开了之后 sendText 会把所有文本包成 markdown 消息（msg_type 2），
  // 模型输出里的 * _ # 会被当格式解析，贴代码和路径容易变形。
  // 平台对群聊/单聊的自定义 markdown 已经全量开放（2026-04-23 起无需申请），
  // 需要 @ 成员或真正的富文本时，单独走 sendMarkdown，把范围控制在需要的地方。
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
//
// 这里要防两件事：
//   1. at 的 id 被塞进引号闭合标签，伪造「@全体」
//   2. 用户原文里的 <qqbot-...> / <emoji:...> 被平台当真标签解析
const AT_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/
const TAG_PATTERN = /<\s*\/?\s*(?:qqbot-[a-z-]+|emoji:\d+)[^>]*>/gi

/** 剥掉文本里的协议标签：用户说什么就发什么，别让平台把它当指令 */
export function sanitizeText(value) {
  return String(value ?? '').replace(TAG_PATTERN, '')
}

export function flatten(payload) {
  const parts = Array.isArray(payload) ? payload : [payload]
  let text = ''
  const media = []

  for (const part of parts) {
    if (part == null) continue
    if (typeof part === 'string') {
      text += sanitizeText(part)
      continue
    }

    const type = part.type
    const data = part.data ?? {}

    if (type === 'text') {
      text += sanitizeText(data.text)
    } else if (type === 'at') {
      const id = String(data.user_id ?? '')
      if (id === 'all') {
        text += '<qqbot-at-everyone />'
      } else if (AT_ID_PATTERN.test(id)) {
        text += `<qqbot-at-user id="${id}" />`
      } else {
        throw new Error(`@ 的 openid 不合法：${id.slice(0, 40)}`)
      }
    } else if (type === 'face') {
      const id = Number(data.id)
      if (Number.isInteger(id) && id >= 0 && id <= 348) text += `<emoji:${id}>`
    } else if (type === 'image' || type === 'audio' || type === 'video' || type === 'file') {
      media.push({ type, data })
    }
  }

  return { text, media }
}

// ── Markdown 内嵌图片 ──
// 本地图片不能直接写进 markdown：平台只认公网 URL 或 qqbot-media:// 引用。
// 所以先按「素材管理」三步上传（prepare → PUT → complete），拿回引用再替换进去。
const IMAGE_MIME = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
}
const MAX_MATERIAL_BYTES = 10 * 1024 * 1024
const MD_IMAGE = /!\[([^\]]*)\]\(([^)\s]+)\)/g
// platform 支持 ![alt #宽px #高px](url)。不指定的话按原图尺寸渲染，
// 一张 1200px 宽的图在手机上会糊满整屏，正文全被挤走。
const DEFAULT_IMAGE_WIDTH = 320

/** alt 里已经写了 #320px 就尊重它，没写才补默认宽度 */
function withSize(alt) {
  const text = String(alt ?? '').trim()
  if (/#\d+px/i.test(text)) return text
  return text ? `${text} #${DEFAULT_IMAGE_WIDTH}px` : `#${DEFAULT_IMAGE_WIDTH}px`
}

async function uploadImageAsset(absPath) {
  // 这条路径也可能是模型从用户原文里抄来的，黑名单必须在这里再判一次：
  // data/ 里是别人的对话，backups/ 是它的每日副本，都不该被上传成群里的素材
  const rel = path.relative(projectRoot, absPath).split(path.sep).join('/')
  const blocked = sensitiveReason(rel)
  if (blocked) throw new Error(`这个路径的图片不能上传（${rel}）：${blocked}`)

  const ext = path.extname(absPath).toLowerCase()
  const contentType = IMAGE_MIME[ext]
  if (!contentType) throw new Error(`markdown 图片只支持 png/jpeg/gif/webp：${path.basename(absPath)}`)

  const buffer = fs.readFileSync(absPath)
  if (buffer.length > MAX_MATERIAL_BYTES) {
    throw new Error(`图片超过 10MB：${path.basename(absPath)}`)
  }

  const md5 = crypto.createHash('md5').update(buffer).digest('hex')
  const sha1 = crypto.createHash('sha1').update(buffer).digest('hex')
  const token = await bot.tokenManager.getAccessToken(env.appId, env.appSecret)

  const prepared = await bot.apiClient.request(token, 'POST', '/v2/media-images/prepare', {
    file_name: path.basename(absPath),
    file_size: buffer.length,
    content_type: contentType,
    md5,
    sha1,
  })

  // 预签名 URL 走 COS 直传，不能带 QQBot 的 Authorization 头。
  // 但它也是出网请求：过一遍地址校验，别让平台返回的 URL 把我们指到内网去
  const uploaded = await fetchPublic(prepared.presigned_url, {
    method: 'PUT',
    headers: { 'Content-Type': contentType },
    body: buffer,
  })
  if (!uploaded.ok) throw new Error(`图片上传失败 HTTP ${uploaded.status}`)

  const etag = String(uploaded.headers.get('etag') ?? '').replace(/"/g, '') || md5
  const done = await bot.apiClient.request(token, 'POST', '/v2/media-images/complete', {
    upload_id: prepared.upload_id,
    md5: etag,
  })

  return done.url
}

/**
 * 把 markdown 里的本地图片路径换成 qqbot-media:// 引用。
 * 已经是 http / qqbot-media 的原样保留；读不到或上传失败就把那一张去掉，
 * 不让整条消息因为一张图发不出去。
 */
export async function rewriteMarkdownImages(
  text,
  baseDir = projectRoot,
  { checkUrl = assertPublicUrlResolved } = {},
) {
  const source = String(text ?? '')
  if (!source.includes('![')) return source

  let result = source
  for (const matched of [...source.matchAll(MD_IMAGE)]) {
    const [full, alt, src] = matched
    if (/^qqbot-media:/i.test(src)) continue

    if (/^https?:/i.test(src)) {
      // 外链图会交给平台去抓。地址是模型从网页里抄来的，同样要过一遍校验：
      // 网页作者把 og:image 写成元数据地址，模型抄进正文，平台就去访问了。
      try {
        await checkUrl(src)
      } catch {
        console.warn(`[qq] markdown 里这张外链图地址不可用，已去掉：${src.slice(0, 60)}`)
        result = result.replace(full, '')
        continue
      }
      // 地址没问题：补上宽度再发出去
      result = result.replace(full, `![${withSize(alt)}](${src})`)
      continue
    }

    const abs = path.resolve(baseDir, src)
    if (!abs.startsWith(path.resolve(baseDir) + path.sep)) continue
    if (!fs.existsSync(abs)) continue

    try {
      const url = await uploadImageAsset(abs)
      result = result.replace(full, `![${withSize(alt)}](${url})`)
    } catch (error) {
      console.warn(`[qq] markdown 图片上传失败，已去掉这张：${String(error?.message ?? error).slice(0, 80)}`)
      result = result.replace(full, '')
    }
  }

  return result
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

async function dispatch(target, payload, msgId, { markdown = false } = {}) {
  const { text, media } = flatten(payload)

  if (media.length === 0) {
    if (!text.trim()) throw new Error('消息内容为空')

    // 群聊里 @ 具体某人只有 markdown 消息支持（官方文档：@用户 → markdown 消息）。
    // 纯文本发出去的话，标签会原样显示成一段字符串。@全体成员例外，文本消息也支持。
    const needsMarkdown = target.scope === 'group' && /<qqbot-at-user/.test(text)

    if (needsMarkdown || markdown) {
      try {
        // 本地图片先传成素材，换成 qqbot-media:// 引用——平台只认公网 URL 或这个引用
        const body = await rewriteMarkdownImages(text)
        return await bot.sendMarkdown({ ...target, msgId }, body)
      } catch (error) {
        // 没开通 markdown 或发送失败：把标签摘掉退回纯文本，别把标签露给用户看
        const plain = text.replace(TAG_PATTERN, '').replace(/[ \t]{2,}/g, ' ').trim()
        console.warn(`[qq] markdown 发送失败，降级纯文本：${String(error?.message ?? error).slice(0, 80)}`)
        return bot.sendText({ ...target, msgId }, plain || text)
      }
    }

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
export function sendGroup(groupId, payload, { msgId, markdown = false } = {}) {
  return dispatch({ scope: 'group', targetId: String(groupId) }, payload, msgId, { markdown })
}

/** 发到私聊 */
export function sendPrivate(userId, payload, { msgId, markdown = false } = {}) {
  return dispatch({ scope: 'c2c', targetId: String(userId) }, payload, msgId, { markdown })
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
  const id = encodeURIComponent(String(targetId ?? ''))
  const path = scope === 'group' ? `/v2/groups/${id}/messages` : `/v2/users/${id}/messages`
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

/**
 * 带按钮的消息。
 * 官方文档：按钮是「在 markdown 消息的基础上」挂载的——发文本消息带 keyboard
 * 会被平台静默忽略（不报错，但用户看不到按钮），所以这里必须走 markdown。
 *
 * 这条路径不经过 postMessage()，是全项目唯一绕过出站过滤的口子：
 * 题干常常是模型拼出来的、可能夹带用户原文，所以在这里自己过一遍
 * sanitizeText + 本地图片上传，别把 <qqbot-at-everyone /> 原样送给平台。
 */
export async function sendWithKeyboard(target, content, keyboard) {
  const safe = await rewriteMarkdownImages(sanitizeText(content))
  return bot.sendMarkdown({ ...target }, safe, { keyboard })
}

/** C2C 唤醒消息：用户主动聊过之后 30 天内可以再敲一次，有频率限制 */
export function sendWakeup(userId, content) {
  return bot.sendWakeup({ scope: 'c2c', targetId: String(userId) }, content)
}

/**
 * 按钮点击要 5 秒内回执。code: 0 成功 / 1 失败 / 2 频繁 / 3 重复 / 4 无权限 / 5 仅管理员。
 * 文档特别注明：interaction_id 不带 `INTERACTION_CREATE:` 前缀，
 * 万一上游传了带前缀的，这里剥掉再发，否则会报 630001。
 */
export function acknowledgeInteraction(id, code = 0) {
  const clean = String(id ?? '')
    .replace(/^INTERACTION_CREATE[:：]\s*/i, '')
    .trim()
  if (!clean) return Promise.resolve(null)
  return bot.acknowledgeInteraction(clean, code).catch(() => null)
}

/** 按钮/交互回调 */
export function onInteraction(handler) {
  bot.on('interaction', (ctx, event) => {
    Promise.resolve(handler(event)).catch((error) => {
      console.error('[qq] 处理交互失败：', error?.message ?? error)
    })
  })
}

/**
 * 兜底原始事件：SDK 只单独发 message / interaction，其余事件（表情回应、
 * 成员变动、加群申请等）统一从这里吐出来，ctx 是 { eventType, data }。
 * 目前只用来观察平台到底推不推某些事件。
 */
export function onRawEvent(handler) {
  bot.on('rawEvent', (ctx) => {
    Promise.resolve(handler(ctx)).catch((error) => {
      console.error('[qq] 处理原始事件失败：', error?.message ?? error)
    })
  })
}

/** 连接生命周期：接日志和重启播报到这儿 */export function onLifecycle({ ready, resumed, disconnected, error } = {}) {
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
  // 观察用：把平台推过来的非消息事件记一行，确认表情回应这类事件到底推不推
  bot.on('rawEvent', (ctx) => {
    const type = String(ctx?.eventType ?? 'unknown')
    let brief = ''
    if (/REACTION|POKE|STAMP|NUDGE/i.test(type)) {
      try {
        brief = ' ' + JSON.stringify(ctx?.data ?? '').slice(0, 300)
      } catch {
        brief = ' ' + String(ctx?.data)
      }
    }
    console.log(`[qq][rawEvent] ${type}${brief}`)
  })
  await bot.start()
}

export function stop() {
  bot.stop()
}

