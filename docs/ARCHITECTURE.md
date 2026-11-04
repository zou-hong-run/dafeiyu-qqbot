# 技术架构

从「群里有人说了句话」到「沙箱里跑完一条命令」，中间经过哪些层、每层的边界在哪、哪些地方是刻意留的口子。看这份就够了，不用翻源码。

行号会随改动漂移，所以只写文件名和函数名。

---

## 一、整体形态

```
pm2 (fork, 单实例)
└── 主进程  src/index.js
      ├── QQ 网关 WebSocket（qq-official-bot）
      ├── 对话循环 / 工单调度 / 定时器 / 记忆
      └── MCP 客户端  src/mcp/client.js
            └── MCP 子进程  src/mcp-server/index.js   ← 独立 node 进程，stdio JSON-RPC
                  ├── 内置工具（shell / 搜索 / 文件 / 媒体 / 调度）
                  └── 外部 MCP 服务（add_mcp 热加载进来的）
```

三个要点：

- **必须单实例**。同一个 AppID 只能保持一条 WebSocket，多开会互相踢下线，所以 `exec_mode: fork`、`instances: 1`。
- **工单不是子进程**。`start_task` 起的是主进程里的异步循环（`src/tasks/worker.js`），共享同一个事件循环和内存预算。所以 `TASK_CONCURRENCY` 直接等于「同时能跑几个对话」，2C2G 上默认是 1-2。
- **工具在子进程里**。MCP 走 stdio，好处是工具崩溃不会带走主进程，代价是每次调用多一层序列化和进程间通信。

## 二、代码分层

| 目录 | 职责 | 不该做的事 |
|---|---|---|
| `src/channel/` | 收消息、发消息、附件下载、群记录采集 | 不判断该不该回 |
| `src/app/` | 消息路由、命令表、定时器、启动自检 | 不直接调模型 |
| `src/chat/` | 提示词组装、对话循环、工具分发、连发合并 | 不碰网络和文件系统 |
| `src/memory/` | 短期 / 中期 / 长期记忆、群画像、情绪记忆 | 不调工具 |
| `src/tasks/` | 工单、调度、看门狗、自愈 | 不直接对用户说话（走 outbox） |
| `src/mcp-server/` | 工具实现 + 沙箱 + 命令校验 | 不读 `.env` |
| `src/ops/` | 平台能力、内存预算、备份、同步、统计 | 不含业务逻辑 |
| `src/config/` | 环境变量、权限策略 | 不做 IO |

`src/config/policy.js` 是权限的唯一来源，`src/ops/platform.js` 是平台差异的唯一来源。任何地方要判断「能不能调」或「这个平台能不能干」，都只能问这两个模块。

---

## 三、一条消息的完整旅程

### 阶段 1：接入

```
QQ 服务器 → WebSocket
  bot.on('message.group')            src/index.js
  bot.on('message.group.at')         src/index.js
  bot.on('message.private.friend')   src/index.js
```

同一会话的消息先进 `enqueue()` 串行队列，避免两条消息抢同一份上下文。

### 阶段 2：判断该不该回

`handleGroupAll()` 里的顺序是固定的，先命中先返回：

1. 记进群记录（不管回不回都记，这是画像和「主动接话」的数据源）
2. 安静模式命令（`安静` / `别吵 30`）
3. 上一条发过选择题、这次回了个数字 → 当选中处理
4. **@ 了我** → 回
5. `/总结` → 回
6. 被喊过安静 → 到此为止
7. **提到「大肥鱼 / 鱼鱼」** → 回（受 `GROUP_TRIGGER_COOLDOWN` 限制）
8. `JUDGE_MODE=auto` → 交给插话判断（异步，有防抖、每小时上限、冷却）

### 阶段 3：预处理

`handleMessage()` 里，按顺序：

| 检查 | 行为 |
|---|---|
| 消息超过 4 分钟 | 丢弃。QQ 被动回复窗口是 4 分钟，过了发不出去 |
| `/` 开头 | 交给 `src/app/commands.js` 的命令表，不再进模型 |
| 「接着发」+ 有待发内容 | 直接把尾巴补发出去 |
| 有工单在跑 | 新消息投给那个工单，不另开对话（`/chat` 开头可绕过） |
| 有附件 | 下载到 `downloads/incoming/<会话>/`，图片额外喂给多模态 |
| 超过 `MAX_INPUT_CHARS` | 截断，并告诉模型「前面被砍了」 |

### 阶段 4：组装请求

`src/chat/deepseek.js` 的 `chat()`：

```
messages = [
  system  = 人格 + 三层记忆 + 群画像 + 技能摘要 + 失败复盘
  ...history（最近 HISTORY_TURNS 轮原文）
  user    = 群上下文前缀 + 用户这句话 + 附件说明
]

tools = 本地工具 + MCP 工具（先过权限过滤，见下一节）
```

群聊时如果只是被 @ 或叫名字，会把最近几条群消息作为前缀带上——否则模型不知道刚才大家在聊什么，只会回「在呢，什么事」。

### 阶段 5：工具循环

`MAX_TOOL_ROUNDS`（默认 12）轮，每轮：

```
POST /chat/completions  (tool_choice: auto)
   ↓
有 tool_calls？
   ├─ 没有 → 检查「空承诺」：
   │           说了「我这就去 / 马上查」却没调工具
   │           说「搞定了」但整轮一次工具都没调过
   │         → 插一条系统提示逼它重来，最多 2 次
   └─ 有   → 逐个执行，结果 push 成 role: 'tool'，进入下一轮
```

还带三个保护：

- **去重缓存**：同参数同工具再调一次，直接返回上次结果，不重复执行
- **停滞检测**：连续 3 次完全相同的调用 → 强制收尾
- **收尾兜底**：工具轮次用完还没出结论，再发一次「不要调工具，直接说结论」

### 阶段 6：发送

回复按 `REPLY_MAX_CHARS` 切段，超出部分存 `data/pending-replies.json`，群里说「接着发」再补。

---

## 四、工具调用与权限：两道闸门

### 闸门一：模型根本看不见

`src/chat/deepseek.js` 组装 `usableTools` 时，高危工具不在白名单里就**不发给模型**。

`DANGEROUS_TOOLS` 包含：`shell` / `run_script` / `write_file` / `edit_file` / `install_package` / `add_mcp` / `restart_self` / `start_task` / `schedule_task` / `broadcast` / `send_to_group` / `git_sync` 等。

模型看不见就不会尝试调，也就不会编出「我没有权限」这类话。

### 闸门二：执行前再判一次

`runTool()` 开头再查一遍 `isToolAllowed(name, scope, actor)`。防的是模型从历史上下文里记住了工具名硬编调用。

判定逻辑在 `src/config/policy.js`：

```
配了 ADMIN_OPENIDS  → 只有白名单里的人能用高危工具（私聊群聊都算）
没配               → 群里禁用，私聊放开（SHELL_GROUP_ENABLED=true 可放开群里）
```

### 分发

```
runTool()
  ├─ 本地工具（send_image / remember / ask_choice / note_situation…）
  │    直接在主进程执行
  └─ MCP 工具
       callTool(name, args)  src/mcp/client.js
         └─ MCP 协议 over stdio
              └─ 子进程 handler   src/mcp-server/index.js
```

`callTool` 外面套 `TOOL_TIMEOUT_SECONDS`（默认 60 秒）超时，超时不会拖死整轮对话。

---

## 五、沙箱层

### 入口

`shell` / `run_script` 最终都走 `src/mcp-server/shell.js` 的 `runOnce()`，它调 `src/mcp-server/sandbox.js` 的 `sandboxCommand()`。

### 命令检查（沙箱之前）

`src/mcp-server/shell-guard.js` 的 `inspectCommand()` 先做归一化再匹配：

```
NFKC（ｒｍ → rm）→ 去引号（r''m → rm）→ 去反斜杠 → 去零宽字符 → 归一空白
```

然后拦：删根目录 / 删家目录 / 删项目外绝对路径 / 关机 / 磁盘操作 / 读 `.env` / 导出环境变量 / 打印密钥 / SSH 密钥。

最后一条是组合判断：**敏感路径 + curl/wget 同时出现** → 拒绝（疑似外传）。

黑名单挡不住所有绕过写法，真正的边界是白名单和下面的 OS 级隔离。

### 资源预估（沙箱之前）

`estimateResourceUsage()` 扫命令里引用的文件，按类型乘系数估峰值内存：

| 类型 | 系数 |
|---|---|
| 视频 | 2.5 |
| 音频 | 4 |
| 图片 | 6 |
| 表格 | 4 |
| JSON | 3 |

估算超过「当前可用内存 × 75%」直接拒绝。2G 机器上这一条拦下的比沙箱还多。

### bwrap 参数

有 bwrap 且自检通过时，命令被包成这样：

```
bwrap
  --cap-drop ALL [--cap-add CAP_DAC_OVERRIDE]  默认不给任何能力
  --unshare-pid --unshare-ipc --unshare-uts   看不见宿主其他进程
  [--unshare-net]                             命令里没 curl/git/pnpm 就断网
  --ro-bind / /                               整个根只读
  --bind <项目根>/tmp <项目根>/tmp              只有这两个目录可写
  --bind <项目根>/downloads <项目根>/downloads
  --tmpfs /tmp --dev /dev --proc /proc
  --tmpfs <密钥目录>                           变成空目录
  --ro-bind-try /dev/null <项目根 .env>        读出来是空
  --ro-bind-try /dev/null /root/.pm2/dump.pm2  pm2 的 env 快照
  --clearenv --setenv PATH ... --setenv HOME /tmp
  --die-with-parent
  --chdir <cwd>
  -- /bin/sh -c "<命令>"
```

`CAP_DAC_OVERRIDE` 是有条件的：只有当可写目录的属主和运行用户不一致时才补。把项目目录 `chown` 给运行用户后，这个 capability 完全不需要——也就去掉了「沙箱内能读全盘」这个面。

`data/`、`src/`、`skills/`、`node_modules/` 全部只读，是因为它们都是能形成逃逸链的东西：

- `data/mcp-registry.json` 改掉，下一轮 `syncRegistry()` 就会在宿主侧 spawn 它指定命令
- `data/audit.log` 擦掉，审计失效
- `src/` 改掉再叠加 `restart_self`，代码就换掉了

装包、改代码、拉仓库都走主进程（`install_package` / `write_file` / `git_sync`），不经过沙箱，所以功能没丢。

### 为什么不用 `--unshare-user`

试过，不行。bwrap 的 user namespace 只映射一个 uid，而项目目录属主是 `www`。那个 uid 在 namespace 里没有映射，`CAP_DAC_OVERRIDE` 对它的 inode 直接失效——`touch` 报 Permission denied。

改成真 namespace + 按需补 `CAP_DAC_OVERRIDE`，写权限正常，`mount` / `ptrace` / `bpf` 这些能把只读根拆掉的能力一个没有。

### 探测不会撒谎

`sandboxStatus()` 会真的跑一次 bwrap（不只是 `--version`），`sandboxSelfTest()` 更进一步：**用完整参数跑一次读写探针**（`touch` 一个文件再删掉）。

启动日志只有两种写法：`bwrap 沙箱已启用` 或 `未隔离（具体原因）`。没有「理论上支持」这种模糊表述。

---

## 六、数据落盘

全部在 `data/`，不进 git（`.gitignore` 已忽略）。

| 文件 | 内容 | 谁写 |
|---|---|---|
| `memory.json` | 长期事实 + 中期摘要 | `remember` 工具、摘要压缩 |
| `knowledge.json` | 群知识沉淀 | 洞察定时器 |
| `situations.json` | 未了结的事（回访用） | `note_situation` 工具 |
| `goals.json` | 会话目标 | 工单系统 |
| `groups/<群号>.jsonl` | 群消息原文（滚动窗口） | 接入层 |
| `tickets.json` | 工单 | 任务层 |
| `schedules.json` | 定时任务 | 调度器 |
| `outbox.json` | 待发消息 | 重试队列 |
| `heals.json` | 自愈记录 | 看门狗 |
| `pending-replies.json` | 没发完的长回复 | 发送层 |
| `usage.json` | token 用量 | 每次模型调用 |
| `audit.log` | 工具调用审计（tab 分隔） | `audit()` |
| `cookies.txt` | 站点登录态（可选） | 手动放 |

`data/` 对模型的 `read_file` / `write_file` 不可写，`send_file` 也不开放。只有 `shell`（仅管理员）能碰到。

---

## 七、已知缺口

### 1. `CAP_DAC_OVERRIDE` 让沙箱内能读全盘

`--ro-bind / /` 只挡写不挡读。当可写目录的属主和运行用户不一致时（默认部署就是这样：项目属 `www`，进程跑 `root`），必须补 `CAP_DAC_OVERRIDE` 才能写得进去，而这个能力同时意味着**读全盘不受 DAC 限制**——`/etc/shadow`、`~/.aws`、systemd 的 EnvironmentFile 都读得到。

遮蔽只能点几个路径（密钥目录、`.ssh`、pm2 快照），点名单永远补不齐。

**根治方式**：把项目目录 `chown` 给运行用户，然后用该用户启动 pm2。代码会自动检测属主，不需要这个 capability 就不加。

### 2. 断网是按命令文本判断的

`NEEDS_NETWORK` 正则只要在命令里看到 `curl`、`git`、`pnpm` 就放行网络。所以「读数据 + 外传」这条路实际靠的是遮蔽和命令黑名单，不是网络隔离。

放到云服务器上还有个具体风险：`169.254.169.254`（阿里云是 `100.100.100.200`）暴露实例角色临时凭证。这条**必须堵在宿主机防火墙**，沙箱管不了。

### 3. macOS / Windows 没有 OS 级沙箱

只有权限表 + 内存预算。详见 [PLATFORMS.md](PLATFORMS.md)。

### 4. 密钥副本在 pm2 的快照里

`pm2 save` 会把启动时的 env 写进 `/root/.pm2/dump.pm2`，里面有明文密钥。沙箱里已把它盖成 `/dev/null`，宿主侧靠文件权限（600 root）保护。

### 5. 主进程侧的工具不受沙箱约束

`write_file`、`edit_file`、`install_package`、`git_sync` 都在主进程里执行，因为它们本来就要改项目目录。所以「高危工具只给白名单」是这层的唯一门槛——白名单没配好，沙箱再严也没用。

---

## 已修复的历史问题

记在这里，免得以后有人照旧实现一遍：

| 问题 | 怎么修的 |
|---|---|
| `background: true` 绕过沙箱 | 后台命令同样走 `sandboxCommand()`；只有 `restart_self` 单开例外（它要连 pm2 daemon） |
| 后台命令继承模型 key | 所有子进程统一用 `shell-env.js` 的 `shellSafeEnv()` |
| `install_package` 继承模型 key | 显式传 `env: shellSafeEnv()` |
| 注册表热加载不校验 command | `syncRegistry()` 复用 `assertMcpCommand()`，env 字段一律清空 |
| `SHELL_UNRESTRICTED` 逃生开关 | 整个删掉，连 `inspectCommand` 的 `unrestricted` 参数一起删 |
| 工作目录整块可写 | 只放开 `tmp/` 和 `downloads/`，`data/`、`src/`、`skills/` 只读 |
| 自检失败仍报「- 已启用」 | 自检结果区分「没装」和「装了跑不起来」，后者直接拒绝执行命令 |
| 审计集合漏 `git_sync` / `write_file` / `edit_file` | 补齐 |
| 后台进程只在起新任务时回收 | 挂 5 分钟定时器，并按进程组杀 |

---

## 八、按需求找文件

| 想改什么 | 去哪 |
|---|---|
| 人格、说话方式 | `src/chat/persona.js` |
| 提示词结构、记忆注入顺序 | `src/chat/deepseek.js` 的 `buildSystemPrompt()` |
| 权限规则 | `src/config/policy.js` |
| 哪些工具算高危 | `src/config/policy.js` 的 `DANGEROUS_TOOLS` |
| 命令黑名单 | `src/mcp-server/shell-guard.js` |
| 沙箱参数 | `src/mcp-server/sandbox.js` |
| 内存预算档位 | `src/ops/budget.js` |
| 平台差异 | `src/ops/platform.js` |
| 加一个新工具 | `src/mcp-server/` 下新建模块 → 在 `index.js` 注册 |
| 加一条命令 | `src/app/commands.js` |
| 定时任务 | `src/app/timers.js` |
| 群聊触发规则 | `src/index.js` 的 `handleGroupAll()` |
| 环境变量 | `src/config/env.js`（默认值都在这） |
