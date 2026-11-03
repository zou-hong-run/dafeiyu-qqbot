import fs from 'node:fs'
import OpenAI from 'openai'
import { env } from '../src/config/env.js'
import { startMcp, getTools, toDeepSeekTools, callTool, stopMcp } from '../src/mcp/client.js'
import { filterTools } from '../src/config/policy.js'
import { chat } from '../src/chat/deepseek.js'

const IMAGE_URL = 'https://www.python.org/static/img/python-logo.png'

function line(title) {
  console.log(`\n${'='.repeat(50)}\n${title}\n${'='.repeat(50)}`)
}

line('1. 配置')
console.log('模型        :', env.model)
console.log('baseURL     :', env.baseURL)
console.log('API key     :', env.apiKey ? `已配置 ${env.apiKey.length} 字符，前缀 ${env.apiKey.slice(0, 5)}…` : '缺失')
console.log('toolsEnabled:', env.toolsEnabled)
console.log('groupTools  :', env.groupToolsEnabled)
console.log('toolDebug   :', env.toolDebug)
console.log('maxToolRound:', env.maxToolRounds)

// 依赖自检：拉完代码忘了装包，最先炸的往往是 MCP 子进程，日志里不直观
line('1.5 依赖')
const projectRoot = new URL('../', import.meta.url)
const pkg = JSON.parse(fs.readFileSync(new URL('package.json', projectRoot), 'utf8'))
const missingDeps = []
for (const name of Object.keys(pkg.dependencies ?? {})) {
  // 直接看目录，不走模块解析：@scope/name 这类包的 exports 可能不允许从根 import
  const installed = fs.existsSync(new URL(`node_modules/${name}/package.json`, projectRoot))
  if (!installed) missingDeps.push(name)
}
if (missingDeps.length === 0) {
  console.log('全部依赖都在:', Object.keys(pkg.dependencies ?? {}).join(', '))
} else {
  console.error('缺依赖:', missingDeps.join('、'))
  console.error('修复：在项目目录跑一次 pnpm install --prod 然后 pm2 restart dafeiyu')
}

line('2. MCP 工具服务')
let mcpTools = []
try {
  await startMcp({ apiKey: env.apiKey, baseURL: env.baseURL })
  mcpTools = getTools()
  console.log('已连接，工具数:', mcpTools.length)
  console.log(mcpTools.map((tool) => tool.name).join(', '))
} catch (error) {
  console.error('MCP 启动失败:', error?.message ?? error)
}

const dsTools = toDeepSeekTools(filterTools(mcpTools, 'private'))
console.log('转换后发给模型的工具数:', dsTools.length)
if (dsTools.length > 0) {
  console.log('工具名:', dsTools.map((tool) => tool.function.name).join(', '))
}

line('3. 裸 API 测试（直接带 tools 调一次，绕开所有业务代码）')
const client = new OpenAI({ apiKey: env.apiKey, baseURL: env.baseURL, timeout: 60_000 })

try {
  const response = await client.chat.completions.create({
    model: env.model,
    messages: [
      { role: 'system', content: '你是一个机器人，可以调用工具。' },
      { role: 'user', content: `把这张图发出来：${IMAGE_URL}` },
    ],
    tools: dsTools,
    tool_choice: 'auto',
    max_tokens: 300,
  })

  const message = response.choices?.[0]?.message
  const calls = message?.tool_calls ?? []
  const content = message?.content ?? ''

  console.log('返回 tool_calls 数量:', calls.length)
  if (calls.length > 0) {
    for (const call of calls) {
      console.log(`  → ${call.function?.name}(${call.function?.arguments})`)
    }
  }
  console.log('返回 content:', JSON.stringify(content.slice(0, 400)))

  if (calls.length === 0 && /DSML/i.test(content)) {
    console.log('\n>>> 结论：content 里含 DSML 标记但没有 tool_calls')
    console.log('>>> 这是模型或 API 网关的问题，不是本项目代码的问题')
  } else if (calls.length === 0) {
    console.log('\n>>> 结论：模型没有调用工具，只回了文本（可能是模型本身不愿调用）')
  } else {
    console.log('\n>>> 结论：API 层工具调用正常')
  }
} catch (error) {
  console.error('裸 API 调用失败:', error?.message ?? error)
  if (error?.status) console.error('HTTP 状态码:', error.status)
}

line('4. 完整链路（走项目自己的 chat 函数，含记忆和工具循环）')
try {
  let imageCalls = 0
  const answer = await chat('diag:image', `把这张图发出来：${IMAGE_URL}`, {
    scope: 'private',
    tools: dsTools,
    callTool: (name, args) => callTool(name, args, 30_000),
    sendImage: async (path) => {
      imageCalls += 1
      console.log(`>>> sendImage 被调用，参数: ${path}`)
      return `（模拟发送成功）${path}`
    },
  })
  console.log('sendImage 调用次数:', imageCalls)
  console.log('最终回答:', JSON.stringify(answer.slice(0, 300)))
} catch (error) {
  console.error('chat 失败:', error?.message ?? error)
}

await stopMcp()
console.log('\n诊断结束')
