import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Resolver } from 'node:dns/promises'
import { config } from 'dotenv'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { systemSnapshot } from '../ops/budget.js'

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
config({ path: path.join(projectRoot, '.env'), quiet: true })

const apiKey =
  process.env.DEEP_SEEK_API_KEY?.trim() ||
  process.env.DEEPSEEK_API_KEY?.trim() ||
  process.env.API_KEY?.trim()
const baseURL = (process.env.DEEPSEEK_BASE_URL?.trim() || 'https://api.deepseek.com').replace(/\/+$/, '')
const contentLimit = Number(process.env.TOOL_CONTENT_LIMIT) || 4000
const NET_TIMEOUT = 15_000

if (!apiKey) {
  console.error('[mcp] 缺少 DEEP_SEEK_API_KEY，工具服务无法启动')
  process.exit(1)
}

function truncate(text, limit) {
  if (!text) return ''
  return text.length <= limit ? text : `${text.slice(0, limit)}…（已截断）`
}

function getJson(url, init = {}) {
  return fetch(url, { ...init, signal: AbortSignal.timeout(NET_TIMEOUT) }).then(async (response) => {
    if (!response.ok) {
      const detail = await response.text().catch(() => '')
      throw new Error(`HTTP ${response.status} ${truncate(detail, 160)}`)
    }
    return response.json()
  })
}

async function search({ query, count = 5 }) {
  const data = await getJson(`${baseURL}/v1/tools/search`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, count }),
  })

  const results = data.results ?? []
  if (results.length === 0) return '没有搜到相关结果。'

  const lines = results.map((item, index) => {
    const parts = [`${index + 1}. ${item.title}`]
    parts.push(`   链接: ${item.url}`)
    if (item.date) parts.push(`   时间: ${item.date}`)
    if (item.site_name) parts.push(`   来源: ${item.site_name}`)
    parts.push(`   摘要: ${truncate(item.summary || item.snippet, 400)}`)
    return parts.join('\n')
  })

  return `共 ${results.length} 条结果：\n\n${lines.join('\n\n')}`
}

/** 相对地址转绝对，失败返回空 */
function absoluteUrl(raw, base) {
  try {
    return new URL(String(raw ?? '').trim(), base).toString()
  } catch {
    return ''
  }
}

/**
 * 从页面 HTML 里提取分享主图（og:image / twitter:image）。
 * 只读前 200KB——这些 meta 都在 head 里，读全文是浪费。
 * 抓不到就返回空，不影响正文。
 */
async function coverImageOf(url) {
  try {
    const response = await fetch(url, {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
        Accept: 'text/html,application/xhtml+xml',
      },
      signal: AbortSignal.timeout(NET_TIMEOUT),
    })
    if (!response.ok) return ''

    const html = (await response.text()).slice(0, 200_000)
    const patterns = [
      /<meta[^>]+property=["']og:image(?::url)?["'][^>]*content=["']([^"']+)["']/i,
      /<meta[^>]+content=["']([^"']+)["'][^>]*property=["']og:image(?::url)?["']/i,
      /<meta[^>]+name=["']twitter:image(?::src)?["'][^>]*content=["']([^"']+)["']/i,
      /<meta[^>]+content=["']([^"']+)["'][^>]*name=["']twitter:image["']/i,
    ]

    for (const pattern of patterns) {
      const matched = html.match(pattern)
      if (matched) {
        const absolute = absoluteUrl(matched[1], url)
        if (absolute) return absolute
      }
    }
    return ''
  } catch {
    return ''
  }
}

async function fetchPage({ url }) {
  const data = await getJson(`${baseURL}/v1/tools/fetch`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ url }),
  })

  const title = data.title ? `标题: ${data.title}\n` : ''

  // 主图单独抓一次：抓取接口只回正文，不给配图。
  // 失败不报错，正文照常返回。
  const cover = await coverImageOf(url)
  const coverLine = cover ? `主图: ${cover}\n` : ''

  return `${title}链接: ${url}\n${coverLine}\n正文（Markdown）：\n${truncate(data.content, contentLimit)}`
}

function now() {
  const current = new Date()
  const weekday = '日一二三四五六'[current.getDay()]
  const local = current.toLocaleString('zh-CN', { hour12: false })
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone
  return `当前时间：${local}（星期${weekday}，时区 ${zone}）`
}

const WMO = {
  0: '晴', 1: '晴间多云', 2: '多云', 3: '阴',
  45: '雾', 48: '霜雾',
  51: '小毛毛雨', 53: '毛毛雨', 55: '强毛毛雨',
  56: '冻毛毛雨', 57: '强冻毛毛雨',
  61: '小雨', 63: '中雨', 65: '大雨',
  66: '冻雨', 67: '强冻雨',
  71: '小雪', 73: '中雪', 75: '大雪', 77: '雪粒',
  80: '小阵雨', 81: '阵雨', 82: '强阵雨',
  85: '小阵雪', 86: '强阵雪',
  95: '雷暴', 96: '雷暴伴小冰雹', 99: '雷暴伴大冰雹',
}

function weatherText(code) {
  return WMO[code] ?? `未知天气(${code})`
}

const CITY_ALIASES = {
  北京: 'Beijing', 上海: 'Shanghai', 广州: 'Guangzhou', 深圳: 'Shenzhen',
  杭州: 'Hangzhou', 成都: 'Chengdu', 重庆: 'Chongqing', 武汉: 'Wuhan',
  西安: "Xi'an", 南京: 'Nanjing', 天津: 'Tianjin', 苏州: 'Suzhou',
  长沙: 'Changsha', 青岛: 'Qingdao', 郑州: 'Zhengzhou', 沈阳: 'Shenyang',
  大连: 'Dalian', 厦门: 'Xiamen', 福州: 'Fuzhou', 济南: 'Jinan',
  哈尔滨: 'Harbin', 昆明: 'Kunming', 合肥: 'Hefei', 南昌: 'Nanchang',
  石家庄: 'Shijiazhuang', 太原: 'Taiyuan', 贵阳: 'Guiyang', 南宁: 'Nanning',
  兰州: 'Lanzhou', 乌鲁木齐: 'Urumqi', 拉萨: 'Lhasa', 海口: 'Haikou',
  银川: 'Yinchuan', 西宁: 'Xining', 呼和浩特: 'Hohhot',
  香港: 'Hong Kong', 澳门: 'Macau', 台北: 'Taipei', 高雄: 'Kaohsiung',
  东京: 'Tokyo', 大阪: 'Osaka', 京都: 'Kyoto', 首尔: 'Seoul', 釜山: 'Busan',
  新加坡: 'Singapore', 曼谷: 'Bangkok', 吉隆坡: 'Kuala Lumpur', 雅加达: 'Jakarta',
  马尼拉: 'Manila', 河内: 'Hanoi', 胡志明市: 'Ho Chi Minh City', 孟买: 'Mumbai',
  新德里: 'New Delhi', 迪拜: 'Dubai', 伊斯坦布尔: 'Istanbul', 莫斯科: 'Moscow',
  伦敦: 'London', 巴黎: 'Paris', 柏林: 'Berlin', 罗马: 'Rome', 马德里: 'Madrid',
  阿姆斯特丹: 'Amsterdam', 苏黎世: 'Zurich', 维也纳: 'Vienna', 斯德哥尔摩: 'Stockholm',
  哥本哈根: 'Copenhagen', 赫尔辛基: 'Helsinki', 都柏林: 'Dublin', 里斯本: 'Lisbon',
  雅典: 'Athens', 华沙: 'Warsaw', 布拉格: 'Prague', 布达佩斯: 'Budapest',
  纽约: 'New York', 洛杉矶: 'Los Angeles', 旧金山: 'San Francisco', 西雅图: 'Seattle',
  芝加哥: 'Chicago', 波士顿: 'Boston', 华盛顿: 'Washington', 迈阿密: 'Miami',
  拉斯维加斯: 'Las Vegas', 休斯顿: 'Houston', 达拉斯: 'Dallas', 丹佛: 'Denver',
  温哥华: 'Vancouver', 多伦多: 'Toronto', 蒙特利尔: 'Montreal', 墨西哥城: 'Mexico City',
  圣保罗: 'Sao Paulo', 里约热内卢: 'Rio de Janeiro', 布宜诺斯艾利斯: 'Buenos Aires',
  悉尼: 'Sydney', 墨尔本: 'Melbourne', 布里斯班: 'Brisbane', 珀斯: 'Perth',
  奥克兰: 'Auckland', 惠灵顿: 'Wellington', 开罗: 'Cairo', 约翰内斯堡: 'Johannesburg',
  内罗毕: 'Nairobi', 拉各斯: 'Lagos', 卡拉奇: 'Karachi', 达卡: 'Dhaka',
}

async function resolveCity(name) {
  const input = String(name ?? '').trim()
  if (!input) throw new Error('请提供城市名')

  const query = CITY_ALIASES[input] ?? input
  const url = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(query)}&count=5&language=zh&format=json`
  const data = await getJson(url)

  const hits = (data.results ?? []).filter(Boolean)
  if (hits.length === 0) {
    throw new Error(`找不到城市「${input}」，试试英文名，如 Tokyo / New York`)
  }

  return hits.reduce((best, item) => ((item.population ?? 0) > (best.population ?? 0) ? item : best))
}

function placeLabel(place) {
  const region = [place.country, place.admin1].filter(Boolean).join(' ')
  return region ? `${place.name}（${region}）` : place.name
}

async function weather({ city, days = 3 }) {
  const place = await resolveCity(city)
  const span = Math.min(Math.max(Number(days) || 3, 1), 7)

  const params = new URLSearchParams({
    latitude: String(place.latitude),
    longitude: String(place.longitude),
    current: 'temperature_2m,relative_humidity_2m,apparent_temperature,weather_code,wind_speed_10m',
    daily: 'weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max',
    timezone: 'auto',
    forecast_days: String(span),
  })

  const data = await getJson(`https://api.open-meteo.com/v1/forecast?${params}`)
  const current = data.current
  const daily = data.daily

  const lines = [
    `${placeLabel(place)}当前天气：`,
    `${weatherText(current.weather_code)}，${current.temperature_2m}°C（体感 ${current.apparent_temperature}°C），` +
      `湿度 ${current.relative_humidity_2m}%，风速 ${current.wind_speed_10m} km/h`,
    `观测时间：${current.time}`,
    '',
    `未来 ${daily.time.length} 天：`,
  ]

  daily.time.forEach((date, index) => {
    lines.push(
      `${index + 1}. ${date} ${weatherText(daily.weather_code[index])} ` +
        `${daily.temperature_2m_min[index]}~${daily.temperature_2m_max[index]}°C ` +
        `降水概率 ${daily.precipitation_probability_max[index] ?? '-'}%`,
    )
  })

  return lines.join('\n')
}

async function exchange({ from = 'CNY', to, amount = 1 }) {
  const base = String(from).trim().toUpperCase()
  const value = Number(amount)
  if (!Number.isFinite(value) || value <= 0) throw new Error('amount 必须是正数')

  const data = await getJson(`https://open.er-api.com/v6/latest/${encodeURIComponent(base)}`)
  if (data.result !== 'success') throw new Error(`不支持的货币：${base}`)

  const rates = data.rates ?? {}
  const requested = to
    ? String(to).toUpperCase().split(',').map((code) => code.trim()).filter(Boolean)
    : ['CNY', 'USD', 'EUR', 'JPY', 'GBP', 'KRW', 'HKD']

  const targets = requested.filter((code) => code !== base)
  if (targets.length === 0) throw new Error('请指定不同于源货币的目标货币')

  const lines = targets.map((code) => {
    const rate = rates[code]
    if (rate === undefined) return `${code}: 不支持的货币`
    const converted = value * rate
    return `${value} ${base} = ${converted.toFixed(rate >= 100 ? 2 : 4)} ${code}`
  })

  lines.push(`数据时间：${data.time_last_update_utc ?? '未知'}`)
  return lines.join('\n')
}

function calc({ expression }) {
  const raw = String(expression ?? '')
  if (raw.length === 0) throw new Error('表达式为空')
  if (raw.length > 200) throw new Error('表达式过长')

  const clean = raw.replace(/\s+/g, '')
  if (!/^[0-9+\-*/%.()^eE]+$/.test(clean)) {
    throw new Error('只支持数字和 + - * / % ( ) ^，不支持变量和函数名')
  }

  // 纯整数四则（没有小数点、没有 / 和 ^）用 BigInt 算，避免 2^53 之后丢精度。
  // 之前 123456789*987654321 会算成 121932631113000000，差好几百，模型自己都发现不对
  const integersOnly = !/[.eE/^]/.test(clean)
  if (integersOnly) {
    try {
      const withBigInt = clean.replace(/\d+/g, (digits) => `${digits}n`)
      const value = Function(`"use strict"; return (${withBigInt})`)()
      if (typeof value === 'bigint') return `${raw.trim()} = ${value.toString()}`
    } catch {
      // 转 BigInt 失败就退回浮点，不影响别的表达式
    }
  }

  const normalized = clean.replace(/\^/g, '**')
  const value = Function(`"use strict"; return (${normalized})`)()

  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error('计算结果无效（可能除以 0）')

  const pretty = Number(value.toPrecision(15))
  return `${raw.trim()} = ${pretty}`
}

async function timezone({ place }) {
  const query = String(place ?? '').trim()
  if (!query) throw new Error('请提供城市名或 IANA 时区名')

  let zone = query
  let label = query

  if (!query.includes('/')) {
    const hit = await resolveCity(query)
    zone = hit.timezone
    label = placeLabel(hit)
  }

  let text
  try {
    text = new Intl.DateTimeFormat('zh-CN', {
      timeZone: zone,
      dateStyle: 'full',
      timeStyle: 'short',
      hour12: false,
    }).format(new Date())
  } catch {
    throw new Error(`无法识别的时区「${query}」，可传 Asia/Shanghai 这类 IANA 名称`)
  }

  const offset = new Intl.DateTimeFormat('en', { timeZone: zone, timeZoneName: 'longOffset' })
    .formatToParts(new Date())
    .find((part) => part.type === 'timeZoneName')?.value

  return `${label}：${text}（${offset ?? '时区未知'}，${zone}）`
}

async function dnsLookup({ domain, type = 'A' }) {
  const name = String(domain ?? '').trim()
  if (!/^[a-zA-Z0-9.-]{1,253}$/.test(name)) throw new Error('域名格式不合法')

  const kind = String(type).toUpperCase()
  const resolver = new Resolver({ timeout: 5000, tries: 2 })

  let records
  if (kind === 'A') records = await resolver.resolve4(name)
  else if (kind === 'AAAA') records = await resolver.resolve6(name)
  else if (kind === 'MX') {
    records = (await resolver.resolveMx(name))
      .sort((a, b) => a.priority - b.priority)
      .map((item) => `${item.priority} ${item.exchange || '(不接受邮件，null MX)'}`)
  } else if (kind === 'TXT') records = (await resolver.resolveTxt(name)).map((chunks) => truncate(chunks.join(''), 200))
  else if (kind === 'NS') records = await resolver.resolveNs(name)
  else if (kind === 'CNAME') records = await resolver.resolveCname(name)
  else throw new Error('type 仅支持 A / AAAA / MX / TXT / NS / CNAME')

  if (!records || records.length === 0) return `${name} 没有 ${kind} 记录`
  if (records.length > 30) records = records.slice(0, 30)
  return `${name} 的 ${kind} 记录（${records.length} 条）：\n${records.join('\n')}`
}

const TOOLS = [
  {
    name: 'search',
    description:
      '联网搜索网页。用户问实时信息、新闻、具体数据，或你不确定、知识可能过时的事实时使用。' +
      'query 支持 site:/lang:/after:/before: 语法。结果只有摘要，需要全文时再用 fetch。',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '搜索词，1-128 字符，支持 site:、after: 等语法' },
        count: { type: 'integer', minimum: 1, maximum: 10, description: '返回条数，默认 5' },
      },
      required: ['query'],
    },
  },
  {
    name: 'fetch',
    description:
      '抓取单个网页正文，返回 Markdown。用于读取搜索结果里值得细看的页面。' +
      '顺带返回页面主图（og:image），有的话返回值里会有一行「主图: https://...」，' +
      '可以直接写进回复：![配图](那个地址)。没有主图的站就没有这一行，别硬凑。',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: '完整的 http/https 网址' },
      },
      required: ['url'],
    },
  },
  {
    name: 'system_info',
    description:
      '查这台机器现在什么状况：内存总量和可用量、CPU 核数和负载、磁盘剩余、以及当前的能力上限' +
      '（主进程堆多大、单条命令能占多少内存、单文件多大、同时能跑几个工单）。' +
      '要跑重命令（装包、转码、批量处理）之前先用它看一眼，别等被拦了才知道内存不够。',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'now',
    description: '获取当前日期时间与星期。用户问「今天几号」「现在几点」时使用。',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'weather',
    description: '查询城市天气与未来几天预报。用户问「明天冷不冷」「要带伞吗」「上海天气」时使用。',
    inputSchema: {
      type: 'object',
      properties: {
        city: { type: 'string', description: '城市名，中英文都可以，如 北京 / Tokyo' },
        days: { type: 'integer', minimum: 1, maximum: 7, description: '预报天数，默认 3' },
      },
      required: ['city'],
    },
  },
  {
    name: 'exchange',
    description: '汇率查询与货币换算。用户问「100 美元多少人民币」「日元汇率」时使用。',
    inputSchema: {
      type: 'object',
      properties: {
        from: { type: 'string', description: '源货币三字母代码，默认 CNY' },
        to: { type: 'string', description: '目标货币代码，可用逗号分隔多个，如 USD,JPY；不填则返回常用几种' },
        amount: { type: 'number', description: '金额，默认 1' },
      },
    },
  },
  {
    name: 'calc',
    description: '精确计算数学表达式。涉及多步算术、百分比、大数或浮点数时用它，不要心算。只支持数字和运算符。',
    inputSchema: {
      type: 'object',
      properties: {
        expression: { type: 'string', description: '如 (1250*0.13)+88 或 2^16' },
      },
      required: ['expression'],
    },
  },
  {
    name: 'timezone',
    description: '查询指定城市或时区的当前时间。用户问「纽约现在几点」「东京时间」时使用。',
    inputSchema: {
      type: 'object',
      properties: {
        place: { type: 'string', description: '城市名或 IANA 时区名，如 纽约 / Asia/Tokyo' },
      },
      required: ['place'],
    },
  },
  {
    name: 'dns',
    description: '查询域名的 DNS 记录（A/AAAA/MX/TXT/NS/CNAME）。技术类问题，如「这个域名解析到哪」时使用。',
    inputSchema: {
      type: 'object',
      properties: {
        domain: { type: 'string', description: '域名，如 example.com' },
        type: { type: 'string', enum: ['A', 'AAAA', 'MX', 'TXT', 'NS', 'CNAME'], description: '记录类型，默认 A' },
      },
      required: ['domain'],
    },
  },
]

const HANDLERS = {
  search,
  fetch: fetchPage,
  system_info: async () => systemSnapshot(projectRoot),
  now,
  weather,
  exchange,
  calc,
  timezone,
  dns: dnsLookup,
}

const { EVOLVE_TOOLS, EVOLVE_HANDLERS } = await import('./evolve.js')
TOOLS.push(...EVOLVE_TOOLS)
Object.assign(HANDLERS, EVOLVE_HANDLERS)

const { DOWNLOAD_TOOLS, DOWNLOAD_HANDLERS } = await import('./download.js')
TOOLS.push(...DOWNLOAD_TOOLS)
Object.assign(HANDLERS, DOWNLOAD_HANDLERS)

const { DRAW_TOOLS, DRAW_HANDLERS } = await import('./draw-pixel.js')
TOOLS.push(...DRAW_TOOLS)
Object.assign(HANDLERS, DRAW_HANDLERS)

const { SHELL_TOOLS, SHELL_HANDLERS } = await import('./shell.js')
TOOLS.push(...SHELL_TOOLS)
Object.assign(HANDLERS, SHELL_HANDLERS)

const { DOC_TOOLS, DOC_HANDLERS } = await import('./doc-tools.js')
TOOLS.push(...DOC_TOOLS)
Object.assign(HANDLERS, DOC_HANDLERS)

const { FS_TOOLS, FS_HANDLERS } = await import('./fs-tools.js')
TOOLS.push(...FS_TOOLS)
Object.assign(HANDLERS, FS_HANDLERS)

const { MUSIC_TOOLS, MUSIC_HANDLERS } = await import('./music.js')
TOOLS.push(...MUSIC_TOOLS)
Object.assign(HANDLERS, MUSIC_HANDLERS)

const {
  VIDEO_TOOLS,
  VIDEO_HANDLERS,
  VIDEO_TOOLS_EXTRA,
  VIDEO_HANDLERS_EXTRA,
  VIDEO_TOOLS_META,
  VIDEO_HANDLERS_META,
} = await import('./video.js')
TOOLS.push(...VIDEO_TOOLS, ...VIDEO_TOOLS_EXTRA, ...VIDEO_TOOLS_META)
Object.assign(HANDLERS, VIDEO_HANDLERS, VIDEO_HANDLERS_EXTRA, VIDEO_HANDLERS_META)

const server = new Server(
  { name: 'qq-bot-tools', version: '1.0.0' },
  { capabilities: { tools: {} } },
)

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }))

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args = {} } = request.params
  const handler = HANDLERS[name]

  if (!handler) {
    return { content: [{ type: 'text', text: `未知工具: ${name}` }], isError: true }
  }

  try {
    const text = await handler(args)
    return { content: [{ type: 'text', text: String(text) }] }
  } catch (error) {
    return {
      content: [{ type: 'text', text: `${name} 调用失败：${error?.message ?? error}` }],
      isError: true,
    }
  }
})

const transport = new StdioServerTransport()
await server.connect(transport)

// 可选依赖自检：缺哪个就报哪个，服务照常起（只让对应用具报错，不搞成整块崩）
const OPTIONAL_LIBS = ['unpdf', 'mammoth', 'exceljs', 'pngjs']
const missingLibs = []
for (const name of OPTIONAL_LIBS) {
  try {
    await import(name)
  } catch {
    missingLibs.push(name)
  }
}
if (missingLibs.length > 0) {
  console.error(
    `[依赖] 缺 ${missingLibs.join('、')}：读文档/画图会报错。在项目目录跑一次 pnpm install 就能修`,
  )
}

console.error(`[mcp] 工具服务已就绪：${TOOLS.map((tool) => tool.name).join(' / ')}`)
