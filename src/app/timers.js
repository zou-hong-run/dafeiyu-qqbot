import { env } from '../config/env.js'
import * as groupLog from '../memory/group-log.js'
import { findCandidates, formatCandidates, noteProactive, shouldProactive } from '../engage/proactive.js'
import { generateHotTake } from '../engage/hot-takes.js'
import { isMuted, oncePer, QUIET_MS } from '../engage/quiet.js'
import { dueFollowUps, markFollowedUp } from '../memory/situations.js'
import { followUpMessage, proactiveReply, runTaskAgent } from '../chat/deepseek.js'
import { callTool, syncRegistry } from '../mcp/client.js'
import { audioSenderFor, imageSenderFor, speakSenderFor, videoSenderFor } from '../channel/media.js'
import { knowledgePrompt } from '../memory/knowledge.js'
import { describeTool } from '../tasks/task-runner.js'
import {
  broadcastSenderFor,
  gitSyncFor,
  groupSenderFor,
  groupsReaderFor,
  historyReaderForGroup,
  notifierFor,
  profileReaderFor,
  schedulerForTarget,
  sendToTarget,
  toolsForScope,
} from './factories.js'

export async function runScheduledTask(task) {
  const scope = task.target.type === 'group' ? 'group' : 'private'

  try {
    await syncRegistry()
  } catch (error) {
    console.error('[定时] 同步工具注册表失败：', error?.message ?? error)
  }

  // 定时任务没有 event，所有发送走主动消息
  const send = (payload) => sendToTarget(task.target, payload)
  const sessionKey = `${task.target.type}:${task.target.id}`
  // 让 send_to_group 知道「当前群」是哪个：没有它就传 current 会报「没指定群」
  const currentEvent = task.target.type === 'group' ? { group_id: task.target.id } : null

  return runTaskAgent({
    taskPrompt: task.prompt,
    scope,
    actor: 'scheduler',
    // 必须显式告诉模型这条任务跑在群里还是私聊，否则它会自己猜，猜错就说「当前是私聊」
    environment:
      task.target.type === 'group'
        ? `当前在 QQ 群聊（群 openid ${task.target.id}），你的回复会用主动消息直接发到这个群，读群记录、往群里发东西都是这个群`
        : `当前是私聊（用户 openid ${task.target.id}），消息直接发给这个用户`,
    tools: toolsForScope(scope, 'scheduler'),
    callTool: (name, args) => callTool(name, args, env.toolTimeoutMs),
    sendImage: imageSenderFor(null, send),
    audioSender: audioSenderFor(null, send),
    videoSender: videoSenderFor(null, send),
    speakSender: speakSenderFor(null, send),
    scheduler: schedulerForTarget(sessionKey, task.target),
    historyReader: historyReaderForGroup(task.target.type === 'group' ? task.target.id : ''),
    profileReader: profileReaderFor({ target: task.target }),
    groupSender: groupSenderFor(currentEvent),
    broadcastSender: broadcastSenderFor(currentEvent),
    groupsReader: groupsReaderFor(),
    gitSync: gitSyncFor(),
  })
}

export function progressReporter(event) {
  const notify = notifierFor(event)
  const isGroup = event.message_type === 'group'
  const groupId = event.group_id
  let lastAt = Date.now()
  let count = 0

  return async ({ round, tool }) => {
    if (round < 1) return

    // 群里「还在处理」最招人烦：一轮最多一条，而且是卡了 45 秒才说一句
    const max = isGroup ? 1 : env.progressMax
    if (count >= max) return
    if (isGroup && !oncePer(`progress:${groupId}`, QUIET_MS.progress)) return
    if (Date.now() - lastAt < env.progressInterval) return

    lastAt = Date.now()
    count += 1
    await notify(
      isGroup ? `还在弄，稍等（正在${describeTool(tool)}）` : `还在处理｜第 ${round + 1} 步：${describeTool(tool)}`,
    )
  }
}

// 主动扫描：没人叫它的时候，自己去翻群记录，看有没有值得接的问题
export async function runProactiveScan() {
  if (!env.proactive.enabled) return

  const ids = groupLog.listGroups().map((group) => group.id)
  if (ids.length === 0) return

  for (const groupId of ids) {
    try {
      if (isMuted(groupId)) continue
      if (!oncePer(`proactive:${groupId}`, QUIET_MS.proactive)) continue

      const candidates = findCandidates(groupId)
      const decision = shouldProactive(groupId, candidates)
      if (!decision.ok) continue

      const answer = await proactiveReply({
        transcript: formatCandidates(candidates),
        knowledge: knowledgePrompt(groupId),
        personaName: env.personaName,
      })

      if (!answer) continue

      noteProactive(groupId, candidates[candidates.length - 1].c)
      await sendToTarget({ type: 'group', id: groupId }, answer)

      groupLog.record(groupId, {
        t: Date.now(),
        u: 'bot',
        n: env.personaName,
        c: answer.replace(/\s+/g, ' ').slice(0, 200),
        id: `bot-${Date.now()}`,
      })

      console.log(`[主动] ${groupId.slice(0, 12)}… 插了一句：${answer.slice(0, 40)}`)
    } catch (error) {
      console.warn(`[主动] ${groupId.slice(0, 12)}… 失败：`, error?.message ?? error)
    }
  }
}

// 回访：之前记下的「还在进行中的事」，隔几小时主动问一句
export async function runFollowUps() {
  if (!env.followup.enabled) return

  const hour = new Date().getHours()
  const quietStart = env.followup.quietStart
  const quietEnd = env.followup.quietEnd
  if (quietStart > quietEnd ? hour >= quietStart || hour < quietEnd : hour >= quietStart && hour < quietEnd) return

  const minAgeHours = env.followup.minAgeHours
  const due = dueFollowUps({ minAgeMs: minAgeHours * 3600_000, limit: 1 })
  if (due.length === 0) return

  for (const item of due) {
    try {
      const [type, ...rest] = item.sessionKey.split(':')
      const id = rest.join(':')
      if (!id) continue

      // 被喊安静了的群，回访也先停：人家不想被打扰
      if (type === 'group' && isMuted(id)) {
        markFollowedUp(item.sessionKey, item.id)
        continue
      }

      const text = await followUpMessage({
        person: item.person,
        topic: item.topic,
        mood: item.mood,
        since: `${Math.round((Date.now() - item.at) / 3600_000)} 小时前`,
        personaName: env.personaName,
      })

      // 生成了空串就是判断不该提，标记掉别每次都重算
      markFollowedUp(item.sessionKey, item.id)
      if (!text) continue

      await sendToTarget({ type: type === 'group' ? 'group' : 'user', id }, text)

      if (type === 'group') {
        groupLog.record(id, {
          t: Date.now(),
          u: 'bot',
          n: env.personaName,
          c: text.replace(/\s+/g, ' ').slice(0, 200),
          id: `bot-${Date.now()}`,
        })
      }

      console.log(`[回访] ${item.sessionKey.slice(0, 16)}… 提起「${item.topic.slice(0, 20)}」：${text.slice(0, 40)}`)
    } catch (error) {
      console.warn('[回访] 失败：', error?.message ?? error)
    }
  }
}

// 选择题：QQ 官方按钮要开放平台预建模板，机器人自己造不出来，
// 所以用「编号选项 + 回数字」实现同样的交互
// 热点吐槽：自己去搜当天新闻，挑一条在群里说两句
function pickActiveGroup() {
  if (env.hotTake.target) return env.hotTake.target

  try {
    const files = groupLog.listGroups().sort((a, b) => b.mtime - a.mtime)

    // 太久的群不提，说明没人说话了
    if (files.length === 0) return ''
    if (Date.now() - files[0].mtime > 7 * 86400_000) return ''
    return files[0].id
  } catch {
    return ''
  }
}

export async function runHotTake() {
  if (!env.hotTake.enabled) return

  const groupId = pickActiveGroup()
  if (!groupId) {
    console.log('[热点] 找不到活跃的群，跳过')
    return
  }

  if (isMuted(groupId)) {
    console.log('[热点] 那个群被喊安静了，跳过')
    return
  }
  if (!oncePer(`hot-take:${groupId}`, QUIET_MS.hotTake)) return

  const take = await generateHotTake({ personaName: env.personaName })
  if (!take) return

  try {
    await sendToTarget({ type: 'group', id: groupId }, take.text)

    groupLog.record(groupId, {
      t: Date.now(),
      u: 'bot',
      n: env.personaName,
      c: take.text.replace(/\s+/g, ' ').slice(0, 200),
      id: `bot-${Date.now()}`,
    })

    console.log(`[热点] ${groupId.slice(0, 12)}… 吐槽「${take.topic}」：${take.text.slice(0, 40)}`)
  } catch (error) {
    console.warn('[热点] 发送失败：', error?.message ?? error)
  }
}

