# v3.1.0 — 官方 SDK、内嵌配图、能自证的定时任务

这一版换掉了机器人底座（腾讯官方 SDK），补齐了消息形态（markdown、按钮、内嵌图片），
并把「定时任务到点没触发」这类问题从「只能猜」变成「一条命令看出来」。

升级不需要改任何配置项，`pnpm install` + 重启即可。

---

## 迁移到腾讯官方 SDK

原来依赖社区单维护的 `qq-official-bot`，现在换成腾讯官方 `@tencent-connect/qqbot-nodejs`。

所有与 SDK 的差异都收在 `src/channel/qq.js` 一个文件里，业务代码没有跟着改。

顺带用上了几个原来没有的能力：

| 能力 | 效果 |
|---|---|
| `sendTyping` | 私聊里先显示「正在输入」，不用干等 |
| 连接生命周期事件 | `ready` / `resumed` / `disconnected` 都有日志，断线重连不再静默 |
| session 持久化 | 重启先试 `RESUME`，少丢几条消息 |
| C2C 唤醒消息 | 对方聊过之后 30 天内可以主动再敲一次 |

---

## Markdown 全量开放

平台已对单聊和群聊全量开放自定义 markdown，不需要再申请模板。`markdownReply` 因此改成默认开启。

新增的消息能力：

- **按钮交互**：`ask_choice` 发的是带按钮的 markdown 消息，点击走 `INTERACTION_CREATE`，3 秒内回执。平台拒绝按钮时自动回落成编号选项
- **选择记名**：群里谁先点谁生效，对话里带上点击者昵称，后来的人点会收到「已被选过」
- **@ 具体成员**：平台限制，只有 markdown 消息能真正 @ 到人，纯文本会原样显示成标签
- **本地图片内嵌**：按素材管理三步上传，换成 `qqbot-media://` 引用嵌进正文

---

## 配图与链接

这两件事返工最多，根因都是「模型拿不到结构化数据就自己编」。

**配图**：`fetch` 现在除了正文还返回页面配图，最多 3 个候选（`og:image` 优先、正文图兜底），
二维码、logo、头像、占位图会被过滤掉。有图就嵌进正文对应段落，没有就直说没有——
不允许用 `draw_pixel` 或字符画拼一张假的顶上去。

**链接**：两个真 bug。

- 长文本分段时会把 `[华尔街见闻](https://wallstreetcn.com/...)` 从中间劈开，前半段变死链
- `search` 只给裸 url，模型要自己拼 markdown，它偷懒就只留「来源：澎湃新闻」，六个条目零链接

现在 `search` / `fetch` 直接返回拼好的、可以整行复制的 markdown，分段逻辑也不会再切开链接和 `![图](地址)`。

---

## 定时任务

- 定时产出、失败补推、跨群转发、全服通报，四条出站路径全部接上 markdown
- **`/diag` 现在会打印调度器状态**：是否在运行、上次检查是几秒前、pid、进程运行时长、每个任务的下次触发时间和上次结果
- 漏跑的不再等下一小时：每次 20 秒的检查都会补，同一个时间点只补一次
- `initScheduler` 提到网关连接之前并单独兜错——调度器不依赖网络，不该被后面的启动步骤拖累

---

## 安全加固

| 项 | 变更 |
|---|---|
| 解压炸弹 | 不再只信 zip 中央目录声明的大小，用 `maxOutputLength` 实测逐条目解压 |
| 配图链路 | 改走 `fetchPublic`：逐跳复核重定向 + 域名解析判内网；响应体流式读，超过 200KB 停止 |
| 发送地址 | `send_image` / `send_video` / `send_audio` 的 http 分支、markdown 外链图，都过地址校验 |
| 文件黑名单 | 抽成 `ops/file-policy.js` 单一真源，读取、发送、图片上传共四类调用方共用 |
| 出站过滤 | `sanitizeText` 下沉到 `postMessage`；按钮消息这条唯一的旁路单独补上 |
| 沙箱遮蔽 | `/www` 改成逐子目录遮，只留 `server/nodejs`；`.npmrc` 这类凭据文件单独盖住 |
| 依赖 | xlsx 的 CVE 换成 exceljs；CI 里 `pnpm audit --prod --audit-level=high` 硬失败 |
| 注入 | @ 标签、搜索结果的标题都做转义，`title='标题](http://evil)'` 伪造不出链接 |

---

## 工具与工程

- 55 个工具，16 个高危（`docs/CAPABILITIES.md`）
- 清掉 50 个没有跨文件引用的导出，新增 `pnpm dead-code` 守住这条线
- `check-refs.js` 的关键标识符清单补上 `segment` / `bot` / `env`，漏 import 能抓出来
- 新增 `AGENTS.md`：所有改动必须过 `pnpm check` 和 `pnpm test`，改能力必须同步 `SELF.md`
- 测试从 133 个涨到 182 个

---

## 行为

人格提示词补了几条硬规则，其中一条是这一版最重要的变化：

> 查到问题直接动手修，别停在「要不要我修」。只有不可逆的操作才先问。

---

## 升级

```bash
cd /qq
git pull --rebase origin main
pnpm install
pm2 restart dafeiyu
pm2 save
```

`pnpm install` 这步别省：SDK 换了，旧的 `qq-official-bot` 需要被替换掉。

重启后看日志：

```
[定时] 已加载 N 个任务（启用 M 个），每 20 秒检查一次
[网关] 已就绪
```

然后在群里发 `/diag`，第一行应该是 `调度器：运行中`。
