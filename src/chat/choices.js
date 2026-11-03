// 选择题：QQ 官方的按钮（keyboard）必须先在开放平台建好按钮模板才能用，
// 机器人没法自己发明一个，所以这里用「编号选项 + 回数字」实现同样的交互。
const TTL_MS = 5 * 60_000
const MAX_OPTIONS = 5

const pending = new Map()

export function putChoice(sessionKey, { question = '', options = [] } = {}) {
  const list = (Array.isArray(options) ? options : [])
    .map((item) => String(item ?? '').trim())
    .filter(Boolean)
    .slice(0, MAX_OPTIONS)

  if (list.length < 2) return null

  const entry = { question: String(question ?? '').trim(), options: list, at: Date.now() }
  pending.set(sessionKey, entry)
  return entry
}

/** 用户回了数字就当成选中；别的输入一律不管 */
export function resolveChoice(sessionKey, text) {
  const entry = pending.get(sessionKey)
  if (!entry) return null

  if (Date.now() - entry.at > TTL_MS) {
    pending.delete(sessionKey)
    return null
  }

  const match = String(text ?? '').trim().match(/^(\d{1,2})[.、。]?$/)
  if (!match) return null

  const option = entry.options[Number(match[1]) - 1]
  if (!option) return null

  pending.delete(sessionKey)
  return { question: entry.question, choice: option }
}

export function clearChoice(sessionKey) {
  pending.delete(sessionKey)
}

export function choiceText({ question, options }) {
  const lines = options.map((item, index) => `${index + 1}. ${item}`)
  return `${question ? `${question}\n` : ''}${lines.join('\n')}\n\n回数字就行。`
}
