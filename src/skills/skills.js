import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
export const skillsDir = path.join(projectRoot, 'skills')

const MAX_SKILLS = 12
const MAX_CHARS_PER_SKILL = 4000
const MAX_READ_CHARS = 8000
// 每轮提示词里技能正文的总预算。超出的技能只挂一行摘要，模型真要用时再 read_skill 读全文。
// 之前是每个技能最多 4000 字全塞，技能一多每轮就是几万字，又贵又挤占上下文。
const FULL_BUDGET = 6000
const SUMMARY_CHARS = 140
// 这两个是我们自己的机制文件（失败教训、任务模板），必须每轮都生效，不能被预算挤成摘要
const ALWAYS_FULL = new Set(['pitfalls', 'templates'])

let cached = { stamp: '', text: '' }

export function ensureSkillsDir() {
  fs.mkdirSync(skillsDir, { recursive: true })
}

function firstMeaningfulLine(text) {
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const value = line.replace(/^#+\s*/, '').trim()
    if (value) return value
  }
  return ''
}

/** 解析开头的 --- 元数据块（name / description / when-to-use / inject） */
function parseSkill(text) {
  const raw = String(text ?? '')
  const matched = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/)
  if (!matched) return { body: raw, meta: {} }

  const meta = {}
  for (const line of matched[1].split(/\r?\n/)) {
    const hit = line.match(/^([a-zA-Z_-]+)\s*:\s*(.*)$/)
    if (!hit) continue
    meta[hit[1].toLowerCase()] = hit[2].trim().replace(/^["']|["']$/g, '')
  }

  return { body: raw.slice(matched[0].length), meta }
}

/**
 * 技能可以是单文件 skills/xxx.md，也可以是目录 skills/xxx/SKILL.md
 */
export function listSkills() {
  const result = []

  try {
    for (const entry of fs.readdirSync(skillsDir, { withFileTypes: true })) {
      const full = path.join(skillsDir, entry.name)

      if (entry.isFile() && entry.name.endsWith('.md')) {
        const stat = fs.statSync(full)
        result.push({
          name: entry.name.replace(/\.md$/, ''),
          file: entry.name,
          full,
          size: stat.size,
          mtime: stat.mtimeMs,
        })
        continue
      }

      if (entry.isDirectory()) {
        const skillFile = path.join(full, 'SKILL.md')
        if (!fs.existsSync(skillFile)) continue
        const stat = fs.statSync(skillFile)
        result.push({
          name: entry.name,
          file: `${entry.name}/SKILL.md`,
          full: skillFile,
          size: stat.size,
          mtime: stat.mtimeMs,
        })
      }
    }
  } catch {
    return []
  }

  return result.sort((a, b) => b.mtime - a.mtime)
}

function readSkillEntry(item) {
  try {
    const raw = fs.readFileSync(item.full, 'utf8')
    const { body, meta } = parseSkill(raw)
    return {
      ...item,
      body: body.trim(),
      description: meta.description || meta.name || firstMeaningfulLine(body).slice(0, SUMMARY_CHARS),
      whenToUse: meta['when-to-use'] || meta.when || '',
      inject: meta.inject || 'auto',
    }
  } catch {
    return null
  }
}

export function skillsPrompt() {
  const skills = listSkills()
  if (skills.length === 0) return ''

  const stamp = skills.map((item) => `${item.file}:${item.mtime}`).join('|')
  if (stamp === cached.stamp) return cached.text

  const fullBlocks = []
  const briefLines = []
  let used = 0

  for (const item of skills.slice(0, MAX_SKILLS)) {
    const entry = readSkillEntry(item)
    if (!entry || !entry.body) continue

    const text = entry.body.slice(0, MAX_CHARS_PER_SKILL)
    const wantFull = entry.inject === 'always' || ALWAYS_FULL.has(entry.name)
    const overBudget = used + text.length > FULL_BUDGET

    if (wantFull || (entry.inject !== 'on-demand' && !overBudget)) {
      fullBlocks.push(`### ${entry.name}\n${text}`)
      used += text.length
      continue
    }

    const hint = entry.whenToUse ? `（${entry.whenToUse}）` : ''
    briefLines.push(`- ${entry.name}：${entry.description.slice(0, SUMMARY_CHARS)}${hint}`)
  }

  const parts = []
  if (fullBlocks.length > 0) {
    parts.push(`【已安装技能】\n以下是你可以调用的技能说明，遇到对应场景时按说明执行：\n\n${fullBlocks.join('\n\n')}`)
  }
  if (briefLines.length > 0) {
    parts.push(
      `【更多技能（按需读取）】\n这些技能的正文没放进来，判断要用的时候先调 read_skill 读全文再照做：\n${briefLines.join('\n')}`,
    )
  }

  cached = { stamp, text: parts.join('\n\n') }
  return cached.text
}

/** 读某个技能的全文（供 read_skill 工具用） */
export function readSkill(name) {
  const wanted = String(name ?? '').trim().replace(/\.md$/i, '')
  if (!wanted) throw new Error('要传技能名')

  const skills = listSkills()
  const hit =
    skills.find((item) => item.name === wanted) ??
    skills.find((item) => item.name.toLowerCase() === wanted.toLowerCase())

  if (!hit) {
    throw new Error(
      skills.length === 0
        ? '当前没有任何技能。'
        : `没有叫「${wanted}」的技能。现有的：${skills.map((item) => item.name).join('、')}`,
    )
  }

  const raw = fs.readFileSync(hit.full, 'utf8')
  const { body } = parseSkill(raw)
  const text = (body || raw).trim()
  return text.length > MAX_READ_CHARS
    ? `${text.slice(0, MAX_READ_CHARS)}\n…（原文 ${text.length} 字，已截断）`
    : text
}
