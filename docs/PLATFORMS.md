# 在不同系统上运行

Linux / macOS / Windows 都能跑，但**能力不一样**。先看这张表，再决定部署到哪。

| | Linux | macOS | Windows |
|---|---|---|---|
| 建议用途 | 生产、公开群 | 本地开发、自用 | 本地开发、自用 |
| 命令沙箱 | bwrap（真隔离） | 无 | 无 |
| 单条命令内存上限 | `ulimit` | 无 | 无 |
| 内存读数 | `/proc/meminfo`（精确） | `os.freemem`（偏保守） | `os.freemem`（偏保守） |
| 后台命令解释器 | POSIX sh | POSIX sh | `cmd.exe` |
| 系统包管理 | apt / yum / dnf | Homebrew | winget |
| 开机自启 | `pm2 startup`（systemd） | `pm2 startup`（launchd） | `pm2-installer` 或任务计划程序 |
| 默认密钥路径 | `/etc/dafeiyu/env` | `~/.config/dafeiyu/env` | `%APPDATA%\dafeiyu\env` |

> 只有 Linux 有 OS 级沙箱。macOS 的 Seatbelt 已被 Apple 弃用，不当作安全边界；Windows 没有可用的同类机制。这两个平台靠的是权限表（谁能调高危工具）+ 内存预算，够自用，别拿来跑公开群。

---

## 通用步骤

三个平台的前半段完全一样：

```bash
git clone https://github.com/zou-hong-run/dafeiyu-qqbot.git
cd dafeiyu-qqbot
node scripts/bootstrap.js
```

`bootstrap.js` 会自己判断平台，依次做这些事：

1. 查 Node 版本（低于 20.12 直接告诉你升级命令）
2. 查 pnpm，没有就用 Node 自带的 corepack 打开
3. 装项目依赖（`pnpm install`）
4. 建运行目录（`data/ downloads/ logs/ tmp/ backups/ skills/`）
5. 生成密钥文件到该平台的默认位置，权限 600
6. 装外部工具：yt-dlp、ffmpeg，Linux 上再加 bubblewrap

它只做「检测」和「安装」，不会启动机器人。缺什么会直接说，能自动装的自动装。

想看它要动什么、但什么都不改：

```bash
node scripts/bootstrap.js --check
```

**接着填密钥**（路径在输出的第 5 步里写着）：

```env
DEEP_SEEK_API_KEY=sk-xxxx
QQ_APP_ID=102xxxxx
QQ_APP_SECRET=xxxx（32 位）
```

再跑一次 `node scripts/bootstrap.js --check` 确认没有红叉，然后 `pnpm start` 试跑。

---

## Linux

### 装依赖

`bootstrap.js` 会自动跑 `apt-get install -y bubblewrap ffmpeg`，yt-dlp 优先用 `pipx`（拿到的是最新版），没有 pipx 再退回 apt。

不是 root 时它会用 `sudo -n`（不弹密码）。如果 sudo 需要密码，手动执行：

```bash
sudo apt-get install -y bubblewrap ffmpeg
pipx install yt-dlp
```

### 沙箱

装了 bubblewrap 且内核允许建命名空间，shell 命令会被包进 `bwrap`：

- 整个根只读，只有 `tmp/` 和 `downloads/` 可写
- 默认断网，只有装包 / 拉代码 / 下载这类命令放行
- 不继承宿主环境变量（`--clearenv`）
- capability 只留 `CAP_DAC_OVERRIDE`，`mount`、`ptrace` 全丢
- 密钥目录 `/etc/dafeiyu`、`/root/.ssh` 挂成空 tmpfs，项目根 `.env` 和 pm2 的 env 快照盖成 `/dev/null`

启动时会**真的跑一遍读写探针**，日志如实写「沙箱已启用」或「未隔离（原因）」。没装就是不隔离，不会假装。

### 开机自启

```bash
pm2 start ecosystem.config.cjs
pm2 save
pm2 startup
# 它打印一行 sudo env PATH=... pm2 startup systemd -u root --hp /root
# 复制那行执行一次，再 pm2 save
```

### 2C2G 小机器

默认配置就是按 1.6G 实测调的：主进程堆 320MB、MCP 子进程 160MB、单条命令 `ulimit -v 512MB`、pm2 RSS 超 420MB 自动重启。机器更小时先加 swap：

```bash
fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile
```

---

## macOS

### 装依赖

```bash
xcode-select --install        # 有 Homebrew 就跳过
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
node scripts/bootstrap.js
```

`bootstrap.js` 会用 `brew install yt-dlp ffmpeg`。

### 沙箱

**没有。** macOS 的 `sandbox-exec` 是 Seatbelt 的接口，Apple 已经弃用，行为在不同系统版本上不一致，不能当安全边界。启动日志会直接写「macOS 无可用沙箱」。

这意味着：拿到管理员身份的人可以让它执行任意命令，只受命令黑名单约束（黑名单挡不住精心构造的绕过）。自用没问题，别把高危工具开放给不信任的人。

### 开机自启

```bash
pm2 start ecosystem.config.cjs
pm2 save
pm2 startup
# 按打印的命令执行一次，它配的是 launchd
```

pm2 在 macOS 上重启后可能因为「完全磁盘访问权限」读不到某些目录，去「系统设置 → 隐私与安全性 → 完全磁盘访问权限」把终端或 pm2 加上。

### 注意

- `ulimit -v` 在 macOS 上不生效，所以单条命令没有硬内存上限，只靠执行前的预估拦截
- Apple 芯片和 Intel 都能跑，Node 用官方安装包或 `brew install node@22`

---

## Windows

### 装依赖

```powershell
winget install OpenJS.NodeJS.LTS
winget install Git.Git
```

然后**在项目目录里**开 PowerShell：

```powershell
node scripts/bootstrap.js
```

它会用 `winget install yt-dlp.yt-dlp` 和 `winget install Gyan.FFmpeg`。装完新开的终端才有 PATH，脚本会提示你重开。

没有 winget（Win10 1809 以前）就手动去 yt-dlp 和 ffmpeg 官网下压缩包，解压后把目录加进系统 PATH。

### 最重要的一条：shell 工具是 cmd 语法

Windows 上 `shell` 工具走 `cmd.exe`，不是 bash。所以：

| 想做的事 | Linux/macOS | Windows |
|---|---|---|
| 列目录 | `ls -la` | `dir` |
| 看文件 | `cat a.txt` | `type a.txt` |
| 删目录 | `rm -rf x` | `rmdir /s /q x` |
| 管道 | `|` | `|`（一样） |
| 环境变量 | `$HOME` | `%USERPROFILE%` |

装了 Git Bash 也不改变这一点——Node 的 `shell: true` 在 Windows 上固定调 `cmd.exe`。所以让机器人在 Windows 上跑 shell 时，要按 cmd 的说法下命令。

### 沙箱

**没有。** Windows 没有等价的轻量沙箱。同样只靠权限表和内存预算。启动日志写「Windows 无 OS 级沙箱」。

### 开机自启

pm2 的 `pm2 startup` 不支持 Windows。两个办法：

**办法一：pm2-installer**

```powershell
npm i -g pm2 pm2-installer
pm2 start ecosystem.config.cjs
pm2 save
pm2-installer
```

**办法二：任务计划程序**

1. 打开「任务计划程序」→「创建任务」
2. 触发器：登录时
3. 操作：启动程序，程序填 `pm2.cmd`，参数填 `resurrect`
4. 勾选「不管用户是否登录都运行」需要填密码

### 注意

- 项目路径别放在太深的目录，Windows 的路径长度限制（260）会让 npm 装包失败
- 中文路径一般没问题，但个别依赖（带 native 编译的）会挂，遇到就换纯英文路径
- 后台进程（`background: true`）在 Windows 上不用 `detached`，因为那会另开一个控制台窗口反而留不干净

---

## 三种平台都会自动降级的事

这些代码里已经处理好了，列出来是让你知道「为什么这里没生效」：

| 能力 | Linux | macOS/Windows |
|---|---|---|
| `ulimit -v` 限单命令内存 | 生效 | 跳过（日志里写「不限制单进程内存」） |
| 沙箱 | bwrap | 无，如实标注 |
| 内存预估 | 按 `/proc` 的可用量 × 75% | 按 `os.freemem()` × 75%（偏保守，会更早拦） |
| 后台命令 | `sh -c` | `cmd /c` |
| 文件权限 600 | 生效 | 忽略（Windows 没有这个语义，靠 NTFS ACL） |

---

## 排错

先跑体检，它会把平台、依赖、工具、密钥一次列清楚：

```bash
pnpm diagnose
```

再看启动日志第一屏，那里写着平台能力：

```bash
pm2 logs dafeiyu --lines 40 --nostream
```

| 现象 | 原因 |
|---|---|
| `未隔离（没装 bwrap）` | Linux 上没装 bubblewrap，跑 `sudo apt-get install -y bubblewrap` |
| `未隔离（参数自检没通过：…）` | bwrap 装了但参数跑不通，日志后面会带具体报错 |
| `pkexec` / `sudo` 要密码卡住 | 用 root 跑，或者手动装那几个包 |
| Windows 上 `ls` 报「不是内部或外部命令」 | 用 cmd 语法，见上面的对照表 |
| `pnpm: command not found` | `corepack enable` 或 `npm i -g pnpm` |
| 装完 ffmpeg 仍说没装 | 新开的终端才有 PATH，重开一个或重启 pm2 |
