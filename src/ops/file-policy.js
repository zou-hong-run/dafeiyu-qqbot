// 敏感路径黑名单：读取（read_document）和发送（send_file、markdown 内嵌图片）共用一份。
// 分两处维护迟早会漂移——一边补了 backups/，另一边漏了，等于白发。
//
// 这些目录的共同点：里面有密钥、别人的对话、命令输出、运行时数据，
// 而调用这些工具的人可能只是群里的普通成员。

import path from 'node:path'

export const SENSITIVE_PREFIXES = [
  '.env',
  'data/',
  'node_modules/',
  '.git/',
  '.ssh/',
  'backups/',
  'logs/',
  'tmp/',
]

/**
 * 命中黑名单返回原因，可以读/发则返回空字符串。
 * 自己做路径规范化：调用方现在都先 resolve 过，但这是公共 API，
 * 不能指望每个调用点都记得先转一遍（Windows 的反斜杠、`./data/x`、`data/../backups/x`）。
 */
export function sensitiveReason(rel) {
  const raw = String(rel ?? '').replace(/\\/g, '/').trim()
  const normalized = path.posix.normalize(raw).replace(/^\.?\//, '')

  if (normalized === '..' || normalized.startsWith('../')) {
    return '路径里有 ..，不认'
  }

  for (const prefix of SENSITIVE_PREFIXES) {
    const hit = prefix.endsWith('/')
      ? normalized.startsWith(prefix)
      : // 目录项要连同子路径一起挡；文件项还要挡 .env.local 这类同名前缀
        normalized === prefix ||
        normalized.startsWith(`${prefix}/`) ||
        normalized.startsWith(`${prefix}.`)
    if (hit) return '密钥、记忆、日志、备份和依赖目录都不在开放范围内'
  }
  return ''
}
