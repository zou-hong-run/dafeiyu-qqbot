# 能力清单

真实数量：本地工具 26 个 + 内置 MCP 工具 29 个 + 外部 MCP 工具（可无限扩展）。斜杠命令 15 个。

实际能用到多少看两个因素：**场景**（私聊/群聊）和**权限**（是否在 `ADMIN_OPENIDS` 白名单里）。群里高危工具默认不发给模型，所以群里看到的工具数会比私聊少一半。

---

## 一、对话

| 能力 | 怎么触发 | 说明 |
|---|---|---|
| 人格对话 | @ 它 / 提到「大肥鱼」「鱼鱼」/ 私聊 | 人格写在 `src/chat/persona.js`，`SYSTEM_PROMPT` 可一行覆盖 |
| 看图 | 直接发图 | 图片喂给 `deepseek-flash` 做多模态理解，能读截图、文档照片 |
| 连发合并 | 连着发几段 | 同一人 2.5 秒内的几句合成一次请求；短句或没说完的多等几秒 |
| 引用上下文 | 引用某条消息 | 能拿到被引用原文，回答时知道在接哪句话 |
| 选择题 | 拿不准时它自己发 | 给 2-5 个编号选项，回数字就算选中 |
| 长回复分段 | 自动 | 超 `REPLY_MAX_CHARS` 切段；发不完的存起来，说「接着发」补 |
| 流式输出 | `STREAM_REPLY=true` | 私聊逐段出现；要开放平台单独开通权限，默认关 |
| 撤回自己 | `/kill` 或 `recall_message` | 只能撤自己发的，且约 2 分钟内有效 |

## 二、记忆

| 层 | 存什么 | 怎么进提示词 | 存哪 |
|---|---|---|---|
| 短期 | 最近 8 轮对话原文 | 每轮直接带上 | 内存，闲置 30 分钟清空 |
| 中期 | 溢出的对话压成摘要 | 摘要形式常驻 | `data/memory.json` |
| 长期 | 跨重启的事实 | 全量注入 | `data/memory.json` |
| 情绪记忆 | 没结的事（「等审批」「接口报错」） | 【还在进行中的事】 | `data/situations.json` |
| 群知识 | 从群记录沉淀的判断 | 本群情况 | `data/knowledge.json` |
| 群画像 | 谁常来、什么时段、聊什么 | 每轮注入 | 聚合自 `data/groups/` |
| 目标 | 会话里未完成的意图 | 有目标就推进 | `data/goals.json` |
| 失败复盘 | 工具连续失败的教训 | 提醒别再犯 | `skills/pitfalls.md` |

写记忆的工具：`remember`、`note_situation`、`clear_memory`、`note_lesson`、`goal`、`todo_write`。

## 三、群聊感知

| 能力 | 开关 | 默认 |
|---|---|---|
| @ 必回 | 不能关 | 开 |
| 提到名字必回 | `GROUP_AUTO_REPLY` | 开，冷却 0 秒 |
| 自动判断要不要插话 | `JUDGE_MODE=auto` | 关 |
| 只观察不插话 | `JUDGE_MODE=observe` | 关，`/observe` 看它想插哪些 |
| 主动找「有人问没人答」 | `PROACTIVE_ENABLED` | 开，5 分钟扫一次，每群每小时最多 2 次，23-8 点静 |
| 回访没结的事 | `FOLLOWUP_ENABLED` | 开，每小时看一次，至少隔 6 小时才提 |
| 热点吐槽 | `HOT_TAKE_ENABLED` | 关 |
| `/总结` 复盘 | 不能关 | 取最近 200 条 |
| 安静模式 | 群友说「安静」「别吵 30」 | 期间只回 @ |

采集：群开了「获取群内全部消息」权限时，所有消息都记进 `data/groups/<群号>.jsonl`（每群 600 条滚动窗口）。没开的话只有 @ 它的那部分。

## 四、本地工具（28）

内置在主进程里，不需要经过 MCP 子进程。

| 分类 | 工具 | 群里可用 |
|---|---|---|
| 记忆 | `remember` `note_situation` `clear_memory` `note_lesson` `goal` `todo_write` | ✓ |
| 交互 | `ask_choice` | ✓ |
| 技能 | `read_skill` | ✓ |
| 群聊读取 | `read_group_history` `read_profile` `list_groups` | ✓（读别的群要管理员） |
| 群聊发言 | `send_to_group` `broadcast` | 仅白名单 |
| 私聊唤醒 | `wake_user`（30 天窗口，比普通主动消息更容易送达） | 仅白名单 |
| 发图片 | `send_image` | ✓ |
| 发语音 | `send_audio` `speak` | ✓ |
| 发视频 | `send_video` | ✓ |
| 发文件 | `send_file` | ✓ |
| 发卡片 | `send_card` | ✓ |
| 撤回 | `recall_message` | 仅白名单 |
| 后台任务 | `start_task` `schedule_task` | 仅白名单 |
| 定时任务管理 | `list_schedules` `update_schedule` `remove_schedule` | ✓（改删要创建者或管理员） |
| 代码同步 | `git_sync` | 仅白名单 |

## 五、内置 MCP 工具（29）

跑在独立子进程里（`--max-old-space-size` 默认 160MB），崩溃不影响主进程。

| 分类 | 工具 | 群里可用 |
|---|---|---|
| 联网 | `search` `fetch` | ✓ |
| 时间天气 | `now` `weather` `timezone` | ✓ |
| 计算汇率 | `calc` `exchange` | ✓ |
| 网络诊断 | `dns` `system_info` | ✓ |
| 文件读取 | `read_file` `list_dir` | ✓ |
| 文件写入 | `write_file` `edit_file` | 仅白名单 |
| 文档解析 | `read_document`（PDF / Word / Excel / 文本） | ✓ |
| 下载 | `download` | ✓ |
| 画图 | `draw_pixel` | ✓ |
| 音乐 | `find_music` | ✓ |
| 视频 | `find_video` `fetch_video` `read_video_subtitle` `video_meta` | ✓ |
| 技能扩展 | `write_skill` `install_package` `add_mcp` | 仅白名单 |
| 技能查询 | `list_skills` `list_mcp` | ✓ |
| 命令执行 | `shell` `run_script` `restart_self` | 仅白名单 |

## 六、外部 MCP（可扩展）

服务器上现有的三个（`tools/` 目录，注册在 `data/mcp-registry.json`）：

| 服务 | 提供 | 说明 |
|---|---|---|
| `kun_fortune` | `fortune` | 抽签、运势 |
| `song_search` | `song` | 搜歌、试听 |
| `group-speakers` | `group_recent_speakers` | 最近谁在说话 |

`add_mcp` 可以热加载新的 MCP 服务，不用重启。限制：只允许 `node tools/*.js` 或已装好的 `npx`（禁 `-y` 联网拉包），`env` 字段不接受自定义值。

## 七、斜杠命令（15）

| 命令 | 作用 | 谁能用 |
|---|---|---|
| `/id` | 查自己的 openid | 所有人 |
| `/help` | 命令和工具总览 | 所有人 |
| `/config` | 当前生效配置（模型、记忆、工具、内存、备份） | 所有人 |
| `/cost` | token 用量和成本 | 所有人 |
| `/memory` `/memory list` | 看长期记忆 | 所有人 |
| `/forget` | 删记忆 | 管理员 |
| `/tasks` `/task` | 工单列表、详情 | 所有人 |
| `/kill` | 中止工单 | 管理员 |
| `/observe` | 看观察模式记下的「本来会插话」的事件 | 所有人 |
| `/reset` | 清掉本会话上下文 | 所有人 |
| `/clean` | 清理 tmp / 过期附件 / 脚本残留 | 管理员 |
| `/diag` | 依赖和 MCP 连通性自检 | 管理员 |
| `/diag vision` | 图片理解链路专项检查 | 管理员 |
| `/总结` `/复盘` | 复盘最近 200 条群消息 | 所有人 |

## 八、运维与安全

| 能力 | 实现 |
|---|---|
| 崩溃自启 | pm2 `autorestart` + `max_restarts`，30 秒内挂掉算启动失败，指数退避 |
| 内存自保 | 主进程堆 320MB（2G 机器）、MCP 160MB、单命令 `ulimit -v 512MB`、RSS 超 420MB 自动重启 |
| 开工前算账 | 按命令引用的文件类型乘系数估峰值内存，超「可用 × 75%」直接拒绝 |
| 命令校验 | 归一化（全角/引号/反斜杠）后再匹配黑名单，敏感路径 + 外传工具组合拦截 |
| OS 级沙箱 | Linux bwrap：只读根、工作目录可写、默认断网、密钥目录挂空、`CAP_DAC_OVERRIDE` 外全部丢弃 |
| 权限隔离 | 17 个高危工具走 `ADMIN_OPENIDS` 白名单；模型连工具列表都看不见 |
| 密钥隔离 | 存项目外（Linux `/etc/dafeiyu/env`，600 root），子进程不继承，沙箱内遮蔽 |
| 审计 | 所有高危调用写 `data/audit.log`（tab 分隔） |
| 备份 | `data/` 每日快照到 `backups/`，`/config` 能看到最近几份 |
| 代码自同步 | 每 30 分钟 + 退出时 `git commit` + `push`，提交前扫密钥和黑名单路径 |
| 自愈 | 看门狗 30 秒巡检工单，卡住的回收，失败写 `data/heals.json` |

**17 个高危工具**（必须白名单）：`shell` `run_script` `write_file` `edit_file` `write_skill` `install_package` `add_mcp` `start_task` `schedule_task` `restart_self` `send_to_group` `broadcast` `git_sync` `note_lesson` `clear_memory` `wake_user` `recall_message`

---

## 按场景看可用数量

| 场景 | 可用工具数 | 原因 |
|---|---|---|
| 私聊，你是管理员 | 全部（54 + 外部 MCP） | 权限全开 |
| 私聊，你不在白名单 | 39 | 17 个高危工具被过滤 |
| 群聊，你是管理员 | 54 | 群聊没额外限制 |
| 群聊，你不在白名单 | 39 | 同上，且 `send_to_group` / `broadcast` 也用不了 |

（数字随外部 MCP 服务增减变化，`/config` 里能看到当前真实值。）
