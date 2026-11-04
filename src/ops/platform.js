import fs from 'node:fs'
import os from 'node:os'

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
  // OS 级沙箱：Linux 用 bwrap，macOS 用 sandbox-exec，Windows 没有原生的
  sandbox: isLinux ? 'bwrap' : isMac ? 'seatbelt' : 'none',
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
export function describePlatform() {
  const parts = [platform]
  parts.push(caps.canUlimit ? 'ulimit 可用' : '不限制单进程内存')
  parts.push(caps.sandbox === 'none' ? '无 OS 沙箱' : `${caps.sandbox} 可用`)
  return parts.join('｜')
}
