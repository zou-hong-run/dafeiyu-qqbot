import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// 失败复盘：同一个工具连续栽三次，就把教训写成一条 pitfall
// 落盘到 skills/pitfalls.md —— 它会被 skills.js 自动注入系统提示词，下次就能看到
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const skillsDir = path.join(projectRoot, 'skills')
const pitfallsFile = path.join(skillsDir, 'pitfalls.md')

const MAX_ENTRIES = 30
const FAIL_THRESHOLD = 3   // 连续失败几次算一个教训
const MAX_PITFALL_CHARS = 3600

// 工具名 → { count, lastMessage }
const streaks = new Map()

const FAIL_PATTERN = /失败|已拦截|不可用|不允许|超时|拒绝|不存在|超出/

function normalize(text) {
  return String(text ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 160)
}

function isFailure(result) {
  const text = String(result ?? '')
  if (!text) return false
  // 只检查开头一段，避免把正常输出里提到的「失败」误判
  return FAIL_PATTERN.test(text.slice(0, 120))
}

function readEntries() {
  try {
    const raw = fs.readFileSync(pitfallsFile, 'utf8')
    const blocks = raw.split(/\n(?=### )/).filter((item) => item.trim())
    return blocks
      .slice(1) // 第一块是文件头
      .map((block) => {
        const title = block.match(/^### (.+)$/m)?.[1] ?? ''
        const time = block.match(/^<!-- (\d{4}-\d{2}-\d{2}) -->$/m)?.[1] ?? ''
        return { title, time, body: block.replace(/^### .+$/m, '').trim() }
      })
      .filter((item) => item.title)
  } catch {
    return []
  }
}

function writeEntries(entries) {
  const list = entries.slice(-MAX_ENTRIES)
  let body = '# 踩过的坑\n\n同类问题连续栽三次会自动记到这里，看到就别再犯。\n'

  for (const entry of list) {
    const chunk = `\n### ${entry.title}\n<!-- ${entry.time} -->\n${entry.body}\n`
    if (body.length + chunk.length > MAX_PITFALL_CHARS) break
    body += chunk
  }

  try {
    fs.mkdirSync(skillsDir, { recursive: true })
    fs.writeFileSync(pitfallsFile, body)
    return true
  } catch (error) {
    console.error('[复盘] 写入失败：', error?.message ?? error)
    return false
  }
}

function dayKey() {
  const now = new Date()
  const pad = (value) => String(value).padStart(2, '0')
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
}

/**
 * 记录一次工具调用结果。连续失败到阈值就落一条教训。
 * @returns {{ recorded: boolean, tool?: string, message?: string }}
 */
export function noteToolResult(toolName, result) {
  const tool = String(toolName ?? '').trim()
  if (!tool) return { recorded: false }

  if (!isFailure(result)) {
    streaks.delete(tool)
    return { recorded: false }
  }

  const message = normalize(result)
  const current = streaks.get(tool) ?? { count: 0, lastMessage: '' }
  const next = { count: current.count + 1, lastMessage: message }
  streaks.set(tool, next)

  if (next.count < FAIL_THRESHOLD) return { recorded: false }

  // 到阈值了：写一条，然后把计数清零，避免同一问题刷满文件
  streaks.delete(tool)

  const entries = readEntries()
  const title = `${tool} 连续失败 ${FAIL_THRESHOLD} 次`
  const signature = message.slice(0, 60)
  const duplicated = entries.some(
    (entry) => entry.title === title && entry.body.includes(signature),
  )
  if (duplicated) return { recorded: false }

  entries.push({
    title,
    time: dayKey(),
    body: `最后错误：${message}\n下次调用前先看这条：同类的报错说明这条路走不通，换个写法或者先补前置条件。`,
  })

  const ok = writeEntries(entries)
  return ok ? { recorded: true, tool, message } : { recorded: false }
}

export function listPitfalls(limit = 10) {
  return readEntries().slice(-limit)
}

export function clearPitfalls() {
  try {
    fs.rmSync(pitfallsFile, { force: true })
    return true
  } catch {
    return false
  }
}
