import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const builtinServerPath = path.join(projectRoot, 'src', 'mcp-server', 'index.js')
const registryFile = path.join(projectRoot, 'data', 'mcp-registry.json')

const SAFE_ENV_KEYS = [
  'PATH', 'Path', 'SYSTEMROOT', 'SystemRoot', 'TEMP', 'TMP',
  'APPDATA', 'LOCALAPPDATA', 'USERPROFILE', 'HOME', 'NODE_OPTIONS',
]

const CONNECTION_ERROR = /connection closed|not connected|EPIPE|ECONNRESET|socket hang up/i

const connections = new Map()
const failedAt = new Map()
const FAIL_RETRY_INTERVAL = 5 * 60_000
const toolOwners = new Map()
let baseEnv = {}
let builtinSpec = null
let registryStamp = -1

function childEnv(extra = {}) {
  const env = {}
  for (const key of SAFE_ENV_KEYS) {
    if (process.env[key] !== undefined) env[key] = process.env[key]
  }
  return { ...env, ...baseEnv, ...extra }
}

async function connect(name, spec) {
  if (connections.has(name)) return

  const transport = new StdioClientTransport({
    command: spec.command,
    args: (spec.args ?? []).map(String),
    env: childEnv(spec.env ?? {}),
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
    args: [builtinServerPath],
    // shell/run_script 的放开开关得传进去，否则子进程读不到
    env: { SHELL_UNRESTRICTED: process.env.SHELL_UNRESTRICTED ?? '' },
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

    const lastFail = failedAt.get(item.name) ?? 0
    if (now - lastFail < FAIL_RETRY_INTERVAL) continue

    try {
      await connect(item.name, item)
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

export async function callTool(name, args, timeoutMs = 30_000) {
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
