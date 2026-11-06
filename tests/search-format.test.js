import test from 'node:test'
import assert from 'node:assert/strict'
import { citationLine, formatSearchResults } from '../src/mcp-server/search-format.js'

// 搜索结果要直接给出可以复制的 markdown 链接。
// 只给裸 url 时模型会漏——真出现过整篇热点新闻六个条目一个链接都没有。

const RESULTS = [
  { title: '纳指单日跌 5.52%', url: 'https://wallstreetcn.com/articles/3785302', site_name: '华尔街见闻', summary: '美股科技股大跌' },
  { title: '法国爆发大规模抗议', url: 'https://www.thepaper.cn/newsDetail_forward_31900000', site_name: '澎湃新闻', date: '2026-11-06' },
  { title: '没有来源的条目', url: 'https://example.com/a' },
]

test('每条结果都带一条拼好的 markdown 链接', () => {
  const text = formatSearchResults(RESULTS)

  assert.match(text, /\[华尔街见闻\]\(https:\/\/wallstreetcn\.com\/articles\/3785302\)/)
  assert.match(text, /\[澎湃新闻\]\(https:\/\/www\.thepaper\.cn\/newsDetail_forward_31900000\)/)
  // 没有 site_name 时退回「网页」，但链接不能丢
  assert.match(text, /\[网页\]\(https:\/\/example\.com\/a\)/)

  // 三条结果就该有三条链接
  assert.equal((text.match(/\]\(https:\/\//g) ?? []).length, 3)
})

test('日期有就带，没有就不留空行', () => {
  const text = formatSearchResults(RESULTS)
  assert.match(text, /时间: 2026-11-06/)
  const noDate = formatSearchResults([RESULTS[0]])
  assert.doesNotMatch(noDate, /时间:/)
})

test('空结果不炸', () => {
  assert.equal(formatSearchResults([]), '共 0 条结果：\n\n')
  assert.equal(formatSearchResults(undefined), '共 0 条结果：\n\n')
})

test('摘要过长时截断，不撑爆上下文', () => {
  const long = [{ ...RESULTS[0], summary: '很'.repeat(600) }]
  const text = formatSearchResults(long)
  assert.match(text, /…/)
  assert.ok(text.length < 600)
})

test('fetch 的引用行也是可直接复制的 markdown', () => {
  assert.equal(
    citationLine('纳指跌了', 'https://wallstreetcn.com/a/1'),
    '引用时原样复制这一行，别改写：[纳指跌了](https://wallstreetcn.com/a/1)\n',
  )
  // 没标题时不能生成空的方括号
  assert.match(citationLine('', 'https://x.com/a'), /\[原文\]/)
})
