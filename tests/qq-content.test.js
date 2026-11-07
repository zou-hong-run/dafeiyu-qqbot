import test from 'node:test'
import assert from 'node:assert/strict'
import { flatten, sanitizeText } from '../src/channel/qq.js'

// 出站内容拼装：@ 和表情在 QQ 协议里是 content 里的特殊标签，
// 所以「谁的内容」必须分清——我们拼的是指令，用户给的只能当文本。

test('普通文本原样保留', () => {
  assert.equal(flatten('你好呀').text, '你好呀')
  assert.equal(flatten({ type: 'text', data: { text: '在' } }).text, '在')
})

test('@ 全体和正常 openid', () => {
  assert.equal(flatten({ type: 'at', data: { user_id: 'all' } }).text, '<qqbot-at-everyone />')
  assert.equal(
    flatten({ type: 'at', data: { user_id: 'D51C979833FA4F3EEFFB65E50B50EB06' } }).text,
    '<qqbot-at-user id="D51C979833FA4F3EEFFB65E50B50EB06" />',
  )
})

test('带引号的 openid 会被拦，没法伪造额外标签', () => {
  assert.throws(
    () => flatten({ type: 'at', data: { user_id: 'x" /><qqbot-at-everyone /><qqbot-at-user id="y' } }),
    /openid 不合法/,
  )
})

test('文本里的协议标签会被剥掉', () => {
  // 用户原文里带标签，发出去不能被平台当成 @ 或表情
  assert.equal(flatten('开会了<qqbot-at-everyone />').text, '开会了')
  assert.equal(flatten('<emoji:118>好开心').text, '好开心')
  assert.equal(flatten('看这个 <qqbot-at-user id="abc" /> 是谁').text, '看这个  是谁')
})

test('sanitizeText 不误伤代码里的尖括号', () => {
  assert.equal(sanitizeText('if (a < b && c > d)'), 'if (a < b && c > d)')
  assert.equal(sanitizeText('用 <div> 包一层'), '用 <div> 包一层')
  assert.equal(sanitizeText('<qqbot-at-user id="x" />'), '')
})

test('表情 id 超范围直接丢弃', () => {
  assert.equal(flatten({ type: 'face', data: { id: 118 } }).text, '<emoji:118>')
  assert.equal(flatten({ type: 'face', data: { id: 9999 } }).text, '')
  assert.equal(flatten({ type: 'face', data: { id: -1 } }).text, '')
})

test('媒体段单独收集，不进 content', () => {
  const result = flatten([
    { type: 'text', data: { text: '看这张' } },
    { type: 'image', data: { file: '/tmp/a.png' } },
  ])
  assert.equal(result.text, '看这张')
  assert.equal(result.media.length, 1)
  assert.equal(result.media[0].type, 'image')
})

test('markdown 图片：外链补默认宽度，已上传的引用不动', async () => {
  const { rewriteMarkdownImages } = await import('../src/channel/qq.js')
  const text = '![图](https://a.com/x.png) 和 ![图2](qqbot-media://image/v1/abc)'
  // 单测不真做 DNS
  const checkUrl = async () => {}
  // 平台按原图尺寸渲染会糊满屏，外链图统一补 #320px；qqbot-media 已经是发出去的引用，不再动
  assert.equal(
    await rewriteMarkdownImages(text, undefined, { checkUrl }),
    '![图 #320px](https://a.com/x.png) 和 ![图2](qqbot-media://image/v1/abc)',
  )
})

test('markdown 图片：自己写了宽度就尊重它', async () => {
  const { rewriteMarkdownImages } = await import('../src/channel/qq.js')
  const text = '![图 #500px](https://a.com/x.png)'
  const checkUrl = async () => {}
  assert.equal(await rewriteMarkdownImages(text, undefined, { checkUrl }), text)
})

test('markdown 图片：内网地址被摘掉', async () => {
  const { rewriteMarkdownImages } = await import('../src/channel/qq.js')
  const text = '正文 ![图](http://169.254.169.254/latest/meta-data/) 结束'
  const checkUrl = async (raw) => {
    if (String(raw).includes('169.254.169.254')) throw new Error('不允许访问内网')
  }
  const output = await rewriteMarkdownImages(text, undefined, { checkUrl })
  assert.equal(output, '正文  结束')
})

test('markdown 图片：读不到的本地路径原样保留', async () => {
  const { rewriteMarkdownImages } = await import('../src/channel/qq.js')
  const text = '![图](tmp/not-exist-12345.png)'
  assert.equal(await rewriteMarkdownImages(text), text)
})

test('markdown 图片：没有图片语法时快速返回', async () => {
  const { rewriteMarkdownImages } = await import('../src/channel/qq.js')
  assert.equal(await rewriteMarkdownImages('纯文本没有图'), '纯文本没有图')
})

test('发文件时文件名一定带扩展名', async () => {
  const { ensureFileNameExtension } = await import('../src/channel/media.js')

  // 名字自带后缀：原样
  assert.equal(ensureFileNameExtension('报告.pdf', '/tmp/x.pdf'), '报告.pdf')
  // 名字没后缀：借源文件的
  assert.equal(ensureFileNameExtension('报告', '/tmp/x.pdf'), '报告.pdf')
  // 都不传：用源文件名
  assert.equal(ensureFileNameExtension('', '/tmp/x.zip'), 'x.zip')
  // 源文件也没后缀：按文件头猜
  assert.equal(ensureFileNameExtension('数据', '/tmp/raw', Buffer.from([0x50, 0x4b, 0x03, 0x04])), '数据.zip')
  assert.equal(ensureFileNameExtension('图片', '/tmp/raw', Buffer.from([0x89, 0x50, 0x4e, 0x47])), '图片.png')
  // 猜不出来兜底成 .bin
  assert.equal(ensureFileNameExtension('未知', '/tmp/raw', Buffer.from('hello world')), '未知.bin')
})

test('超长文件名加后缀后仍不超过 120 字符', async () => {
  const { ensureFileNameExtension } = await import('../src/channel/media.js')
  const name = 'a'.repeat(200)
  const result = ensureFileNameExtension(name, '/tmp/x.pdf')
  assert.ok(result.length <= 120)
  assert.ok(result.endsWith('.pdf'))
})
