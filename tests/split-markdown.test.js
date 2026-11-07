import test from 'node:test'
import assert from 'node:assert/strict'
import { chunkText, clip, looksSliced, splitMarkdown } from '../src/channel/sender.js'

// 定时任务的日报分段：markdown 不能按句子切，否则列表和引用会被劈开

test('按空行切，每段是完整的块', () => {
  const text = '# 日报\n\n- 第一项\n- 第二项\n\n> 一句引用\n\n收尾'
  const parts = splitMarkdown(text, 20)

  assert.ok(parts.length >= 2)
  for (const part of parts) {
    assert.ok(part.length <= 20, `每段不超限：${part.length}`)
  }
  // 列表不能被拆成两段
  const listPart = parts.find((part) => part.includes('第一项'))
  assert.ok(listPart.includes('第二项'), '列表项应该在同一段里')
})

test('单个块本身超长时硬切', () => {
  const text = 'A'.repeat(100)
  const parts = splitMarkdown(text, 30)
  assert.equal(parts.length, 4)
  assert.equal(parts.join(''), text)
})

test('空输入返回空数组', () => {
  assert.deepEqual(splitMarkdown(''), [])
  assert.deepEqual(splitMarkdown('   '), [])
  assert.deepEqual(splitMarkdown(null), [])
})

test('没有空行的连续列表保持连续', () => {
  const text = '- 一\n- 二\n- 三'
  const parts = splitMarkdown(text, 100)
  assert.equal(parts.length, 1)
  assert.equal(parts[0], text)
})

test('切分时不会把 URL 劈成两半', () => {
  const url = 'https://m.sohu.com/a/1097835995_313745'
  const text = '前面一段话。' + 'A'.repeat(30) + `[界面早报](${url})` + '后面还有内容'

  for (const part of splitMarkdown(text, 40)) {
    // 任何一段都不该出现半截链接
    const opens = (part.match(/\]\(/g) ?? []).length
    const closes = (part.match(/\)/g) ?? []).length
    assert.ok(opens <= closes, `链接没闭合：${part}`)
    assert.ok(!/https?:\/\/[^\s)]*$/.test(part) || part.includes(')'), `URL 被截断：${part}`)
  }
})

test('超长纯 URL 不会被切成死链', () => {
  const url = 'https://example.com/' + 'x'.repeat(100)
  const parts = splitMarkdown(url, 40)
  const joined = parts.join('')
  assert.equal(joined, url, '拼起来应该还原成完整 URL')
})

// 群里真出过的事：长回复被分成两条时，[华尔街见闻](https://wallstreetcn.com/...)
// 从 https://walls | treetcn.com/... 断开，第一条里的链接变成死链。

const NEWS = `11月6日 全球市场速览
1. AI 股暴跌，纳指进入技术性回调
美国中期选举中民主党获胜后，市场开始担心数据中心审批会收紧、电价会上涨。纳指单日 -5.52%，费城半导体指数 -12.25%。
个股：闪迪 -22%，AMD -17.3%，英伟达 -9.3%，年内涨幅已经转负。
2. 得州成为数据中心面临政策风险的焦点
高盛警告：约 45% 的美国计划数据中心扩张容量面临暂停风险，约 13GW 容量直接暴露。
4. 松下新竹覆铜板厂爆炸，高端 CCL 缺口 4%
受损产能约占全球高端 CCL 供给的 4%，MEGTRON 核心产线复工可能需要数月。
[华尔街见闻](https://wallstreetcn.com/articles/3785302)
5. 中国空间站造出已知最冷人造物质
梦天舱超冷原子物理实验柜刷新人类最低温物质纪录，成果当天发表在《科学》。`

test('分段后每一段都不是半截链接', () => {
  for (const limit of [200, 300, 400, 500, 700, 900]) {
    for (const part of chunkText(NEWS, limit)) {
      assert.equal(looksSliced(part), false, `limit=${limit} 出现半截链接：${JSON.stringify(part.slice(-40))}`)
    }
    for (const part of splitMarkdown(NEWS, limit)) {
      assert.equal(looksSliced(part), false, `limit=${limit}（markdown）出现半截链接`)
    }
  }
})

test('looksSliced 认得出被切开的链接', () => {
  assert.ok(looksSliced('4. 松下厂爆炸\n[华尔街见闻](https://walls'))
  assert.ok(looksSliced('treetcn.com/articles/3785302)\n5. 中国空间站'))
  assert.ok(looksSliced('详情见 https://example.com/a'))
  assert.equal(looksSliced('看这里 [华尔街见闻](https://wallstreetcn.com/articles/3785302) 就明白了'), false)
  assert.equal(looksSliced('今天天气不错。'), false)
})

// markdown 支持内嵌图片：![说明](地址)。切在 ! 和 [ 之间、或切在地址中间，
// 图片都会坏——上半段一个孤零零的感叹号，下半段是半截 URL。
const WITH_IMAGE = `11月7日凌晨 热点
1. 今早 5:30，金星伴月
东方低空，一弯残月旁边挂着启明星。用望远镜看，金星也是月牙形状。
![香山红叶](https://imgpai.thepaper.cn/newpai/image/1793969301237_XjzCwp_1793969301448.png)
2. 法国爆发今秋最大规模抗议
跨工会联盟称，巴黎有 4 万到 8 万人上街，全法实际参与人数在 60 万到 160 万之间。`

test('图片标记不会被切开', () => {
  for (const limit of [200, 300, 400, 600, 900]) {
    for (const part of chunkText(WITH_IMAGE, limit)) {
      assert.doesNotMatch(part, /!\s*$/, `limit=${limit} 段尾留下孤立的感叹号`)
      assert.ok(
        !/!\[[^\]]*\]\(https:\/\/[^)]*$/.test(part),
        `limit=${limit} 图片地址被切断：${JSON.stringify(part.slice(-30))}`,
      )
    }
    const joined = chunkText(WITH_IMAGE, limit).join('')
    assert.match(joined, /!\[香山红叶\]\(https:\/\/imgpai[^)]+\)/, `limit=${limit} 图片标记没保住`)
  }
})

test('切点正好落在 ! 和 [ 之间时往前挪一位', () => {
  const text = `${'a'.repeat(19)}![图](https://x.com/a.png)`
  const parts = chunkText(text, 20)
  assert.ok(parts.every((part) => !/!\s*$/.test(part)), '不能把 ! 留在段尾')
})

// 分段目标是 900，但有些段因为链接跨了切点切不开，会略超。
// 硬上限之内整段发出去，超过才截断——切坏链接和丢掉大半条回复，后者严重得多。
test('略超分段目标不截断，超过硬上限才截', async () => {
  const env = (await import('../src/config/env.js')).env

  // 超过分段目标但没到硬上限：原样返回
  const over = 'A'.repeat(env.replyMaxChars + 100)
  assert.ok(over.length > env.replyMaxChars && over.length <= env.replyHardMax, '前提成立')
  assert.equal(clip(over), over, '这种段要整段发出去，不能截')

  // 超过硬上限：才截，并且带说明
  const huge = 'B'.repeat(env.replyHardMax + 200)
  const clipped = clip(huge)
  assert.match(clipped, /内容过长，已截断/)
  assert.ok(clipped.length < huge.length)
})
