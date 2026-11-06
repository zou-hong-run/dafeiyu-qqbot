// 搜索结果的呈现格式。
// 抽成独立模块是为了能单测：index.js 一被 import 就会读 .env、起 MCP 服务，测不了。

import { assertPublicUrl } from './net-guard.js'

function clip(text, limit) {
  const value = String(text ?? '').replace(/\s+/g, ' ').trim()
  return value.length <= limit ? value : `${value.slice(0, limit)}…`
}

/**
 * 标题和媒体名来自第三方网页，作者可以随便写。
 * 不转义的话，标题 `标题](http://evil)` 会拼成
 * `[标题](http://evil)](https://ok.com)` —— 链接目标被掉包，
 * 而 persona 又要求模型「原样复制这一行」，等于让机器人账号替攻击者发链接。
 */
function escapeInline(text) {
  return String(text ?? '')
    .replace(/[\r\n]+/g, ' ')
    .replace(/([\\[\]()])/g, '\\$1')
    .replace(/\s+/g, ' ')
    .trim()
}

/** 链接目标里的括号会提前闭合链接；地址不合法就干脆不给链接 */
function safeLinkTarget(raw) {
  try {
    const url = assertPublicUrl(raw)
    return url.toString().replace(/\(/g, '%28').replace(/\)/g, '%29')
  } catch {
    return ''
  }
}

/**
 * 每条结果都必须带一条可直接复制的 markdown 链接。
 *
 * 给的是拼好的整行，不是裸 url——模型拿到裸 url 会自己重拼，然后漏掉。
 * 真出过：整篇热点新闻只有「来源：澎湃新闻」「央视网」「看看新闻·K24」，
 * 六个条目一个链接都没有，用户点不开。
 */
export function formatSearchResults(results) {
  const list = Array.isArray(results) ? results : []

  const lines = list.map((item, index) => {
    const media = escapeInline(item.site_name || '网页')
    const title = escapeInline(item.title || '（无标题）')
    const target = safeLinkTarget(item.url)

    const parts = [`${index + 1}. ${title}`]
    parts.push(
      target
        ? `   引用时原样复制这一行，别改写：[${media}](${target})`
        : '   （这条的链接地址不合法，不要把它当新闻报出来）',
    )
    if (item.date) parts.push(`   时间: ${escapeInline(item.date)}`)
    parts.push(`   摘要: ${clip(item.summary || item.snippet, 400)}`)
    return parts.join('\n')
  })

  return `共 ${list.length} 条结果：\n\n${lines.join('\n\n')}`
}

/** fetch 的引用行：同样是拼好的 markdown，模型照抄即可 */
export function citationLine(title, url) {
  const target = safeLinkTarget(url)
  if (!target) return '（这个页面的地址不合法，不要引用它）\n'

  const label = escapeInline(title || '原文')
  // 方括号和圆括号都已经转义，标题里塞不进额外的链接
  return `引用时原样复制这一行，别改写：[${label}](${target})\n`
}
