import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const docFile = path.join(projectRoot, 'SELF.md')

// 原来只注入 4000 字，而文件早就一万多字了——后写的经验全被截掉，
// 表现就是「说了它也记不住」。提到 12000，并保留截断提示。
const MAX_CHARS = 12_000

// 踩坑记录段：机器人自己往里追加，不用手工 edit 整个文件
const LESSON_HEADING = '## 踩坑记录（自己总结的，别删）'
const MAX_LESSONS = 40

let cache = { mtime: -1, text: '' }
export function selfDoc() {
  try {
    const stat = fs.statSync(docFile)
    if (stat.mtimeMs === cache.mtime) return cache.text

    const raw = fs.readFileSync(docFile, 'utf8').trim()
    cache = {
      mtime: stat.mtimeMs,
      text: raw.length > MAX_CHARS ? `${raw.slice(0, MAX_CHARS)}\n…（已截断）` : raw,
    }
    return cache.text
  } catch {
    return cache.text
  }
}

function lessonLines(section) {
  return section
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('- '))
}

/**
 * 把一条踩坑经验追加到 SELF.md 的踩坑记录段。
 * 只写「症状 → 原因 → 做法」一行，不记过程；同一条不重复记。
 */
export function appendLesson({ symptom = '', cause = '', fix = '' } = {}) {
  const brief = String(symptom ?? '').replace(/\s+/g, ' ').trim().slice(0, 80)
  const reason = String(cause ?? '').replace(/\s+/g, ' ').trim().slice(0, 120)
  const action = String(fix ?? '').replace(/\s+/g, ' ').trim().slice(0, 160)

  if (!brief) throw new Error('要说清是什么问题（symptom）')
  if (!action) throw new Error('要说清正确做法（fix）')

  const line = `- ${brief}${reason ? ` → ${reason}` : ''} → ${action}`

  let raw = ''
  try {
    raw = fs.readFileSync(docFile, 'utf8')
  } catch {
    raw = `# 万能大肥鱼 · 自身能力说明\n\n${LESSON_HEADING}\n\n`
  }

  const headingIndex = raw.indexOf(LESSON_HEADING)
  if (headingIndex >= 0) {
    const before = raw.slice(0, headingIndex + LESSON_HEADING.length)
    const rest = raw.slice(headingIndex + LESSON_HEADING.length)
    const nextHeading = rest.search(/\n##\s/)
    const section = nextHeading >= 0 ? rest.slice(0, nextHeading) : rest
    const tail = nextHeading >= 0 ? rest.slice(nextHeading) : ''

    if (section.includes(brief)) return { duplicated: true, line }

    const lessons = [...lessonLines(section), line].slice(-MAX_LESSONS)
    const rebuilt = `\n\n${lessons.join('\n')}\n`
    const updated = `${before}${rebuilt}${tail}`
    fs.writeFileSync(docFile, updated, 'utf8')
    cache.mtime = -1
    return { duplicated: false, line, total: lessons.length }
  }

  const updated = `${raw.trimEnd()}\n\n${LESSON_HEADING}\n\n${line}\n`
  fs.writeFileSync(docFile, updated, 'utf8')
  cache.mtime = -1
  return { duplicated: false, line, total: 1 }
}
