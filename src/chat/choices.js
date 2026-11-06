// 选择题：优先用 QQ 的按钮（keyboard），不支持时回落到「编号 + 回数字」。
//
// 按钮点击会推 INTERACTION_CREATE 事件，里面有 button_data，我们把它写成
// `choice:<id>:<index>`，收到就按 id 找回原题、按 index 取选项。

const TTL_MS = 5 * 60_000
const MAX_OPTIONS = 5

const pending = new Map()
const pendingById = new Map()
// 已答过的题：id → { at, choice }。用来区分「被别人抢先选了」和「压根不存在/已过期」
const answered = new Map()

function sweep() {
  const now = Date.now()
  for (const [key, item] of pending) {
    if (now - item.at > TTL_MS) {
      pending.delete(key)
      pendingById.delete(item.id)
    }
  }
}

export function putChoice(sessionKey, { question = '', options = [] } = {}) {
  const list = (Array.isArray(options) ? options : [])
    .map((item) => String(item ?? '').trim())
    .filter(Boolean)
    .slice(0, MAX_OPTIONS)

  if (list.length < 2) return null

  const entry = {
    id: `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`,
    sessionKey,
    question: String(question ?? '').trim(),
    options: list,
    at: Date.now(),
  }

  pending.set(sessionKey, entry)
  pendingById.set(entry.id, entry)

  if (pending.size > 200) sweep()
  return entry
}

/** 用户回了数字就当成选中；别的输入一律不管 */
export function resolveChoice(sessionKey, text) {
  const entry = pending.get(sessionKey)
  if (!entry) return null

  if (Date.now() - entry.at > TTL_MS) {
    pending.delete(sessionKey)
    pendingById.delete(entry.id)
    return null
  }

  const match = String(text ?? '').trim().match(/^(\d{1,2})[.、。]?$/)
  if (!match) return null

  const option = entry.options[Number(match[1]) - 1]
  if (!option) return null

  pending.delete(sessionKey)
  pendingById.delete(entry.id)
  return { question: entry.question, choice: option }
}

/**
 * 按钮点击：按 id 找回原题，按 index 取选项。
 * 返回三种情况：
 *   { sessionKey, question, choice }  选中了
 *   { taken: true, choice }           这题已经被别人选过了
 *   null                              不存在或已过期
 */
export function resolveChoiceById(id, index) {
  const key = String(id ?? '')
  const entry = pendingById.get(key)

  if (!entry) {
    const done = answered.get(key)
    if (done && Date.now() - done.at <= TTL_MS) return { taken: true, choice: done.choice }
    return null
  }

  if (Date.now() - entry.at > TTL_MS) {
    pendingById.delete(entry.id)
    pending.delete(entry.sessionKey)
    return null
  }

  const option = entry.options[Number(index)]
  if (!option) return null

  pendingById.delete(entry.id)
  pending.delete(entry.sessionKey)
  answered.set(key, { at: Date.now(), choice: option })

  if (answered.size > 200) {
    for (const [oldKey, item] of answered) {
      if (Date.now() - item.at > TTL_MS) answered.delete(oldKey)
    }
  }

  return { sessionKey: entry.sessionKey, question: entry.question, choice: option }
}

export function clearChoice(sessionKey) {
  const entry = pending.get(sessionKey)
  if (entry) pendingById.delete(entry.id)
  pending.delete(sessionKey)
}

export function choiceText({ question, options }) {
  const lines = options.map((item, index) => `${index + 1}. ${item}`)
  return `${question ? `${question}\n` : ''}${lines.join('\n')}\n\n回数字就行。`
}

/**
 * 构造按钮布局。每个选项一个按钮，点了触发 INTERACTION_CREATE。
 * action.type=1 是回调按钮（不往会话里发指令），permission.type=2 表示所有人可点。
 */
export function choiceKeyboard(entry) {
  return {
    content: {
      rows: [
        {
          buttons: entry.options.map((label, index) => ({
            id: `b_${entry.id}_${index}`,
            render_data: {
              label: `${index + 1}. ${label}`.slice(0, 20),
              visited_label: `已选 ${index + 1}`,
              style: index === 0 ? 1 : 0,
            },
            action: {
              type: 1,
              permission: { type: 2 },
              data: `choice:${entry.id}:${index}`,
              click_limit: 1,
            },
          })),
        },
      ],
    },
  }
}
