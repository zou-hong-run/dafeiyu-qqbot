# 能力演示清单

录视频、给别人看、或者自己回归验证时，按这份清单走。

**原则**：每一项都要**真的调工具产出东西**，不能只描述「我能做什么」。失败的项如实说失败原因，那本身也是演示的一部分。

工具清单变了就得更新这里（见 `AGENTS.md` 第六节）。

---

## 批次一：媒体

一次发这些，让它逐项真做：

> 演示媒体能力，每项都要真的产出东西：
> 1. 用 draw_pixel 画一条鱼发出来
> 2. 用 speak 合成一句话发出来，换个音色再发一条
> 3. 用 find_video 搜一个 B 站视频，把标题、时长、简介报出来，再截 8 秒发到群里
> 4. 用 find_music 搜一首歌，把 30 秒试听发出来
> 5. 用 send_card 发一张图文卡片

| 项 | 工具 | 备注 |
|---|---|---|
| 像素画 | `draw_pixel` | 预设 fish / heart / star / camera，也能用字符网格自己拼 |
| 语音 | `speak` | 音色可换：东北话、粤语、新闻播报腔、男声 |
| 视频片段 | `find_video` → `fetch_video` | 走 yt-dlp，依赖外部服务，网络不通会失败 |
| 视频元信息 | `video_meta` `read_video_subtitle` | 标题、时长、字幕 |
| 音乐 | `find_music` | iTunes 接口，返回 30 秒试听，不是整首 |
| 图文卡片 | `send_card` | 封面图要公网 https 链接 |
| 发文件 | `send_file` | 任意文件，扩展名会自动补 |

---

## 批次二：查询

> 演示查询能力：
> 1. now 报当前时间
> 2. weather 报北京天气
> 3. exchange 算 100 美元兑人民币
> 4. timezone 报纽约现在几点
> 5. dns 查 github.com 的 A 记录
> 6. calc 算 1250 的 13% 加 88
> 7. search 搜今天一条科技新闻，带链接
> 8. 用 fetch 抓那条新闻的正文，把配图嵌进 markdown 发出来

| 项 | 工具 | 备注 |
|---|---|---|
| 时间 | `now` | 日期、星期、时区 |
| 天气 | `weather` | 支持未来几天 |
| 汇率 | `exchange` | |
| 时区 | `timezone` | |
| DNS | `dns` | A / AAAA / MX / TXT / NS / CNAME |
| 精确计算 | `calc` | 多步算术不心算 |
| 联网搜索 | `search` | 支持 `site:` `after:` 语法 |
| 抓正文 | `fetch` | 顺带返回页面配图，会嵌进正文 |
| 系统体检 | `system_info` | CPU / 内存 / 磁盘 / 预算档位 |

---

## 批次三：交互与任务

> 演示交互和任务能力：
> 1. 用 ask_choice 出一道选择题，四个选项，做成按钮
> 2. 读一份文档给我看：先造一个 3 行的 CSV 放 downloads，再 read_document 读出来
> 3. 撤回你刚才发的那条消息
> 4. 用 list_schedules 说一遍现在有哪些定时任务
> 5. 用 read_group_history 统计本群最近谁说话最多
> 6. 记住「视频标题是《万能大肥鱼》」，然后告诉我记下了

| 项 | 工具 | 备注 |
|---|---|---|
| 按钮选择题 | `ask_choice` | 一行一个按钮，正文同时列选项；点一下或回数字都算 |
| 读文档 | `read_document` | PDF / Word / Excel / CSV / 文本，扫描件会提示提取不出 |
| 下载 | `download` | 公网链接落到 `downloads/` |
| 撤回 | `recall_message` | 高危工具，只有白名单能用；只能撤当前会话 |
| 定时任务 | `schedule_task` `list_schedules` `update_schedule` `remove_schedule` | 增删改查都支持，改时间不用重建 |
| 群记录 | `read_group_history` `read_profile` `list_groups` | 管理员可指定任意群 |
| 记忆 | `remember` `clear_memory` `note_situation` | 长期事实跨重启保留 |
| 任务清单 | `todo_write` | 多步任务的进度跟踪 |
| 跨群发送 | `send_to_group` `broadcast` | 高危，需要至少两个群 |

---

## 不适合在群里演示的

这些是高危工具，演示等于在群里跑命令、改文件、装包。录视频时建议单独说明它们的**存在**，而不是现场执行：

`shell` `run_script` `write_file` `edit_file` `install_package` `add_mcp` `write_skill` `git_sync` `start_task` `restart_self` `wake_user` `file_copy`

想演示它们，在私聊里做，或者说明「这些要白名单才开，默认对群友关闭」。

---

## 演示时容易踩的坑

- **视频和音乐依赖外部服务**：`fetch_video` 走 yt-dlp，`find_music` 走 iTunes。网络不通会失败，如实报错比假装成功强。
- **跨群 / 全服通报**需要至少两个群，单群演示不了，跳过并说明。
- **重启类演示**（`restart_self`）会中断录制。
- **长回复会分段**：批次里一次给 5~8 项，它会拆成几条消息发，属正常。
- **配图默认 320px 宽**，要别的尺寸在 alt 里写 `#500px`。

---

## 回归验证用

不是录视频时，这份清单也能当冒烟测试：跑一遍，哪项失败就是哪条链路断了。比看单测更直观 —— 单测覆盖不到真机行为（按钮渲染、图片转存、语音格式）。
