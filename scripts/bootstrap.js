#!/usr/bin/env node
// 一键初始化：检测平台 → 装依赖 → 建目录 → 生成密钥文件 → 装外部工具。
// 用法：
//   node scripts/bootstrap.js              检测并自动安装缺失的东西
//   node scripts/bootstrap.js --check      只检测，不改动任何文件
//   node scripts/bootstrap.js --no-install 不装外部工具（yt-dlp / ffmpeg / bwrap）
//
// 只做「装」和「建」两类事，不启动机器人、不写 pm2 配置——
// 那一步留给用户确认，脚本最后会打印对应平台的命令。
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { defaultEnvFile, isElevated, isLinux, isMac, isWindows, platform } from '../src/ops/platform.js'

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const argv = process.argv.slice(2)
const CHECK_ONLY = argv.includes('--check')
const NO_INSTALL = argv.includes('--no-install') || CHECK_ONLY
const HELP = argv.includes('--help') || argv.includes('-h')

const MIN_NODE = [20, 12]
const BIN = isWindows ? (name) => `${name}.cmd` : (name) => name

const ok = (text) => `\x1b[32m✓\x1b[0m ${text}`
const bad = (text) => `\x1b[31m✗\x1b[0m ${text}`
const info = (text) => `\x1b[36m→\x1b[0m ${text}`
const dim = (text) => `\x1b[2m${text}\x1b[0m`

const problems = []
const warnings = []

if (HELP) {
  console.log(`
用法: node scripts/bootstrap.js [选项]

  --check       只检测，不改动任何文件
  --no-install  跳过外部工具安装（yt-dlp / ffmpeg / bwrap）
  --help        显示这段说明

外部工具不是必需的：缺 yt-dlp 就下不了视频，缺 ffmpeg 就切不了片段和转语音，
缺 bwrap 只是少一层隔离（Linux）。只有密钥和依赖是必填的。
`)
  process.exit(0)
}

function step(index, total, title) {
  console.log(`\n[${index}/${total}] ${title}`)
}

function run(command, args = [], options = {}) {
  // Windows 上 .cmd / .bat 不能直接 spawn（Node 20 起报 EINVAL），要走 cmd.exe 转发
  const needsShell = isWindows && /\.(cmd|bat)$/i.test(command)
  const bin = needsShell ? 'cmd.exe' : command
  const finalArgs = needsShell ? ['/d', '/s', '/c', command, ...args] : args

  const result = spawnSync(bin, finalArgs, {
    encoding: 'utf8',
    timeout: 600_000,
    stdio: options.inherit ? 'inherit' : 'pipe',
    ...options,
  })
  return {
    ok: result.status === 0,
    status: result.status,
    stdout: String(result.stdout ?? '').trim(),
    stderr: String(result.stderr ?? '').trim(),
    error: result.error,
  }
}

/** 有新版本就返回版本号，没有返回 null */
function versionOf(command, args = ['--version']) {
  const result = run(command, args)
  if (!result.ok) return null
  return result.stdout.split('\n')[0].trim() || '已安装'
}

function compareVersion(current, minimum) {
  const a = current.split('.').map(Number)
  const b = minimum
  for (let i = 0; i < b.length; i += 1) {
    const left = a[i] ?? 0
    if (left > b[i]) return 1
    if (left < b[i]) return -1
  }
  return 0
}

// ── 系统包装载器 ──
// 每个平台一套命令，别在业务逻辑里 if 平台。

function apt(packages) {
  const prefix = isElevated() ? [] : ['-n']
  const command = isElevated() ? 'apt-get' : 'sudo'
  const args = isElevated() ? ['install', '-y', ...packages] : [...prefix, 'apt-get', 'install', '-y', ...packages]
  return run(command, args, { inherit: true })
}

function brew(packages) {
  return run('brew', ['install', ...packages], { inherit: true })
}

function winget(id) {
  return run('winget', ['install', '--id', id, '--accept-package-agreements', '--accept-source-agreements'], {
    inherit: true,
  })
}

function installPackages(packages) {
  if (NO_INSTALL) return false
  if (isLinux) return apt(packages).ok
  if (isMac) return brew(packages).ok
  return false
}

// ── 1. Node ──

function checkNode() {
  const current = process.versions.node
  const passed = compareVersion(current, MIN_NODE) >= 0
  console.log(passed ? ok(`Node ${current}`) : bad(`Node ${current} 太旧，需要 >= ${MIN_NODE.join('.')}`))
  if (!passed) {
    problems.push(`Node 版本过低（${current}），升级到 ${MIN_NODE.join('.')} 以上再来`)
    if (isLinux) console.log(dim('  升级：curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt-get install -y nodejs'))
    else if (isMac) console.log(dim('  升级：brew install node@22'))
    else console.log(dim('  升级：winget install OpenJS.NodeJS.LTS'))
  }
  return passed
}

// ── 2. pnpm ──

function checkPnpm() {
  const version = versionOf(BIN('pnpm'), ['--version'])
  if (version) {
    console.log(ok(`pnpm ${version}`))
    return true
  }

  console.log(bad('pnpm 没装'))
  if (CHECK_ONLY) {
    problems.push('pnpm 没装（corepack enable 或 npm i -g pnpm）')
    return false
  }

  console.log(info('用 corepack 打开 pnpm（Node 自带，不用额外下载）'))
  const enabled = run('corepack', ['enable'])
  if (!enabled.ok) {
    console.log(bad(`corepack enable 失败：${enabled.stderr || enabled.error?.message || '未知原因'}`))
    problems.push('pnpm 装不上，手动执行 npm i -g pnpm 后重跑')
    return false
  }

  const after = versionOf(BIN('pnpm'), ['--version'])
  if (after) {
    console.log(ok(`pnpm ${after}`))
    return true
  }

  problems.push('corepack 开了但 pnpm 仍然不可用，手动执行 npm i -g pnpm')
  return false
}

// ── 3. 项目依赖 ──

function checkDeps() {
  const marker = path.join(projectRoot, 'node_modules', 'qq-official-bot', 'package.json')
  if (fs.existsSync(marker)) {
    console.log(ok('依赖已安装'))
    return true
  }

  if (CHECK_ONLY) {
    console.log(bad('依赖没装'))
    problems.push('依赖没装（pnpm install）')
    return false
  }

  console.log(info('安装依赖（pnpm install，第一次要几分钟）'))
  const result = run(BIN('pnpm'), ['install'], { cwd: projectRoot, inherit: true })
  if (!result.ok) {
    console.log(bad('pnpm install 失败'))
    problems.push('pnpm install 失败，看上面的报错')
    return false
  }
  console.log(ok('依赖装好了'))
  return true
}

// ── 4. 运行目录 ──

const DIRS = ['data', 'downloads', 'logs', 'tmp', 'backups', 'skills']

function checkDirs() {
  const missing = DIRS.filter((name) => !fs.existsSync(path.join(projectRoot, name)))
  if (missing.length === 0) {
    console.log(ok(`运行目录都在（${DIRS.join(' ')}）`))
    return true
  }

  if (CHECK_ONLY) {
    console.log(info(`缺目录：${missing.join(' ')}`))
    return true
  }

  for (const name of missing) fs.mkdirSync(path.join(projectRoot, name), { recursive: true })
  console.log(ok(`建好了：${missing.join(' ')}`))
  return true
}

// ── 5. 密钥文件 ──

function checkEnvFile() {
  const target = process.env.APP_ENV_FILE?.trim() || defaultEnvFile()
  const exists = fs.existsSync(target)

  if (exists) {
    const size = fs.statSync(target).size
    const mode = isWindows ? '' : ` (${(fs.statSync(target).mode & 0o777).toString(8)})`
    console.log(ok(`${target}${mode} 已存在，${size} 字节`))
    if (size < 40) {
      problems.push(`${target} 太小（${size} 字节），大概只复制了模板没填密钥`)
    }
    return exists
  }

  if (CHECK_ONLY) {
    console.log(bad(`密钥文件不存在：${target}`))
    problems.push(`密钥文件不存在：${target}`)
    return false
  }

  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.copyFileSync(path.join(projectRoot, '.env.example'), target)
  if (!isWindows) fs.chmodSync(target, 0o600)

  console.log(info(`生成模板：${target}`))
  console.log(dim('  接着把 DEEP_SEEK_API_KEY / QQ_APP_ID / QQ_APP_SECRET 三行填进去'))
  problems.push(`密钥还没填：${target}`)
  return false
}

// ── 6. 外部工具 ──

const TOOLS = [
  {
    name: 'yt-dlp',
    probe: ['--version'],
    need: '下视频、切片段',
    install: () => {
      if (isLinux) {
        if (versionOf('pipx', ['--version'])) {
          return run('pipx', ['install', 'yt-dlp'], { inherit: true }).ok
        }
        return installPackages(['yt-dlp'])
      }
      if (isMac) return brew(['yt-dlp']).ok
      return winget('yt-dlp.yt-dlp').ok
    },
  },
  {
    name: 'ffmpeg',
    probe: ['-version'],
    need: '视频切片、转码、文字转语音',
    install: () => {
      if (isLinux) return installPackages(['ffmpeg'])
      if (isMac) return brew(['ffmpeg']).ok
      return winget('Gyan.FFmpeg').ok
    },
  },
  {
    name: 'bwrap',
    probe: ['--version'],
    need: 'Linux 上的命令沙箱（其他平台没有）',
    only: 'linux',
    install: () => installPackages(['bubblewrap']),
  },
]

function checkTools() {
  let healthy = true

  for (const tool of TOOLS) {
    if (tool.only === 'linux' && !isLinux) {
      console.log(dim(`  ${tool.name.padEnd(10)} — ${isMac ? 'macOS' : 'Windows'} 上没有可用沙箱，跳过`))
      continue
    }

    const command = tool.name === 'bwrap' ? 'bwrap' : BIN(tool.name)
    const version = versionOf(command, tool.probe)
    if (version) {
      console.log(ok(`  ${tool.name.padEnd(10)} ${version}`))
      continue
    }

    healthy = false
    if (NO_INSTALL) {
      console.log(bad(`  ${tool.name.padEnd(10)} 没装（${tool.need}）`))
      warnings.push(`${tool.name} 没装：${tool.need} 不可用（手动装：${manualHint(tool.name)}）`)
      continue
    }

    console.log(info(`  ${tool.name.padEnd(10)} 没装，正在安装…`))
    const installed = tool.install()
    const now = installed ? versionOf(command, tool.probe) : null

    if (now) {
      console.log(ok(`  ${tool.name.padEnd(10)} ${now}`))
      healthy = true
    } else {
      console.log(bad(`  ${tool.name.padEnd(10)} 装不上，${tool.need} 会不可用`))
      console.log(dim(`    手动装：${manualHint(tool.name)}`))
      warnings.push(`${tool.name} 装不上：${tool.need} 会不可用`)
    }
  }

  return healthy
}

function manualHint(name) {
  if (isLinux) {
    return name === 'yt-dlp' ? 'pipx install yt-dlp' : `sudo apt-get install -y ${name === 'bwrap' ? 'bubblewrap' : name}`
  }
  if (isMac) return `brew install ${name}`
  return name === 'ffmpeg' ? 'winget install Gyan.FFmpeg' : 'winget install yt-dlp.yt-dlp'
}

// ── 下一步提示 ──

function nextSteps() {
  console.log('\n下一步：')

  if (isWindows) {
    console.log('  pm2 start ecosystem.config.cjs')
    console.log('  pm2 save')
    console.log(dim('  开机自启：pm2 不支持 Windows 的 pm2 startup，用 pm2-installer：'))
    console.log(dim('    npm i -g pm2-installer && pm2-installer'))
    console.log(dim('  或者把启动命令做成「任务计划程序」里的登录时任务'))
  } else if (isMac) {
    console.log('  pm2 start ecosystem.config.cjs')
    console.log('  pm2 save')
    console.log('  pm2 startup            # 按它打印的那行再执行一次，配 launchd 自启')
  } else {
    console.log('  pm2 start ecosystem.config.cjs')
    console.log('  pm2 save')
    console.log('  pm2 startup            # 按它打印的那行再执行一次，配 systemd 自启')
  }

  console.log(dim('\n  日志：pm2 logs dafeiyu'))
  console.log(dim('  体检：pnpm diagnose'))
}

// ── 主流程 ──

console.log(`\n万能大肥鱼 · 环境初始化${CHECK_ONLY ? '（只检测）' : ''}`)
console.log(
  dim(
    `${platform} ${process.arch}｜Node ${process.versions.node}｜` +
      (isWindows ? 'Windows 无需提权' : isElevated() ? 'root' : '普通用户（装包会走 sudo）'),
  ),
)

const TOTAL = 6
step(1, TOTAL, 'Node 版本')
checkNode()
step(2, TOTAL, 'pnpm')
checkPnpm()
step(3, TOTAL, '项目依赖')
checkDeps()
step(4, TOTAL, '运行目录')
checkDirs()
step(5, TOTAL, '密钥文件')
checkEnvFile()
step(6, TOTAL, '外部工具')
checkTools()

console.log('')

if (warnings.length > 0) {
  console.log(info('可选（不影响启动，只是对应功能不可用）：'))
  for (const item of warnings) console.log(`  - ${item}`)
  console.log('')
}

if (problems.length === 0) {
  console.log(ok('必需的都齐了'))
  nextSteps()
  process.exit(0)
}

console.log(bad(`${problems.length} 项必须先处理：`))
for (const item of problems) console.log(`  - ${item}`)
console.log('')
process.exit(1)
