import * as groupLog from '../memory/group-log.js'

// 群里的普通消息不会进对话上下文（只有 @ 和提到名字才进），
// 被叫到时把最近几条别人说的话带上，模型才知道刚才在聊什么。
// 不这么做，群友说「大半夜吓死人」再喊名字，模型只会回「在呢，什么事」。
export function recentGroupContext(event, windowMs = 3 * 60_000, limit = 6) {
  try {
    const recent = groupLog
      .recent(event?.group_id, 8)
      .filter((item) => item.id !== event?.message_id && item.u !== 'bot')
      .filter((item) => Date.now() - Number(item.t ?? 0) < windowMs)
      .slice(-limit)

    if (recent.length === 0) return ''

    const lines = recent.map((item) => {
      const who = item.n || String(item.u ?? '').slice(0, 6) || '有人'
      return `${who}：${String(item.c ?? '').slice(0, 120)}`
    })
    return `（刚才群里最近几条，我可能没在场，供你接话）\n${lines.join('\n')}\n\n`
  } catch {
    return ''
  }
}
