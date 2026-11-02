#!/usr/bin/env node
// 每日运势工具（kun/fortune）
// 纯本地实现，不联网。同一个名字 + 同一天 => 结果完全一致（基于 hash 种子）。

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'

// ── 1. 工具清单 ──────────────────────────────────────────────
const TOOLS = [
  {
    name: 'fortune',
    description:
      '每日运势：输入一个名字或昵称，返回这个人今天的运势等级、幸运数字、幸运颜色和一条建议。同一个人同一天结果固定不变。纯本地计算，不联网。',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: '名字或昵称，例如「小明」「阿伟」' },
        date: {
          type: 'string',
          description: '可选，指定日期 YYYY-MM-DD，默认今天（本地时区）',
        },
      },
      required: ['name'],
    },
  },
]

// ── 2. 素材 ──────────────────────────────────────────────────
const LEVELS = ['大吉', '中吉', '小吉', '吉', '末吉', '凶']

const COLORS = [
  '正红', '樱花粉', '薄荷绿', '雾霾蓝', '柠檬黄', '奶茶色', '藏青', '香芋紫',
  '琥珀橙', '月光白', '生椰灰', '抹茶绿', '玫瑰金', '天青', '砖红', '奶油黄',
]

// 建议池：好笑但健康，按运势等级分组
const ADVICE_GOOD = [
  '今天你的手气不错，适合抽卡，但建议先抽自己的钱包冷静一下。',
  '适合早睡，因为你今天的运气全在白天用完了。',
  '今天说话特别有说服力，慎用，容易说服自己去买没用的东西。',
  '会遇到一件小确幸，大概率是外卖没洒。',
  '适合整理桌面，你会发现三样一直以为丢了的东西。',
  '今天你的魅力值偏高，连楼下保安都会多看你一眼。',
  '适合做决定，包括但不限于今天中午吃什么这种世纪难题。',
  '今天的心情像刚洗完的被子，蓬松且带点阳光味。',
  '适合主动出击，比如主动承认昨晚的碗还没洗。',
  '今天的运气够你撑到下班，再往后就得靠自己了。',
  '许愿的成功率略高于平时，建议许个实际点的，比如「别加班」。',
  '今天遇到的人可能都挺和气，别紧张，他们不是针对你。',
]

const ADVICE_MID = [
  '平稳的一天，适合把上个月的计划继续往后拖，但只拖一天。',
  '今天没有大惊喜，但你也没有大麻烦，这已经算赢了。',
  '适合按部就班，别搞大事，大事明天再说。',
  '今天适合喝点热的，人生难题不一定解决，但手会暖。',
  '你的运气正在加载中，进度条卡在 87%，请耐心。',
  '适合少说话多吃饭，今天的沉默比高谈阔论值钱。',
  '今天可能有点小波折，比如电梯在你到的那一刻关门。',
  '适合清空手机相册，你会删掉两百张路人后脑勺。',
  '今天会有个小误会，解释清楚就好，别在心里演三集连续剧。',
  '适合跟讨厌的人保持一米距离，社交距离有助于身心健康。',
  '今天适合慢慢来，反正急也急不出结果。',
  '你的钱包今晚可能轻微缩水，建议提前跟它道个歉。',
]

const ADVICE_BAD = [
  '今天不太适合冲动消费，购物车可以先放着，明天可能就不想买了。',
  '运气在检修，建议低调做人，高调吃饭。',
  '今天可能会遇到点小麻烦，但只要不慌，麻烦也拿你没办法。',
  '建议今天少立 flag，风大。',
  '今天适合早退，但你可能不敢，那就早点收拾包给自己心理暗示。',
  '遇到选择题就选最省事的那个，今天不适合硬扛。',
  '今天别跟人较劲，赢了也不解气，输了更不解气。',
  '建议今天把「算了」这两个字常挂嘴边，能省不少命。',
]

// ── 3. 稳定哈希（名字 + 日期）─────────────────────────────────
function hash32(str) {
  // FNV-1a 32bit，稳定且实现简单
  let h = 0x811c9dc5
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h >>> 0
}

// 由种子派生多个互不相关的确定性数值
function makeRng(seed) {
  let s = seed >>> 0
  return function next() {
    // xorshift32
    s ^= s << 13; s >>>= 0
    s ^= s >>> 17
    s ^= s << 5; s >>>= 0
    return s >>> 0
  }
}

function todayLocal() {
  const d = new Date()
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

function pick(list, n) {
  return list[n % list.length]
}

// ── 4. 实现 ──────────────────────────────────────────────────
const HANDLERS = {
  async fortune({ name, date }) {
    const raw = String(name ?? '').trim()
    if (!raw) throw new Error('请提供一个名字或昵称')
    const day = (date && String(date).trim()) || todayLocal()

    const seed = hash32(`${raw.toLowerCase()}|${day}`)
    const rng = makeRng(seed)

    // 等级：前段偏向好运，凶的概率最低，符合运势工具的调性
    // 权重: 大吉 8, 中吉 16, 小吉 22, 吉 24, 末吉 18, 凶 12
    const weights = [8, 16, 22, 24, 18, 12]
    const total = weights.reduce((a, b) => a + b, 0)
    const rLevel = rng() % total
    let acc = 0
    let levelIdx = LEVELS.length - 1
    for (let i = 0; i < weights.length; i++) {
      acc += weights[i]
      if (rLevel < acc) { levelIdx = i; break }
    }
    const level = LEVELS[levelIdx]

    const luckyNumber = (rng() % 99) + 1                 // 1-99
    const luckyColor = pick(COLORS, rng())
    const score = 30 + (rng() % 71)                       // 30-100 分，纯装饰

    let advicePool
    if (levelIdx <= 2) advicePool = ADVICE_GOOD
    else if (levelIdx <= 4) advicePool = ADVICE_MID
    else advicePool = ADVICE_BAD
    const advice = pick(advicePool, rng())

    return [
      `【${raw} · ${day} 运势】`,
      `运势等级：${level}（${score} 分）`,
      `幸运数字：${luckyNumber}`,
      `幸运颜色：${luckyColor}`,
      `今日建议：${advice}`,
      ``,
      `（同一个人同一天结果固定，明天再来会变）`,
    ].join('\n')
  },
}

// ── 5. 协议装配 ──────────────────────────────────────────────
const server = new Server({ name: 'kun-fortune', version: '1.0.0' }, { capabilities: { tools: {} } })

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
console.error(`[kun-fortune] 已就绪，工具：${TOOLS.map((t) => t.name).join(', ')}`)
