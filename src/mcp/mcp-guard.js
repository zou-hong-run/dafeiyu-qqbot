import fs from 'node:fs'
import path from 'node:path'

// MCP 服务启动命令的白名单。add_mcp 和注册表热加载必须共用这一份，
// 否则「工具入口管住了、热加载没管」就等于白名单形同虚设。
//
// 关键：所有路径必须先 resolve 再判断。只看前缀的话，
// `tools/../../tmp/evil.js` 照样以 `tools/` 开头——而 tmp/ 是沙箱唯一可写的目录。

const ALLOWED_COMMANDS = new Set(['node', 'npx'])

// node 除了内存上限，其余选项一律拒绝。
// --require / --import / --loader / -e 都能在宿主侧加载并执行任意 JS，
// 而 MCP 服务本身就是主进程 spawn 的，绕过了 bwrap 和 shell-guard。
const SAFE_NODE_FLAG = /^--max-old-space-size=\d+$/

function insideDir(root, target) {
  const base = path.resolve(root)
  const resolved = path.resolve(target)
  if (resolved === base) return resolved
  return resolved.startsWith(base + path.sep) ? resolved : null
}

function hasInstalledPackage(name, projectRoot) {
  if (!projectRoot || !name) return false

  const clean = String(name)
  // 包名里出现 .. 或反斜杠就是想跳出 node_modules
  if (clean.includes('..') || clean.includes('\\')) return false
  if (!/^@?[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)?$/.test(clean)) return false

  const nodeModules = path.join(projectRoot, 'node_modules')
  const dir = insideDir(nodeModules, path.join(nodeModules, clean))
  if (!dir) return false

  return (
    fs.existsSync(path.join(dir, 'package.json')) ||
    fs.existsSync(path.join(nodeModules, '.bin', clean))
  )
}

/**
 * 校验一条 MCP 启动命令。
 * @param {string} command 可执行文件名
 * @param {string[]} argList 参数
 * @param {{ projectRoot?: string }} options 传了 projectRoot 才能做路径归一化（生产环境必须传）
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

    // 其余选项也拒：npx 会把部分参数透传给 node，--node-options 之类同样能注入
    const npxFlags = args.filter((item) => item.startsWith('-'))
    if (npxFlags.length > 0) {
      throw new Error(`npx 不接受额外选项（收到 ${npxFlags.join(' ')}），参数里只写包名`)
    }

    const pkg = args.find((item) => !item.startsWith('-'))
    if (!pkg) throw new Error('npx 要指定包名')
    if (projectRoot && !hasInstalledPackage(pkg, projectRoot)) {
      throw new Error(`包「${pkg}」还没装，或者不在 node_modules 里。先用 install_package 装上`)
    }
    return
  }

  // 选项全部拒掉：只要放行 --require 这一类，脚本路径校验就等于没做
  const flags = args.filter((item) => item.startsWith('-') && !SAFE_NODE_FLAG.test(item))
  if (flags.length > 0) {
    throw new Error(
      `node 启动参数里不允许带选项（收到 ${flags.join(' ')}）。` +
        `--require / --import / --loader / -e 会在宿主侧执行任意代码，绕开整个沙箱。`,
    )
  }

  const target = args.find((item) => !item.startsWith('-'))
  if (!target) throw new Error('node 启动要指定脚本路径，比如 tools/my-tool.js')

  if (projectRoot) {
    // 归一化后必须真的落在项目 tools/ 里，`tools/../../tmp/x.js` 这类写法过不去
    const toolsDir = path.join(projectRoot, 'tools')
    const resolved = insideDir(toolsDir, path.resolve(projectRoot, target))
    if (!resolved) {
      throw new Error(`node 只能启动项目内 tools/ 目录下的脚本，收到的是「${target}」`)
    }
    return
  }

  // 没给项目根时退化成保守检查：至少挡住 `..` 和绝对路径
  if (path.isAbsolute(target) || target.split(/[\\/]/).includes('..')) {
    throw new Error(`脚本路径不能跳出项目 tools/，收到的是「${target}」`)
  }
  if (!target.startsWith('tools/') && !target.startsWith('./tools/')) {
    throw new Error(`node 只能启动项目内 tools/ 下的脚本，收到的是「${target}」`)
  }
}
