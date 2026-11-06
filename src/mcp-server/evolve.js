import fs from 'node:fs'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { assertMcpCommand } from '../mcp/mcp-guard.js'
import { shellSafeEnv } from './shell-env.js'

const execFileAsync = promisify(execFile)
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const dataDir = path.join(projectRoot, 'data')
const skillsDir = path.join(projectRoot, 'skills')
const registryFile = path.join(dataDir, 'mcp-registry.json')

function readRegistry() {
  try {
    const raw = JSON.parse(fs.readFileSync(registryFile, 'utf8'))
    return Array.isArray(raw) ? raw : []
  } catch {
    return []
  }
}

function writeRegistry(list) {
  fs.mkdirSync(dataDir, { recursive: true })
  const tmp = `${registryFile}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(list, null, 2))
  fs.renameSync(tmp, registryFile)
}

async function writeSkill({ name, content }) {
  const raw = String(name ?? '').trim()
  const safe = raw.replace(/[\\/:*?"<>|]/g, '').replace(/\s+/g, '-')
  if (!safe) throw new Error('技能名不合法')
  if (!content || String(content).trim().length < 10) throw new Error('技能内容太短，至少写清楚适用场景和步骤')

  fs.mkdirSync(skillsDir, { recursive: true })
  const file = path.join(skillsDir, `${safe}.md`)
  const body = String(content).slice(0, 4000)

  const existed = fs.existsSync(file)
  fs.writeFileSync(file, body, 'utf8')

  return `${existed ? '已更新' : '已创建'}技能「${safe}」，共 ${body.length} 字。主进程下一轮对话会自动加载。`
}

async function listSkills() {
  try {
    const files = fs.readdirSync(skillsDir).filter((file) => file.endsWith('.md'))
    if (files.length === 0) return '当前没有安装任何技能。用 write_skill 创建一个。'

    return `已安装 ${files.length} 个技能：\n${files
      .map((file) => {
        const stat = fs.statSync(path.join(skillsDir, file))
        return `- ${file.replace(/\.md$/, '')}（${stat.size} 字节，${new Date(stat.mtimeMs).toLocaleString('zh-CN')}）`
      })
      .join('\n')}`
  } catch {
    return '当前没有安装任何技能。用 write_skill 创建一个。'
  }
}

async function addMcp({ name, command, args = [], env = {} }) {
  const safe = String(name ?? '').trim()
  if (!/^[a-zA-Z0-9_-]{1,40}$/.test(safe)) throw new Error('name 只能包含字母、数字、下划线、短横线，长度 1-40')
  if (!command) throw new Error('command 必填，目前只允许 node 或 npx')

  const argList = Array.isArray(args) ? args.map(String) : []
  assertMcpCommand(command, argList, { projectRoot })

  // env 不让随便塞：外部服务不需要密钥，塞进去等于给子进程开权限
  const envMap = {}

  const registry = readRegistry()
  const entry = { name: safe, command: String(command), args: argList, env: envMap }
  const index = registry.findIndex((item) => item?.name === safe)

  if (index >= 0) registry[index] = entry
  else registry.push(entry)

  writeRegistry(registry)
  return (
    `已注册 MCP server「${safe}」：${command} ${argList.join(' ')}\n` +
    '主进程会在下一轮对话时尝试连接，连接成功就能用它的工具。\n' +
    '注意：新工具默认不在权限表里，谁都用不了——要启用得让管理员在 src/config/policy.js 的 TOOL_POLICY 里加一行。'
  )
}

async function listMcp() {
  const registry = readRegistry()
  const builtin = ['search', 'fetch', 'now', 'weather', 'exchange', 'calc', 'timezone', 'dns']

  const lines = [`内置工具：${builtin.join(', ')}`]
  if (registry.length === 0) {
    lines.push('没有额外注册的 MCP server。用 add_mcp 添加一个。')
  } else {
    lines.push(`\n已注册 ${registry.length} 个 MCP server：`)
    for (const item of registry) {
      lines.push(`- ${item.name}: ${item.command} ${(item.args ?? []).join(' ')}`)
    }
  }
  return lines.join('\n')
}

async function installPackage({ package: pkg }) {
  const name = String(pkg ?? '').trim()
  if (!/^(@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/i.test(name)) {
    throw new Error('包名不合法，只接受 npm 包名格式，如 @scope/name 或 some-package')
  }

  try {
    const { stdout, stderr } = await execFileAsync('pnpm', ['add', name, '--ignore-scripts'], {
      cwd: projectRoot,
      timeout: 180_000,
      shell: true,
      maxBuffer: 4 * 1024 * 1024,
      // 不继承本进程环境：pnpm 的 postinstall 已经禁用，但依赖里的脚本仍可能读 env
      env: shellSafeEnv(),
    })
    const output = `${stdout ?? ''}${stderr ?? ''}`.trim()
    return `已安装 ${name}\n${output.slice(-800)}`
  } catch (error) {
    throw new Error(`安装失败：${error?.message ?? error}`)
  }
}

export const EVOLVE_HANDLERS = {
  write_skill: writeSkill,
  list_skills: listSkills,
  add_mcp: addMcp,
  list_mcp: listMcp,
  install_package: installPackage,
}

export const EVOLVE_TOOLS = [
  {
    name: 'write_skill',
    description:
      '创建或更新一个技能。技能是写给自己看的说明书，会在以后的对话里自动加载进你的上下文。' +
      '用户让你「学一个新本领」「记住这套流程」时使用。内容写清楚：什么时候用、怎么一步步做。',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: '技能名，如 代码审查 / 周报整理' },
        content: { type: 'string', description: '技能正文，Markdown，包含适用场景和步骤' },
      },
      required: ['name', 'content'],
    },
  },
  {
    name: 'list_skills',
    description: '列出当前已安装的技能。',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'add_mcp',
    description:
      '注册一个新的 MCP server 来获取新工具能力。主进程下一轮对话会自动连接它。' +
      'command 通常是 npx，args 是包名和参数。',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: '服务名，字母数字下划线短横线' },
        command: { type: 'string', description: '启动命令，如 npx' },
        args: { type: 'array', items: { type: 'string' }, description: '命令参数，如 ["-y","@modelcontextprotocol/server-filesystem","/tmp"]' },
        env: { type: 'object', description: '额外环境变量（可选）。注意：不会继承 QQ 与模型密钥' },
      },
      required: ['name', 'command'],
    },
  },
  {
    name: 'list_mcp',
    description: '列出内置工具和已注册的 MCP server。',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'install_package',
    description: '在项目里安装一个 npm 包（pnpm add）。装完通常还要用 add_mcp 把它注册成工具服务。',
    inputSchema: {
      type: 'object',
      properties: {
        package: { type: 'string', description: 'npm 包名，如 @modelcontextprotocol/server-memory' },
      },
      required: ['package'],
    },
  },
]
