import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { audit } from '../app/audit.js'
import { AUDITED_TOOLS } from '../config/policy.js'
import { assertMcpCommand } from './mcp-guard.js'

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const builtinServerPath = path.join(projectRoot, 'src', 'mcp-server', 'index.js')
const registryFile = path.join(projectRoot, 'data', 'mcp-registry.json')

const SAFE_ENV_KEYS = [
  'PATH', 'Path', 'SYSTEMROOT', 'SystemRoot', 'TEMP', 'TMP',
  // 视频解析用：yt-dlp 的路径和伪装开关，子进程要靠这两个
  'YTDLP_PATH', 'YTDLP_IMPERSONATE',
  'APPDATA', 'LOCALAPPDATA', 'USERPROFILE', 'HOME',
  // 注意：NODE_OPTIONS 绝对不能传。
  // NODE_OPTIONS=--require=/tmp/x.js 和 node --require 等价，
  // MCP 子进程是主进程在宿主侧 spawn 的，bwrap 和 --clearenv 都管不到它。
]

const CONNECTION_ERROR = /connection closed|not connected|EPIPE|ECONNRESET|socket hang up/i

const connections = new Map()
const failedAt = new Map()
const FAIL_RETRY_INTERVAL = 5 * 60_000
const toolOwners = new Map()
let baseEnv = {}
let builtinSpec = null
let registryStamp = -1

function childEnv(extra = {}, { withSecrets = false } = {}) {
  const env = {}
  for (const key of SAFE_ENV_KEYS) {
    if (process.env[key] !== undefined) env[key] = process.env[key]
  }
  // 模型 key 只给内置服务：search / fetch 要用它调搜索接口。
  // 注册进来的第三方 MCP 服务不该拿到它——那等于把「能跑命令」升级成「能刷额度」。
  return { ...env, ...(withSecrets ? baseEnv : {}), ...extra }
}

async function connect(name, spec) {
  if (connections.has(name)) return

  const transport = new StdioClientTransport({
    command: spec.command,
    args: (spec.args ?? []).map(String),
    env: childEnv(spec.env ?? {}, { withSecrets: name === 'builtin' }),
    stderr: 'inherit',
  })

  const client = new Client({ name: `qq-bot-${name}`, version: '1.0.0' }, { capabilities: {} })

  let timer
  try {
    await Promise.race([
      client.connect(transport),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`连接 ${name} 超时（15 秒）`)), 15_000)
      }),
    ])
  } catch (error) {
    await client.close().catch(() => {})
    throw error
  } finally {
    clearTimeout(timer)
  }

  const { tools } = await client.listTools()
  const connection = { name, client, tools: tools ?? [], dead: false, spec }
  connections.set(name, connection)

  let added = 0
  for (const tool of connection.tools) {
    if (toolOwners.has(tool.name)) {
      console.error(`[mcp] 工具名冲突：${tool.name} 已被 ${toolOwners.get(tool.name).name} 占用，跳过`)
      continue
    }
    toolOwners.set(tool.name, connection)
    added += 1
  }

  console.error(`[mcp] 已连接 ${name}，新增 ${added} 个工具`)
}

function forget(name) {
  const connection = connections.get(name)
  if (!connection) return

  for (const tool of connection.tools) {
    if (toolOwners.get(tool.name) === connection) toolOwners.delete(tool.name)
  }
  connections.delete(name)
  connection.client.close().catch(() => {})
}

async function dropDeadConnections() {
  const dead = [...connections.values()].filter((connection) => connection.dead)
  for (const connection of dead) {
    console.error(`[mcp] ${connection.name} 连接已断开，准备重连`)
    forget(connection.name)
  }
  return dead.length > 0
}

export async function startMcp({ apiKey, baseURL }) {
  baseEnv = { DEEP_SEEK_API_KEY: apiKey, DEEPSEEK_BASE_URL: baseURL }
  builtinSpec = {
    command: process.execPath,
    // 内置工具服务是第二个 Node 进程，2G 机器上必须给它设上限，否则会跟主进程抢内存
    args: [`--max-old-space-size=${Number(process.env.MCP_HEAP_MB || 160)}`, builtinServerPath],
    // 子进程默认只有最小 env，这些开关得显式传
    env: {
      PM2_MANAGED: process.env.PM2_MANAGED ?? '',
      PM2_APP_NAME: process.env.PM2_APP_NAME ?? '',
    },
  }
  await connect('builtin', builtinSpec)
  await syncRegistry(true)
  return getTools()
}

export async function syncRegistry(force = false) {
  const dropped = await dropDeadConnections()

  if (!connections.has('builtin') && builtinSpec) {
    try {
      await connect('builtin', builtinSpec)
    } catch (error) {
      console.error('[mcp] 内置工具服务重连失败：', error?.message ?? error)
    }
  }

  let stat
  try {
    stat = fs.statSync(registryFile)
  } catch {
    return
  }

  if (!force && !dropped && stat.mtimeMs === registryStamp) return
  registryStamp = stat.mtimeMs

  let list
  try {
    list = JSON.parse(fs.readFileSync(registryFile, 'utf8'))
  } catch (error) {
    console.error('[mcp] 读取注册表失败：', error?.message ?? error)
    return
  }

  if (!Array.isArray(list)) return

  const now = Date.now()

  for (const item of list) {
    if (!item?.name || !item?.command) continue
    if (connections.has(item.name)) continue

    // 注册表是个可写文件，沙箱里的进程能改它。所以命令必须在这里再校验一次，
    // 不能只靠 add_mcp 入口那道——热加载路径不校验就等于白名单没做。
    try {
      assertMcpCommand(item.command, item.args ?? [], { projectRoot })
    } catch (error) {
      console.error(`[mcp] 注册表里的「${item.name}」被拒绝：${error?.message ?? error}`)
      continue
    }

    const lastFail = failedAt.get(item.name) ?? 0
    if (now - lastFail < FAIL_RETRY_INTERVAL) continue

    try {
      // env 一律清空：注册表里的 env 字段等于给子进程开任意环境变量
      await connect(item.name, { ...item, env: {} })
      failedAt.delete(item.name)
    } catch (error) {
      failedAt.set(item.name, Date.now())
      console.error(
        `[mcp] 连接 ${item.name} 失败，${FAIL_RETRY_INTERVAL / 60000} 分钟内不再重试：`,
        error?.message ?? error,
      )
    }
  }
}

export function getTools() {
  const all = []
  for (const connection of connections.values()) {
    for (const tool of connection.tools) {
      if (toolOwners.get(tool.name) === connection) all.push(tool)
    }
  }
  return all
}

export function toDeepSeekTools(toolList) {
  return toolList.map((tool) => ({
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema ?? { type: 'object', properties: {} },
    },
  }))
}

/**
 * 调一个 MCP 工具。
 *
 * 留痕下沉到这里：原来审计包在对话循环外面，定时任务、子 agent、自愈
 * 这些直接调 callTool 的路径全都没有记录。放在最底层，谁都绕不过去。
 *
 * @param {{ sessionKey?: string }} options 只用于审计归属，不影响调用
 */
export async function callTool(name, args, timeoutMs = 30_000, { sessionKey = '' } = {}) {
  const connection = toolOwners.get(name)
  if (!connection) throw new Error(`工具 ${name} 未连接`)
  if (connection.dead) throw new Error(`工具 ${name} 的服务已断开，下一轮会重连`)

  let timer
  try {
    const result = await Promise.race([
      connection.client.callTool({ name, arguments: args }),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`工具调用超时（${timeoutMs}ms）`)), timeoutMs)
      }),
    ])

    const text = (result?.content ?? [])
      .filter((item) => item.type === 'text')
      .map((item) => item.text)
      .join('\n')

    if (result?.isError) throw new Error(text || '工具返回错误')

    if (AUDITED_TOOLS.has(name)) audit(sessionKey || 'unknown', name, args, text)
    return text
  } catch (error) {
    const message = String(error?.message ?? error)
    if (CONNECTION_ERROR.test(message)) connection.dead = true
    throw error
  } finally {
    clearTimeout(timer)
  }
}

export async function stopMcp() {
  for (const name of [...connections.keys()]) forget(name)
  connections.clear()
  toolOwners.clear()
}
