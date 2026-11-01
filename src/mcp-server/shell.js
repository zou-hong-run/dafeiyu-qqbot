import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { execFile, spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const tmpDir = path.join(projectRoot, 'tmp')
const logDir = path.join(projectRoot, 'logs')
const MAX_OUTPUT = 3000
const MAX_COMMAND = 4000
const MAX_SCRIPT = 40_000

// SHELL_UNRESTRICTED=true 时只保留最基本的非空校验，命令完全交给模型
const UNRESTRICTED = process.env.SHELL_UNRESTRICTED === 'true'

const BLOCKED_PATTERNS = [
  { pattern: /rm\s+(-[a-zA-Z]+\s+)*\/(\s|$|\*)/, reason: '禁止删除根目录' },
  { pattern: /rm\s+(-[a-zA-Z]+\s+)*(~|\$HOME)(\/|\s|$)/, reason: '禁止删除用户主目录' },
  // 只允许删项目内的相对路径和 /tmp，别把宝塔站点、系统目录一起带走
  {
    pattern: /rm\s+(-[a-zA-Z]+\s+)*\/(?!tmp\/)[^\s]*/,
    reason: '禁止删除项目目录以外的绝对路径（只能删项目内相对路径或 /tmp 下的东西）',
  },
  { pattern: /:\(\)\s*\{.*\};\s*:/, reason: '禁止 fork 炸弹' },
  { pattern: /\b(shutdown|reboot|halt|poweroff|init\s+0)\b/i, reason: '禁止关机或重启' },
  { pattern: /\b(mkfs|fdisk|dd\s+if=|dd\s+of=\/dev)/i, reason: '禁止磁盘操作' },
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

const isLinux = process.platform === 'linux'

const HEAVY_COMMAND =
  /\b(apt|apt-get|dpkg)\s+(install|upgrade|dist-upgrade|--configure)|\b(pnpm|npm|yarn)\s+(add|install|i)\b|\bpip3?\s+install\b|\bdocker\s+(build|pull)\b|\bcargo\s+build\b|\bgo\s+build\b|\bmake\s+-j/i

const MEMORY_RESCUE =
  /\b(swapon|swapoff|mkswap|fallocate|fstab|sysctl|free|df|du|ps|top|htop|kill|pkill|reboot)\b/i

function readLinuxMemory() {
  try {
    const raw = fs.readFileSync('/proc/meminfo', 'utf8')
    const pick = (key) => {
      const match = raw.match(new RegExp(`^${key}:\\s+(\\d+)`, 'm'))
      return match ? Number(match[1]) / 1024 : null
    }

    const totalMB = pick('MemTotal')
    const availableMB = pick('MemAvailable') ?? pick('MemFree')
    if (!totalMB || !availableMB) return null

    const swapTotalMB = pick('SwapTotal') ?? 0

    return { totalMB, availableMB, swapTotalMB }
  } catch {
    return null
  }
}

function assertMemory(command) {
  const mem = readLinuxMemory()
  if (!mem) return

  if (MEMORY_RESCUE.test(command)) return

  const video = VIDEO_PROCESS.test(command)
  const heavy = HEAVY_COMMAND.test(command)
  const needMB = video ? VIDEO_NEED_MB : heavy ? 600 : 150

  // 小机器没 swap，随便一个重活就能把整机拖死，先拦住
  if ((video || heavy) && mem.totalMB < 2048 && mem.swapTotalMB < 500) {
    throw new Error(
      `这台机器内存 ${mem.totalMB.toFixed(0)}MB、swap ${mem.swapTotalMB.toFixed(0)}MB，` +
        `跑${video ? '视频处理' : '安装/编译'}类命令很容易把整机 OOM 掉（上次就是 ffmpeg 把宝塔面板带走的）。\n` +
        '先加 swap 再来：\n' +
        '  fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile',
    )
  }

  if (mem.availableMB >= needMB) return

  const hint = heavy
    ? '这是安装类命令，很容易把机器打爆。先加 swap 再来：\n' +
      '  fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile'
    : '先用 free -m 看看谁在吃内存，清理后再试。'

  throw new Error(
    `内存不足：可用 ${mem.availableMB.toFixed(0)}MB / 总计 ${mem.totalMB.toFixed(0)}MB。` +
      `执行${heavy ? '安装类' : '该'}命令需要至少 ${needMB}MB 可用。\n${hint}`,
  )
}

function wrapRiskyCommand(command) {
  if (!isLinux) return command
  if (!VIDEO_PROCESS.test(command)) return command
  if (/\bulimit\b/i.test(command)) return command

  // 限制虚拟内存 + 降 CPU 优先级：内存爆了先 OOM 自己，别把整机拖死
  return `ulimit -v ${VIDEO_ULIMIT_MB * 1000} 2>/dev/null; nice -n 19 ${command}`
}

function assertSafeCommand(command, { script = false } = {}) {
  const limit = script ? MAX_SCRIPT : MAX_COMMAND
  if (command.length > limit) throw new Error(`内容太长（${command.length} 字符），上限 ${limit}`)
  if (command.includes('\0')) throw new Error('内容包含非法字符')
  if (UNRESTRICTED) return

  for (const { pattern, reason } of BLOCKED_PATTERNS) {
    if (pattern.test(command)) throw new Error(`已拦截：${reason}。换成安全的写法再试，或在 .env 设 SHELL_UNRESTRICTED=true 彻底放开。`)
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

function runInBackground(command, cwd) {
  fs.mkdirSync(logDir, { recursive: true })
  const logFile = path.join(logDir, `bg-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.log`)

  // 让命令自己把输出重定向到日志文件，比继承 fd 更可靠（父子进程、跨平台都稳）
  // 括号包起来是必须的：不然 `a && b >> log` 只有 b 会进日志
  const child = spawn(`( ${command} ) >> "${logFile}" 2>&1`, {
    shell: true,
    cwd,
    detached: true,
    stdio: 'ignore',
  })

  child.on('error', (error) => {
    try {
      fs.appendFileSync(logFile, `\n[启动失败] ${error?.message ?? error}\n`)
    } catch {
      // 日志写不进去就算了
    }
  })

  child.unref()

  return { pid: child.pid, logFile: path.relative(projectRoot, logFile).split(path.sep).join('/') }
}

async function shell({ command, cwd, timeout_ms: timeoutMs, retries, background }) {
  const cmd = String(command ?? '').trim()
  if (!cmd) throw new Error('命令不能为空')

  assertSafeCommand(cmd)
  assertMemory(cmd)
  const workDir = resolveCwd(cwd)

  if (background) {
    const { pid, logFile } = runInBackground(cmd, workDir)
    return [
      `命令已在后台启动：${cmd}`,
      `工作目录：${workDir}`,
      `进程 PID：${pid}`,
      `日志文件：${logFile}`,
      '',
      `稍后用 shell 执行 \`tail -n 50 ${logFile}\` 看进度；进程是否还在用 \`ps -p ${pid}\` 查。`,
      '后台进程不随这次对话结束被杀掉。如果日志一直是空的、进程也查不到，说明这条命令在后台起不来，改前台执行。',
    ].join('\n')
  }

  const execCmd = wrapRiskyCommand(cmd)

  const waitMs = Math.min(Math.max(Number(timeoutMs) || 120_000, 1000), 600_000)
  const maxRetries = Math.min(Math.max(Number(retries ?? 3), 0), 5)

  const attempts = []
  for (let round = 0; round <= maxRetries; round += 1) {
    const outcome = await runOnce(execCmd, workDir, waitMs)
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

  if (last.timedOut && VIDEO_PROCESS.test(cmd)) {
    lines.push(
      '\n⚠️ 视频处理超时了。**不要换条命令再试一次**——每试一次就多一个 ffmpeg，' +
        '几个叠起来会把这台 1.5G 的机器直接 OOM（上次就是这么把宝塔面板带走的）。\n' +
        '正确做法：先用 background:true 放后台，加 `-threads 1` 限制线程，' +
        '或者先把分辨率/时长降下来（例如 `-vf scale=640:-2 -t 30`）再转。',
    )
  }

  if (last.stdout.trim()) lines.push(`\nstdout:\n${truncate(last.stdout)}`)
  if (last.stderr.trim()) lines.push(`\nstderr:\n${truncate(last.stderr)}`)

  return lines.join('\n')
}

export const SHELL_HANDLERS = { shell, run_script: runScript, restart_self: restartSelf }

const PM2_MANAGED = process.env.PM2_MANAGED === '1'
const PM2_APP = process.env.PM2_APP_NAME?.trim() || 'dafeiyu'

async function restartSelf({ delay_seconds: delaySeconds = 6, reason = '' }) {
  if (!PM2_MANAGED) {
    throw new Error(
      '当前进程不是 pm2 托管的，自重启用不了。本地开发直接 Ctrl+C 再 pnpm start；' +
        '线上请用 ecosystem.config.cjs 启动（pm2 start ecosystem.config.cjs）。',
    )
  }

  const delay = Math.min(Math.max(Number(delaySeconds) || 6, 2), 60)
  const note = String(reason ?? '').trim().slice(0, 120)
  const { pid, logFile } = runInBackground(`sleep ${delay} && pm2 restart ${PM2_APP}`, projectRoot)

  return [
    `已安排 ${delay} 秒后重启 ${PM2_APP}（调度进程 PID ${pid}）。`,
    note ? `原因：${note}` : '',
    `日志：${logFile}`,
    '',
    '现在立刻用一句简短的话告诉用户「正在重启，稍等十几秒」，不要再调用其他工具。',
    '重启会中断当前对话（进程被 pm2 拉起后是全新的），记忆已落盘不会丢。',
    '如果过一分钟还没反应，用 tail 看上面那个日志，或者 pm2 list 看进程状态。',
  ]
    .filter(Boolean)
    .join('\n')
}

const INTERPRETERS = {
  bash: { ext: 'sh', cmd: 'bash' },
  sh: { ext: 'sh', cmd: 'sh' },
  python: { ext: 'py', cmd: 'python3' },
  node: { ext: 'mjs', cmd: process.execPath },
}

async function runScript({ code, language = 'bash', cwd, timeout_ms: timeoutMs, retries, background, keep }) {
  const source = String(code ?? '').trim()
  if (!source) throw new Error('脚本内容不能为空')

  const spec = INTERPRETERS[String(language).toLowerCase()]
  if (!spec) throw new Error(`不支持的语言 ${language}，可选：${Object.keys(INTERPRETERS).join(' / ')}`)

  assertSafeCommand(source, { script: true })
  assertMemory(source)

  fs.mkdirSync(tmpDir, { recursive: true })
  const file = path.join(tmpDir, `script-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.${spec.ext}`)
  fs.writeFileSync(file, source.endsWith('\n') ? source : `${source}\n`)

  const scriptPath = path.relative(projectRoot, file).split(path.sep).join('/')
  const workDir = resolveCwd(cwd)
  // 用普通引号包路径（JSON.stringify 会做 JS 转义，反斜杠会变成双份，shell 认不出来）
  const command = `${spec.cmd} "${file.replace(/"/g, '\\"')}"`

  if (background) {
    const { pid, logFile } = runInBackground(command, workDir)
    return [
      `脚本已写入 ${scriptPath}（${source.length} 字符，${language}）`,
      `已在后台启动，PID：${pid}`,
      `日志文件：${logFile}`,
      '',
      `查看进度：tail -n 50 ${logFile}`,
      keep ? '脚本文件已保留，可继续修改后重跑。' : '脚本文件留在 tmp/ 里，/clean 会清掉。',
    ].join('\n')
  }

  const waitMs = Math.min(Math.max(Number(timeoutMs) || 120_000, 1000), 600_000)
  const maxRetries = Math.min(Math.max(Number(retries ?? 1), 0), 3)

  const attempts = []
  for (let round = 0; round <= maxRetries; round += 1) {
    const outcome = await runOnce(command, workDir, waitMs)
    attempts.push(outcome)
    if (outcome.ok || outcome.timedOut) break
    if (round < maxRetries) await delay(1000)
  }

  const last = attempts[attempts.length - 1]
  const lines = [
    `脚本已写入 ${scriptPath}（${source.length} 字符，${language}）`,
    `工作目录：${workDir}`,
    `结果：${last.ok ? '成功' : `失败（退出码 ${last.code}${last.timedOut ? '，超时' : ''}）`}`,
    `尝试：${attempts.length} 次`,
    `耗时：${last.ms}ms`,
  ]

  if (last.stdout.trim()) lines.push(`\nstdout:\n${truncate(last.stdout)}`)
  if (last.stderr.trim()) lines.push(`\nstderr:\n${truncate(last.stderr)}`)

  if (last.ok && !keep) {
    try {
      fs.rmSync(file, { force: true })
    } catch {
      // 删不掉就留着，/clean 会处理
    }
  }

  return lines.join('\n')
}

export const SHELL_TOOLS = [
  {
    name: 'shell',
    description:
      '在服务器上执行 shell 命令，用于跑脚本、装依赖、git 操作、查看文件、运行测试、管理进程（pm2 也可以）。' +
      '命令失败（退出码非 0）时会自动重试，默认最多 3 次。' +
      '长任务（转码、大文件下载、装大包）传 background:true，会在后台跑并返回 PID 和日志文件，用 tail 看进度。' +
      '仍被拦的只有：删根目录、关机、磁盘操作、读 .env / 导出环境变量 / 打印密钥、系统账号与 SSH 密钥。' +
      '要彻底放开就在 .env 设 SHELL_UNRESTRICTED=true。' +
      '给非零退出码但属正常情况的命令（如 grep 无匹配）建议传 retries: 0。',
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: '要执行的命令，如 "pnpm test" 或 "ls -la src"' },
        cwd: { type: 'string', description: '工作目录，相对项目根，可选' },
        timeout_ms: { type: 'integer', description: '超时毫秒，默认 120000，上限 600000' },
        retries: { type: 'integer', description: '失败重试次数，默认 3，0 表示不重试，上限 5' },
        background: {
          type: 'boolean',
          description: 'true = 后台运行不等待，立刻返回 PID 和日志路径，适合长任务',
        },
      },
      required: ['command'],
    },
  },
  {
    name: 'run_script',
    description:
      '把一段脚本写进 tmp/ 再执行。比 shell 更适合多行脚本：不用处理引号转义和换行，' +
      '代码原样落地成文件，失败还能保留下来继续改。' +
      'bash / python / node 三种都支持；长脚本传 background:true 后台跑并返回 PID 和日志。' +
      '默认执行完即删脚本文件，传 keep:true 保留。',
    inputSchema: {
      type: 'object',
      properties: {
        code: { type: 'string', description: '完整脚本内容，原样写入文件' },
        language: {
          type: 'string',
          description: 'bash / python / node，默认 bash',
          enum: ['bash', 'sh', 'python', 'node'],
        },
        cwd: { type: 'string', description: '工作目录，相对项目根，可选' },
        timeout_ms: { type: 'integer', description: '超时毫秒，默认 120000，上限 600000' },
        retries: { type: 'integer', description: '失败重试次数，默认 1，上限 3' },
        background: { type: 'boolean', description: 'true = 后台运行，立刻返回 PID 和日志路径' },
        keep: { type: 'boolean', description: 'true = 执行后保留脚本文件，方便继续修改' },
      },
      required: ['code'],
    },
  },
  {
    name: 'restart_self',
    description:
      '重启自己（pm2 拉起的那个进程）。改完源码、改了 .env、装了依赖需要生效时用这个，' +
      '不要用 shell 直接敲 pm2 restart——那样命令还没返回进程就被杀了，用户收不到回复。' +
      '调用后会延迟几秒再重启，你有时间先把「正在重启」这句话发出去。只管理员可用。',
    inputSchema: {
      type: 'object',
      properties: {
        delay_seconds: {
          type: 'integer',
          description: '延迟多少秒后重启，默认 6，范围 2-60，给回复留发送时间',
        },
        reason: { type: 'string', description: '为什么要重启，写进日志方便以后回溯' },
      },
      required: [],
    },
  },
]
