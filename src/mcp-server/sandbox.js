import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
import { sandboxStatus, defaultEnvFile } from '../ops/platform.js'

// 把命令包进 bwrap：只读挂整个根，只有工作目录和一个临时 /tmp 可写。
// 没网（除非命令明确需要联网），看不到宿主的环境变量和家目录。
// bwrap 不可用时返回 null，调用方自己决定降级策略。

// 沙箱里的命令一律断网。
// 装包走 install_package、拉代码走 git_sync、下载走 download、搜索走 search——
// 这些都在宿主侧执行，shell 不需要网。所以不再按命令文本猜「这条要不要联网」：
// 那个判断只要被一个词触发（`git status && ...`），整条命令就拿到宿主完整网络栈。

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

// 沙箱里的 PATH：默认系统目录 + 当前 node 所在目录（nvm / pnpm 装的 node 不在 /usr/bin）。
// 这样机器人在沙箱里也能跑 node --check 和 pnpm test，改完代码可以自己验。
function sandboxPath() {
  const dirs = [
    path.dirname(process.execPath),
    '/usr/local/bin',
    '/usr/local/sbin',
    '/usr/bin',
    '/bin',
  ]
  return [...new Set(dirs)].join(':')
}

// `--ro-bind / /` 只能挡写，挡不住读。bwrap 默认一个 capability 都不给，
// 但下面要补 DAC 越权让 root 能写属 www 的项目目录，所以读取面得单独挡住：
// 目录挂空 tmpfs（整个目录变空），文件盖成 /dev/null（读到 0 字节）。
const envFile = process.env.APP_ENV_FILE?.trim() || defaultEnvFile()

export const SHIELDED_DIRS = [
  path.dirname(envFile), // 外部密钥文件所在目录
  '/root', // 家目录：SSH 私钥、云凭据、bash_history、.pm2 快照都在这
  '/home', // 其他用户的家目录
  // 宝塔的站点源码和面板数据。注意不能整个 /www 都遮：
  // node / pnpm 装在 /www/server/nodejs，遮了之后沙箱里连 node 都跑不了，
  // 机器人改完代码没法自检，只能靠猜。
  '/www/wwwroot',
  '/www/server/panel',
  '/etc/sudoers.d',
]

export const SHIELDED_FILES = [
  path.join(projectRoot, '.env'),
  '/etc/shadow',
  '/etc/gshadow',
  '/etc/sudoers',
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

  const isRoot = process.getuid?.() === 0

  // 沙箱里只有 tmp/ 可写。downloads/ 不行——它整块可写就能读到别的会话的附件，
  // 把「附件按会话隔离」那条承诺打穿。下载和产出物都走宿主侧工具，不需要 shell 写。
  // data/（注册表、审计、记忆）、src/、skills/ 同样只读：
  // 沙箱里的进程不该有能力改自己的配置、日志和代码，那是目前最短的一条逃逸路。
  const writableDirs = ['tmp']
    .map((name) => path.join(projectRoot, name))
    .filter((target) => {
      try {
        return fs.existsSync(target)
      } catch {
        return false
      }
    })

  // 只有当需要写的目录属主不是当前用户时才补 DAC 越权。
  // 项目目录 chown 给运行用户后，这个 capability 就完全不需要了（更安全）。
  const needsDacOverride =
    isRoot &&
    writableDirs.some((target) => {
      try {
        return fs.statSync(target).uid !== process.getuid?.()
      } catch {
        return false
      }
    })

  const argv = [
    'bwrap',
    // 不用 --unshare-user：bwrap 的 userns 只映射一个 uid，属主不同的 inode 上
    // CAP_DAC_OVERRIDE 会失效（实测 touch 报 Permission denied）。
    // 改成丢掉除 DAC 越权之外的所有 capability：能写指定目录，
    // 但拿不到 mount / ptrace / bpf 这些能把只读根和遮蔽拆掉的能力。
    ...(needsDacOverride ? ['--cap-drop', 'ALL', '--cap-add', 'CAP_DAC_OVERRIDE'] : ['--cap-drop', 'ALL']),
    // 其余命名空间照常隔离，网络一律断
    '--unshare-pid',
    '--unshare-ipc',
    '--unshare-uts',
    '--unshare-net',
    // 整个根只读挂载
    '--ro-bind', '/', '/',
    // 只有 tmp/ 可写，其余（含 cwd 本身）都是只读
    ...writableDirs.flatMap((target) => ['--bind', target, target]),
    // 临时目录、设备、进程信息
    '--tmpfs', '/tmp',
    '--dev', '/dev',
    '--proc', '/proc',
    // 密钥、SSH 私钥、pm2 env 快照统一遮掉（对应上面的 SHIELDED_DIRS / FILES）
    ...shieldArgs(),
    // 干净环境：不继承宿主的密钥
    '--clearenv',
    // node 不一定在 /usr/bin（nvm、pnpm 装的可能在别处），
    // 把当前进程的 node 目录也带上，否则机器人改完代码连 node --check 都跑不了
    '--setenv', 'PATH', sandboxPath(),
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

  // 光跑 true 只能证明参数合法，证明不了能不能写目录。
  // 探针要落在真正可写的 tmp/ 里：项目根现在是只读的，写在那儿必然失败，
  // 自检会把好好的沙箱判成不可用。
  const probeDir = path.join(projectRoot, 'tmp')
  try {
    fs.mkdirSync(probeDir, { recursive: true })
  } catch {
    // 建不了就让后面老实报错
  }

  const boxed = sandboxCommand('touch .sbx-probe && rm -f .sbx-probe', probeDir)
  if (!boxed) {
    selfTest = status
    return selfTest
  }

  try {
    execFileSync(boxed.argv[0], boxed.argv.slice(1), { stdio: 'pipe', timeout: 8000 })
    selfTest = { available: true, installed: true, kind: 'bwrap', reason: '' }
  } catch (error) {
    const raw = String(error?.stderr ?? error?.message ?? error).replace(/\s+/g, ' ').trim()
    selfTest = {
      available: false,
      installed: true,
      kind: 'none',
      reason: `参数自检没通过：${raw.slice(0, 120)}`,
    }
  }

  return selfTest
}
