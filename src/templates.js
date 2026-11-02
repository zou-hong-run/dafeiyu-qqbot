import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// 任务模板：把跑成功的工单沉淀成「目标 → 路子 → 要点」，下次遇到同类任务直接照抄
// 落盘到 skills/templates.md，由 skills.js 自动注入提示词
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const skillsDir = path.join(projectRoot, 'skills')
const templateFile = path.join(skillsDir, 'templates.md')

const MAX_ITEMS = 12
const MAX_GOAL = 60
const MAX_NOTE = 200

function escape(text) {
  return String(text ?? '').replace(/\s+/g, ' ').trim()
}

function readItems() {
  try {
    if (!fs.existsSync(templateFile)) return []
    const raw = fs.readFileSync(templateFile, 'utf8')
    const blocks = raw.split(/\n(?=### )/)
    return blocks
      .filter((block) => block.trim().startsWith('### '))
      .map((block) => block.trim())
  } catch {
    return []
  }
}

function render(items) {
  return [`（跑成功的工单自动记在这里；遇到同类任务先照这个路子走，别再重新试错）`, ...items].join('\n\n')
}

/**
 * 记一条任务模板。同一目标（前 20 字相同）不重复记，直接更新。
 * @param {{ goal: string, tools?: string[], steps?: number, note?: string }} input
 */
export function recordTemplate({ goal, tools = [], steps = 0, note = '' } = {}) {
  const target = escape(goal).slice(0, MAX_GOAL)
  if (!target || target.length < 4) return null
  if (steps < 3) return null // 两三步的小事不值得存

  const route = [...new Set(tools.filter((name) => name && name !== 'notify_user'))].join(' → ')
  const key = target.replace(/\s+/g, '').slice(0, 12)
  const when = new Date().toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit' })

  const lines = [`### ${target}`, `- 路子：${route || '（没记录到工具序列）'}`]

  const items = readItems()
  const matches = (item) => item.split('\n')[0].replace(/\s+/g, '').includes(key)
  const previous = items.find(matches)

  // 旧条目记过要点、这次没总结出来，就把旧的留着
  if (!note && previous) {
    const oldNote = previous.split('\n').find((line) => line.startsWith('- 要点：'))
    if (oldNote) lines.push(oldNote)
  } else if (note) {
    lines.push(`- 要点：${escape(note).slice(0, MAX_NOTE)}`)
  }

  const block = `${lines.join('\n')}\n- 记于 ${when}｜${steps} 步`

  const kept = items.filter((item) => !matches(item))
  kept.unshift(block)

  try {
    fs.mkdirSync(skillsDir, { recursive: true })
    fs.writeFileSync(templateFile, render(kept.slice(0, MAX_ITEMS)))
    return block
  } catch (error) {
    console.error('[模板] 写入失败：', error?.message ?? error)
    return null
  }
}

export function listTemplates() {
  return readItems()
}
