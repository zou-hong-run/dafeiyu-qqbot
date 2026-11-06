import test from 'node:test'
import assert from 'node:assert/strict'
import { pickImages, pageImagesOf, usableImage } from '../src/mcp-server/page-images.js'

// 新闻页配图提取：og:image 优先，正文图兜底，二维码/logo 一律丢掉

const BASE = 'https://www.news.cn/politics/20261104/c.html'

test('usableImage 只认 http 图片地址', () => {
  assert.equal(usableImage('/pic/a.jpg', BASE), 'https://www.news.cn/pic/a.jpg')
  assert.equal(usableImage('https://cdn.x.com/b.png?w=600', BASE), 'https://cdn.x.com/b.png?w=600')
  assert.equal(usableImage('data:image/png;base64,xxx', BASE), '')
  assert.equal(usableImage('/detail/page.html', BASE), '')
  assert.equal(usableImage('', BASE), '')
})

test('usableImage 过滤二维码和装饰图', () => {
  for (const junk of [
    '/images/qrcode.png',
    '/zxcode_202611045de5.jpg',
    '/static/images/logo-144.png',
    '/avatar/profile/228925.png',
    '/img/loading.gif',
    '/img/share_icon.png',
  ]) {
    assert.equal(usableImage(junk, BASE), '', `${junk} 不该被当成配图`)
  }
})

test('og:image 排第一，正文图跟后面', () => {
  const html = `
    <head><meta property="og:image" content="https://cdn.x.com/cover.jpg"></head>
    <body>
      <img src="/images/logo-144.png">
      <img src="/politics/20261104/photo1.jpg">
      <img src="/politics/20261104/photo2.jpg">
    </body>`
  const images = pickImages(html, BASE)
  assert.equal(images[0], 'https://cdn.x.com/cover.jpg')
  assert.equal(images[1], 'https://www.news.cn/politics/20261104/photo1.jpg')
  assert.equal(images[2], 'https://www.news.cn/politics/20261104/photo2.jpg')
})

test('og:image 是 logo 时退回正文图', () => {
  const html = `
    <meta property="og:image" content="https://zmt.itc.cn/static/images/pic/logo-144.png">
    <img src="/2026/news/pic.jpg">`
  assert.deepEqual(pickImages(html, BASE), ['https://www.news.cn/2026/news/pic.jpg'])
})

test('最多 3 张，重复地址只留一次', () => {
  const html = ['a.jpg', 'b.jpg', 'a.jpg', 'c.jpg', 'd.jpg', 'e.jpg']
    .map((name) => `<img src="https://cdn.x.com/${name}">`)
    .join('')
  const images = pickImages(html, BASE)
  assert.equal(images.length, 3)
  assert.equal(new Set(images).size, 3)
})

test('没有可用图时返回空数组', () => {
  const html = '<img src="/images/qrcode.png"><img src="/img/logo.png">'
  assert.deepEqual(pickImages(html, BASE), [])
  assert.deepEqual(pickImages('', BASE), [])
})

test('pageImagesOf 抓页面后返回图片', async () => {
  const fetchImpl = async () => ({
    ok: true,
    text: async () => '<meta property="og:image" content="https://cdn.x.com/cover.jpg">',
  })
  assert.deepEqual(await pageImagesOf(BASE, { fetchImpl }), ['https://cdn.x.com/cover.jpg'])
})

test('pageImagesOf 出错或非 200 时返回空，不抛', async () => {
  const notOk = async () => ({ ok: false, text: async () => '' })
  assert.deepEqual(await pageImagesOf(BASE, { fetchImpl: notOk }), [])

  const boom = async () => {
    throw new Error('network down')
  }
  assert.deepEqual(await pageImagesOf(BASE, { fetchImpl: boom }), [])
})
