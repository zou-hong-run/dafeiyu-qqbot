import fs from 'node:fs'
import path from 'node:path'

// 超长回复被拆成多条时，超过单次上限（默认 6 段）的尾巴存这里
// 用户说「接着发」再把剩下的补出去；落盘到 data/pending-replies.json，重启不丢

const FILE = path.resolve('data/pending-replies.json')
const store = new Map()
let loaded = false

function load() {
  if (loaded) return
  loaded = true
  try {
    const raw = fs.readFileSync(FILE, 'utf8')
    const obj = JSON.parse(raw)
    for (const [key, value] of Object.entries(obj ?? {})) {
      if (Array.isArray(value?.parts) && value.parts.length > 0) {
        store.set(key, { parts: value.parts.map(String), ts: Number(value.ts) || Date.now() })
      }
    }
  } catch {
    // 文件不存在或坏了，当空处理
  }
}

function save() {
  try {
    fs.mkdirSync(path.dirname(FILE), { recursive: true })
    fs.writeFileSync(FILE, JSON.stringify(Object.fromEntries(store)))
  } catch (error) {
    console.warn('[补发] 暂存剩余段失败：', error?.message ?? error)
  }
}

export function keyOf(event) {
  return event?.message_type === 'group' ? `group:${event.group_id}` : `user:${event.user_id}`
}

// 追加剩余段；同一会话里之前没发完的排在前面，保证不丢内容
export function addPending(event, parts) {
  const list = (parts ?? []).filter((item) => String(item ?? '').trim())
  if (list.length === 0) return
  load()
  const key = keyOf(event)
  const old = store.get(key)
  const merged = [...(old?.parts ?? []), ...list.map(String)]
  store.set(key, { parts: merged, ts: Date.now() })
  save()
}

export function pendingCount(event) {
  load()
  return store.get(keyOf(event))?.parts?.length ?? 0
}

// 取出一批（默认 6 段），剩下的继续留着
export function takePending(event, maxParts = 6) {
  load()
  const key = keyOf(event)
  const item = store.get(key)
  if (!item || item.parts.length === 0) return { parts: [], rest: 0 }

  const parts = item.parts.slice(0, maxParts)
  const remain = item.parts.slice(maxParts)
  if (remain.length > 0) store.set(key, { parts: remain, ts: Date.now() })
  else store.delete(key)
  save()

  return { parts, rest: remain.length }
}

export function clearPending(event) {
  load()
  store.delete(keyOf(event))
  save()
}
