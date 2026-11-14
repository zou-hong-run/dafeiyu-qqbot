// Chat Completions ↔ Responses API 的双向转换。
//
// 只在这一层做形状转换，内部所有代码继续用 messages / choices 那套结构——
// 主循环、工具循环、16 处 createCompletion 调用点都不用动。
// 抽成独立模块是为了能单测：这部分出错的后果是工具调用静默失效，跑起来很难发现。

/**
 * 清理要发出去的字符串。
 *
 * 服务端会 400「Failed to parse the request body as JSON: unexpected end of hex escape」——
 * 原因是字符串里有孤立代理对（UTF-16 半个 emoji）或者不可打印控制字符，
 * 序列化出来不是合法 JSON。工具输出是外部内容（网页、命令结果），什么都可能有。
 *
 * 顺序是先截断再清洗：反过来截断可能又切出一个孤立代理。
 */
function sanitizeText(text, limit = 20_000) {
  let out = String(text ?? '')
  if (out.length > limit) out = out.slice(0, limit)

  // 孤立的高位/低位代理。合规的成对代理要保留，emoji 才不乱码
  out = out.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/g, '')
  out = out.replace(/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '')
  // C0 控制字符，保留 \n \t \r
  out = out.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
  return out
}

// 输出额度低于这个数就不开思考：思考 token 也算进同一个额度，小额度会被吃光
const THINKING_MIN_BUDGET = 1200

/**
 * 这次请求要不要开思考。
 *
 * 主对话额度大（8192），开着——关掉会让推理类问题明显变笨。
 * 摘要、收尾、各类解析只给几百 token，开了就全花在 reasoning 上，正文是空的。
 *
 * @param {{ maxTokens?: number, override?: string, fallback?: string }} input
 * @returns {string} 'none' | 'low' | 'medium' | 'high' | 'off'
 */
export function resolveEffort({ maxTokens, override, fallback = 'medium' } = {}) {
  const asked = String(override ?? '').trim()
  if (asked) return asked

  const budget = Number(maxTokens)
  if (Number.isFinite(budget) && budget > 0 && budget < THINKING_MIN_BUDGET) return 'none'

  return String(fallback ?? 'medium').trim() || 'medium'
}

/** 取一段 content 里的纯文本（字符串或内容块数组都接受） */
function textOf(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return String(content ?? '')

  return content
    .map((part) => {
      if (typeof part === 'string') return part
      if (part?.type === 'text') return String(part.text ?? '')
      return ''
    })
    .join('')
}

/**
 * 用户消息的 content：字符串保持字符串，多模态转成 responses 的内容块。
 * image_url（Chat 形状）→ input_image（Responses 形状），两边的字段名不一样。
 */
function userContentOf(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return String(content ?? '')

  const parts = []
  for (const part of content) {
    if (typeof part === 'string') {
      parts.push({ type: 'input_text', text: part })
      continue
    }
    if (part?.type === 'image_url') {
      const url = typeof part.image_url === 'string' ? part.image_url : part.image_url?.url
      if (url) parts.push({ type: 'input_image', image_url: String(url) })
      continue
    }
    parts.push({ type: 'input_text', text: String(part?.text ?? '') })
  }
  return parts
}

/** Chat 的 tools 是 { type, function: {...} }，Responses 是扁平的 { type, name, ... } */
export function toResponsesTools(tools) {
  if (!Array.isArray(tools)) return undefined

  const list = tools
    .map((tool) => {
      const fn = tool?.function ?? tool
      if (!fn?.name) return null
      return {
        type: 'function',
        name: fn.name,
        description: fn.description ?? '',
        parameters: fn.parameters ?? { type: 'object', properties: {} },
      }
    })
    .filter(Boolean)

  return list.length > 0 ? list : undefined
}

/** tool_choice 指定具体工具时，两边形状也不同 */
function toResponsesToolChoice(choice) {
  if (typeof choice === 'string') return choice
  if (choice?.function?.name) return { type: 'function', name: choice.function.name }
  if (choice?.name) return { type: 'function', name: choice.name }
  return 'auto'
}

/**
 * 把 Chat 形状的请求体转成 Responses 形状。
 *
 * - 所有 system / developer 消息合并成 instructions（Responses 里它单独一个参数）
 * - assistant 的 tool_calls 展开成独立的 function_call item
 * - role: 'tool' 的结果变成 function_call_output，靠 call_id 配对
 */
export function toResponsesRequest(payload = {}) {
  const { model, messages, tools, tool_choice, max_tokens, temperature, response_format, reasoning } =
    payload

  const instructions = []
  const input = []

  for (const message of Array.isArray(messages) ? messages : []) {
    const role = String(message?.role ?? 'user')

    if (role === 'system' || role === 'developer') {
      const text = textOf(message.content)
      if (text) instructions.push(text)
      continue
    }

    if (role === 'tool') {
      input.push({
        type: 'function_call_output',
        call_id: String(message.tool_call_id ?? ''),
        output: sanitizeText(textOf(message.content)),
      })
      continue
    }

    if (role === 'assistant') {
      const text = textOf(message.content)
      const calls = Array.isArray(message.tool_calls) ? message.tool_calls : []

      // 有文字就留一条 assistant 消息；没有文字但有工具调用时不用空消息占位
      if (text || calls.length === 0) input.push({ role: 'assistant', content: sanitizeText(text) })

      for (const call of calls) {
        input.push({
          type: 'function_call',
          call_id: String(call?.id ?? ''),
          name: String(call?.function?.name ?? ''),
          arguments: sanitizeText(call?.function?.arguments ?? '{}', 8000),
        })
      }
      continue
    }

    input.push({ role: 'user', content: userContentOf(message.content) })
  }

  const body = { model, input }

  if (instructions.length > 0) body.instructions = instructions.join('\n\n')
  const responsesTools = toResponsesTools(tools)
  if (responsesTools) body.tools = responsesTools
  if (tool_choice !== undefined) body.tool_choice = toResponsesToolChoice(tool_choice)
  if (max_tokens) body.max_output_tokens = max_tokens
  if (temperature !== undefined) body.temperature = temperature
  // Chat: response_format；Responses: text.format
  if (response_format) body.text = { format: response_format }
  if (reasoning) body.reasoning = reasoning

  return body
}

/** 从 output 里拼文本：优先用 SDK 的 output_text，没有就自己扫 message item */
function collectText(response) {
  if (typeof response?.output_text === 'string' && response.output_text.length > 0) {
    return response.output_text
  }

  let text = ''
  for (const item of response?.output ?? []) {
    if (item?.type !== 'message') continue
    for (const part of item.content ?? []) {
      if (part?.type === 'output_text') text += String(part.text ?? '')
    }
  }
  return text
}

export function toChatShape(response) {
  const text = collectText(response)

  const toolCalls = (response?.output ?? [])
    .filter((item) => item?.type === 'function_call')
    .map((item, index) => ({
      // 字段名按 OpenAI 标准取，同时兼容几种常见别名——
      // 取不到 name 的话上层会当成「模型没调工具」，表现是它一直回文字不做事，
      // 而且不会有任何报错，所以这里宁可宽容一点。
      id: String(item.call_id ?? item.id ?? item.tool_call_id ?? `call_${index}`),
      type: 'function',
      function: {
        name: String(item.name ?? item.tool_name ?? item.function?.name ?? ''),
        arguments: String(
          item.arguments ?? item.input ?? item.function?.arguments ?? '{}',
        ),
      },
    }))

  const message = { role: 'assistant', content: text }
  if (toolCalls.length > 0) message.tool_calls = toolCalls

  return {
    choices: [
      {
        message,
        // 有的调用方靠 finish_reason === 'length' 判断输出被截断
        finish_reason: response?.status === 'incomplete' ? 'length' : 'stop',
      },
    ],
    usage: {
      prompt_tokens: Number(response?.usage?.input_tokens) || 0,
      completion_tokens: Number(response?.usage?.output_tokens) || 0,
    },
  }
}
