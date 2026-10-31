import { env } from './env.js'
import { runTaskAgent } from './deepseek.js'

const running = new Map()
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

function describeTool(name) {
  return TOOL_LABELS[name] ?? `调用 ${name}`
}

export function busyTasks(sessionKey) {
  return [...running.values()].filter((task) => task.sessionKey === sessionKey)
}

export function taskStatus() {
  return [...running.values()].map((task) => ({
    id: task.id,
    sessionKey: task.sessionKey,
    step: task.step ?? 0,
    elapsed: Math.round((Date.now() - task.startedAt) / 1000),
  }))
}

export function startTask({ sessionKey, scope, goal, notify, tools, callTool, sendImage, audioSender }) {
  if (busyTasks(sessionKey).length > 0) {
    throw new Error('这个会话已经有一个任务在跑了，等它结束再开新的')
  }
  if (running.size >= env.taskConcurrency) {
    throw new Error(`当前同时有 ${running.size} 个任务在跑，太多了，稍后再试`)
  }

  const id = `task-${++seq}`
  const record = { id, sessionKey, goal, startedAt: Date.now(), step: 0, reports: 0 }
  running.set(id, record)

  let lastReportAt = Date.now()

  const onStep = async ({ round, tool }) => {
    record.step = round + 1

    if (record.reports >= env.taskMaxReports) return
    if (record.step <= 1) return
    if (Date.now() - lastReportAt < env.taskReportInterval) return

    lastReportAt = Date.now()
    record.reports += 1

    await notify(`进行中｜第 ${record.step} 步：${describeTool(tool)}`).catch(() => {})
  }

  const finished = (async () => {
    try {
      const answer = await runTaskAgent({
        taskPrompt: goal,
        scope,
        tools,
        callTool,
        sendImage,
        audioSender,
        onStep,
      })

      const seconds = Math.round((Date.now() - record.startedAt) / 1000)
      await notify(`任务完成，用时 ${seconds} 秒，共 ${record.step} 步\n\n${answer}`).catch(() => {})
      return answer
    } catch (error) {
      console.error(`[任务] ${id} 失败：`, error?.message ?? error)
      await notify(`任务失败：${error?.message ?? error}`).catch(() => {})
      throw error
    } finally {
      running.delete(id)
    }
  })()

  finished.catch(() => {})

  return { id, goal }
}
