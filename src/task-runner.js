import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { env } from './env.js'
import { runTaskAgent, verifyCompletion } from './deepseek.js'

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const dataDir = path.join(projectRoot, 'data')
const tasksFile = path.join(dataDir, 'active-tasks.json')

const running = new Map()
const controllers = new Map()
let seq = 0

const TOOL_LABELS = {
  search: '联网查资料',
  fetch: '读取网页正文',
  read_file: '查看文件',
  write_file: '写文件',
  list_dir: '看目录结构',
  shell: '执行命令',
  download: '下载文件',
  send_image: '发送图片',
  send_audio: '发送语音',
  send_video: '发送视频',
  weather: '查天气',
  exchange: '查汇率',
  calc: '做计算',
  timezone: '查时区',
  dns: '查域名',
  now: '看时间',
  install_package: '安装依赖',
  add_mcp: '注册新工具',
  write_skill: '写技能',
}

export function describeTool(name) {
  return TOOL_LABELS[name] ?? `调用 ${name}`
}

function targetFromSessionKey(sessionKey) {
  const [type, ...rest] = String(sessionKey ?? '').split(':')
  return { type, id: rest.join(':') }
}

function persistTasks() {
  try {
    fs.mkdirSync(dataDir, { recursive: true })
    const list = [...running.values()].map((task) => ({
      id: task.id,
      sessionKey: task.sessionKey,
      target: task.target,
      goal: task.goal,
      startedAt: task.startedAt,
      step: task.step,
    }))

    const tmp = `${tasksFile}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(list, null, 2))
    fs.renameSync(tmp, tasksFile)
  } catch (error) {
    console.error('[任务] 状态落盘失败：', error?.message ?? error)
  }
}

export function takeInterruptedTasks() {
  try {
    if (!fs.existsSync(tasksFile)) return []
    const list = JSON.parse(fs.readFileSync(tasksFile, 'utf8'))
    fs.rmSync(tasksFile, { force: true })
    return Array.isArray(list) ? list : []
  } catch {
    return []
  }
}

export function busyTasks(sessionKey) {
  return [...running.values()].filter((task) => task.sessionKey === sessionKey)
}

export function taskStatus() {
  const now = Date.now()
  return [...running.values()].map((task) => ({
    id: task.id,
    sessionKey: task.sessionKey,
    step: task.step ?? 0,
    elapsed: Math.round((now - task.startedAt) / 1000),
    idle: Math.round((now - (task.lastActivityAt ?? task.startedAt)) / 1000),
  }))
}

export function killTask(id) {
  const key = String(id ?? '').trim()
  const controller = controllers.get(key)
  if (!controller) throw new Error(`没有正在运行的任务 ${key}，发 /tasks 看当前有哪些`)

  controller.abort()
  return key
}

export function startTask({
  sessionKey,
  scope,
  goal,
  notify,
  tools,
  callTool,
  sendImage,
  audioSender,
  videoSender,
}) {
  if (busyTasks(sessionKey).length > 0) {
    throw new Error('这个会话已经有一个任务在跑了，等它结束再开新的')
  }
  if (running.size >= env.taskConcurrency) {
    throw new Error(`当前同时有 ${running.size} 个任务在跑，太多了，稍后再试`)
  }

  const id = `task-${++seq}`
  const controller = new AbortController()
  const record = {
    id,
    sessionKey,
    target: targetFromSessionKey(sessionKey),
    goal,
    startedAt: Date.now(),
    lastActivityAt: Date.now(),
    step: 0,
    reports: 0,
  }

  running.set(id, record)
  controllers.set(id, controller)
  persistTasks()

  let lastReportAt = Date.now()
  let stalledNotified = false
  let userMessages = 0

  const watchdog = setInterval(() => {
    if (!running.has(id)) {
      clearInterval(watchdog)
      return
    }

    const idle = Date.now() - record.lastActivityAt
    if (idle < env.taskStallMs || stalledNotified) return

    stalledNotified = true
    console.warn(`[任务] ${id} 停滞 ${Math.round(idle / 1000)} 秒`)
    notify(
      `任务 ${id} 已经 ${Math.round(idle / 1000)} 秒没有新进展，可能卡在某个命令上了。\n` +
        `发 /kill ${id} 可以终止它。`,
    ).catch(() => {})
  }, 30_000)
  watchdog.unref?.()

  const onStep = async ({ round, tool }) => {
    record.step = round + 1
    record.lastActivityAt = Date.now()
    stalledNotified = false
    persistTasks()

    if (tool === 'notify_user') return
    if (record.reports >= env.taskMaxReports) return
    if (record.step <= 1) return
    if (Date.now() - lastReportAt < env.taskReportInterval) return

    lastReportAt = Date.now()
    record.reports += 1

    await notify(`进行中｜第 ${record.step} 步：${describeTool(tool)}`).catch(() => {})
  }

  const sendUserMessage = async (text) => {
    if (userMessages >= 10) return '这个任务已经主动发了不少条了，剩下的留到最终汇报。'
    userMessages += 1
    await notify(text)
    return '已发送给对方。'
  }

  const finished = (async () => {
    try {
      const history = []
      let answer = ''
      let lastNextStep = ''
      let passed = false

      for (let attempt = 1; attempt <= env.taskMaxContinuations + 1; attempt += 1) {
        if (controller.signal.aborted) throw new Error('任务已被中止')

        const prompt =
          attempt === 1
            ? goal
            : `${goal}\n\n【上一轮进展】\n${history[history.length - 1] ?? ''}\n\n` +
              `【验收意见】${lastNextStep || '目标还没完成'}\n\n` +
              '继续推进，不要重复已经做完的部分。'

        console.log(`[任务] ${id} 第 ${attempt} 轮开始`)
        answer = await runTaskAgent({
          taskPrompt: prompt,
          scope,
          tools,
          callTool,
          sendImage,
          audioSender,
          videoSender,
          onStep,
          notifyUser: sendUserMessage,
          signal: controller.signal,
        })

        history.push(answer)
        record.lastActivityAt = Date.now()
        persistTasks()

        if (attempt > env.taskMaxContinuations) break

        const verdict = await verifyCompletion(goal, history.join('\n\n---\n\n'))
        if (verdict.done) {
          passed = true
          break
        }

        lastNextStep = verdict.nextStep
        console.log(`[任务] ${id} 第 ${attempt} 轮验收未过：${verdict.reason}`)
        await notify(
          `第 ${attempt} 轮结束，验收没通过：${verdict.reason}\n继续推进（${attempt}/${env.taskMaxContinuations}）`,
        ).catch(() => {})
      }

      const seconds = Math.round((Date.now() - record.startedAt) / 1000)
      const tail = passed ? '' : `\n（自动续跑 ${env.taskMaxContinuations} 次仍未通过验收）`
      await notify(`任务结束，用时 ${seconds} 秒，共 ${record.step} 步${tail}\n\n${answer}`).catch(
        () => {},
      )
      return answer
    } catch (error) {
      if (controller.signal.aborted) {
        console.log(`[任务] ${id} 被用户中止`)
        await notify(`任务 ${id} 已中止。`).catch(() => {})
        return ''
      }

      console.error(`[任务] ${id} 失败：`, error?.message ?? error)
      await notify(`任务失败：${error?.message ?? error}`).catch(() => {})
      throw error
    } finally {
      clearInterval(watchdog)
      running.delete(id)
      controllers.delete(id)
      persistTasks()
    }
  })()

  finished.catch(() => {})

  return { id, goal }
}
