import { env } from './env.js'
import { activeTickets, getTicket, noteDelivery, STATUS } from './ticket.js'

// 外部控制回路：不参与执行，只站在外面看工单有没有真的在往前走
// 文章里 Watchdog 除了看接口报错，还要判断 Worker 是否陷入无效循环
const TIMER_MS = 30_000

let timer = null
let notify = async () => {}
let abortTicket = () => false
let started = false

const warned = new Map()

function warnOnce(ticketId, kind) {
  const key = `${ticketId}:${kind}`
  const last = warned.get(key) ?? 0
  if (Date.now() - last < 10 * 60_000) return false

  warned.set(key, Date.now())
  if (warned.size > 200) {
    for (const item of [...warned.keys()].slice(0, 100)) warned.delete(item)
  }
  return true
}

async function inspect(ticket) {
  if (ticket.status !== STATUS.running) return

  const idle = Date.now() - (ticket.progress?.at ?? ticket.updatedAt ?? ticket.createdAt)

  // 1) 长时间没有新动作：可能卡在某个命令上
  if (idle > env.taskStallMs && warnOnce(ticket.id, 'stall')) {
    console.warn(`[巡检] ${ticket.id} 停滞 ${Math.round(idle / 1000)} 秒`)
    await notify(
      ticket.target,
      `工单 ${ticket.id} 已经 ${Math.round(idle / 1000)} 秒没有新进展，可能卡在某个命令上了。\n` +
        `发 /kill ${ticket.id} 可以终止它，或者等它自己缓过来。`,
    ).catch(() => {})
    return
  }

  // 2) 反复调同一个工具：无效循环，直接掐掉比继续烧 token 划算
  const streak = ticket.progress?.streak ?? 0
  if (streak >= 4 && warnOnce(ticket.id, 'loop')) {
    console.warn(`[巡检] ${ticket.id} 连续 ${streak} 次调用 ${ticket.progress.signature}，判为无效循环`)
    const stopped = abortTicket(ticket.id)
    await notify(
      ticket.target,
      `工单 ${ticket.id} 连续 ${streak + 1} 次卡在「${ticket.progress.signature}」上，像是陷入无效循环，已经中止。\n` +
        (stopped ? '换个说法或缩小范围再提一次会更快。' : '但没找到可中止的执行单元，可能已经自己结束了。'),
    ).catch(() => {})
  }
}

async function tick() {
  const running = activeTickets().filter((ticket) => ticket.status === STATUS.running)
  for (const ticket of running) {
    try {
      await inspect(ticket)
    } catch (error) {
      console.error('[巡检] 检查失败：', error?.message ?? error)
    }
  }
}

export function startWatchdog({ send, abort }) {
  if (started) return
  started = true

  notify = typeof send === 'function' ? send : async () => {}
  abortTicket = typeof abort === 'function' ? abort : () => false

  timer = setInterval(() => {
    tick().catch(() => {})
  }, TIMER_MS)
  timer.unref?.()

  console.log(`[巡检] 已启动，每 ${TIMER_MS / 1000} 秒看一次运行中的工单`)
}

export function stopWatchdog() {
  if (timer) clearInterval(timer)
  timer = null
  started = false
}

export function watchdogSnapshot() {
  return activeTickets()
    .filter((ticket) => ticket.status === STATUS.running)
    .map((ticket) => {
      const full = getTicket(ticket.id)
      return {
        id: full.id,
        step: full.step,
        idle: Math.round((Date.now() - (full.progress?.at ?? full.createdAt)) / 1000),
        streak: full.progress?.streak ?? 0,
      }
    })
}
