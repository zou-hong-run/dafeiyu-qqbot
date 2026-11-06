# 迁移到官方 SDK 的评估

> **状态：已迁移完成。** 实际改动比评估多一步——加了个适配层 `src/qq/client.js`，把事件形状、消息段拼装、媒体上传、撤回、流式全部收口，业务代码只改了调用名，下游逻辑一行没动。旧 SDK 已从依赖里移除。

结论：**可以做，能力全覆盖，没有功能损失**。代价是 5 个文件 + 一轮真机验证。

评估依据：`@tencent-connect/qqbot-nodejs` v1.0.5（2026-10-12）的源码，不是文档推测。

---

## 一、两个 SDK 的实际差别

| | `qq-official-bot`（现在） | `@tencent-connect/qqbot-nodejs` |
|---|---|---|
| 维护方 | 社区 zhinjs，单人 | 腾讯官方 |
| 版本 | 1.3.3 | 1.0.5 |
| 依赖 | 若干 | 只有 `ws` |
| 大文件分块上传 | ✗ | ✓（≥5MB 自动） |
| 上传去重 | ✗ | ✓（LRU + TTL） |
| session 持久化 | ✗ | ✓（重启走 RESUME） |
| 错误类型 | 普通 Error | `ApiError` / `GatewayError` / `UploadDailyLimitExceededError` |
| Webhook 验签 | ✗ | ✓（Ed25519） |
| 中间件 | ✗ | 13 层内置 |
| 协议层导出 | 部分 | `/protocol` 全开放 |

对我们有实际价值的四个：**官方维护**、**分块上传**、**session 持久化**（重启不再丢消息）、**错误分类**（能区分被封禁 / token 失效 / 额度超限）。

---

## 二、能力对照

关键发现：**官方 SDK 的所有特殊消息也是拼进 `content` 字符串的**，所以 `@` 和表情都能做到，只是要自己拼标记。

| 我们的用法 | 官方 SDK 的写法 |
|---|---|
| `bot.group(id).send([segment.at(x), segment.text(t)])` | `sendText({ scope: 'group', targetId: id }, `<qqbot-at-user id="${x}" />正文`)` |
| `segment.at('all')` | `<qqbot-at-everyone />` |
| `segment.text(t)` | 直接用字符串 |
| `segment.face(id)` | `<emoji:${id}>` |
| `segment.image(file)` | `sendImage(target, { localPath })` |
| `segment.audio(file)` | `sendVoice(target, { localPath })` |
| `segment.video(file)` | `sendVideo(target, { localPath })` |
| `segment.file(file)` | `sendFile(target, { localPath }, { fileName })` |
| `bot.recallGroupMessage(...)` | `recallMessage(target, messageId)` |
| `bot.on('message.group')` | `bot.on('message', (ctx, msg) => ...)` + `msg.kind === 'group'` |
| `bot.on('message.group.at')` | 同上，自己看 `msg.mentions` 里有没有自己 |

标记语法来自 `qq-official-bot` 的 `lib/message/builder.js` 的 `handleAt` / `handleFace`——两个 SDK 最终都拼同一套 `<qqbot-at-user>` 标签。

---

## 三、字段映射

入站事件从「按事件名分发」变成「统一结构 + `kind` 字段」：

| 现在 | 官方 | 说明 |
|---|---|---|
| `event.group_id` | `msg.groupOpenid` | 群 openid，同一种东西 |
| `event.user_id` | `msg.senderId` | 群聊里是 `member_openid` |
| `event.content` | `msg.content` | |
| `event.message_id` | `msg.messageId` | |
| `event.sender.user_name` | `msg.senderName` | 已确认有：`ev.author.username` |
| `event.mentions` | `msg.mentions` | |
| `event.message_type === 'group'` | `msg.kind === 'group'` | |
| `event.msg_idx` | `msg.msgIdx` | |
| — | `msg.replyTarget` | 新增：`{ scope, targetId, msgId }`，直接传给发送 API |

消息 id 有关的：
- **被动回复**必须带 `replyTarget.msgId`（SDK 自动派生）
- **主动发群**不带 `msgId`，`{ scope: 'group', targetId }` 即可，受平台主动消息额度限制

---

## 四、要改的文件

| 文件 | 改动 |
|---|---|
| `src/bot.js` | 换 `new QQBot({ appId, appSecret, logger })`；事件收口到一个 `message` 监听 |
| `src/index.js` | 三个 `bot.on('message.*')` 合成一个，按 `msg.kind` 和 `mentions` 分发 |
| `src/app/factories.js` | `groupSenderFor` / 私聊发送改 `sendText`，`at` 参数拼 `<qqbot-at-user>` |
| `src/channel/media.js` | 四个 `segment.*` 换成 `sendImage/sendVoice/sendVideo/sendFile` |
| `src/channel/recall.js` | `recallMessage(target, messageId)` |

其余文件只读 `event.xxx`，跟着字段映射改就行（`channel/incoming.js`、`memory/group-log.js` 里存字段的地方）。

---

## 五、风险和验证点

**① 语音格式**

官方 `sendVoice` 只是 `sendMedia({ fileType: VOICE })`，**不做格式转换**。我们现在发 mp3（`segment.audio`），迁移后传 mp3 是否被平台接受，需要真机验一次。如果不接受，得加 `silk-wasm` 转码（官方列为可选 peer 依赖）。

**② `@` 的拼接位置**

`<qqbot-at-user id="..." />` 必须和文本拼在同一个 `content` 里。需要确认官方 SDK 不对 content 做 HTML 转义——从 `buildMessageBody` 看是原样放进 `body.content`，应该没问题，但要真机验。

**③ 事件里没有 `.at` 变体**

现在 SDK 帮我们区分了 `message.group.at`（@ 我）和 `message.group`（普通群消息）。官方只有 `message`，要自己判断：

```js
const atMe = msg.mentions?.some((item) => item.bot || item.id === botSelfOpenid)
```

`botSelfOpenid` 从 `bot.getSelfInfo()` 拿，启动时缓存一次。

**④ 主动消息额度**

`send_to_group` / `broadcast` 走主动消息，官方 SDK 会抛 `ApiError`，我们现在的错误处理能接住，但错误文案要跟着改。

**⑤ 被动回复窗口**

官方 SDK 不校验 4 分钟窗口，我们的 `isStaleMessage` 逻辑保留不变。

---

## 六、迁移步骤

分三步，每步都能单独回滚：

**第一步：连接与接收**
1. 装 `@tencent-connect/qqbot-nodejs`
2. 改 `src/bot.js`，用官方 SDK 建实例
3. 改 `src/index.js`，一个 `message` 监听 + 路由到现有 `handleGroupAll` / `handleGroupAt` / 私聊处理
4. 发送层先**不动**——两边同时存在，发消息还用旧 SDK

这一步风险最高（连接和事件），但改动面最小。

**第二步：发送**
1. `factories.js` 改 `sendText` + 拼 at 标记
2. `media.js` 改四个媒体 API
3. `recall.js` 改撤回
4. 旧 SDK 移除

**第三步：吃新能力**
1. 开 `sessionPersistence`（重启不再丢消息）
2. 大文件走分块上传（`MAX_SEND_FILE_MB` 可以放开）
3. 错误处理细分（`UploadDailyLimitExceededError` 单独处理）

---

## 七、什么时候值得迁

**现在迁的理由**：官方维护，供应链风险归零；重启不丢消息是真实体验提升；分块上传能发大文件。

**现在不迁的理由**：当前 SDK 工作正常，官方 SDK 才 1.0.x，可能还有坑；迁移期间要停机验证。

**建议**：先做第一步（连接 + 接收）的改造，但**不立刻上线**。在本地跑通事件解析和发送对照日志，确认字段和 @ 标记都对得上，再切生产。

这个项目里 SDK 的调用面很窄（10 来个 API，集中在 5 个文件），迁移的爆炸半径可控——真正要小心的只有事件模型和语音格式两处。
