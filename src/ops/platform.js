import fs from 'node:fs'
import os from 'node:os'
import { execFileSync } from 'node:child_process'

// 平台差异都收在这里，别散在业务代码里。
// Linux 上能力最全（ulimit、/proc 精确内存、bwrap 沙箱）；
// macOS / Windows 自动降级，功能照跑，只是少几项保护。
export const platform = process.platform
export const isLinux = platform === 'linux'
export const isMac = platform === 'darwin'
export const isWindows = platform === 'win32'

export const caps = {
  platform,
  // macOS 的 ulimit -v 不生效，Windows 根本没有，只有 Linux 能靠它限内存
  canUlimit: isLinux,
  // Windows 的 cmd 不认 POSIX 的 `( ) >>` 分组重定向，后台命令要用文件描述符
  posixShell: !isWindows,
  // OS 级沙箱的实际状态由 sandboxStatus() 探测，这里只留占位。
  // 之前直接写 isLinux ? 'bwrap' 是错的：那只是「理论上能用」，不是「真的能用」。
  sandbox: 'pending',
  // /proc 只有 Linux 有
  hasProcfs: isLinux,
}

const MB = 1024 * 1024

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

    return { totalMB, availableMB, swapTotalMB: pick('SwapTotal') ?? 0, precise: true }
  } catch {
    return null
  }
}

/**
 * 内存信息，跨平台。
 * Linux 读 /proc 拿 MemAvailable（比 freemem 准，它算上了可回收的缓存）；
 * 其他平台退回 Node 内置的 os.freemem —— 数字偏保守，但足以判断「还能不能跑重活」。
 */
export function memoryInfo() {
  if (isLinux) {
    const info = readLinuxMemory()
    if (info) return info
  }

  return {
    totalMB: os.totalmem() / MB,
    availableMB: os.freemem() / MB,
    swapTotalMB: 0,
    precise: false,
  }
}

/** 一句话描述当前平台能力，启动日志用 */
export function describePlatform(sandbox = sandboxStatus()) {
  const parts = [platform]
  parts.push(caps.canUlimit ? 'ulimit 可用' : '不限制单进程内存')
  parts.push(sandbox.available ? `${sandbox.kind} 沙箱已启用` : `未隔离（${sandbox.reason}）`)
  return parts.join('｜')
}

let sandboxProbe = null

/**
 * 真正探测 OS 级沙箱能不能用：不只看命令在不在，还要真建一次 namespace。
 * 结果缓存，启动时调一次就够。
 */
export function sandboxStatus() {
  if (sandboxProbe) return sandboxProbe

  if (!isLinux) {
    sandboxProbe = { available: false, kind: 'none', reason: `非 Linux（${platform}）` }
    return sandboxProbe
  }

  try {
    execFileSync('bwrap', ['--version'], { stdio: 'pipe', timeout: 3000 })
  } catch {
    sandboxProbe = { available: false, kind: 'none', reason: '没装 bwrap' }
    return sandboxProbe
  }

  try {
    // 空跑一次：能建出 namespace 才算真的可用，光有二进制不够
    execFileSync(
      'bwrap',
      ['--unshare-user', '--unshare-pid', '--ro-bind', '/', '/', '--dev', '/dev', '--proc', '/proc', '--', '/bin/true'],
      { stdio: 'pipe', timeout: 5000 },
    )
  } catch (error) {
    const raw = String(error?.stderr ?? error?.message ?? error).replace(/\s+/g, ' ').trim()
    sandboxProbe = {
      available: false,
      kind: 'none',
      reason: `bwrap 装了但跑不起来（常见是内核禁了 user namespace）：${raw.slice(0, 100)}`,
    }
    return sandboxProbe
  }

  sandboxProbe = { available: true, kind: 'bwrap', reason: '' }
  return sandboxProbe
}
