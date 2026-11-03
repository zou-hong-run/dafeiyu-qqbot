import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// 数据备份：data/ 里是记忆、群记录、定时任务、开销账本，机器一重装就全没了。
// 每天把 json 和群记录复制到 backups/<日期>/，保留最近 N 份，删旧的。
// 不用 tar：Linux/Windows 上都能跑，出问题也好排查。
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const dataDir = path.join(projectRoot, 'data')
const skillsDir = path.join(projectRoot, 'skills')
const backupsDir = path.join(projectRoot, 'backups')

const KEEP = Number(process.env.BACKUP_KEEP || 7)

function stampOf(date = new Date()) {
  const pad = (n) => String(n).padStart(2, '0')
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`
}

function copyInto(from, to) {
  try {
    fs.copyFileSync(from, to)
    return fs.statSync(to).size
  } catch (error) {
    console.warn('[备份] 复制失败：', path.basename(from), error?.message ?? error)
    return 0
  }
}

/** 备份一次。同一天重复调用会跳过 */
export function runBackup(now = new Date()) {
  const stamp = stampOf(now)
  const target = path.join(backupsDir, stamp)
  const doneFlag = path.join(target, '.done')

  if (fs.existsSync(doneFlag)) return { skipped: true, stamp }

  let files = 0
  let bytes = 0

  try {
    fs.mkdirSync(path.join(target, 'groups'), { recursive: true })

    // data 目录下的 json（记忆、任务、账单、静音状态、情绪记录…）
    for (const name of fs.readdirSync(dataDir)) {
      const full = path.join(dataDir, name)
      if (!name.endsWith('.json')) continue
      if (!fs.statSync(full).isFile()) continue
      bytes += copyInto(full, path.join(target, name))
      files += 1
    }

    // 群聊记录（每个群一个 jsonl）
    const groupsDir = path.join(dataDir, 'groups')
    if (fs.existsSync(groupsDir)) {
      for (const name of fs.readdirSync(groupsDir)) {
        if (!name.endsWith('.jsonl')) continue
        bytes += copyInto(path.join(groupsDir, name), path.join(target, 'groups', name))
        files += 1
      }
    }

    // 技能（机器人自己写的）
    if (fs.existsSync(skillsDir)) {
      for (const name of fs.readdirSync(skillsDir)) {
        if (!name.endsWith('.md')) continue
        bytes += copyInto(path.join(skillsDir, name), path.join(target, name))
        files += 1
      }
    }

    fs.writeFileSync(doneFlag, new Date().toISOString())
  } catch (error) {
    console.error('[备份] 失败：', error?.message ?? error)
    return { skipped: false, failed: true, stamp }
  }

  // 只留最近 N 份
  try {
    const dirs = fs
      .readdirSync(backupsDir)
      .filter((name) => /^\d{8}$/.test(name))
      .sort()

    for (const name of dirs.slice(0, Math.max(0, dirs.length - KEEP))) {
      fs.rmSync(path.join(backupsDir, name), { recursive: true, force: true })
    }
  } catch (error) {
    console.warn('[备份] 清理旧备份失败：', error?.message ?? error)
  }

  return { skipped: false, stamp, files, bytes }
}

export function listBackups(limit = KEEP) {
  try {
    return fs
      .readdirSync(backupsDir)
      .filter((name) => /^\d{8}$/.test(name))
      .sort()
      .slice(-limit)
      .map((name) => {
        const full = path.join(backupsDir, name)
        let size = 0
        const walk = (dir) => {
          for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
            const child = path.join(dir, item.name)
            if (item.isDirectory()) walk(child)
            else size += fs.statSync(child).size
          }
        }
        try {
          walk(full)
        } catch {
          // 读不到就算了
        }
        return { name, size }
      })
  } catch {
    return []
  }
}
