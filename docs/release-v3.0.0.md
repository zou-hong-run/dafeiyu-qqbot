# v3.0.0 — 安全架构重做

这次不改功能，改边界。从「能跑命令的机器人」变成「命令跑在能说清楚边界的地方」。

三轮外部审计、五轮迭代，把「看起来有隔离」换成了「真的隔离，并且知道哪里没隔住」。

---

## 破坏性变更

升级前先看这三条，它们会让原来能跑的命令失败：

| 变更 | 原来 | 现在 |
|---|---|---|
| **沙箱断网** | 命令里出现 `curl`/`git`/`pnpm` 就放行网络 | 一律没网 |
| **可写目录** | 整个项目根可写 | 只有 `tmp/` |
| **密钥位置** | 项目根 `.env` | 推荐 `/etc/dafeiyu/env`（项目根仍兜底） |

因此这几件事改走专门工具：装包用 `install_package`、拉代码用 `git_sync`、下载用 `download`、联网查用 `search` / `fetch`、重启用 `restart_self`。

---

## 沙箱

`src/mcp-server/sandbox.js`，bwrap 参数：

```
--cap-drop ALL [--cap-add CAP_DAC_OVERRIDE]   默认不给任何能力
--unshare-pid --unshare-ipc --unshare-uts    看不见宿主其他进程
--unshare-net                                一律断网
--ro-bind / /                                整个根只读
--bind <项目根>/tmp <项目根>/tmp               只有 tmp/ 可写
--tmpfs <密钥目录> /root /home /www           敏感位置挂成空目录
--ro-bind-try /dev/null /etc/shadow ...      系统凭据盖成空设备
--clearenv --die-with-parent
```

几个关键判断：

- **不用 `--unshare-user`**：bwrap 的 user namespace 只映射一个 uid，属主不同的 inode 上 `CAP_DAC_OVERRIDE` 会失效。改成真 namespace + 按需补 capability
- **`CAP_DAC_OVERRIDE` 按属主决定**：项目目录 `chown` 给运行用户后自动不加
- **自检 fail-closed**：装了 bwrap 但探针跑不过，命令直接拒绝执行，不降级成裸跑
- **探针落在 `tmp/`**：项目根只读，探针写那里必然误判

---

## 权限

| 层 | 做什么 |
|---|---|
| `ADMIN_OPENIDS` | 13 个高危工具的白名单，不在名单里的人模型连工具名都看不见 |
| `policy.js` | 场景过滤（私聊/群聊）、读写属性、危险工具集合 |
| MCP 白名单 | `node tools/*.js` 或已安装的 `npx`，路径先 `path.resolve` 再判是否真在 `tools/` 内 |
| 密钥隔离 | 只有内置 MCP 服务拿到模型 key，第三方服务拿不到 |

---

## 出网校验

`src/mcp-server/net-guard.js`，download 和视频工具共用：

- 内网段、云元数据段、IPv4 映射的 IPv6 一律拒
- `redirect: 'manual'` 逐跳复核，最多 5 跳，环状重定向掐断
- 域名解析结果也过一遍 IP 规则，挡 `127.0.0.1.nip.io` 这类

代码层总有绕法（DNS rebinding 的时序窗口），所以 README 里给了宿主机防火墙的封禁命令——那才是硬边界。

---

## 其他修复

这轮顺带挖出一批「异常被 `catch` 吞掉 → 功能静默消失」的问题：

- `list_groups`、`broadcast`、主动接话扫描、`/config` 的内存显示全部因为漏了 `import fs` 而恒返回空
- `pnpm check` 补上第三类检查：用了 `fs.` / `path.` 这类 Node 模块别名却没 `import`
- pm2 启动时补齐 PATH，修 Debian 下 `/usr/local/bin` 不在 PATH 导致 `yt-dlp` 找不到

---

## 测试

89 个用例，`node:test` 零依赖：

```bash
pnpm test    # 约 1.5 秒
pnpm check   # 静态引用检查
```

安全相关的四组：命令黑名单归一化、MCP 启动白名单（含路径穿越）、沙箱遮蔽参数、出网地址校验。

---

## 升级

```bash
cd /qq && git pull --rebase origin main
node scripts/bootstrap.js --check     # 看有没有缺的
pm2 delete dafeiyu && pm2 start ecosystem.config.cjs && pm2 save
```

启动日志确认这两行：

```
[平台] linux｜ulimit 可用｜bwrap 沙箱已启用
[启动] 正在连接 QQ 开放平台（AppID: ...）
```

---

## 已知取舍

写在 README 第一屏，不藏：

1. **`CAP_DAC_OVERRIDE` 在 root 部署下仍生效** —— 沙箱内能读 `/etc` 下没遮到的文件。根治要非 root 跑 pm2
2. **宿主侧工具不受沙箱约束** —— `write_file` 能改 `src/`、`add_mcp` 能起新进程，这是「自己进化」的前提
3. **审计没覆盖所有路径** —— 定时任务和工单里的工具调用不记 `audit.log`

再加一条这轮新发现的：**yt-dlp 是外部进程，自己跟 302**，net-guard 的逐跳管不到它。三个视频工具都是 `READ_ONLY`。要收紧就加站点白名单或收进 `DANGEROUS_TOOLS`。
