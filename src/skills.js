import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
export const skillsDir = path.join(projectRoot, 'skills')

const MAX_SKILLS = 10
const MAX_CHARS_PER_SKILL = 4000

let cached = { stamp: '', text: '' }

export function ensureSkillsDir() {
  fs.mkdirSync(skillsDir, { recursive: true })
}

export function listSkills() {
  try {
    return fs
      .readdirSync(skillsDir)
      .filter((file) => file.endsWith('.md'))
      .map((file) => {
        const full = path.join(skillsDir, file)
        const stat = fs.statSync(full)
        return { file, name: file.replace(/\.md$/, ''), size: stat.size, mtime: stat.mtimeMs }
      })
      .sort((a, b) => b.mtime - a.mtime)
  } catch {
    return []
  }
}

export function skillsPrompt() {
  const skills = listSkills()
  if (skills.length === 0) return ''

  const stamp = skills.map((item) => `${item.file}:${item.mtime}`).join('|')
  if (stamp === cached.stamp) return cached.text

  const blocks = []
  for (const item of skills.slice(0, MAX_SKILLS)) {
    try {
      const content = fs.readFileSync(path.join(skillsDir, item.file), 'utf8').trim()
      if (!content) continue
      blocks.push(`### ${item.name}\n${content.slice(0, MAX_CHARS_PER_SKILL)}`)
    } catch {
      continue
    }
  }

  cached = {
    stamp,
    text: blocks.length > 0 ? `【已安装技能】\n以下是你可以调用的技能说明，遇到对应场景时按说明执行：\n\n${blocks.join('\n\n')}` : '',
  }

  return cached.text
}
