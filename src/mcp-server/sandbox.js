import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
import { sandboxStatus } from '../ops/platform.js'

// 把命令包进 bwrap：只读挂整个根，只有工作目录和一个临时 /tmp 可写。
// 没网（除非命令明确需要联网），看不到宿主的环境变量和家目录。
// bwrap 不可用时返回 null，调用方自己决定降级策略。

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

// 装包、拉代码这类必须有网，其余一律断网
const NEEDS_NETWORK = /\b(pnpm|npm|yarn|npx|pip3?|apt|apt-get|yum|dnf|apk|brew|git|curl|wget)\b/

// `--ro-bind / /` 只能挡写，挡不住读。bwrap 默认一个 capability 都不给，
// 但下面要补 DAC 越权让 root 能写属 www 的项目目录，所以读取面得单独挡住：
// 目录挂空 tmpfs（整个目录变空），文件盖成 /dev/null（读到 0 字节）。
export const SHIELDED_DIRS = [
  '/etc/dafeiyu', // 外部密钥文件所在目录
  '/root/.ssh', // SSH 私钥
]

export const SHIELDED_FILES = [
  process.env.APP_ENV_FILE?.trim() || '/etc/dafeiyu/env',
  path.join(projectRoot, '.env'),
  '/root/.pm2/dump.pm2', // pm2 保存的进程列表，里面是启动时的 env 快照
]

function exists(target) {
  try {
    return fs.existsSync(target)
  } catch {
    return false
  }
}

function coveredByDir(target, dirs) {
  return dirs.some((dir) => target === dir || target.startsWith(dir + path.sep))
}

/** 生成遮蔽参数：目录挂空 tmpfs，文件盖成 /dev/null */
export function shieldArgs({ dirs = SHIELDED_DIRS, files = SHIELDED_FILES } = {}) {
  // 两条参数都要求目标存在：--tmpfs 挂不上不存在的目录，
  // --ro-bind-try 只忽略「源不存在」，目标不存在时会去只读根上创建挂载点而失败。
  const usingDirs = dirs.filter(exists)
  const usingFiles = files.filter((file) => exists(file) && !coveredByDir(file, usingDirs))

  return [
    ...usingDirs.flatMap((dir) => ['--tmpfs', dir]),
    ...usingFiles.flatMap((file) => ['--ro-bind-try', '/dev/null', file]),
  ]
}

/**
 * @param {string} command 原始命令
 * @param {string} cwd 工作目录（必须已校验在项目内）
 * @returns {{ argv: string[], shell: boolean } | null} 包好的命令；null 表示沙箱不可用
 */
export function sandboxCommand(command, cwd) {
  const status = sandboxStatus()
  if (!status.available) return null

  const network = NEEDS_NETWORK.test(command)
  const isRoot = process.getuid?.() === 0

  const argv = [
    'bwrap',
    // 不用 --unshare-user：bwrap 的 userns 只映射一个 uid，/qq 属 www 的 inode
    // 不在映射里，CAP_DAC_OVERRIDE 对它们不生效（实测 touch 报 Permission denied）。
    // 改成丢掉除 DAC 越权之外的所有 capability：能写工作目录，
    // 但拿不到 mount / ptrace / bpf 这些能把只读根和遮蔽拆掉的能力。
    ...(isRoot ? ['--cap-drop', 'ALL', '--cap-add', 'CAP_DAC_OVERRIDE'] : []),
    // 其余命名空间照常隔离；网络按需
    '--unshare-pid',
    '--unshare-ipc',
    '--unshare-uts',
    ...(network ? [] : ['--unshare-net']),
    // 整个根只读挂载
    '--ro-bind', '/', '/',
    // 工作目录单独给读写
    '--bind', cwd, cwd,
    // 临时目录、设备、进程信息
    '--tmpfs', '/tmp',
    '--dev', '/dev',
    '--proc', '/proc',
    // 密钥、SSH 私钥、pm2 env 快照统一遮掉（对应上面的 SHIELDED_DIRS / FILES）
    ...shieldArgs(),
    // 干净环境：不继承宿主的密钥
    '--clearenv',
    '--setenv', 'PATH', '/usr/local/bin:/usr/bin:/bin',
    '--setenv', 'HOME', '/tmp',
    '--setenv', 'LANG', 'C.UTF-8',
    // 父进程死了就跟着死，别留孤儿
    '--die-with-parent',
    '--chdir', cwd,
    '--',
    '/bin/sh',
    '-c',
    command,
  ]

  return { argv, shell: false }
}

/** 当前命令会不会因为断网而失败（给提示用） */
export function commandNeedsNetwork(command) {
  return NEEDS_NETWORK.test(String(command ?? ''))
}

let selfTest = null

/**
 * 用真实参数空跑一次。光能建 namespace 不代表这套参数在这个内核上成立——
 * 之前遮蔽参数写错，探测照样显示「已启用」，直到群里触发才炸。启动时先自检。
 */
export function sandboxSelfTest() {
  if (selfTest) return selfTest

  const status = sandboxStatus()
  if (!status.available) {
    selfTest = status
    return selfTest
  }

  // 光跑 true 只能证明参数合法，证明不了能不能写工作目录 ——
  // 而「写不了 /qq」正是没补 CAP_DAC_OVERRIDE 时的症状，下载和生成文件全废。
  const boxed = sandboxCommand('touch .sbx-probe && rm -f .sbx-probe', projectRoot)
  if (!boxed) {
    selfTest = status
    return selfTest
  }

  try {
    execFileSync(boxed.argv[0], boxed.argv.slice(1), { stdio: 'pipe', timeout: 8000 })
    selfTest = { available: true, kind: 'bwrap', reason: '' }
  } catch (error) {
    const raw = String(error?.stderr ?? error?.message ?? error).replace(/\s+/g, ' ').trim()
    selfTest = { available: false, kind: 'none', reason: `参数自检没通过：${raw.slice(0, 120)}` }
  }

  return selfTest
}
