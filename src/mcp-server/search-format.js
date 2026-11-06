// 搜索结果的呈现格式。
// 抽成独立模块是为了能单测：index.js 一被 import 就会读 .env、起 MCP 服务，测不了。

function clip(text, limit) {
  const value = String(text ?? '').replace(/\s+/g, ' ').trim()
  return value.length <= limit ? value : `${value.slice(0, limit)}…`
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
    const media = item.site_name || '网页'
    const parts = [`${index + 1}. ${item.title}`]
    parts.push(`   引用时原样复制这一行，别改写：[${media}](${item.url})`)
    if (item.date) parts.push(`   时间: ${item.date}`)
    parts.push(`   摘要: ${clip(item.summary || item.snippet, 400)}`)
    return parts.join('\n')
  })

  return `共 ${list.length} 条结果：\n\n${lines.join('\n\n')}`
}

/** fetch 的引用行：同样是拼好的 markdown，模型照抄即可 */
export function citationLine(title, url) {
  return `引用时原样复制这一行，别改写：[${title || '原文'}](${url})\n`
}
