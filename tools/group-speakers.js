#!/usr/bin/env node
// group-speakers：读 data/groups/*.jsonl 的群聊记录，返回最近 N 天发过言的人
// 记录格式：{"t":时间戳ms,"u":"openid","n":"昵称","c":"内容","id":"..."}
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import fs from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(import.meta.dirname, '..')
const GROUP_DIR = path.join(ROOT, 'data', 'groups')

const TOOLS = [
  {
    name: 'group_recent_speakers',
    description:
      '列出最近 N 天内发过言的群成员（按发言条数从多到少）。用于每日抽签之类需要挑一个活跃群友的场景。',
    inputSchema: {
      type: 'object',
      properties: {
        days: { type: 'number', description: '回溯天数，默认 7' },
        group_id: { type: 'string', description: '群 openid，**必填**：只读这个群的记录，不填就返回空' },
        limit: { type: 'number', description: '最多返回人数，默认 30' },
      },
    },
  },
]

function readLines(file) {
  const out = []
  const raw = fs.readFileSync(file, 'utf8')
  for (const line of raw.split('\n')) {
    const s = line.trim()
    if (!s) continue
    try {
      const obj = JSON.parse(s)
      if (obj && typeof obj.t === 'number') out.push(obj)
    } catch {
      // 坏行跳过
    }
  }
  return out
}

function listGroupFiles(groupId) {
  if (!fs.existsSync(GROUP_DIR)) return []

  const files = fs
    .readdirSync(GROUP_DIR)
    .filter((f) => f.endsWith('.jsonl'))
    .map((f) => ({ file: path.join(GROUP_DIR, f), id: f.replace(/\.jsonl$/, '') }))

  // 必须指定群：不传或者传错都不许退回到「所有群」——
  // 那等于把别的群的发言记录混进来，抽签会抽到外群的人。
  const id = String(groupId ?? '').trim()
  if (!id) return []
  return files.filter((f) => f.id === id)
}

async function groupRecentSpeakers({ days = 7, group_id, limit = 30 } = {}) {
  const since = Date.now() - Number(days) * 86400000
  const people = new Map()

  for (const { file } of listGroupFiles(group_id)) {
    for (const rec of readLines(file)) {
      if (rec.t < since) continue
      const key = rec.u || rec.n
      if (!key) continue
      const item = people.get(key) || { name: rec.n || rec.u, count: 0, last: 0 }
      item.count += 1
      if (rec.t > item.last) item.last = rec.t
      if (rec.n) item.name = rec.n
      people.set(key, item)
    }
  }

  const list = [...people.values()]
    .sort((a, b) => b.count - a.count || b.last - a.last)
    .slice(0, Number(limit))

  if (!list.length) {
    return group_id
      ? `这个群最近 ${days} 天没有记录到任何人发言（检查群主是否开了「获取群内全部消息」）。`
      : '没有指定 group_id，所以一条记录都没查。这个工具必须带当前群 openid，不能跨群。'
  }

  const lines = list.map((p, i) => `${i + 1}. ${p.name}（发言 ${p.count} 条，最后 ${new Date(p.last).toLocaleString('zh-CN')}）`)
  return `最近 ${days} 天发言的人共 ${list.length} 位：\n${lines.join('\n')}`
}

const HANDLERS = { group_recent_speakers: groupRecentSpeakers }

const server = new Server({ name: 'group-speakers', version: '1.0.0' }, { capabilities: { tools: {} } })

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
    return { content: [{ type: 'text', text: `${name} 调用失败：${error?.message ?? error}` }], isError: true }
  }
})

await server.connect(new StdioServerTransport())
console.error(`[group-speakers] 已就绪，工具：${TOOLS.map((t) => t.name).join(', ')}`)
