# 万能大肥鱼 · 会自己长大的 QQ 机器人

基于 **QQ 官方开放平台 API** + **DeepSeek** 的群聊机器人：有三层记忆、30+ 个工具、可以自己给自己装技能和新 MCP 服务，还能把耗时任务丢给后台子助手边做边汇报。

不是聊天壳子，是一个能动手的 agent：能搜网页、跑 shell、装包、生成图片和视频、发语音、定时爬起来干活。

![Node](https://img.shields.io/badge/node-%3E%3D20.12-brightgreen)
![License](https://img.shields.io/badge/license-MIT-blue)

---

![群聊演示](assets/demo.png)

> 真实群聊截屏：@ 它、叫它名字、或者它判断该插话时才会接话；引用气泡只在这一句真的「插进来」时出现。

## 特性

- **人格化对话**：人格写在 `src/persona.js`（默认「万能大肥鱼，技术女宅」），也可用 `SYSTEM_PROMPT` 一行覆盖
- **三层记忆**：短期（最近 N 轮原文）→ 中期（溢出的对话自动压成摘要）→ 长期（跨重启保存的事实，靠 `remember` 工具写入）
- **30+ 工具**：联网搜索/抓网页、shell、文件读写、图片/语音/视频/文件/图文卡片发送、文字转语音、定时任务、技能与 MCP 自我扩展
- **后台子助手**：复杂任务用 `start_task` 交给子 agent，最多 20 步，期间往群里推进度，做完自动汇报
- **定时任务**：cron 五段表达式，到点执行并把结果推到群里（`schedule_task`）
- **群聊自动接话**：@ 我必回、提到名字必回、没有点名时用一次轻量判断决定要不要插话，避免刷屏
- **自我进化**：`write_skill` 写技能、`add_mcp` 注册新 MCP 服务（热加载，不用重启）、`install_package` 装 npm 包
- **权限隔离**：工具按场景（私聊/群聊）和读写属性管控；子进程只拿 PATH 和模型 key，**不拿 QQ 密钥**
- **审计日志**：`write_skill` / `add_mcp` / `install_package` / `shell` 的每次调用都记到 `data/audit.log`

## 技术栈

| 组件 | 用途 |
| --- | --- |
| [qq-official-bot](https://www.npmjs.com/package/qq-official-bot) | QQ 官方 API v2 的 WebSocket 接收 + 发送封装 |
| [DeepSeek API](https://platform.deepseek.com/) | `deepseek-chat`，OpenAI 兼容协议 |
| [@modelcontextprotocol/sdk](https://www.npmjs.com/package/@modelcontextprotocol/sdk) | 内置工具服务用 MCP 协议跑在子进程里 |
| pm2 | 常驻、崩溃自重启、开机自启 |

## 目录结构

```
src/
  index.js         入口：QQ 收发、发送层（文本/Markdown/文件/卡片/语音）、群聊触发与插话判断
  deepseek.js      模型调用、工具定义与执行、记忆注入、后台子 agent
  env.js           环境变量解析与校验（缺失直接退出）
  persona.js       人格提示词
  policy.js        工具权限表（哪个场景能用哪个工具）
  memory.js        三层记忆：短期/中期/长期 + 落盘 data/memory.json
  group-log.js     群聊记录（每群保留最近若干条，供插话判断和 /总结 用）
  task-runner.js   后台任务调度：进度上报、卡住检测、多轮续跑
  scheduler.js     定时任务：cron 解析、到点执行、结果推群
  skills.js        技能目录加载（skills/*.md 注入系统提示词）
  self-doc.js      把 SELF.md 注入提示词，机器人可以自己改这份能力说明
  goal.js          跨轮目标跟踪
  workspace.js     tmp/ 清理与占用统计
  mcp/
    client.js      MCP 客户端：启动内置服务、热加载 data/mcp-registry.json 里注册的外部服务
  mcp-server/
    index.js       内置工具服务：搜索、抓网页、时间、天气、汇率、计算、时区、DNS
    shell.js       shell 执行（带黑名单 + 重试）
    fs-tools.js    文件读写、列目录
    evolve.js      写技能、注册 MCP、装包
    download.js    下载网络文件
tools/
  mcp-server-template.js  自建 MCP 服务的模板（复制改名即可）
scripts/
  diagnose.js      自检脚本：配置、MCP 工具、裸 API 调用逐层验证
SELF.md            机器人的自我能力说明（会注入提示词，可被机器人自己改写）
```

## 快速开始

前置：Node.js ≥ 20.12、pnpm（或 npm）、一个已加入沙箱群的 QQ 机器人。

**1. 在 [QQ 开放平台](https://q.qq.com/) 创建机器人**

拿到 `AppID` 和 `AppSecret`，并在「开发管理」里开启群聊能力、把机器人拉进一个测试群。

**2. 装依赖、填配置**

```bash
git clone https://github.com/zou-hong-run/dafeiyu-qqbot.git
cd robot
pnpm install
cp .env.example .env
```

编辑 `.env`，至少填三项：

```env
DEEP_SEEK_API_KEY=sk-xxxx
QQ_APP_ID=102xxxxx
QQ_APP_SECRET=xxxx（32 位）
```

**3. 启动**

```bash
pnpm start
```

看到 `[启动] 已连接` 就说明连上网关了，私聊直接发消息，群里 @ 它。

## 配置

只列常用项，全部可选项见 `.env.example`（括号里是默认值）。

| 变量 | 说明 |
| --- | --- |
| `DEEP_SEEK_API_KEY` | 必填。也认 `DEEPSEEK_API_KEY` / `API_KEY` |
| `QQ_APP_ID` / `QQ_APP_SECRET` | 必填。也认 `QQBOT_APP_ID` / `QQBOT_APP_SECRET` |
| `DEEPSEEK_MODEL` | 模型名（`deepseek-chat`） |
| `SYSTEM_PROMPT` | 单行覆盖整个人格提示词 |
| `BOT_ALIASES` | 群里提到这些词必回（`大肥鱼,鱼鱼,万能大肥鱼`） |
| `GROUP_AUTO_REPLY` / `GROUP_JUDGE` | 关掉名字触发 / 关掉自动插话判断 |
| `MAX_TOOL_ROUNDS` | 单次对话最多几轮工具调用（100） |
| `TOOL_TIMEOUT_SECONDS` | 单个工具调用超时（60） |
| `TASK_MAX_ROUNDS` / `TASK_CONCURRENCY` | 子助手最多几步（20）/ 并发任务数（3） |
| `CONTEXT_WINDOW_TOKENS` | 上下文预算（1000000），超出后早期内容压成摘要 |
| `MARKDOWN_REPLY` | 用 Markdown 发回复（false）。平台已开放自定义 Markdown |
| `QUOTE_REPLY` | 引用气泡：`false` 关（默认）/ `judge` 只在插话时 / `always` 每条都引用 |
| `TTS_VOICE` | `speak` 工具用的 edge-tts 音色（`zh-CN-XiaoxiaoNeural`） |
| `SHELL_GROUP_ENABLED` | 设成 `false` 后 shell 只给私聊用 |

## 部署（pm2）

`ecosystem.config.cjs` 已经配好单实例、崩溃重启、`wait_ready`（连上网关才算启动成功）、优雅退出（落盘记忆 + 关 MCP 子进程）。

```bash
pnpm add -g pm2
pm2 start ecosystem.config.cjs
pm2 logs dafeiyu          # 看日志
pm2 restart dafeiyu       # 改完代码重启
pm2 save                  # 保存进程列表
pm2 startup               # 生成开机自启脚本，然后执行它打印出来的那行命令
```

注意：

- **同一个 AppID 只能有一个连接**，多开会互相踢下线，所以 `instances: 1`
- 机器人会往 `data/`、`logs/`、`downloads/`、`tmp/` 写东西，这些目录已在 `.gitignore` 里
- 小内存机器（1.5G 左右）跑视频转码要小心：`ffmpeg` 一个进程能吃掉 700M，建议加 2G swap，并把 `max_memory_restart` 留在 512M

## 工具清单

**本地工具**（直接接管当前会话的发送能力）

| 工具 | 作用 |
| --- | --- |
| `send_image` / `send_audio` / `send_video` / `send_file` | 发图片 / 语音 / 视频 / 任意文件（文件走 `msg_type=7`，群里显示成可下载卡片） |
| `send_card` | 图文卡片：标题 + 描述 + 链接 + 封面图外链 |
| `speak` | 文字转语音（edge-tts → python edge_tts → espeak-ng 依次探测） |
| `remember` / `clear_memory` | 写长期记忆 / 清空当前会话全部记忆 |
| `start_task` | 把复杂任务丢给后台子助手，边做边汇报 |
| `schedule_task` / `list_schedules` / `remove_schedule` | 定时任务增删查 |
| `goal` | 跨轮目标跟踪：目标没完成就继续推进 |

**内置 MCP 工具**（跑在子进程里，通过 MCP 协议调用）

| 工具 | 作用 |
| --- | --- |
| `search` / `fetch` | 联网搜索（支持 `site:` `after:` 语法）/ 抓网页正文 |
| `now` / `weather` / `exchange` / `calc` / `timezone` / `dns` | 时间、天气、汇率、精确计算、时区、DNS |
| `shell` | 执行命令。黑名单：删根目录/家目录、关机、磁盘操作、下载即执行远程脚本、读 `.env`、导出环境变量、打印密钥、用 pm2 管理自身进程；装包/编译这类重命令前先查可用内存；失败自动重试 3 次 |
| `read_file` / `write_file` / `list_dir` | 项目内文件读写（`.env`、`data/` 不可写） |
| `download` | 下载网络文件到 `downloads/` |
| `write_skill` / `list_skills` | 写技能 Markdown 到 `skills/`，后续对话自动注入 |
| `add_mcp` / `list_mcp` | 注册新的 MCP 服务（热加载）/ 查看已注册服务 |
| `install_package` | 装 npm 包 |

群聊里默认以上工具全部可用；要收紧就改 `src/policy.js` 或把 `GROUP_TOOLS=false`。

## 架构

**一条消息的旅程**

```
QQ 网关 ──WS──▶ index.js
                  ├─ 记录群聊到 group-log
                  ├─ 触发判定：@我 / 提到名字 / 自动插话判断
                  ├─ 组装上下文：系统提示词(SELF.md+技能+长期事实) + 短期历史 + 本轮输入
                  ├─ deepseek.js 循环调用模型，直到不再请求工具（上限 MAX_TOOL_ROUNDS）
                  │    └─ 工具：本地发送类 / MCP 子进程工具
                  └─ 发送：被动回复优先（每条消息最多 4 次），超时/超次自动降级主动消息
```

**记忆分层**：短期是最近 `HISTORY_TURNS` 轮原文；超出上下文预算的部分压缩成中期摘要；`remember` 写入的事实长期保存，重启不丢。

**任务与调度**：`start_task` 会起一个独立会话跑子 agent，按 `TASK_REPORT_INTERVAL` 推进度，卡住超过 `TASK_STALL_SECONDS` 判失败，验收不通过会续跑最多 `TASK_MAX_CONTINUATIONS` 轮。`scheduler.js` 自己解析 5 段 cron，到点把结果发回原会话。

**自我进化**：`write_skill` 写进 `skills/`，`add_mcp` 写进 `data/mcp-registry.json`，客户端每轮对话前检查注册表 mtime，变了就重连，所以装完立刻能用。

## 安全须知

这个项目默认把能力开到很大（尤其是群聊里），**上生产前务必按需收紧**：

- `shell` 默认群聊可用 —— 任何群友都能让机器人执行命令。建议 `.env` 加 `SHELL_GROUP_ENABLED=false`
- `write_file` / `install_package` / `add_mcp` 同样默认群聊可用，调 `src/policy.js` 里的 `TOOL_POLICY` 可以逐项改
- shell 子进程的环境变量只透传 `PATH` 等基础变量和模型 key，**QQ_APP_ID / QQ_APP_SECRET 不会进子进程**
- `.env`、`data/` 对模型的文件写入工具不可写；`.env` 读取被 shell 黑名单拦住
- 审计日志在 `data/audit.log`，出问题先看它
- 别把 `.env` 提交上去，`.gitignore` 已经忽略；仓库里只有 `.env.example`

## 常见问题

| 现象 | 原因 / 处理 |
| --- | --- |
| `40034005 回复消息msg_id已过期` | 被动回复 5 分钟内有效。代码已自动降级主动消息，看到这个说明那条消息太旧了 |
| `40034128 被动回复时间或次数超限` | 一条消息最多回 5 次，本项目的上限设成 4 |
| `40054005 消息被去重` | 同一个 `msg_id + msg_seq` 重复发送，换 seq 重发 |
| `40034127 / 304036 无 Markdown 权限` | 平台已开放自定义 Markdown，若仍报错请检查请求体里不要带废弃的 `template_id` / `custom_template_id` |
| `speak` 报「没有可用的语音合成后端」 | 服务器装一个：`pip3 install edge-tts`（音质好，需外网）或 `apt-get install espeak-ng`（离线） |
| 群里只收到 @ 它的消息 | 群里把「机器人可获取的群聊消息范围」设成「获取群内全部消息」 |
| 机器人不说话 / 一直「插话」 | 调 `JUDGE_HOURLY_LIMIT`、`JUDGE_MIN_LENGTH`，或直接 `GROUP_JUDGE=false` |

## 开发与自检

```bash
pnpm start                   # 前台跑，直接看日志
pnpm dev                     # --watch 热重载
node scripts/diagnose.js     # 逐层体检：配置 → MCP 工具 → 裸 API 调用
```

`TOOL_DEBUG=false` 可以关掉每轮的 `[请求]` `[执行]` `[结果]` 日志，日志量会小很多。

## License

[MIT](LICENSE) © 2026 zou-hong-run

## 免责声明

本项目只做技术演示：机器人在群里说的话、执行的命令、发的文件都由大模型自行决定，作者不对其后果负责。接到自己的群之前，请务必把工具权限收紧到你能接受的范围。
