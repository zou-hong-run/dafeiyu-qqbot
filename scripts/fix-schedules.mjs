// 一次性数据修复：把旧的定时任务整理成这一版的写法。
//
// 做的事：
//   1. 删掉寓言故事任务（群里两个重复的 + 私聊一个），它们会在 21:30 同时发两遍
//   2. 早报 / 抽签 / 节日三个任务的 prompt 改成 markdown 版
//      （旧 prompt 里写死了「纯文本，禁止 Markdown」，而这一版默认开 markdown）
//   3. 改之前先备份原文件
//
// 用法：node scripts/fix-schedules.mjs [--dry]
// 改完要 pm2 restart 才生效——调度器是启动时把任务读进内存的。

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const dataDir = process.env.APP_DATA_DIR?.trim() || path.join(projectRoot, 'data')
const scheduleFile = path.join(dataDir, 'schedules.json')

const dry = process.argv.includes('--dry')

// 用内容特征匹配，不依赖 id：用户可能是从某个 .bak 里恢复的，id 不一定对得上
const PATCHES = [
  {
    name: '早报',
    match: (text) => text.includes('热点新闻'),
    prompt: `每天早上 8:30 推送热点新闻。

步骤：
1. 用 search 检索当天国内科技/互联网热点，可以分别搜「今日热点新闻」「科技新闻 今天」，取最新结果。
2. 挑 5 到 8 条最值得看的，每条一句话概括，不要照抄长段摘要。
3. 开头一行写日期，例如：**11月7日 早报**
4. 每条按 1. 2. 3. 编号，新闻标题用 **加粗**，正文一行说完。
5. 重要新闻后面附 markdown 链接，格式 [来源名](网址)。search 的返回里已经给好可以直接复制的整行，原样抄过来，别自己重拼。
6. 用 markdown 排版：加粗、编号列表、链接。不要用 # 标题、代码块、表格——QQ 不渲染这些，只会露出原始符号。
7. 搜不到或工具失败就直说没查到，不要编造新闻。`,
  },
  {
    name: '抽签',
    match: (text) => text.includes('赛博抽签'),
    prompt: `每天 9:00 做一次群友赛博抽签。

步骤：
1. 调用 group_recent_speakers（days=7，limit=30）拿最近 7 天在本群发过言的群友，排除我自己。group_id 系统会自动注入，不用传。
2. 用 shell 随机挑一位：把候选昵称一行一个写进临时文件，用 shuf -n1 取一行；沙箱里没有 shuf 就用 node -e 取一次随机下标。不要凭感觉挑。
3. 用 kun_fortune 工具按这位群友的昵称抽签。
4. 整理成一条 markdown 消息发到本群：

**【今日群友赛博抽签】**
- 主角：**昵称**
- 运势：**末吉 · 43 分**
- 幸运数字：55
- 幸运颜色：薄荷绿
- 今日建议：一句话

要求：简洁、语气日常，总长不超过 150 字。用加粗和列表，不要 # 标题、代码块、表格。
5. 如果 group_recent_speakers 返回没人发言，就说明今天群里太安静，改为抽我自己，不要编造人名。`,
  },
  {
    name: '节日节气',
    match: (text) => text.includes('节日') && text.includes('节气'),
    prompt: `每天 9:05 生成今日节日节气报告，发到本群。

内容：
1. 今天是什么节日/纪念日，或当前是否处于某个节气当天（24 节气）。
2. 未来 7 天内即将到来的节日和节气，标注具体日期和星期。
3. 临近法定节假日就附上调休安排。

要求：
- 用 search 查准确的 2026 年节假日与节气日期，不要凭记忆编造。
- 输出 markdown：关键日期用 **加粗**，条目用 - 列表。
- 不要 # 标题、代码块、表格。
- 总长不超过 200 字。`,
  },
]

const FABLE = /寓言/

function readTasks() {
  try {
    const raw = JSON.parse(fs.readFileSync(scheduleFile, 'utf8'))
    return Array.isArray(raw) ? raw : null
  } catch (error) {
    console.error(`读不到任务文件（${scheduleFile}）：${error?.message ?? error}`)
    return null
  }
}

const tasks = readTasks()
if (!tasks) {
  console.error('先确认 data/schedules.json 存在且是合法 JSON。如果它是空的，先用 .bak 文件恢复再跑这个脚本。')
  process.exit(1)
}

if (tasks.length === 0) {
  console.error('任务文件是空的。先用备份恢复：cp data/schedules.json.bakXXXX data/schedules.json，再跑这个脚本。')
  process.exit(1)
}

const kept = []
const removed = []
const patched = []

for (const task of tasks) {
  const prompt = String(task.prompt ?? '')

  if (FABLE.test(prompt)) {
    removed.push(`${task.id}｜${task.cron}｜${prompt.slice(0, 20)}…`)
    continue
  }

  const patch = PATCHES.find((item) => item.match(prompt))
  if (patch) {
    task.prompt = patch.prompt
    patched.push(`${task.id}｜${patch.name}`)
  }

  kept.push(task)
}

console.log(`原有 ${tasks.length} 个任务`)
console.log(`删除 ${removed.length} 个：`)
for (const line of removed) console.log(`  - ${line}`)
console.log(`改写 ${patched.length} 个 prompt：`)
for (const line of patched) console.log(`  - ${line}`)
console.log(`保留 ${kept.length} 个任务`)

if (kept.length === 0) {
  console.error('全部任务都被删了，这不像预期结果，什么都没写。')
  process.exit(1)
}

if (dry) {
  console.log('\n--dry：只看结果，没有写文件')
  process.exit(0)
}

const backup = `${scheduleFile}.bak-before-fix-${Date.now()}`
fs.copyFileSync(scheduleFile, backup)
fs.writeFileSync(scheduleFile, `${JSON.stringify(kept, null, 2)}\n`)

console.log(`\n已写入 ${scheduleFile}`)
console.log(`原文件备份到 ${path.basename(backup)}`)
console.log('重启才生效：pm2 restart dafeiyu')
