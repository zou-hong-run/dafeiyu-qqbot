import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

// 两层：
//   SELF.md              跟着代码走，能力说明 + 默认踩坑，多人共用一个仓库时这是共享基线
//   data/self-learned.md 本机攒的经验，data/ 不进仓库，各部署互不影响
// 分开的原因：所有人都读同一份 SELF.md，谁 push 一次就改了所有人的「自我认知」。
const docFile = path.join(projectRoot, 'SELF.md')
let learnedFile = path.join(projectRoot, 'data', 'self-learned.md')

// 原来只注入 4000 字，而文件早就一万多字了——后写的经验全被截掉，
// 表现就是「说了它也记不住」。分开给额度：基线占大头，本机经验不被挤掉。
const BASE_MAX_CHARS = 10_000
const LEARNED_MAX_CHARS = 2_000

const LEARNED_HEADING = '## 本机积累的经验（只在这台机器上有）'
const MAX_LESSONS = 40

/** 测试用：把本机经验文件指到临时目录 */
export function useLearnedFile(target) {
  learnedFile = target
  cache = { key: '', text: '' }
}

let cache = { key: '', text: '' }

function readIfExists(target) {
  try {
    return fs.readFileSync(target, 'utf8').trim()
  } catch {
    return ''
  }
}

function clip(text, limit) {
  return text.length > limit ? `${text.slice(0, limit)}\n…（已截断）` : text
}

export function selfDoc() {
  const base = readIfExists(docFile)
  const learned = readIfExists(learnedFile)
  if (!base && !learned) return cache.text

  const key = `${base.length}:${learned.length}:${base.slice(-40)}:${learned.slice(-40)}`
  if (key === cache.key) return cache.text

  const parts = []
  if (base) parts.push(clip(base, BASE_MAX_CHARS))
  if (learned) parts.push(`${LEARNED_HEADING}\n\n${clip(learned, LEARNED_MAX_CHARS)}`)

  cache = { key, text: parts.join('\n\n') }
  return cache.text
}

/**
 * 把一条踩坑经验追加到**本机**的经验文件（data/self-learned.md）。
 *
 * 不写 SELF.md：那是跟着代码走的共享基线，多人部署同一个仓库时，
 * 谁 push 一次就改了所有机器人的认知。本机学到的东西只该留在这台机器上。
 */
export function appendLesson({ symptom = '', cause = '', fix = '' } = {}) {
  const brief = String(symptom ?? '').replace(/\s+/g, ' ').trim().slice(0, 80)
  const reason = String(cause ?? '').replace(/\s+/g, ' ').trim().slice(0, 120)
  const action = String(fix ?? '').replace(/\s+/g, ' ').trim().slice(0, 160)

  if (!brief) throw new Error('要说清是什么问题（symptom）')
  if (!action) throw new Error('要说清正确做法（fix）')

  const line = `- ${brief}${reason ? ` → ${reason}` : ''} → ${action}`

  const raw = readIfExists(learnedFile)
  const existing = raw
    .split('\n')
    .map((item) => item.trim())
    .filter((item) => item.startsWith('- '))

  if (existing.some((item) => item.includes(brief))) return { duplicated: true, line }

  const lessons = [...existing, line].slice(-MAX_LESSONS)

  try {
    fs.mkdirSync(path.dirname(learnedFile), { recursive: true })
    fs.writeFileSync(learnedFile, `${lessons.join('\n')}\n`, 'utf8')
    cache = { key: '', text: '' }
  } catch (error) {
    throw new Error(`写本机经验失败：${error?.message ?? error}`)
  }

  return { duplicated: false, line, total: lessons.length }
}
