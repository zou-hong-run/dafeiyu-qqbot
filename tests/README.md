# 测试

用 Node 内置的 `node:test`，**零依赖** —— 不用装 vitest / jest，`pnpm test` 直接跑。本地和服务器都能跑，不占内存。

## 跑

```bash
pnpm test                   # 全量
pnpm test:watch             # 改代码自动重跑
node --test tests/merge.test.js    # 单个文件
node --test --test-name-pattern="合并" tests/     # 按用例名筛
```

## 目录

```
tests/
  merge.test.js          连发合并：窗口、分用户、命令不合并、满 6 条提前冲
  ops.test.js            内存档位、平台能力探测、/clean 清理范围
  policy.test.js         高危工具名单、场景过滤、权限判断
  commands.test.js       命令注册表：匹配顺序、权限拦截、不误吞
  session-state.test.js  任务清单、选择题、静音与节流
  text-utils.test.js     工具标记清理、动作意图判断、输出截断
  shell-guard.test.js    shell 命令安全检查：全角/引号拼接绕过、敏感路径外传
  sandbox.test.js        bwrap 遮蔽参数：目录挂 tmpfs、文件盖 /dev/null、不存在的路径跳过
  mcp-guard.test.js      MCP 启动白名单：路径穿越、npx 包必须已安装、环境变量清空
```

## 写测试的几条约定

**1. 不碰真实数据**

这些模块会往 `data/` 落盘（任务清单、选择题、静音状态）。用例里一律用 `test:` 开头的独立 sessionKey，测完调对应的 `clearXxx` 清掉：

```js
const KEY = 'test:state-1'
writeTodos(KEY, [...])
// ...断言
clearTodos(KEY)
```

**2. 不依赖网络和模型**

单测只测纯逻辑：合并窗口、命令匹配、权限判断、档位计算。涉及模型调用、QQ 接口的一律不测（那是集成测试的事，需要真机）。

**3. 定时相关的用例用短窗口**

合并、节流这类有定时器的逻辑，测的时候传 `windowMs: 120` 这种小值，别让测试跑几秒。

**4. 破坏性操作要先断言「不该动的没动」**

`/clean` 会删文件，所以它的测试既要确认临时文件被删，也要确认 `scripts/`、`src/` 没被动 —— 这个 bug 真发生过：清理规则里误加了 `scripts`，把 `check-refs.js` 删掉了。

```js
assert.equal(fs.existsSync(tmpFile), false, '临时文件该删')
assert.equal(fs.existsSync('scripts/check-refs.js'), true, 'scripts 不该动')
```

**5. 断言失败时写清期望**

```js
assert.equal(memory.match('/memory list'), false, '/memory list 不该被 /memory 吃掉')
```

## 现在覆盖了什么

| 模块 | 覆盖点 |
|---|---|
| `chat/merge.js` | 窗口内合并、不同用户不合并、命令/附件立即处理、满 6 条提前冲、`clearMerged` / `flushMerged` |
| `ops/budget.js` | 四档划分、各档参数、运行时三态（blocked / light-only / normal） |
| `ops/platform.js` | 内存读取、平台能力探测、非 Linux 不给 ulimit |
| `ops/workspace.js` | 只清 tmp，不动 scripts / src |
| `config/policy.js` | 高危名单完整性、点歌画图不算高危、场景过滤 |
| `app/commands.js` | 15 个命令的匹配顺序、`adminOnly` 拦截、未知输入不认领 |
| `chat/todos.js` | 写入 / 进度 / 注入文本 / 过期提醒 / 全部完成后不提醒 |
| `chat/choices.js` | 回数字选中、用过失效、非数字和越界不算、少于两个选项不建 |
| `engage/quiet.js` | `oncePer` 节流、静音开关、时长夹取 |

## 没覆盖的（需要真机）

- 定时任务到点执行（`app/timers.js` 的完整链路）
- 群消息路由（`handleGroupAll` / `handleGroupAt`）
- 模型调用与工具循环（`chat/deepseek.js`）
- 媒体发送（需要 QQ 接口）
- 视频截取、字幕（依赖 yt-dlp / ffmpeg）

这些靠 `pnpm diagnose`（逐层自检）和真机验证，不是单测能解决的。

## 加新测试

新建 `tests/xxx.test.js`，按上面的约定写，`pnpm test` 会自动收进去。

如果要测一个会落盘的模块，先确认它有对应的 `clearXxx(key)` 导出 —— 没有就先加一个，否则测试会污染真实数据。
