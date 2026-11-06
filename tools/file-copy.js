#!/usr/bin/env node
// 文件复制工具：在项目目录内把 src 复制/覆盖到 dst。
// 用途：shell 沙箱只读、只有 tmp/ 可写时，先把改好的内容生成到 tmp/，再用这个工具落到项目里。
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { promises as fs } from 'node:fs'
import path from 'node:path'

const ROOT = process.cwd()

const TOOLS = [
  {
    name: 'file_copy',
    description: '在项目目录内复制文件（可覆盖目标）。用于把 tmp/ 下生成好的内容落回项目文件。目标不能是 .env 或 data/。',
    inputSchema: {
      type: 'object',
      properties: {
        src: { type: 'string', description: '源文件相对路径，如 tmp/self_clean.md' },
        dst: { type: 'string', description: '目标相对路径，如 SELF.md' },
      },
      required: ['src', 'dst'],
    },
  },
]

function safeResolve(p) {
  const abs = path.resolve(ROOT, p)
  if (!abs.startsWith(ROOT + path.sep)) throw new Error(`路径越界：${p}`)
  const rel = path.relative(ROOT, abs)
  if (rel === '.env' || rel.startsWith('.env') || rel.startsWith('data' + path.sep)) {
    throw new Error(`不允许写入：${rel}`)
  }
  return abs
}

const HANDLERS = {
  async file_copy({ src, dst }) {
    const s = safeResolve(src)
    const d = safeResolve(dst)
    const buf = await fs.readFile(s)
    await fs.writeFile(d, buf)
    return `已复制 ${src} -> ${dst}（${buf.length} 字节）`
  },
}

const server = new Server({ name: 'file-copy', version: '1.0.0' }, { capabilities: { tools: {} } })

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }))

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args = {} } = request.params
  const handler = HANDLERS[name]
  if (!handler) return { content: [{ type: 'text', text: `未知工具: ${name}` }], isError: true }
  try {
    const result = await handler(args)
    return { content: [{ type: 'text', text: String(result) }] }
  } catch (error) {
    return { content: [{ type: 'text', text: `${name} 调用失败：${error?.message ?? error}` }], isError: true }
  }
})

await server.connect(new StdioServerTransport())
console.error(`[file-copy] 已就绪，工具：${TOOLS.map((t) => t.name).join(', ')}`)
