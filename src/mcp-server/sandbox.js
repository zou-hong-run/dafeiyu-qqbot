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

// `--ro-bind / /` 只能挡写，挡不住读：沙箱内是 uid=0，600 权限的文件照样读得出来。
// 这些路径统一盖成 /dev/null，读到的是空。
export const SHIELDED_PATHS = [
  process.env.APP_ENV_FILE?.trim() || '/etc/dafeiyu/env',
  path.join(projectRoot, '.env'),
  '/root/.ssh/id_rsa',
  '/root/.ssh/id_ed25519',
  '/root/.ssh/id_ecdsa',
  '/root/.ssh/config',
]

/** 生成遮蔽参数：把敏感文件在沙箱内盖成 /dev/null */
export function shieldArgs(targets = SHIELDED_PATHS) {
  return targets
    .filter((target) => {
      // --ro-bind-try 只忽略「源不存在」；目标不存在时 bwrap 会尝试创建挂载点，
      // 而根是只读的，创建失败整条命令就起不来。所以这里先筛掉不存在的路径。
      try {
        return fs.existsSync(target)
      } catch {
        return false
      }
    })
    .flatMap((target) => ['--ro-bind-try', '/dev/null', target])
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

  const argv = [
    'bwrap',
    // 命名空间隔离：用户、PID、IPC、UTS；网络按需
    '--unshare-user',
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
    // 密钥和 SSH 私钥盖成空设备，读出来是空的（对应上面的 SHIELDED）
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

  const boxed = sandboxCommand('true', projectRoot)
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
