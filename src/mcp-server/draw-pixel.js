import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { PNG } from 'pngjs'

// 像素画工具：只按预设图形或字符网格画 PNG，不执行任何命令
// PNG 编码用 pngjs（纯 JS，无原生依赖），比手写 CRC32 + IHDR 靠谱
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const outDir = path.join(projectRoot, 'downloads')

const MAX_COLS = 200
const MAX_ROWS = 200
const MAX_SCALE = 20
const MAX_OUTPUT_PIXELS = 4_000_000
const MAX_COLORS = 12

function encodePng(width, height, rgba) {
  const png = new PNG({ width, height })
  rgba.copy(png.data)
  return PNG.sync.write(png, { deflateLevel: 9 })
}

const NAMED_COLORS = {
  black: '#000000',
  white: '#ffffff',
  red: '#e53935',
  green: '#43a047',
  blue: '#1e88e5',
  yellow: '#fdd835',
  orange: '#fb8c00',
  purple: '#8e24aa',
  pink: '#ec407a',
  gray: '#9e9e9e',
  grey: '#9e9e9e',
  silver: '#c0c0c0',
}

function parseColor(input) {
  const raw = String(input ?? '').trim().toLowerCase()
  const value = NAMED_COLORS[raw] ?? raw
  const matched = value.match(/^#?([0-9a-f]{3}|[0-9a-f]{6})$/)
  if (!matched) return null

  let hex = matched[1]
  if (hex.length === 3) hex = hex.split('').map((c) => c + c).join('')

  return {
    r: parseInt(hex.slice(0, 2), 16),
    g: parseInt(hex.slice(2, 4), 16),
    b: parseInt(hex.slice(4, 6), 16),
  }
}

// 预设图案：每个预设带显式配色和字符映射，不靠出现顺序，避免颜色串味
const PRESETS = {
  heart: {
    colors: ['#ec407a'],
    map: { '#': 0 },
    rows: [
      '..##...##..',
      '.####.####.',
      '###########',
      '###########',
      '.#########.',
      '..#######..',
      '...#####...',
      '....###....',
      '.....#.....',
    ],
  },
  star: {
    colors: ['#fdd835'],
    map: { '#': 0 },
    rows: [
      '.....#.....',
      '....###....',
      '....###....',
      '###########',
      '.#########.',
      '..#######..',
      '...#####...',
      '..###.###..',
      '.##.....##.',
    ],
  },
  // 鱼头朝右，w 是眼睛
  fish: {
    colors: ['#1e88e5', '#ffffff'],
    map: { '#': 0, w: 1 },
    rows: [
      '.........#####',
      '.......#######',
      '..############',
      '.#####w#######',
      '..############',
      '.......#######',
      '.........#####',
    ],
  },
  // # 机身 / w 银色边框 / L 蓝色镜片 / s 红色快门
  camera: {
    colors: ['#1b1b1b', '#c0c0c0', '#64b5f6', '#e53935'],
    map: { '#': 0, w: 1, L: 2, s: 3 },
    rows: [
      '..###....###...',
      '..###....s##...',
      '###############',
      '###############',
      '#wwwwwwwwwwwww#',
      '#ww..LLLLL..ww#',
      '#ww.LLLLLLL.ww#',
      '#wwLLLLLLLLLww#',
      '#ww.LLLLLLL.ww#',
      '#ww..LLLLL..ww#',
      '#wwwwwwwwwwwww#',
      '###############',
    ],
  },
}

function normalizePattern(pattern) {
  if (!pattern) return null

  const raw = Array.isArray(pattern) ? pattern : String(pattern).split('\n')
  const rows = raw.map((line) => String(line).replace(/\r/g, '')).filter((line) => line.length > 0)
  if (rows.length === 0) return null

  const cols = Math.max(...rows.map((line) => line.length))
  return rows.map((line) => line.padEnd(cols, '.'))
}

async function drawPixel(args = {}) {
  const presetName = String(args.preset ?? '').trim().toLowerCase()
  const preset = PRESETS[presetName]
  const rows = normalizePattern(args.pattern) ?? preset?.rows

  if (!rows) {
    throw new Error(
      `没拿到图案：传 preset（${Object.keys(PRESETS).join(' / ')}）或者 pattern（每行一个字符串）`,
    )
  }

  const lines = rows.length
  const cols = rows[0].length

  if (cols > MAX_COLS || lines > MAX_ROWS) {
    throw new Error(`图案最大 ${MAX_COLS}×${MAX_ROWS}，你这是 ${cols}×${lines}`)
  }

  const scale = Math.min(Math.max(Number(args.scale) || 8, 1), MAX_SCALE)
  const outW = cols * scale
  const outH = lines * scale

  if (outW * outH > MAX_OUTPUT_PIXELS) {
    throw new Error(
      `放大后 ${outW}×${outH} = ${(outW * outH / 1_000_000).toFixed(1)}M 像素，超过 ${MAX_OUTPUT_PIXELS / 1_000_000}M 上限，把 scale 调小`,
    )
  }

  const colorInputs =
    Array.isArray(args.colors) && args.colors.length > 0
      ? args.colors
      : (preset?.colors ?? ['#1e88e5'])
  if (colorInputs.length > MAX_COLORS) throw new Error(`最多 ${MAX_COLORS} 种颜色`)

  const palette = colorInputs.map(parseColor)
  if (palette.some((color) => !color)) throw new Error('颜色要写成 #rgb / #rrggbb 或 black/white/red 这类名字')

  const background = args.background ? parseColor(args.background) : null

  const rgba = Buffer.alloc(outW * outH * 4)
  if (background) {
    for (let i = 0; i < outW * outH; i += 1) {
      rgba[i * 4] = background.r
      rgba[i * 4 + 1] = background.g
      rgba[i * 4 + 2] = background.b
      rgba[i * 4 + 3] = 255
    }
  }

  // 字符 → 颜色索引：预设用自带映射；自定义 pattern 按出现顺序分配
  const charIndex = new Map()

  if (preset && !args.pattern) {
    for (const [char, index] of Object.entries(preset.map)) charIndex.set(char, index)
  } else {
    charIndex.set('#', 0)
    let nextIndex = 1
    for (const line of rows) {
      for (const char of line) {
        if (char === '.' || char === ' ') continue
        if (charIndex.has(char)) continue
        charIndex.set(char, nextIndex % palette.length)
        nextIndex += 1
      }
    }
  }

  for (let y = 0; y < lines; y += 1) {
    for (let x = 0; x < cols; x += 1) {
      const char = rows[y][x]
      const index = charIndex.get(char)
      if (index === undefined) continue

      const color = palette[index] ?? palette[0]

      for (let dy = 0; dy < scale; dy += 1) {
        for (let dx = 0; dx < scale; dx += 1) {
          const px = x * scale + dx
          const py = y * scale + dy
          const offset = (py * outW + px) * 4
          rgba[offset] = color.r
          rgba[offset + 1] = color.g
          rgba[offset + 2] = color.b
          rgba[offset + 3] = 255
        }
      }
    }
  }

  fs.mkdirSync(outDir, { recursive: true })
  const file = path.join(outDir, `draw-${Date.now()}.png`)
  fs.writeFileSync(file, encodePng(outW, outH, rgba))

  const relative = path.relative(projectRoot, file).split(path.sep).join('/')

  return [
    `已生成 ${relative}（${outW}×${outH} 像素，图案 ${cols}×${lines} 放大 ${scale} 倍）`,
    `用 send_image 发它，path 传 "${path.basename(file)}"`,
  ].join('\n')
}

export const DRAW_HANDLERS = { draw_pixel: drawPixel }

export const DRAW_TOOLS = [
  {
    name: 'draw_pixel',
    description:
      '画一张像素风 PNG 存到 downloads/，然后可以用 send_image 发出去。' +
      '两种用法：传 preset（heart 爱心 / star 星星 / fish 鱼 / camera 相机），' +
      '或者传 pattern 自己拼——每行一个字符串，# 是主色，. 是透明，其他字符按顺序用 colors 里的颜色。' +
      'colors 支持 #rrggbb 或 black/white/red 这类名字；scale 是整数倍放大（1-20，默认 8）。' +
      '只画图，不接受命令行、不执行任何东西，所以谁都能用。',
    inputSchema: {
      type: 'object',
      properties: {
        preset: {
          type: 'string',
          description: '预设图案：heart / star / fish / camera',
          enum: ['heart', 'star', 'fish', 'camera'],
        },
        pattern: {
          type: 'array',
          items: { type: 'string' },
          description: '自定义字符网格，每行一个字符串，例如 ["..##..", ".####.", "######"]',
        },
        colors: {
          type: 'array',
          items: { type: 'string' },
          description: '颜色列表，如 ["#ff3366", "#ffffff"]；不传默认蓝色',
        },
        scale: { type: 'integer', description: '放大倍数，1-20，默认 8' },
        background: { type: 'string', description: '背景色，不传透明' },
      },
    },
  },
]
