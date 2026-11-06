# 官方 SDK 能力覆盖

`@tencent-connect/qqbot-nodejs` v1.0.5 的全部公开能力，以及我们用它做了什么。

适配层在 `src/channel/qq.js`——业务代码只调这里导出的函数，不直接碰 SDK。

## 已用

| 能力 | 用在哪 | 说明 |
|---|---|---|
| WebSocket 连接 + 自动重连 | `client.js` | 心跳、RESUME、按关闭码分类处理都是 SDK 做的 |
| **session 持久化** | `data/qq-session.json` | 重启后先试 RESUME，不用重新 IDENTIFY，少丢几条消息 |
| 文本发送 | `sendGroup` / `sendPrivate` | 有 `msgId` 走被动回复，没有走主动消息 |
| **@ 成员** | `segment.at()` | 拼成 `<qqbot-at-user id="..." />`。**群聊里 @ 具体某人只有 markdown 消息支持**（平台对群聊/单聊的自定义 markdown 自 2026-04-23 起全量开放，无需申请）；`@全体成员` 文本消息也支持（需群管理员，每群每天 1 次） |
| 图片 / 语音 / 视频 / 文件 | `segment.image` 等 | 转成 `sendImage/sendVoice/sendVideo/sendFile` |
| **大文件分块上传** | 自动 | ≥5MB 自动走 `upload_prepare → PUT → complete`，调用方无感 |
| **上传去重** | 内置 | 同字节同目标 TTL 内只传一次 |
| 撤回 | `recallGroup` / `recallPrivate` | |
| **C2C 流式消息** | `openPrivateStream` | 官方语义是「同一条消息原地改写」，每次传全文 |
| **C2C 输入中提示** | `sendTyping` | 私聊处理前调一次，30 秒有效 |
| **C2C 唤醒消息** | `sendWakeup` + `wake_user` 工具 | 用户主动聊过之后 30 天内可以再敲一次，比普通主动消息更容易送达 |
| **连接生命周期事件** | `onLifecycle` | ready / resumed / disconnected / error 都进了日志 |
| 错误分类 | 透传 | `ApiError`（含 httpStatus / bizCode）、`GatewayError`、`UploadDailyLimitExceededError` |
| **协议层直连** | `postRaw` | 引用回复、文件卡片这类要发原始 body 的，走 `apiClient.request` |
| 机器人自身信息 | `selfInfo` / `selfOpenid` | 启动时拉一次缓存，`atMe` 判断用 |

## 部分可用

**Markdown 内嵌图片**

本地图片不能直接写进 markdown：平台只认公网 URL 或 `qqbot-media://` 引用。
所以 `rewriteMarkdownImages()` 会扫出 `![说明](tmp/x.png)` 这类本地路径，按「素材管理」三步上传（prepare → PUT 到 COS → complete），拿回引用再替换进去。单张 ≤10MB，支持 png/jpeg/gif/webp；读不到或上传失败就把那张图去掉，不让整条消息发不出去。

**Markdown 消息**

群聊和单聊的自定义 markdown **自 2026-04-23 起对所有机器人开放**，不需要申请模版（频道场景才要内邀）。

但我们默认**不用**它发普通回复：`markdownSupport: true` 会让所有文本都走 `msg_type: 2`，模型输出里的 `*`、`_`、`#` 会被当格式解析，贴代码和路径容易变形。所以只在两处用 markdown：`@` 成员（平台硬要求），以及手动打开 `MARKDOWN_REPLY=true`。

**按钮 + 交互事件**

已经接进选择题：

- `ask_choice` 优先发按钮，发不出去（没权限、配置被拒）自动回落成编号选项，功能不受影响
- 点击触发 `INTERACTION_CREATE`，3 秒内回执后按 `choice:<id>:<index>` 找回原题，走正常对话

适配层提供的三个函数：

```js
sendWithKeyboard(target, content, keyboard)   // 发带按钮的文本
onInteraction((event) => ...)                 // 按钮点击回调
acknowledgeInteraction(id, code)              // 5 秒内回执
```

按钮的 `action.type=1`（回调）、`permission.type=2`（所有人可点）是按官方文档写的。回执走 `PUT /interactions/{id}`，文档特别注明 **id 不带 `INTERACTION_CREATE:` 前缀**——SDK 传的是事件体 `d`，所以 `interaction.id` 天然是对的，代码里还是加了剥离做兜底。

回执码：0 成功 / 1 失败 / 2 频繁 / 3 重复 / 4 无权限 / 5 仅管理员。选过期或已选过的选项回 1，不是 2。

**一个坑**：按钮只能挂在 markdown 消息上（文档原话「在 markdown 消息的基础上，支持消息最底部挂载按钮」）。发 `msg_type: 0` 的文本消息带 `keyboard` 字段，平台会**静默忽略**——不报错，只是用户看不到按钮，很难查。所以 `sendWithKeyboard()` 内部走的是 `sendMarkdown`。

## 不用的

**频道消息 `sendChannelMessage` / `sendDmMessage`**

那是 QQ 频道（类似 Discord 服务器）的接口。我们是群聊 + 私聊机器人，`intents` 里也没开频道事件，用不上。

**13 个内置中间件**

SDK 提供 `errorHandler` / `messageFilter` / `rateLimiter` / `concurrencyGuard` / `accessPolicy` / `contentSanitizer` / `mentionGate` / `quoteRef` / `historyBuffer` / `envelopeFormatter` / `typingIndicator` / `slashCommand`。

我们对应的能力都已经有自己的实现，而且耦合了业务逻辑：

| SDK 中间件 | 我们的对应物 |
|---|---|
| `messageFilter`（回声过滤 + 去重） | `channel/trigger.js` 的 `claim()` |
| `rateLimiter` | `engage/quiet.js` 的节流 + `judgeHourlyLimit` |
| `concurrencyGuard` | `channel/trigger.js` 的 `enqueue()` |
| `quoteRef` | `channel/sender.js` 的 `quoteRefOf()` + msg_idx |
| `historyBuffer` | `memory/group-log.js` |
| `contentSanitizer` | `chat/text-utils.js` 的 `finalizeReply()` |
| `envelopeFormatter` | `chat/deepseek.js` 的 `buildSystemPrompt()` |
| `typingIndicator` | 已用 `sendTyping`（保留自己的触发时机） |
| `slashCommand` | `app/commands.js` |

换成 SDK 的等于重写一遍还丢业务逻辑，不划算。

**Webhook 传输**

需要公网 HTTPS 回调和证书。pm2 + WebSocket 长连接更简单，也符合我们的部署方式（单机常驻进程）。

## 还能做什么

如果要把 SDK 能力榨干，剩下三件事：

1. **按钮交互**——`ask_choice` 换成 inline keyboard，`interaction` 事件接回来。要确认平台权限。
2. **markdown**——申请权限后可以发更漂亮的消息（表格、加粗、链接卡片）。
3. **频道支持**——如果你想同时服务 QQ 频道，加 `sendChannelMessage` 分支和频道事件监听就行，适配层已经留了口子。
