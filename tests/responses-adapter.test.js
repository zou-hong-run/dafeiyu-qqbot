import test from 'node:test'
import assert from 'node:assert/strict'
import { resolveEffort, toChatShape, toResponsesRequest, toResponsesTools } from '../src/chat/responses-adapter.js'

// 这层转错的后果是「工具调用静默失效」——跑起来只会看到模型一直回文字、不做事，
// 不会有任何报错。所以每一处形状差异都钉一条断言。

test('system 合成 instructions，不进 input', () => {
  const body = toResponsesRequest({
    model: 'deepseek-flash',
    messages: [
      { role: 'system', content: '你是助手' },
      { role: 'system', content: '回答用中文' },
      { role: 'user', content: '你好' },
    ],
  })

  assert.equal(body.instructions, '你是助手\n\n回答用中文')
  assert.deepEqual(body.input, [{ role: 'user', content: '你好' }])
})

test('assistant 的 tool_calls 展开成独立 item', () => {
  const body = toResponsesRequest({
    messages: [
      { role: 'user', content: '查天气' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [
          { id: 'c1', type: 'function', function: { name: 'weather', arguments: '{"city":"北京"}' } },
        ],
      },
      { role: 'tool', tool_call_id: 'c1', content: '晴 20 度' },
    ],
  })

  assert.equal(body.input.length, 3)
  assert.deepEqual(body.input[1], {
    type: 'function_call',
    call_id: 'c1',
    name: 'weather',
    arguments: '{"city":"北京"}',
  })
  assert.deepEqual(body.input[2], {
    type: 'function_call_output',
    call_id: 'c1',
    output: '晴 20 度',
  })
})

test('assistant 有文字也有工具调用时，两样都留', () => {
  const body = toResponsesRequest({
    messages: [
      {
        role: 'assistant',
        content: '我查一下',
        tool_calls: [{ id: 'c1', function: { name: 'search', arguments: '{}' } }],
      },
    ],
  })

  assert.deepEqual(body.input[0], { role: 'assistant', content: '我查一下' })
  assert.equal(body.input[1].type, 'function_call')
})

test('工具定义从嵌套的 function 拍平', () => {
  const tools = toResponsesTools([
    {
      type: 'function',
      function: { name: 'calc', description: '算数', parameters: { type: 'object', properties: {} } },
    },
  ])

  assert.deepEqual(tools, [
    { type: 'function', name: 'calc', description: '算数', parameters: { type: 'object', properties: {} } },
  ])
})

test('参数名映射：max_tokens / response_format / tool_choice', () => {
  const body = toResponsesRequest({
    messages: [],
    max_tokens: 800,
    temperature: 0.3,
    response_format: { type: 'json_object' },
    tool_choice: { type: 'function', function: { name: 'calc' } },
  })

  assert.equal(body.max_output_tokens, 800, 'Responses 叫 max_output_tokens')
  assert.equal(body.max_tokens, undefined, '旧名字不能同时传')
  assert.deepEqual(body.text, { format: { type: 'json_object' } }, 'format 挂在 text 下面')
  assert.deepEqual(body.tool_choice, { type: 'function', name: 'calc' }, '指定工具的形状不同')
})

test('图片：image_url 转成 input_image', () => {
  const body = toResponsesRequest({
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: '这是什么' },
          { type: 'image_url', image_url: { url: 'https://x/a.png' } },
        ],
      },
    ],
  })

  assert.deepEqual(body.input[0].content, [
    { type: 'input_text', text: '这是什么' },
    { type: 'input_image', image_url: 'https://x/a.png' },
  ])
})

test('响应转回 Chat 形状：文本、工具调用、用量', () => {
  const shaped = toChatShape({
    status: 'completed',
    output_text: '我查一下',
    output: [
      { type: 'message', content: [{ type: 'output_text', text: '我查一下' }] },
      { type: 'function_call', call_id: 'c9', name: 'weather', arguments: '{"city":"上海"}' },
    ],
    usage: { input_tokens: 120, output_tokens: 30 },
  })

  assert.equal(shaped.choices[0].message.content, '我查一下')
  assert.equal(shaped.choices[0].message.tool_calls[0].id, 'c9', 'call_id 要保留，后面靠它配对结果')
  assert.equal(shaped.choices[0].message.tool_calls[0].function.name, 'weather')
  assert.equal(shaped.choices[0].finish_reason, 'stop')
  assert.equal(shaped.usage.prompt_tokens, 120)
  assert.equal(shaped.usage.completion_tokens, 30)
})

test('没有 output_text 时自己扫 message item 拼文本', () => {
  const shaped = toChatShape({
    output: [
      { type: 'message', content: [{ type: 'output_text', text: '第一段' }] },
      { type: 'message', content: [{ type: 'output_text', text: '第二段' }] },
    ],
    usage: {},
  })

  assert.equal(shaped.choices[0].message.content, '第一段第二段')
})

test('被截断时 finish_reason 映射成 length', () => {
  const shaped = toChatShape({ status: 'incomplete', output: [], usage: {} })
  assert.equal(shaped.choices[0].finish_reason, 'length')
})

test('没有工具调用时不给空数组（调用方靠它判空）', () => {
  const shaped = toChatShape({ output_text: '好的', output: [], usage: {} })
  assert.equal(shaped.choices[0].message.tool_calls, undefined)
})

test('孤立代理对和控制字符会被清掉（服务端 400 的来源）', () => {
  const broken = '正常文字\uD800半截emoji\u0000控制字符'
  const body = toResponsesRequest({
    messages: [
      { role: 'user', content: 'x' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [{ id: 'c1', function: { name: 'shell', arguments: '{}' } }],
      },
      { role: 'tool', tool_call_id: 'c1', content: broken },
    ],
  })

  const output = body.input.find((item) => item.type === 'function_call_output').output
  assert.equal(output.includes('\uD800'), false, '孤立高位代理必须去掉')
  assert.equal(output.includes('\u0000'), false, '空字符必须去掉')
  assert.match(output, /正常文字/)
})

test('成对的代理对（正常 emoji）要保留', () => {
  const body = toResponsesRequest({
    messages: [{ role: 'user', content: '这条消息带 emoji 😀 和 🎉' }],
  })
  assert.match(String(body.input[0].content), /😀/)
})

test('reasoning 能透传', () => {
  const body = toResponsesRequest({
    messages: [{ role: 'user', content: 'x' }],
    reasoning: { effort: 'none' },
  })
  assert.deepEqual(body.reasoning, { effort: 'none' })
})

test('工具调用字段名宽容：tool_name / input 这类别名也能取到', () => {
  // 取不到 name 的话上层会当成「模型没调工具」，表现是一直回文字、不做事，且不报错
  const shaped = toChatShape({
    output: [
      { type: 'function_call', tool_call_id: 'x1', tool_name: 'calc', input: '{"a":1}' },
    ],
    usage: {},
  })

  const call = shaped.choices[0].message.tool_calls[0]
  assert.equal(call.id, 'x1')
  assert.equal(call.function.name, 'calc')
  assert.equal(call.function.arguments, '{"a":1}')
})

// 思考 token 也算进 max_output_tokens。主对话额度大、要开思考（关掉会变笨）；
// 摘要收尾只给几百 token，开了就全花在 reasoning 上、正文是空的。
test('主对话开思考，小额度请求自动关', () => {
  assert.equal(resolveEffort({ maxTokens: 8192 }), 'medium', '主对话用默认强度')
  assert.equal(resolveEffort({ maxTokens: 8192, fallback: 'high' }), 'high', '跟随配置')
  assert.equal(resolveEffort({ maxTokens: 900 }), 'none', '摘要额度太小，不能思考')
  assert.equal(resolveEffort({ maxTokens: 800 }), 'none', '收尾同理')
  assert.equal(resolveEffort({ maxTokens: 200 }), 'none')
})

test('阈值边界：正好 1200 仍然开思考', () => {
  assert.equal(resolveEffort({ maxTokens: 1200 }), 'medium')
  assert.equal(resolveEffort({ maxTokens: 1199 }), 'none')
})

test('调用方能显式覆盖', () => {
  assert.equal(resolveEffort({ maxTokens: 8192, override: 'none' }), 'none')
  assert.equal(resolveEffort({ maxTokens: 300, override: 'high' }), 'high')
})

test('用户消息和 instructions 里的畸形字符也要清', () => {
  // 用户消息来自 QQ，什么字节都可能；不清一样会撞 400
  const body = toResponsesRequest({
    messages: [
      { role: 'system', content: '指令\uD800带半个 emoji' },
      { role: 'user', content: '用户说\uDC00了什么' },
      { role: 'user', content: [{ type: 'text', text: '多模态\uD800文本' }] },
    ],
  })

  assert.equal(body.instructions.includes('\uD800'), false, 'instructions 要清')
  assert.equal(String(body.input[0].content).includes('\uDC00'), false, 'user 纯文本要清')
  assert.equal(String(body.input[1].content[0].text).includes('\uD800'), false, '内容块也要清')
})
