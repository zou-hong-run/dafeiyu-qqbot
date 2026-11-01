// 兼容层：对外接口不变，内部已换成「工单 + Worker」两层
// 旧代码里的 startTask / taskStatus 等调用不用改，Router 只认工单
import { recoverTickets } from './ticket.js'
import { busyTasks, describeTool, killTask, startTask, taskStatus } from './worker.js'

export { startTask, busyTasks, taskStatus, describeTool, killTask }

// 进程重启后，把上次没跑完的工单收上来交给 Router 通知用户
export function takeInterruptedTasks() {
  return recoverTickets().map((ticket) => ({
    id: ticket.id,
    target: ticket.target,
    goal: ticket.goal,
    step: ticket.step ?? 0,
  }))
}
