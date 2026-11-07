import test from 'node:test'
import assert from 'node:assert/strict'
import { pickImages, pageImagesOf, usableImage } from '../src/mcp-server/page-images.js'
import { NET_ERROR } from '../src/mcp-server/net-guard.js'

// 新闻页配图提取：og:image 优先，正文图兜底，二维码/logo 一律丢掉。
// 网页内容由网站作者控制，所以每个候选地址还要过一遍出网校验。

const BASE = 'https://www.news.cn/politics/20261104/c.html'

// 单测不真做 DNS：默认放行，需要时注入一个会抛的
const allowDns = async () => {}

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
  const fetchImpl = async () =>
    new Response('<meta property="og:image" content="https://cdn.x.com/cover.jpg">', {
      headers: { 'Content-Type': 'text/html' },
    })
  assert.deepEqual(await pageImagesOf(BASE, { fetchImpl, resolveImpl: allowDns }), ['https://cdn.x.com/cover.jpg'])
})

test('pageImagesOf 出错或非 200 时返回空，不抛', async () => {
  const notOk = async () => new Response('', { status: 404 })
  assert.deepEqual(await pageImagesOf(BASE, { fetchImpl: notOk, resolveImpl: allowDns }), [])

  const boom = async () => {
    throw new Error('network down')
  }
  assert.deepEqual(await pageImagesOf(BASE, { fetchImpl: boom, resolveImpl: allowDns }), [])
})

test('页面里指向内网或云元数据的图一律丢掉', () => {
  const html = [
    '<meta property="og:image" content="http://169.254.169.254/latest/meta-data/">',
    '<img src="http://127.0.0.1:8080/admin/a.png">',
    '<img src="http://[::ffff:169.254.169.254]/x.jpg">',
    '<img src="http://10.0.0.1/logo.png">',
    '<img src="https://cdn.x.com/ok.jpg">',
  ].join('\n')
  assert.deepEqual(pickImages(html, BASE), ['https://cdn.x.com/ok.jpg'])
})

test('og:image 写内网地址时不采用，退回正文图', () => {
  const html = [
    '<meta property="og:image" content="http://100.100.100.200/latest/meta-data/">',
    '<img src="https://cdn.x.com/photo.jpg">',
  ].join('\n')
  assert.deepEqual(pickImages(html, BASE), ['https://cdn.x.com/photo.jpg'])
})

test('pageImagesOf 拒绝抓内网地址，一个请求都不发', async () => {
  let called = false
  const fetchImpl = async () => {
    called = true
    return new Response('<img src="https://cdn.x.com/a.jpg">')
  }

  assert.deepEqual(await pageImagesOf('http://127.0.0.1:8080/admin', { fetchImpl, resolveImpl: allowDns }), [])
  assert.deepEqual(await pageImagesOf('http://169.254.169.254/latest/meta-data/', { fetchImpl, resolveImpl: allowDns }), [])
  assert.equal(called, false, '内网地址根本不该发出请求')
})

test('响应体超大时只读前面一段', async () => {
  const huge = '<img src="https://cdn.x.com/a.jpg">' + 'x'.repeat(5_000_000)
  const fetchImpl = async () => new Response(huge)
  assert.deepEqual(await pageImagesOf(BASE, { fetchImpl, resolveImpl: allowDns }), ['https://cdn.x.com/a.jpg'])
})

test('解析到内网的域名图片被丢掉（字面量看不出来）', async () => {
  const fetchImpl = async () =>
    new Response(
      [
        '<img src="http://127.0.0.1.nip.io/x.jpg">',
        '<img src="https://cdn.x.com/ok.jpg">',
      ].join('\n'),
    )

  // 模拟 DNS：nip.io 解析到回环，cdn.x.com 正常
  const resolveImpl = async (raw) => {
    if (String(raw).includes('nip.io')) {
      const error = new Error('不允许访问内网或云元数据地址')
      error.code = NET_ERROR.BLOCKED_ADDRESS
      throw error
    }
  }

  assert.deepEqual(await pageImagesOf(BASE, { fetchImpl, resolveImpl }), ['https://cdn.x.com/ok.jpg'])
})

test('DNS 解析失败不丢图，只有指向内网才丢', async () => {
  const fetchImpl = async () =>
    new Response(
      ['<img src="https://cdn-a.example/x.jpg">', '<img src="https://cdn-b.example/y.jpg">'].join('\n'),
    )

  // cdn-a 解析失败（DNS 抽风），cdn-b 解析到内网
  const resolveImpl = async (raw) => {
    if (String(raw).includes('cdn-b')) {
      const error = new Error('不允许访问内网或云元数据地址')
      error.code = NET_ERROR.BLOCKED_ADDRESS
      throw error
    }
    if (String(raw).includes('cdn-a')) throw new Error('域名解析失败：cdn-a.example')
  }

  const images = await pageImagesOf(BASE, { fetchImpl, resolveImpl })
  assert.deepEqual(images, ['https://cdn-a.example/x.jpg'], '解析失败的保留，指向内网的丢掉')
})
