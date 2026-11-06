// 敏感路径黑名单：读取（read_document）和发送（send_file、markdown 内嵌图片）共用一份。
// 分两处维护迟早会漂移——一边补了 backups/，另一边漏了，等于白发。
//
// 这些目录的共同点：里面有密钥、别人的对话、命令输出、运行时数据，
// 而调用这些工具的人可能只是群里的普通成员。

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

/** 命中黑名单返回原因，可以读/发则返回空字符串 */
export function sensitiveReason(rel) {
  const path = String(rel ?? '')
  for (const prefix of SENSITIVE_PREFIXES) {
    const hit = prefix.endsWith('/')
      ? path.startsWith(prefix)
      : // 目录项要连同子路径一起挡；文件项还要挡 .env.local 这类同名前缀
        path === prefix || path.startsWith(`${prefix}/`) || path.startsWith(`${prefix}.`)
    if (hit) return '密钥、记忆、日志、备份和依赖目录都不在开放范围内'
  }
  return ''
}
