import fs from 'node:fs'
import path from 'node:path'
import { execFile, spawn } from 'node:child_process'
import { caps, isWindows, memoryInfo } from '../ops/platform.js'
import { budgetFor } from '../ops/budget.js'
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

const isLinux = caps.canUlimit // 只有 Linux 能靠 ulimit 限内存，其余平台自动跳过

const HEAVY_COMMAND =
  /\b(apt|apt-get|dpkg)\s+(install|upgrade|dist-upgrade|--configure)|\b(pnpm|npm|yarn)\s+(add|install|i)\b|\bpip3?\s+install\b|\bdocker\s+(build|pull)\b|\bcargo\s+build\b|\bgo\s+build\b|\bmake\s+-j/i

// 视频转码是最容易把 2G 小机器打死的操作：一个 ffmpeg 能吃 700MB，
// 超时后模型还可能重试，几个进程叠起来就 OOM
const VIDEO_PROCESS = /\b(ffmpeg|ffprobe|avconv)\b/i
const budget = budgetFor()
const VIDEO_NEED_MB = Math.max(700, Math.round(budget.heavyNeedMB * 1.6))
const VIDEO_ULIMIT_MB = 480
const DEFAULT_ULIMIT_MB = Number(process.env.SHELL_ULIMIT_MB || budget.shellUlimitMB)

const MEMORY_RESCUE =
  /\b(swapon|swapoff|mkswap|fallocate|fstab|sysctl|free|df|du|ps|top|htop|kill|pkill|reboot)\b/i



// ── 脚本资源预估 ──
// 执行前先算账：扫脚本/命令里引用的文件、显式内存分配、循环规模，
// 估出峰值内存再决定放不放行。2G 机器经不起「先跑起来看看」。
const EXT_LIST = 'mp4|mov|mkv|avi|webm|flv|csv|tsv|json|jsonl|log|zip|tar|gz|png|jpg|jpeg|gif|webp|bmp|pdf|docx|xlsx|txt|md|py|js|mjs|ts|wav|mp3|silk|flac'

const FILE_HINT = new RegExp(`['"]([^'"\\r\\n]{3,200}\\.(?:${EXT_LIST}))['"]`, 'gi')
// 命令行里通常不带引号：ffmpeg -i tmp/clip.mp4
const BARE_HINT = new RegExp(`(?:^|[\\s'"=])([\\w./-]{2,200}\\.(?:${EXT_LIST}))(?=[\\s'"]|$)`, 'gi')

function collectFileRefs(text) {
  const refs = new Set()
  const source = String(text ?? '')

  for (const matched of source.matchAll(FILE_HINT)) refs.add(matched[1])
  for (const matched of source.matchAll(BARE_HINT)) refs.add(matched[1])

  return [...refs]
}

const KIND_FACTOR = {
  video: { factor: 2.5, label: '视频解码' },
  audio: { factor: 4, label: '音频解码' },
  image: { factor: 6, label: '图片解码' },
  table: { factor: 4, label: '表格载入' },
  json: { factor: 3, label: 'JSON 解析' },
  text: { factor: 2, label: '文本读入' },
  archive: { factor: 2, label: '压缩包处理' },
  script: { factor: 0.5, label: '源码读取' },
}

function classifyFile(ext) {
  const e = ext.toLowerCase()
  if (['.mp4', '.mov', '.mkv', '.avi', '.webm', '.flv'].includes(e)) return 'video'
  if (['.wav', '.mp3', '.silk', '.flac'].includes(e)) return 'audio'
  if (['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp'].includes(e)) return 'image'
  if (['.csv', '.tsv', '.xlsx', '.docx'].includes(e)) return 'table'
  if (['.json', '.jsonl'].includes(e)) return 'json'
  if (['.zip', '.tar', '.gz'].includes(e)) return 'archive'
  if (['.py', '.js', '.mjs', '.ts'].includes(e)) return 'script'
  return 'text'
}

const BASE_MEM_MB = 64

export function estimateResourceUsage(text, cwd) {
  let memMB = BASE_MEM_MB
  const notes = []
  const seen = new Set()

  // 1) 引用的文件：按类型乘系数估解码/解析缓冲
  for (const rel of collectFileRefs(text)) {
    if (seen.has(rel)) continue
    seen.add(rel)

    let stat
    try {
      stat = fs.statSync(path.resolve(cwd, rel))
    } catch {
      continue
    }
    if (!stat.isFile()) continue

    const kind = classifyFile(path.extname(rel))
    const { factor, label } = KIND_FACTOR[kind] ?? KIND_FACTOR.text
    const fileMB = stat.size / 1048576
    const costMB = Math.max(fileMB * factor, 2)

    memMB += costMB
    if (costMB >= 20) {
      notes.push(`${rel} ${fileMB.toFixed(1)}MB ×${factor}（${label}）≈ ${costMB.toFixed(0)}MB`)
    }
  }

  // 2) 显式分配：bytearray(N) / np.zeros((a, b)) / [0]*N / Buffer.alloc(N)
  const explicitPatterns = [
    { re: /bytearray\(\s*(\d{4,})/, unit: 1, name: 'bytearray', dims: 1 },
    { re: /np\.(?:zeros|ones|empty)\(\s*\(?\s*(\d+)\s*(?:,\s*(\d+))?/, unit: 8, name: 'numpy 数组', dims: 2 },
    { re: /\[\s*0\s*\]\s*\*\s*(\d{5,})/, unit: 28, name: 'Python 列表', dims: 1 },
    { re: /Buffer\.alloc\(\s*(\d{5,})/, unit: 1, name: 'Buffer', dims: 1 },
  ]

  for (const { re, unit, name, dims } of explicitPatterns) {
    const matched = String(text ?? '').match(re)
    if (!matched) continue

    const first = Number(matched[1])
    const second = dims === 2 && matched[2] ? Number(matched[2]) : 1
    if (!Number.isFinite(first) || first <= 0) continue

    const count = first * (Number.isFinite(second) && second > 0 ? second : 1)
    const costMB = (count * unit) / 1048576
    memMB += costMB
    notes.push(`${name} ${count.toLocaleString('en-US')} 个元素 ≈ ${costMB.toFixed(0)}MB`)
  }

  // 3) ffmpeg：命令行没写路径时也得给个底
  if (VIDEO_PROCESS.test(String(text ?? '')) && notes.length === 0) {
    memMB += 300
    notes.push('ffmpeg 默认预留 300MB')
  }

  return { memMB: Math.round(memMB), notes }
}

function assertEstimate(estimate, text) {
  const mem = memoryInfo()
  if (!mem) return estimate

  const { memMB, notes } = estimate
  const detail = notes.length > 0 ? `\n明细：\n  ${notes.join('\n  ')}` : ''

  // 留 25% 缓冲：这台机器总共才 1.6G，扣掉系统和其他服务，不能把可用内存吃干
  const ceiling = Math.max(120, Math.floor(mem.availableMB * 0.75))

  if (memMB > ceiling) {
    throw new Error(
      `预估要 ${memMB}MB，超过安全线 ${ceiling}MB（当前可用 ${mem.availableMB.toFixed(0)}MB × 75%，` +
        `总内存 ${mem.totalMB.toFixed(0)}MB）。直接跑很可能触发 OOM。${detail}\n` +
        '改法：缩小输入（截取片段、降分辨率）、分批处理、或者先腾内存（free -m 看谁占着）。',
    )
  }

  const tight = mem.availableMB - memMB < 150
  if (tight) {
    console.warn(`[预估] 内存偏紧：预估 ${memMB}MB，可用 ${mem.availableMB.toFixed(0)}MB`)
  }

  return { ...estimate, tight }
}

function assertMemory(command) {
  const mem = memoryInfo()
  if (!mem) return

  if (MEMORY_RESCUE.test(command)) return

  // 可用内存不到 300MB 时除了救援命令一律停摆：这时候再跑任何东西都可能触发 OOM
  if (mem.availableMB < 300) {
    throw new Error(
      `可用内存只剩 ${mem.availableMB.toFixed(0)}MB（总 ${mem.totalMB.toFixed(0)}MB），` +
        '现在跑任何命令都可能把整机拖进 OOM，先腾内存再说。\n' +
        '救援命令不受限制：free -m、ps aux --sort=-%mem | head、kill <pid>、pm2 list',
    )
  }

  const video = VIDEO_PROCESS.test(command)
  const heavy = HEAVY_COMMAND.test(command)
  const needMB = video ? VIDEO_NEED_MB : heavy ? 550 : 120

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
  if (/\bulimit\b/i.test(command)) return command

  const video = VIDEO_PROCESS.test(command)
  const limitMB = video ? VIDEO_ULIMIT_MB : DEFAULT_ULIMIT_MB

  // 每个命令都设内存上限：子进程撑爆了自己先死，别把整机拖进 OOM
  const prefix = `ulimit -v ${limitMB * 1000} 2>/dev/null`
  return video ? `${prefix}; nice -n 19 ${command}` : `${prefix}; ${command}`
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

  // 用文件描述符接输出，不拼 `( ) >> log`：那是 POSIX 语法，Windows 的 cmd 不认。
  // 顺带解决 `a && b >> log` 只有 b 进日志的老问题。
  const logFd = fs.openSync(logFile, 'a')
  const child = spawn(command, {
    shell: true,
    cwd,
    // Windows 上 detached 会另开控制台，反而留不干净，用默认行为
    detached: !isWindows,
    stdio: ['ignore', logFd, logFd],
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
  const estimate = assertEstimate(estimateResourceUsage(cmd, workDir), cmd)

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
    `预估内存：约 ${estimate.memMB}MB${estimate.tight ? '（当前可用内存偏紧）' : ''}`,
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

  // 留个标记，重启后新进程会读它，用来告诉用户「为什么重启」
  try {
    const pending = path.join(projectRoot, 'data', 'restart-pending.json')
    fs.mkdirSync(path.dirname(pending), { recursive: true })
    fs.writeFileSync(pending, JSON.stringify({ at: Date.now(), reason: note, app: PM2_APP }))
  } catch {
    // 写不进去就算了，播报会退回默认文案
  }

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

  const workDirForEstimate = resolveCwd(cwd)
  const estimate = assertEstimate(estimateResourceUsage(source, workDirForEstimate), source)

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
    `预估内存：约 ${estimate.memMB}MB${estimate.tight ? '（当前可用内存偏紧）' : ''}`,
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
      '执行前会预估内存（按命令里引用的文件大小和类型系数），超了直接拒绝。' +
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
      '执行前会按脚本里引用的文件大小、numpy/Buffer 分配量预估内存，' +
      '估算超过当前可用内存会直接拒绝并说明原因，结果里也会回显预估值。' +
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
