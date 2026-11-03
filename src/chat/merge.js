// 连发合并：同一个人在同一会话里连着发的几段话，合起来当一次输入理解。
// 不加这个，用户「我有个问题」「关于昨天那个报错」「你帮我看看」连发三条，
// 机器人只会理解最后一条，前两句被当成两条独立对话各回一次。

const MAX_PARTS = 6
const MAX_CHARS = 1600

const slots = new Map()

function keyOf(sessionKey, userId) {
  return `${sessionKey}\u0000${userId || ''}`
}

function flush(key, entry, handler) {
  slots.delete(key)
  clearTimeout(entry.timer)
  handler({
    sessionKey: entry.sessionKey,
    userId: entry.userId,
    events: entry.events,
    text: entry.texts.join('\n'),
  })
}

/**
 * 把一条消息丢进合并槽。窗口内没新消息就合并成一次处理。
 * @param {{ sessionKey: string, userId?: string, text?: string, event: object, windowMs?: number, maxChars?: number }} input
 * @param {(batch: { events: object[], text: string }) => void} handler
 */
export function mergeMessage(
  { sessionKey, userId = '', text = '', event, windowMs = 1200, maxChars = MAX_CHARS, immediate = false },
  handler,
) {
  const body = String(text ?? '').trim()
  const key = keyOf(sessionKey, userId)
  const existing = slots.get(key)

  // 命令、空消息、超长、带附件的都不合并：先把攒着的冲出去，再单独处理这条，顺序不会乱
  if (immediate || !body || body.startsWith('/') || body.length > maxChars) {
    if (existing) flush(key, existing, handler)
    handler({ sessionKey, userId, events: [event], text: body })
    return
  }

  if (!existing) {
    const entry = { events: [], texts: [], timer: null, sessionKey, userId }
    slots.set(key, entry)
    queue(key, entry, body, event, windowMs, maxChars, handler)
    return
  }

  queue(key, existing, body, event, windowMs, maxChars, handler)
}

function queue(key, entry, body, event, windowMs, maxChars, handler) {
  entry.events.push(event)
  entry.texts.push(body)

  // 攒太多就别再等了，立刻冲
  const total = entry.texts.join('\n').length
  if (entry.events.length >= MAX_PARTS || total >= maxChars) {
    flush(key, entry, handler)
    return
  }

  clearTimeout(entry.timer)
  entry.timer = setTimeout(() => flush(key, entry, handler), windowMs)
  entry.timer.unref?.()
}

/** 进程退出或该会话关闭时，把攒着的立刻交出去，别丢消息 */
export function flushMerged(handler) {
  for (const [key, entry] of slots) {
    flush(key, entry, handler)
  }
}
