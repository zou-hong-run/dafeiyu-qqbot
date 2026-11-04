import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

// 只清临时产物，绝不动源码目录：scripts/ 里是正式脚本，删了就等于删代码
const CLEAN_RULES = [
  { dir: 'tmp', keep: [] },
  { dir: 'downloads/tmp', keep: [] },
  { dir: 'downloads/frames', keep: [] },
]

function dirSize(dir) {
  let total = 0

  const walk = (current) => {
    let entries = []
    try {
      entries = fs.readdirSync(current, { withFileTypes: true })
    } catch {
      return
    }

    for (const entry of entries) {
      const full = path.join(current, entry.name)
      if (entry.isDirectory()) walk(full)
      else {
        try {
          total += fs.statSync(full).size
        } catch {
          continue
        }
      }
    }
  }

  walk(dir)
  return total
}

export function cleanWorkspace({ includeDownloads = false } = {}) {
  const removed = []
  let freed = 0

  for (const rule of CLEAN_RULES) {
    const dir = path.join(projectRoot, rule.dir)
    if (!fs.existsSync(dir)) continue

    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (rule.keep.includes(entry.name)) continue

      const full = path.join(dir, entry.name)
      try {
        freed += entry.isDirectory() ? dirSize(full) : fs.statSync(full).size
        fs.rmSync(full, { recursive: true, force: true })
        removed.push(path.relative(projectRoot, full).split(path.sep).join('/'))
      } catch (error) {
        console.error('[清理] 删除失败：', full, error?.message ?? error)
      }
    }
  }

  const downloadsDir = path.join(projectRoot, 'downloads')
  if (fs.existsSync(downloadsDir)) {
    for (const entry of fs.readdirSync(downloadsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue

      const full = path.join(downloadsDir, entry.name)
      try {
        freed += dirSize(full)
        fs.rmSync(full, { recursive: true, force: true })
        removed.push(path.relative(projectRoot, full).split(path.sep).join('/'))
      } catch (error) {
        console.error('[清理] 删除失败：', full, error?.message ?? error)
      }
    }
  }

  if (includeDownloads) {
    const dir = path.join(projectRoot, 'downloads')
    if (fs.existsSync(dir)) {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.isDirectory()) continue

        const full = path.join(dir, entry.name)
        try {
          freed += fs.statSync(full).size
          fs.rmSync(full, { force: true })
          removed.push(path.relative(projectRoot, full).split(path.sep).join('/'))
        } catch (error) {
          console.error('[清理] 删除失败：', full, error?.message ?? error)
        }
      }
    }
  }

  return { removed, freed }
}

export function workspaceStats() {
  const report = []

  for (const name of ['tmp', 'scripts', 'downloads', 'logs']) {
    const dir = path.join(projectRoot, name)
    if (!fs.existsSync(dir)) continue

    let count = 0
    let size = 0
    try {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        count += 1
        const full = path.join(dir, entry.name)
        try {
          size += entry.isDirectory() ? dirSize(full) : fs.statSync(full).size
        } catch {
          continue
        }
      }
    } catch {
      continue
    }

    report.push({ name, count, size })
  }

  return report
}
