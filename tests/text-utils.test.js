import test from 'node:test'
import assert from 'node:assert/strict'
import {
  SPILL_LIMIT,
  cleanReply,
  finalizeReply,
  looksLikeActionRequest,
  pruneToolOutput,
  stripToolMarkup,
} from '../src/chat/text-utils.js'

// 纯文本处理，不依赖 env 和网络，CI 上可直接跑

test('stripToolMarkup：普通文本原样返回', () => {
  assert.equal(stripToolMarkup('今天北京晴，11 度'), '今天北京晴，11 度')
  assert.equal(stripToolMarkup(''), '')
})

test('stripToolMarkup：标记在中间就砍掉后面', () => {
  const input = '我查一下｜｜DSML｜｜ calls invoke name="search"'
  assert.equal(stripToolMarkup(input), '我查一下')
})

test('stripToolMarkup：整条都是标记返回空', () => {
  assert.equal(stripToolMarkup('｜｜DSML｜｜ calls'), '')
  assert.equal(stripToolMarkup('  ||DSML|| invoke  '), '')
})

test('stripToolMarkup：砍完之后压掉多余空行', () => {
  const input = '结论在这\n\n\n\n｜｜DSML｜｜ calls'
  assert.equal(stripToolMarkup(input), '结论在这')
})

test('looksLikeActionRequest：明确让动手的算', () => {
  for (const text of ['帮我查一下今天北京天气', '把早报发到群里', '下载这个链接', '把 data 目录删了']) {
    assert.equal(looksLikeActionRequest(text), true, `${text} 应该判为要动手`)
  }
})

test('looksLikeActionRequest：问概念、问能力、闲聊都不算', () => {
  for (const text of ['什么是闭包', '帮我解释一下闭包是什么', '你能查天气吗', '这个错误怎么解决？', '你好', '现在几点']) {
    assert.equal(looksLikeActionRequest(text), false, `${text} 不该判为要动手`)
  }
})

test('looksLikeActionRequest：空输入不算', () => {
  assert.equal(looksLikeActionRequest(''), false)
  assert.equal(looksLikeActionRequest(undefined), false)
})

test('pruneToolOutput：短内容原样返回', () => {
  const short = 'x'.repeat(100)
  assert.equal(pruneToolOutput(short), short)
})

test('pruneToolOutput：超长时保留头尾并标注省略字数', () => {
  const long = 'A'.repeat(20000)
  const out = pruneToolOutput(long)

  assert.ok(out.length < long.length, '应该变短')
  assert.match(out, /中间省略 \d+ 字符/)
  assert.ok(out.startsWith('A'.repeat(100)), '头部保留')
  assert.ok(out.endsWith('A'), '尾部保留')
})

test('pruneToolOutput：省略字数算得对', () => {
  const total = SPILL_LIMIT + 5000
  const out = pruneToolOutput('B'.repeat(total))
  const matched = out.match(/中间省略 (\d+) 字符/)
  assert.ok(matched, '应该有省略标注')
  // 头 4500 + 尾 1800
  assert.equal(Number(matched[1]), total - 4500 - 1800)
})

test('cleanReply：去掉开头的自我指涉', () => {
  assert.equal(cleanReply('作为一个 AI，我不能吃辣。'), '我不能吃辣。')
  assert.equal(cleanReply('我是人工智能，没有身体。'), '没有身体。')
  assert.equal(cleanReply('作为语言模型，我建议先备份。'), '我建议先备份。')
})

test('cleanReply：正常开场白不动', () => {
  const text = '我建议先重启一下看看。'
  assert.equal(cleanReply(text), text)
  assert.equal(cleanReply('作为一个程序员，我觉得这写法有问题。'), '作为一个程序员，我觉得这写法有问题。')
})

test('cleanReply：紧挨着的重复整句只留一句', () => {
  assert.equal(cleanReply('已经重启了。已经重启了。'), '已经重启了。')
  assert.equal(cleanReply('好了。好了。好了。接下来看日志。'), '好了。接下来看日志。')
})

test('cleanReply：代码块原样保留', () => {
  const text = '```js\nconsole.log(1)\n```\n跑一下看看'
  assert.equal(cleanReply(text), text)
})

test('cleanReply：空输入返回空', () => {
  assert.equal(cleanReply(''), '')
  assert.equal(cleanReply(null), '')
  assert.equal(cleanReply('   '), '')
})

test('finalizeReply：先清工具标记再清口癖', () => {
  const raw = '好的，我来查。｜｜DSML｜｜ calls'
  assert.equal(finalizeReply(raw), '好的，我来查。')
})
