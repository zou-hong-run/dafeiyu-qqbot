import path from 'node:path'
import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const MAX_OUTPUT = 3000
const MAX_COMMAND = 4000

const BLOCKED_PATTERNS = [
  { pattern: /rm\s+(-[a-zA-Z]+\s+)*\/(\s|$|\*)/, reason: '禁止删除根目录' },
  { pattern: /rm\s+(-[a-zA-Z]+\s+)*(~|\$HOME)(\/|\s|$)/, reason: '禁止删除用户主目录' },
  { pattern: /:\(\)\s*\{.*\};\s*:/, reason: '禁止 fork 炸弹' },
  { pattern: /\b(shutdown|reboot|halt|poweroff|init\s+0)\b/i, reason: '禁止关机或重启' },
  { pattern: /\b(mkfs|fdisk|dd\s+if=|dd\s+of=\/dev)/i, reason: '禁止磁盘操作' },
  { pattern: /(curl|wget)[^|]*\|\s*(ba|z)?sh/i, reason: '禁止下载后直接执行远程脚本' },
  { pattern: /(cat|less|more|head|tail|grep|strings|awk|sed)[^|;]*\.env(\s|$|['"])/i, reason: '禁止读取 .env' },
  { pattern: /\.env\b[^'"]*$/, reason: '禁止直接操作 .env' },
  { pattern: /\/etc\/(passwd|shadow|sudoers)/i, reason: '禁止读取系统账号文件' },
  { pattern: /\b(ssh-keygen|authorized_keys|id_rsa)\b/i, reason: '禁止操作 SSH 密钥' },
  { pattern: /\bchmod\s+(-R\s+)?777\s+\//i, reason: '禁止递归改根目录权限' },
  { pattern: /\bchown\s+(-R\s+)?[^\s]+\s+\//i, reason: '禁止递归改根目录属主' },
  { pattern: /^\s*(env|printenv)\s*$/i, reason: '禁止导出全部环境变量（会泄露密钥）' },
  { pattern: /\b(env|printenv)\s*\|\s*/i, reason: '禁止管道导出环境变量（会泄露密钥）' },
  { pattern: /(echo|printf|cat)[^|;]*\$\{?(DEEP_SEEK|DEEPSEEK|QQ_APP)/i, reason: '禁止打印密钥变量' },
]

function assertSafeCommand(command) {
  if (command.length > MAX_COMMAND) throw new Error(`命令太长（${command.length} 字符），上限 ${MAX_COMMAND}`)
  if (command.includes('\0')) throw new Error('命令包含非法字符')

  for (const { pattern, reason } of BLOCKED_PATTERNS) {
    if (pattern.test(command)) throw new Error(`已拦截：${reason}。换成安全的写法再试。`)
  }
}

function resolveCwd(input) {
  if (!input) return projectRoot
  const target = path.resolve(projectRoot, String(input))
  if (target !== projectRoot && !target.startsWith(projectRoot + path.sep)) {
    throw new Error('工作目录必须在项目目录内')
  }
  return target
}

function truncate(text, limit = MAX_OUTPUT) {
  const value = String(text ?? '')
  if (value.length <= limit) return value
  return `${value.slice(0, limit)}…（输出已截断，共 ${value.length} 字符）`
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function runOnce(command, cwd, timeoutMs) {
  return new Promise((resolve) => {
    const startedAt = Date.now()

    execFile(command, { shell: true, cwd, timeout: timeoutMs, maxBuffer: 2 * 1024 * 1024 }, (error, stdout, stderr) => {
      const elapsed = Date.now() - startedAt
      const code = error ? (typeof error.code === 'number' ? error.code : 1) : 0

      resolve({
        ok: !error,
        code,
        stdout: String(stdout ?? ''),
        stderr: String(stderr ?? error?.message ?? ''),
        ms: elapsed,
        timedOut: Boolean(error?.killed) || /timed? ?out/i.test(String(error?.message ?? '')),
      })
    })
  })
}

async function shell({ command, cwd, timeout_ms: timeoutMs, retries }) {
  const cmd = String(command ?? '').trim()
  if (!cmd) throw new Error('命令不能为空')

  assertSafeCommand(cmd)
  const workDir = resolveCwd(cwd)

  const waitMs = Math.min(Math.max(Number(timeoutMs) || 60_000, 1000), 300_000)
  const maxRetries = Math.min(Math.max(Number(retries ?? 3), 0), 5)

  const attempts = []
  for (let round = 0; round <= maxRetries; round += 1) {
    const outcome = await runOnce(cmd, workDir, waitMs)
    attempts.push(outcome)
    if (outcome.ok) break
    if (outcome.timedOut) break
    if (round < maxRetries) await delay(1000)
  }

  const last = attempts[attempts.length - 1]
  const lines = [
    `命令：${cmd}`,
    `工作目录：${workDir}`,
    `结果：${last.ok ? '成功' : `失败（退出码 ${last.code}${last.timedOut ? '，超时' : ''}）`}`,
    `尝试：${attempts.length} 次${attempts.length > 1 ? `（失败后自动重试，最多 ${maxRetries} 次）` : ''}`,
    `耗时：${last.ms}ms`,
    `环境变量：仅 PATH 等基础变量 + DeepSeek key，不含 QQ 密钥`,
  ]

  if (attempts.length > 1) {
    lines.push(
      `前 ${attempts.length - 1} 次失败：${attempts
        .slice(0, -1)
        .map((item, index) => `第${index + 1}次退出码 ${item.code}`)
        .join('，')}`,
    )
  }

  if (last.stdout.trim()) lines.push(`\nstdout:\n${truncate(last.stdout)}`)
  if (last.stderr.trim()) lines.push(`\nstderr:\n${truncate(last.stderr)}`)

  return lines.join('\n')
}

export const SHELL_HANDLERS = { shell }

export const SHELL_TOOLS = [
  {
    name: 'shell',
    description:
      '在服务器上执行 shell 命令，用于跑脚本、装依赖、git 操作、查看文件、运行测试。' +
      '命令失败（退出码非 0）时会自动重试，默认最多 3 次。' +
      '限制：只能在项目目录内执行；禁止删除根目录、关机、读 .env、下载后直接执行远程脚本。' +
      '给非零退出码但属正常情况的命令（如 grep 无匹配）建议传 retries: 0。',
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: '要执行的命令，如 "pnpm test" 或 "ls -la src"' },
        cwd: { type: 'string', description: '工作目录，相对项目根，可选' },
        timeout_ms: { type: 'integer', description: '超时毫秒，默认 60000，上限 300000' },
        retries: { type: 'integer', description: '失败重试次数，默认 3，0 表示不重试，上限 5' },
      },
      required: ['command'],
    },
  },
]
