import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { env } from './env.js'
import { runTaskAgent, verifyCompletion } from './deepseek.js'
import {
  createTicket,
  finishTicket,
  getTicket,
  markProgress,
  noteDelivery,
  noteStep,
  STATUS,
  updateTicket,
} from './ticket.js'

// Worker：只干活，不直接对用户说话
// 上下文按工单隔离（sessionKey 用 worker:<工单号>），结果统一交给 Router 交付
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const workersDir = path.join(projectRoot, 'tmp', 'workers')

const running = new Map()
const controllers = new Map()

const TOOL_LABELS = {
  search: '联网查资料',
  fetch: '读取网页正文',
  read_file: '查看文件',
  write_file: '写文件',
  list_dir: '看目录结构',
  shell: '执行命令',
  run_script: '执行脚本',
  restart_self: '重启服务',
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

function workerContext(ticketId) {
  const dir = path.join(workersDir, ticketId)
  try {
    fs.mkdirSync(dir, { recursive: true })
  } catch {
    // 目录建不出来也不影响跑，只是文件落在项目根
  }
  return { sessionKey: `worker:${ticketId}`, dir }
}

export function busyTasks(sessionKey) {
  return [...running.values()]
    .filter((worker) => !sessionKey || worker.ticket.sessionKey === sessionKey)
    .map((worker) => getTicket(worker.ticket.id) ?? worker.ticket)
}

export function taskStatus() {
  return [...running.values()].map((worker) => {
    const ticket = getTicket(worker.ticket.id) ?? worker.ticket
    return {
      id: ticket.id,
      sessionKey: ticket.sessionKey,
      step: ticket.step ?? 0,
      elapsed: Math.round((Date.now() - ticket.createdAt) / 1000),
      idle: Math.round((Date.now() - (ticket.progress?.at ?? ticket.createdAt)) / 1000),
    }
  })
}

// 订阅直通：工单跑着的时候，同一会话的新消息直接投给这个 Worker
export function submitInput(sessionKey, text) {
  const body = String(text ?? '').trim()
  if (!body) return null

  for (const [id, worker] of running) {
    if (worker.ticket.sessionKey !== sessionKey) continue
    worker.inputs.push(body.slice(0, 1000))
    return id
  }

  return null
}

export function killTask(id) {
  const key = String(id ?? '').trim()
  const controller = controllers.get(key)
  if (!controller) throw new Error(`工单 ${key} 没在运行，发 /tasks 看当前有哪些`)

  controller.abort()
  return key
}

export function startTask({
  sessionKey,
  scope,
  actor = '',
  goal,
  notify,
  tools,
  callTool,
  sendImage,
  audioSender,
  videoSender,
  fileSender,
  cardSender,
  speakSender,
  groupSender,
  groupsReader,
  gitSync,
  runAgent = runTaskAgent,
}) {
  if (busyTasks(sessionKey).length > 0) {
    throw new Error('这个会话已经有一个工单在跑了，等它结束再开新的')
  }
  if (running.size >= env.taskConcurrency) {
    throw new Error(`当前同时有 ${running.size} 个工单在跑，太多了，稍后再试`)
  }

  const target = (() => {
    const [type, ...rest] = String(sessionKey ?? '').split(':')
    return { type, id: rest.join(':') }
  })()

  const ticket = createTicket({ sessionKey, target, goal, actor, scope })
  const controller = new AbortController()
  const context = workerContext(ticket.id)

  // Router 的说话口子：Worker 只往这里丢消息，不关心发到哪
  const say = async (text) => {
    noteDelivery(ticket.id, text)
    await notify(text).catch(() => {})
  }

  running.set(ticket.id, { ticket, controller, context, inputs: [] })
  controllers.set(ticket.id, controller)
  updateTicket(ticket.id, { status: STATUS.running })

  let lastReportAt = Date.now()

  const onStep = async ({ round, tool }) => {
    const current = noteStep(ticket.id, round + 1, tool)
    if (!current) return

    if (tool === 'notify_user') return
    if (current.reports >= env.taskMaxReports) return
    if (current.step <= 1) return
    if (Date.now() - lastReportAt < env.taskReportInterval) return

    lastReportAt = Date.now()
    updateTicket(ticket.id, { reports: current.reports + 1 })
    await say(`工单 ${ticket.id}｜第 ${current.step} 步：${describeTool(tool)}`)
  }

  const pullInput = async () => {
    const worker = running.get(ticket.id)
    if (!worker) return []
    return worker.inputs.splice(0, worker.inputs.length)
  }

  const sendUserMessage = async (text) => {
    const current = getTicket(ticket.id)
    if (!current || current.deliveries.length >= 10) {
      return '这个工单已经主动发了不少条了，剩下的留到最终汇报。'
    }
    await say(text)
    return '已交给 Router 发送。'
  }

  const finished = (async () => {
    const history = []
    let answer = ''
    let lastNextStep = ''
    let passed = false

    try {
      for (let attempt = 1; attempt <= env.taskMaxContinuations + 1; attempt += 1) {
        if (controller.signal.aborted) throw new Error('工单已被中止')

        updateTicket(ticket.id, { attempts: attempt })

        const prompt =
          attempt === 1
            ? goal
            : `${goal}\n\n【上一轮进展】\n${history[history.length - 1] ?? ''}\n\n` +
              `【验收意见】${lastNextStep || '目标还没完成'}\n\n` +
              '继续推进，不要重复已经做完的部分。'

        console.log(`[Worker] ${ticket.id} 第 ${attempt} 轮开始`)

        answer = await runAgent({
          taskPrompt: prompt,
          scope,
          actor,
          tools,
          callTool,
          sendImage,
          audioSender,
          videoSender,
          fileSender,
          cardSender,
          speakSender,
          groupSender,
          groupsReader,
          gitSync,
          onStep,
          notifyUser: sendUserMessage,
          pullInput,
          signal: controller.signal,
          sessionKey: context.sessionKey,
          workdir: context.dir,
        })

        history.push(answer)
        markProgress(ticket.id)

        if (attempt > env.taskMaxContinuations) break

        const verdict = await verifyCompletion(goal, history.join('\n\n---\n\n'))
        if (verdict.done) {
          passed = true
          break
        }

        lastNextStep = verdict.nextStep
        console.log(`[Worker] ${ticket.id} 验收未过：${verdict.reason}`)
        await say(
          `工单 ${ticket.id} 第 ${attempt} 轮结束，验收没通过：${verdict.reason}\n继续推进（${attempt}/${env.taskMaxContinuations}）`,
        )
      }

      const seconds = Math.round((Date.now() - ticket.createdAt) / 1000)
      const tail = passed ? '' : `\n（自动续跑 ${env.taskMaxContinuations} 次仍未通过验收）`

      finishTicket(ticket.id, { status: STATUS.done, answer })
      await say(`工单 ${ticket.id} 完成，用时 ${seconds} 秒，共 ${ticket.step} 步${tail}\n\n${answer}`)
      return answer
    } catch (error) {
      if (controller.signal.aborted) {
        console.log(`[Worker] ${ticket.id} 被中止`)
        finishTicket(ticket.id, { status: STATUS.cancelled, error: '被用户中止' })
        await say(`工单 ${ticket.id} 已中止。`)
        return ''
      }

      console.error(`[Worker] ${ticket.id} 失败：`, error?.message ?? error)
      finishTicket(ticket.id, { status: STATUS.failed, error: String(error?.message ?? error) })
      await say(`工单 ${ticket.id} 失败：${error?.message ?? error}`)
      throw error
    } finally {
      running.delete(ticket.id)
      controllers.delete(ticket.id)
    }
  })()

  finished.catch(() => {})

  return { id: ticket.id, goal }
}
