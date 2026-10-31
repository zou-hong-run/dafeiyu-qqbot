#!/usr/bin/env node
// 自建 MCP 工具模板
//
// 用法：复制这个文件，改名为 tools/你的工具名.js，然后改 TOOLS 和 HANDLERS 两部分。
// 改完用 add_mcp 注册：name=工具名, command=node, args=["tools/你的工具名.js"]
// 主进程下一轮对话会自动连接，不需要重启。
//
// 重要：不要用 console.log，stdout 是协议通道，任何输出都会破坏通信。要打日志用 console.error。

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'

// ── 1. 定义工具清单 ──────────────────────────────────────────
const TOOLS = [
  {
    name: 'hello',
    description: '示例工具：把传入的文字原样回显。把这个改成你真正想要的能力。',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: '要回显的文字' },
      },
      required: ['text'],
    },
  },
]

// ── 2. 实现每个工具 ──────────────────────────────────────────
const HANDLERS = {
  async hello({ text }) {
    return `收到：${text}`
  },
}

// ── 3. 协议装配（一般不用改）──────────────────────────────────
const server = new Server({ name: 'custom-tool', version: '1.0.0' }, { capabilities: { tools: {} } })

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }))

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args = {} } = request.params
  const handler = HANDLERS[name]

  if (!handler) {
    return { content: [{ type: 'text', text: `未知工具: ${name}` }], isError: true }
  }

  try {
    const result = await handler(args)
    return { content: [{ type: 'text', text: String(result) }] }
  } catch (error) {
    return {
      content: [{ type: 'text', text: `${name} 调用失败：${error?.message ?? error}` }],
      isError: true,
    }
  }
})

await server.connect(new StdioServerTransport())
console.error(`[custom-tool] 已就绪，工具：${TOOLS.map((tool) => tool.name).join(', ')}`)
