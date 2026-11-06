// 纯文本处理：不依赖 env、不碰文件系统，方便单测。

// 工具输出的落盘阈值：超过就把全文写文件，上下文里只留头部和提示
export const SPILL_LIMIT = 7000
export const SPILL_HEAD = 4000

// 模型偶尔会输出 DSML 这类工具标记，而不是真的调用工具
const TOOL_MARKUP_PATTERN = /[｜|]{2}\s*DSML/i

/** 去掉工具标记：标记在中间就砍掉后面，整条都是标记就返回空 */
export function stripToolMarkup(text) {
  const raw = String(text ?? '').trim()
  if (!TOOL_MARKUP_PATTERN.test(raw)) return raw

  const cut = raw.search(TOOL_MARKUP_PATTERN)
  if (cut < 0) return raw
  if (cut === 0) return ''

  return raw.slice(0, cut).replace(/\n{3,}/g, '\n\n').trim()
}

/** 太长就掐头去尾留中间提示（落盘失败时的兜底） */
export function pruneToolOutput(text, limit = SPILL_LIMIT) {
  const value = String(text ?? '')
  if (value.length <= limit) return value

  const head = value.slice(0, 4500)
  const tail = value.slice(-1800)
  const omitted = value.length - head.length - tail.length

  return `${head}\n\n…（中间省略 ${omitted} 字符；需要完整内容请换更精确的命令，或用 read_file 分段读取）…\n\n${tail}`
}

// 出站清理：去掉模型自我指涉的元说明，以及机械重复的整句。
// 只处理句首和连续重复，代码块、链接、引用一律原样保留。
const META_PREFIX =
  /^(?:作为(?:一个|一名)?\s*(?:AI|人工智能|语言模型|大模型|智能助手|助手)[^。！？，,\n]{0,24}[。！？，,]\s*|我是(?:一个|一名)?\s*(?:AI|人工智能|语言模型|助手)[^。！？，,\n]{0,10}[。！？，,]\s*)/

function dedupeSentences(text) {
  const parts = String(text).split(/(?<=[。！？!?\n])/)
  const out = []

  for (const part of parts) {
    const key = part.trim()
    if (!key) {
      out.push(part)
      continue
    }
    // 只去掉紧挨着的完全重复，不碰正常语气词
    if (out.length > 0 && out[out.length - 1].trim() === key) continue
    out.push(part)
  }

  return out.join('')
}

/**
 * 回复文本的最后一道清理，在 stripToolMarkup 之后跑。
 * 返回空字符串表示清完之后什么都不剩，调用方应该换一条兜底话术。
 */
export function cleanReply(text) {
  let value = String(text ?? '').trim()
  if (!value) return ''

  // 代码块先摘出来，免得被下面的规则动到
  const blocks = []
  value = value.replace(/```[\s\S]*?```/g, (matched) => {
    blocks.push(matched)
    return `\u0000CODE${blocks.length - 1}\u0000`
  })

  // 开头的「作为一个AI…」这类自我说明，念出来很出戏
  let guard = 0
  while (META_PREFIX.test(value) && guard < 3) {
    value = value.replace(META_PREFIX, '')
    guard += 1
  }

  value = dedupeSentences(value)

  value = value.replace(/\u0000CODE(\d+)\u0000/g, (_, index) => blocks[Number(index)] ?? '')
  return value.trim()
}

// 中括号表情名（[旺柴]、[吃瓜]）在 QQ 官方 API 里不会渲染成表情，只会原样显示成文字。
// 出站时不删，但要能识别出来提示模型别这么写。

/** 回复出站的统一收尾：先去工具标记，再做清理 */
export function finalizeReply(text) {
  return cleanReply(stripToolMarkup(text))
}

// 用户这句话是在要一个动作（去查、去发、去改），而不是问概念。
// 用来给模型加一句「现在就动手」的提醒 —— 它很容易先回「我这就去」然后等下一轮。
const ACTION_WORDS = /(查|搜|下载|生成|画|发|写|改|装|部署|跑|统计|总结|整理|删|建|创建|上传|转换|翻译|分析)/
const QUESTION_WORDS = /[？?]|吗|呢|能不能|可不可以|是否|怎么|如何|哪里|哪个/
const CONCEPT_WORDS = /(是什么|为什么|怎么理解|有什么区别|介绍一下|讲讲|聊聊|原理|概念|区别)/

export function looksLikeActionRequest(text) {
  const value = String(text ?? '')
  if (!value) return false
  return !QUESTION_WORDS.test(value) && ACTION_WORDS.test(value) && !CONCEPT_WORDS.test(value)
}

/**
 * 模型没给出结论时的退路：把最后一次工具的真实返回交给用户。
 *
 * 之前这里只会说「没整理出结论，换个问法」——可工具其实已经跑成功了，
 * 数据在手里却被丢掉，用户只能再问一遍。宁可给一段没润色的原文。
 */
export function fallbackFromTool(snapshot) {
  const text = String(snapshot?.text ?? '').trim()

  if (!text) return '这个问题我没整理出结论，换个问法或者把任务拆小一点再试试？'

  // 工具本来就报了错：把错误原样说出来，比「换个问法」有用
  // 只看开头一小段：正文里偶然出现「失败」两个字不该被当成错误
  if (/(失败|错误|读不到|没有这个群|只能在|权限|❌)/.test(text.slice(0, 60))) {
    return text.slice(0, 500)
  }

  const clipped = text.length > 900 ? `${text.slice(0, 900)}…（还有 ${text.length - 900} 字没显示）` : text
  return `我没整理成结论，但 ${snapshot?.name ?? '工具'} 查到的内容在这儿：

${clipped}`
}
