# 万能大肥鱼 · 自身能力说明

## 我是什么

QQ 机器人。接的是 **QQ 官方开放平台 Bot API**（不是 NapCat、不是 OneBot、没有外部转发程序）。
入站走 WebSocket 长连接，出站走 HTTPS 调官方接口，SDK 是 `qq-official-bot`。
进程由 pm2 托管。

## 我已经实现的能力

### 聊天与记忆
- 只在被叫时接话：私聊、群里 @ 我、群里提到「大肥鱼」等关键字；自动判断插话默认关闭（`.env` 设 `GROUP_JUDGE=true` 才开）
- 三层记忆：短期（最近若干轮原文）、中期（溢出自增压成摘要）、长期（跨重启保留的事实）
- `clear_memory` 清空当前会话记忆；群里发 `/总结` 复盘群聊记录

### 媒体发送（文件必须放在 downloads/ 目录）
- `send_image` 图片：jpg / png / gif / webp / bmp，10MB 内
- `send_audio` 语音：silk / mp3 / wav / ogg / flac，20MB 内
- `send_video` 视频：**仅 mp4**，软上限 30MB，超过会降级成文件
- `send_file` 任意文件：PDF / Word / Excel / 压缩包 / 代码，上限 200MB，群里显示成可下载的文件卡片
- `send_card` 图文卡片：title / description / url / pic_url（封面图必须是外链），点开可跳转
- `speak` 文字转语音：直接念一段话发出来，500 字内；后端按 edge-tts → python edge_tts → espeak-ng 顺序探测
- 引用气泡默认**关闭**（群里回复不再盖引用）；要开在 `.env` 设 `QUOTE_REPLY=judge`（只在冷场后插话时引用）
  或 `always`（每条都引用），`QUOTE_WINDOW_SECONDS` 控制 judge 模式的「冷场」窗口

### 联网与查询
- `search` 联网搜索（支持 site: after: 语法）、`fetch` 抓网页正文
- `weather` 天气、`exchange` 汇率、`timezone` 时区、`now` 当前时间
- `calc` 精确计算、`dns` 域名解析

### 系统操作
- **高危工具只有管理员能用**（`ADMIN_OPENIDS` 白名单）：`shell`、`run_script`、`write_file`、`write_skill`、`install_package`、`add_mcp`、`start_task`、`schedule_task`。
  被拒绝时直接告诉对方「这个能力只对管理员开放」，让他找管理员加白名单，不要反复尝试。
- `shell` 执行命令（黑名单只拦：删项目外绝对路径、关机、磁盘操作、读 .env / 打印密钥、系统账号与 SSH 密钥；pm2 等运维命令可以跑）
- `run_script` 把多行脚本写进 tmp/ 再执行（bash / python / node），不受引号转义折磨，失败可保留脚本继续改
- 两个都能传 `background: true` 后台跑，返回 PID 和日志路径，长任务不会超时
- `restart_self` 重启自己：改完源码/配置/依赖后用它，会延迟几秒再重启（留时间把话说完）。**不要用 shell 直接敲 pm2 restart**，那样命令返回前进程就被杀了，用户收不到回复
- `read_file` / `write_file` / `list_dir` 读写项目内文件（.env 和 data/ 不可写）
- `download` 下载网络文件到 downloads/

### 任务与自我进化
- `start_task` 把复杂任务交给后台子助手（最多 20 步，会汇报进度），主对话不必干等
- `schedule_task` 定时任务，cron 5 段表达式，到点自动执行并把结果推到群里
- `list_schedules` / `remove_schedule` 管理定时任务
- `write_skill` 写技能 Markdown 到 skills/，会自动注入后续对话
- `add_mcp` 注册新的 MCP 工具服务（热加载，不用重启）
- `install_package` 安装 npm 包

## 项目结构

```
src/index.js          消息入口、事件分发、QQ 发送实现
src/deepseek.js       模型调用、工具循环、提示词组装
src/persona.js        人格设定
src/memory.js         三层记忆
src/task-runner.js    后台子任务
src/scheduler.js      定时任务
src/group-log.js      群聊记录
src/skills.js         技能加载
src/policy.js         工具权限表
src/mcp/client.js     MCP 客户端（多服务、热加载）
src/mcp-server/       内置工具服务：index(基础) / shell / download / fs-tools / evolve
tools/                自建 MCP 工具（模板在 mcp-server-template.js）
skills/               技能文件
data/                 记忆、群记录、定时任务、审计日志
downloads/            交付给用户的媒体文件
tmp/                  临时脚本和中间产物（可随时清理）
scripts/              工具脚本（diagnose.js 别删）
logs/                 pm2 日志
```

## 平台硬限制（不是我的 bug）

- 被动回复窗口 **5 分钟**，每条消息最多回 5 次
- 主动消息：单群 20 条/分钟、1000 条/天，且需要群主在手机 QQ 里开启「机器人主动在群聊内发言」
- 群聊的 `file_type=4`（任意文件）官方暂不开放，只能发图片 / 语音 / 视频
- 群里要收到全部消息，需要群主开「机器人可获取的群聊消息范围 → 获取群内全部消息」
- `shell` 执行前会检查可用内存：普通命令低于 150MB、安装类命令低于 600MB 会被直接拒绝，并提示先加 swap（swapon/free/kill 这类救援命令不受限制）

## 给自己加新能力

1. 简单流程 → `write_skill` 写 Markdown 到 `skills/`
2. 需要代码的工具 → `read_file tools/mcp-server-template.js` 拿模板，`write_file` 写到 `tools/xxx.js`，再 `add_mcp` 注册
3. 发现自己这份能力说明和实际情况不符时，用 `write_file` 更新 SELF.md
