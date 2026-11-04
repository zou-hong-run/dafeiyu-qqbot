import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const auditFile = path.join(projectRoot, 'data', 'audit.log')

export function auditKeyOf(event) {
  if (!event) return 'scheduler'
  return event.message_type === 'group' ? `group:${event.group_id}` : `user:${event.user_id}`
}

/** 高危工具调用留痕：谁、什么时候、调了什么、结果多大 */
export function audit(sessionKey, tool, args, result) {
  try {
    fs.mkdirSync(path.dirname(auditFile), { recursive: true })
    const line = [
      new Date().toISOString(),
      sessionKey,
      tool,
      JSON.stringify(args ?? {}).slice(0, 300),
      String(result ?? '').replace(/\s+/g, ' ').slice(0, 200),
    ].join('	')
    fs.appendFileSync(auditFile, `${line}
`)
  } catch {
    // 审计写不进去不能影响主流程
  }
}
