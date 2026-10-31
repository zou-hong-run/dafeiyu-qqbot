import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const docFile = path.join(projectRoot, 'SELF.md')

const MAX_CHARS = 4000

let cache = { mtime: -1, text: '' }

export function selfDocPath() {
  return docFile
}

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
