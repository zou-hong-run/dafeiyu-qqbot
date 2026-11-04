import fs from 'node:fs'
import path from 'node:path'

// MCP 服务启动命令的白名单。add_mcp 和注册表热加载必须共用这一份，
// 否则「工具入口管住了、热加载没管」就等于白名单形同虚设。

const ALLOWED_COMMANDS = new Set(['node', 'npx'])

function hasInstalledPackage(name, projectRoot) {
  if (!projectRoot || !name) return false
  const clean = String(name).replace(/^npx\s+/, '')
  const candidates = [
    path.join(projectRoot, 'node_modules', clean, 'package.json'),
    path.join(projectRoot, 'node_modules', '.bin', clean),
  ]
  return candidates.some((target) => fs.existsSync(target))
}

/**
 * 校验一条 MCP 启动命令。
 * @param {string} command 可执行文件名
 * @param {string[]} argList 参数
 * @param {{ projectRoot?: string }} options 传了 projectRoot 才会校验 npx 包是否已安装
 * @throws {Error} 不合法时抛错
 */
export function assertMcpCommand(command, argList = [], { projectRoot } = {}) {
  const cmd = path.basename(String(command ?? '').trim())
  if (!ALLOWED_COMMANDS.has(cmd)) {
    throw new Error(
      `只允许用 node 或 npx 启动 MCP 服务，收到的是「${cmd}」。` +
        '要跑别的解释器就先写成项目内的 node 脚本。',
    )
  }

  const args = Array.isArray(argList) ? argList.map(String) : []

  if (cmd === 'npx') {
    if (args.some((item) => item === '-y' || item === '--yes')) {
      throw new Error('npx 不允许带 -y/--yes：那会联网下载并执行任意包。请先安装好，再用 node 启动')
    }
    const pkg = args.find((item) => !item.startsWith('-'))
    if (!pkg) throw new Error('npx 要指定包名')
    if (projectRoot && !hasInstalledPackage(pkg, projectRoot)) {
      throw new Error(`包「${pkg}」还没装。先用 install_package 装上，再注册 MCP 服务`)
    }
    return
  }

  const target = args.find((item) => !item.startsWith('-'))
  if (!target) throw new Error('node 启动要指定脚本路径，比如 tools/my-tool.js')
  if (!target.startsWith('tools/') && !target.startsWith('./tools/')) {
    throw new Error(`node 只能启动项目内 tools/ 下的脚本，收到的是「${target}」`)
  }
}

/** 注册表条目是否合法（文件被篡改时能挡住） */
export function isValidRegistryEntry(item, projectRoot) {
  if (!item || typeof item !== 'object') return false
  if (typeof item.name !== 'string' || !item.name.trim()) return false
  if (typeof item.command !== 'string' || !item.command.trim()) return false
  if (item.args !== undefined && !Array.isArray(item.args)) return false

  try {
    assertMcpCommand(item.command, item.args ?? [], { projectRoot })
    return true
  } catch {
    return false
  }
}
