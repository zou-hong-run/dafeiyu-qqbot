import { sandboxStatus } from '../ops/platform.js'

// 把命令包进 bwrap：只读挂整个根，只有工作目录和一个临时 /tmp 可写。
// 没网（除非命令明确需要联网），看不到宿主的环境变量和家目录。
// bwrap 不可用时返回 null，调用方自己决定降级策略。

// 装包、拉代码这类必须有网，其余一律断网
const NEEDS_NETWORK = /\b(pnpm|npm|yarn|npx|pip3?|apt|apt-get|yum|dnf|apk|brew|git|curl|wget)\b/

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
