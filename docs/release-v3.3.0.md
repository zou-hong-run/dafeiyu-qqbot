# v3.3.0 — 群里的图能看了，语音能听了，模型接口换成 Responses

这一版最重要的不是 API 迁移，而是三个**用户能直接感觉到**的修复：
群里发的图以前它根本看不到、语音的识别文字被扔掉、新闻配图在群里永远是空的。

另外模型接口按官方推荐换到了 Responses API，差异收在一层适配里。

---

## 一、群里发的图，现在真的能看到

这一条最值得说，因为**不是模型能力问题，是数据在入口就断了**。

官方 SDK 给的是 `attachments` 数组，业务层的入站逻辑读的却是 `event.message` 里的 `{ type, data: { url } }`。这一层翻译从来没写，所以 `extractInbound` 永远拿到空数组 —— 群里发的图、语音、文件全部只剩正文。

修完之后：

- 图/文件会落盘到 `downloads/incoming/<会话>/`，平台给的附件地址会过期，不存就永远补不回来
- **语音用平台自带的识别文字**（`asr_refer_text`）当正文继续走，纯语音消息也能触发名字接话
- 群图缓存 10 分钟：「先发图、下一句才 @ 我问这是什么」这种也接得住

`labelInbound()` 让群记录里写的是实际内容而不是笼统的 `[附件]`。

> 注意：语音只认平台转写。平台没给文字的，本机没有识别引擎，会如实说「没听清，你打字说一遍」，不猜。

---

## 二、群聊里的配图不再空着

平台在群聊的 markdown 里**不抓外链图**，只认 `qqbot-media://` 素材引用。写个 https 地址过去：文字照发、图是空的，而且不报错。

现在群聊会先把图下回来（走 `fetchPublic`，有出网校验）再按素材上传；私聊仍然让平台自己抓，省一次往返。

顺带：**图片默认 320px 宽**。以前按原图渲染，一张 1200px 的图在手机上糊满整屏。想要别的尺寸在 alt 里写 `#500px`。

---

## 三、模型接口换成 Responses API

`client.chat.completions.create` → `client.responses.create`，差异全收在 `src/chat/responses-adapter.js`：

| Chat Completions | Responses |
|---|---|
| `system` 消息 | `instructions` 参数（多条合并） |
| `tool_calls` 数组 | 独立的 `function_call` item |
| `role: 'tool'` | `function_call_output`（靠 `call_id` 配对） |
| `tools: [{type, function:{...}}]` | 扁平 `{type:'function', name, ...}` |
| `max_tokens` | `max_output_tokens` |
| `response_format` | `text.format` |
| `usage.prompt_tokens` | `usage.input_tokens` |

**为什么包一层**：上层有十几处调用点依赖 `choices[0].message` 这个形状（工具循环、摘要、收尾、各种重试），适配层把 API 差异关在一个文件里。

### 迁移踩的两个坑

**1. 思考 token 也算进 `max_output_tokens`**

Chat Completions 里 reasoning 和 content 分开计数，摘要给 900 够用。换过来之后同样的 900 全花在思考上，`output_text` 是空的——表现是「摘要一直失败」，看不出原因。

现在按额度自动分档：

- 主对话 8192 → 开思考（`REASONING_EFFORT`，默认 `high`）
- 摘要 900、收尾 800、各类解析 200~400 → 自动降成 `none`

**关掉主对话的思考是错的**——推理类问题会明显变笨，这个试过。

**2. 工具输出要清洗**

网页正文、命令结果里可能带孤立代理对（半个 emoji）或控制字符，序列化后服务端直接 400：

```
Failed to parse the request body as JSON: input[24].output: unexpected end of hex escape
```

这个报错不说哪个字段有问题，得从 `input[24]` 这种下标反推。现在 `output` / `arguments` / user 内容 / instructions 全部过 `sanitizeText`，孤立代理去掉、成对保留（emoji 不能乱码）。

### 一个必须知道的限制

DeepSeek 的 Responses API 是**无状态子集**：`previous_response_id` / `conversation` / `store` 都不支持，`truncation` 也不支持。

也就是说多轮历史仍然由客户端拼，超上下文直接 400。想享受「推理跨轮保留」那套红利，得等官方实现。判断真实能力就看那三个字段，别看「原生支持 Responses API」这句话。

---

## 四、安全

| 项 | 处理 |
|---|---|
| 外链图 / 附件 / TTS 音频无上限读取 | 统一走 `readLimitedBody()` 流式限额，超限当场中断而不是先读进内存 |
| 本地高危工具不留痕 | `runToolTracked` 入口按 `AUDITED_TOOLS` / `DANGEROUS_TOOLS` 记审计（只记本地工具，MCP 那侧已经在 `callTool` 里记过） |
| TTS 的裸 `fetch` | 补 `assertPublicUrlResolved`（`baseURL` 是配置项，理论上能配成内网） |
| `hono` 传递依赖有 7 个漏洞 | 覆盖到修复版，`pnpm audit --prod --audit-level=high` 清零 |
| 上下文超限重试失效 | 正则覆盖 Responses 的报错文案（`input is too long` / `context window`），否则压缩重试根本不会触发 |

---

## 五、消息与工具

- **分段目标与硬上限分离**：`REPLY_MAX_CHARS`（900，分段目标）和 `REPLY_HARD_MAX`（1500，硬上限）。链接跨切点导致某段略超时整段发出去，不再被截断
- **选择题正文也列选项**：按钮没渲染出来时至少知道能选什么
- **正文里列「1. 2. 3.」直接定性为做错**：该用 `ask_choice` 却没用会记诊断日志
- `/diag` 里 cron 改用中文描述（`*` 在 markdown 里会被吃掉）

---

## 六、工程

- `docs/DEMO.md`：能力演示清单，录视频和真机回归都用它；`AGENTS.md` 加了「能力变了同步它」的硬规则
- `check-refs` 补认对象方法简写的形参（原来把 `transform(a, b, callback)` 里的 `callback` 报成未定义）
- `pnpm-workspace.yaml` 的 overrides 里加了 `hono` / `@hono/node-server`
- 测试 235 → 258

---

## 升级

```bash
cd /qq && git pull --rebase origin main && pnpm install && pm2 restart dafeiyu && pm2 save
```

`pnpm install` 别省——依赖换了（hono 升级）。

### 会感觉到的变化

- **群里发图它能认了**（最直观）
- **发语音它能「听」了** —— 前提是平台给了转写文字
- 新闻配图在群里能显示，而且大小正常
- 回复偶尔会长一点，但不会再被截断在第几条中间

### 建议真机过一遍

| 项 | 怎么验 |
|---|---|
| 群图识别 | 群里发图，再说「这图里是什么」 |
| 语音 | 发一条语音，看它能不能接住内容 |
| 外链配图 | 搜热点新闻，看配图是否显示 |
| 按钮 | 出一道选择题，点按钮 |
| 定时任务 | `list_schedules` 看任务还在不在 |

如果日志里出现 `[模型调用失败]`，把原文发出来——最可能是 `reasoning.effort` 的取值不被接受，改 `REASONING_EFFORT=low` 或 `none` 试试。
