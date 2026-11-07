// 从网页 HTML 里挑可用的配图。
// 抽成独立模块是为了能单测：index.js 一被 import 就会读 .env、起 MCP 服务，测不了。

import { NET_ERROR, assertPublicUrl, assertPublicUrlResolved, fetchPublic } from './net-guard.js'

// 页面里大量 <img> 是二维码、logo、头像、占位图，拿它们当配图等于发垃圾
const IMAGE_JUNK =
  /(qrcode|zxcode|ewm|erweima|logo|avatar|icon|emoji|sprite|spacer|blank|placeholder|loading|lazy|default[_-]?img|share)/i
const IMAGE_EXT = /\.(jpe?g|png|webp|gif)(?:[?#]|$)/i
const MAX_IMAGES = 3
const MAX_HTML_BYTES = 200_000
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36'

function absoluteUrl(raw, base) {
  try {
    return new URL(String(raw ?? '').trim(), base).toString()
  } catch {
    return ''
  }
}

/**
 * 这个地址能不能当配图交出去。
 *
 * 网页内容由网站作者控制：og:image 写成 http://169.254.169.254/latest/meta-data/
 * 一样能被提取出来，模型会当可信数据、再交给 send_image。所以地址必须过一遍
 * 出网校验，内网和云元数据一律不认。
 */
function publicImage(raw, base) {
  const absolute = absoluteUrl(raw, base)
  if (!absolute) return ''
  try {
    assertPublicUrl(absolute)
  } catch {
    return ''
  }
  return absolute
}

/** 正文图要用：公网地址 + 图片扩展名 + 不是装饰图 */
export function usableImage(raw, base) {
  const absolute = publicImage(raw, base)
  if (!absolute) return ''
  if (!IMAGE_EXT.test(absolute)) return ''
  if (IMAGE_JUNK.test(absolute)) return ''
  return absolute
}

/**
 * 分享主图不看扩展名——很多 CDN 地址不带后缀——但仍要排除 logo 之类，
 * 且地址必须是公网可达的。主图排最前，正文图跟后面，最多 3 个。
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
    const absolute = publicImage(matched[1], base)
    if (absolute && !IMAGE_JUNK.test(absolute)) {
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

/** 流式读，超过上限就停——不认识的服务器可以一直吐数据，readAll 会把进程撑爆 */
async function readLimited(response, limit) {
  if (!response.body) return ''
  const reader = response.body.getReader()
  const chunks = []
  let total = 0
  try {
    while (total < limit) {
      const { done, value } = await reader.read()
      if (done) break
      chunks.push(Buffer.from(value))
      total += value?.length ?? 0
    }
  } finally {
    reader.cancel().catch(() => {})
  }
  return Buffer.concat(chunks).subarray(0, limit).toString('utf8')
}

/**
 * 抓一次页面 HTML 再挑图。
 *
 * 走 fetchPublic：逐跳复核重定向、并对域名解析结果做内网判断。
 * 原来的裸 fetch 是「群聊里任何人给个网址就能让服务器去请求」——fetch 工具
 * 原本交给服务端抓，本地不出网，配图这一步把它变成了本地出网，必须收回来。
 */
export async function pageImagesOf(
  url,
  { timeout = 15_000, fetchImpl = fetchPublic, resolveImpl = assertPublicUrlResolved } = {},
) {
  try {
    assertPublicUrl(url)

    const response = await fetchImpl(url, {
      headers: { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml' },
      signal: AbortSignal.timeout(timeout),
    })
    if (!response.ok) return []

    const html = await readLimited(response, MAX_HTML_BYTES)
    const candidates = pickImages(html, url)

    // pickImages 只做字面量校验（同步、能单测）。这里再补 DNS 解析：
    // `127.0.0.1.nip.io`、`localtest.me` 这类域名字面量看着是公网，解析出来是内网。
    const safe = []
    for (const image of candidates) {
      try {
        await resolveImpl(image)
      } catch (error) {
        // 只有「确实指向内网/元数据」才丢。单纯的解析失败（DNS 临时抽风、
        // CDN 域名在沙箱里查不到）不该连图一起扔掉——平台那边会做自己的校验。
        // 按错误码判，不匹配文案：文案改了这里不会跟着失效。
        if (error?.code === NET_ERROR.BLOCKED_ADDRESS) continue
      }
      safe.push(image)
    }
    return safe
  } catch {
    return []
  }
}

