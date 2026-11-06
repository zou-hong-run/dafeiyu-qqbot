// 从网页 HTML 里挑可用的配图。
// 抽成独立模块是为了能单测：index.js 一被 import 就会读 .env、起 MCP 服务，测不了。

// 页面里大量 <img> 是二维码、logo、头像、占位图，拿它们当配图等于发垃圾
const IMAGE_JUNK =
  /(qrcode|zxcode|ewm|erweima|logo|avatar|icon|emoji|sprite|spacer|blank|placeholder|loading|lazy|default[_-]?img|share)/i
const IMAGE_EXT = /\.(jpe?g|png|webp|gif)(?:[?#]|$)/i
const MAX_IMAGES = 3
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36'

function absoluteUrl(raw, base) {
  try {
    return new URL(String(raw ?? '').trim(), base).toString()
  } catch {
    return ''
  }
}

/** 正文图要用：http(s) + 图片扩展名 + 不是装饰图 */
export function usableImage(raw, base) {
  const absolute = absoluteUrl(raw, base)
  if (!absolute.startsWith('http')) return ''
  if (!IMAGE_EXT.test(absolute)) return ''
  if (IMAGE_JUNK.test(absolute)) return ''
  return absolute
}

/**
 * 分享主图不看扩展名——很多 CDN 地址不带后缀——但仍要排除 logo 之类。
 * 主图排在最前，正文图跟在后面，最多 3 个。
 */
export function pickImages(html, base) {
  const text = String(html ?? '')
  const found = []

  const metas = [
    /<meta[^>]+property=["']og:image(?::url)?["'][^>]*content=["']([^"']+)["']/i,
    /<meta[^>]+content=["']([^"']+)["'][^>]*property=["']og:image(?::url)?["']/i,
    /<meta[^>]+name=["']twitter:image(?::src)?["'][^>]*content=["']([^"']+)["']/i,
    /<meta[^>]+content=["']([^"']+)["'][^>]*name=["']twitter:image["']/i,
  ]
  for (const pattern of metas) {
    const matched = text.match(pattern)
    if (!matched) continue
    const absolute = absoluteUrl(matched[1], base)
    if (absolute.startsWith('http') && !IMAGE_JUNK.test(absolute)) {
      found.push(absolute)
      break
    }
  }

  for (const matched of text.matchAll(/<img[^>]+src=["']([^"']+)["']/gi)) {
    if (found.length >= MAX_IMAGES) break
    const image = usableImage(matched[1], base)
    if (image && !found.includes(image)) found.push(image)
  }

  return found.slice(0, MAX_IMAGES)
}

/**
 * 抓一次页面 HTML 再挑图。只读前 200KB 就够：meta 在 head，正文首图不会太靠后。
 * 任何失败都返回空数组，不影响正文。
 */
export async function pageImagesOf(url, { timeout = 15_000, fetchImpl = fetch } = {}) {
  try {
    const response = await fetchImpl(url, {
      headers: { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml' },
      signal: AbortSignal.timeout(timeout),
    })
    if (!response.ok) return []
    const html = (await response.text()).slice(0, 200_000)
    return pickImages(html, url)
  } catch {
    return []
  }
}
