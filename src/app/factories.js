import { bot } from '../bot.js'
import { env } from '../config/env.js'
import * as groupLog from '../memory/group-log.js'
import { clip, withSendRetry } from '../channel/sender.js'
import { sendMediaToGroup } from '../channel/media.js'
import { noteSentToGroup } from '../channel/recall.js'
import { audit, auditKeyOf } from './audit.js'
import { chunkText } from '../channel/sender.js'
import { formatProfile } from '../memory/profiles.js'
import { commitAndPush, describeStatus, pullLatest } from '../ops/sync.js'
import { filterTools } from '../config/policy.js'
import { getTools, toDeepSeekTools } from '../mcp/client.js'
import { addSchedule, listSchedules, removeSchedule } from '../tasks/scheduler.js'
import { putChoice, choiceText } from '../chat/choices.js'
import { sendReply } from '../channel/sender.js'

export function referencedContext(event) {
  const groupId = event?.group_id
  if (!groupId) return ''

  for (const elem of event?.message ?? []) {
    if (elem?.type !== 'reply') continue

    const refId = elem.data?.id
    if (!refId) continue

    const found = groupLog.findByRef(groupId, refId)
    if (found) {
      const who = found.n || `用户${String(found.u ?? '').slice(-4)}`
      const quoted = String(found.c ?? '').slice(0, 120)
      return '\n\n（这句是在回复 ' + who + ' 的这条消息：「' + quoted + '」）'
    }

    return '\n\n（这句引用了某条消息，但那条不在我的本地记录里，可能是我加入之前的）'
  }

  return ''
}

// 让模型自己把改动提交回仓库，或者拉取最新代码
export function gitSyncFor() {
  return async ({ mode = 'status', reason = '' } = {}) => {
    const action = String(mode).toLowerCase()

    if (action === 'status') return describeStatus()

    if (action === 'push') {
      const result = await commitAndPush(
        reason ? `auto sync: ${String(reason).slice(0, 60)}` : 'auto sync: 手动推送',
      )
      if (result.skipped) return `没有需要同步的改动（${result.reason}）`
      if (result.pushed) return `已提交并推送 ${result.files} 个文件到 ${result.branch}`
      return `已本地提交 ${result.files} 个文件，但推送失败：${result.reason}`
    }

    if (action === 'pull') {
      const result = await pullLatest()
      if (!result.ok) throw new Error(result.reason)
      const detail = result.output ? `：\n${result.output}` : ''
      return `已拉取 ${result.branch} 的最新代码${detail}\n改完记得重启才生效`
    }

    throw new Error(`不认识的 mode：${mode}，只能是 status / push / pull`)
  }
}

// 主动往别的群发消息：私聊里也能把话送到指定的群
export function groupSenderFor(event) {
  const currentGroup = event?.group_id

  return async (input) => {
    const target = String(input?.groupId ?? '').trim()
    const text = String(input?.text ?? '').trim()
    const mediaPath = String(input?.path ?? '').trim()

    // 带 path 就是发文件（图片/视频/语音/其他），不带就是发文本
    if (mediaPath) {
      const groupId = !target || target === 'current' ? currentGroup : target
      if (!groupId) throw new Error('没指定群：私聊里发文件要传 groupId（群 openid，不是 QQ 群号）')

      const result = await sendMediaToGroup(groupId, mediaPath, { fileName: input?.fileName })
      console.log(
        `[主动发送] 已发${result.kind}到群 ${groupId.slice(0, 12)}…（${result.name}，${result.sizeMB}MB）`,
      )
      audit(auditKeyOf(event), 'send_to_group', { groupId, media: result.name }, `已发送${result.kind}`)
      return { groupId, kind: result.kind, name: result.name, sizeMB: result.sizeMB }
    }

    if (!text) throw new Error('缺少要发送的内容：文字放 text，文件放 path')
    if (text.length > 2000) throw new Error(`内容 ${text.length} 字，太长了，压到 2000 字以内`)

    const groupId = !target || target === 'current' ? currentGroup : target
    if (!groupId) throw new Error('没指定群，也没法确定当前群：私聊里要传 groupId')

    const result = await bot.group(groupId).send(clip(text))
    noteSentToGroup(groupId, result?.id, text, 'text')
    console.log(`[主动发送] 已发往群 ${groupId.slice(0, 12)}…（${text.length} 字）`)

    audit(auditKeyOf(event), 'send_to_group', { groupId, chars: text.length }, `已发送 ${text.length} 字`)

    return { groupId, chars: text.length, messageId: result?.id ?? '' }
  }
}

// 全服通报：把同一条消息推给所有待过的群，默认跳过当前群
export function broadcastSenderFor(event) {
  const currentGroup = event?.group_id

  return async (input) => {
    const text = String(input?.text ?? '').trim()
    if (!text) throw new Error('缺少要通报的内容')
    if (text.length > 2000) throw new Error(`内容 ${text.length} 字，太长了，压到 2000 字以内`)

    let ids = groupLog.listGroups().map((group) => group.id)

    const only = Array.isArray(input?.targets) ? input.targets.map(String) : []
    if (only.length > 0) ids = ids.filter((id) => only.includes(id))
    if (!input?.includeCurrent && currentGroup) ids = ids.filter((id) => id !== currentGroup)

    if (ids.length === 0) return { total: 0, sent: [], failed: [] }
    if (input?.dryRun) return { total: ids.length, sent: [], failed: [], dryRun: true, targets: ids }

    // 群多的时候强制先预演一次：全服通报发错很难收回
    const needConfirm = ids.length > 3 && input?.confirm !== true
    if (needConfirm) {
      return { total: ids.length, sent: [], failed: [], dryRun: true, targets: ids, needConfirm: true }
    }

    // 通报正文可能超过单条上限，按句子边界切开逐段发，别用 clip 截断
    const parts = chunkText(text).slice(0, 3)
    const sent = []
    const failed = []

    for (const groupId of ids) {
      try {
        for (let i = 0; i < parts.length; i += 1) {
          if (i > 0) await new Promise((resolve) => setTimeout(resolve, 600))
          await bot.group(groupId).send(parts[i])
        }
        sent.push(groupId)
      } catch (error) {
        failed.push(`${groupId}：${error?.message ?? error}`)
      }
      await new Promise((resolve) => setTimeout(resolve, 900))
    }

    console.log(`[全服通报] 成功 ${sent.length}/${ids.length} 个群，每个 ${parts.length} 段`)

    audit(
      auditKeyOf(event),
      'broadcast',
      { targets: ids.length, chars: text.length, parts: parts.length },
      `成功 ${sent.length}/${ids.length}${failed.length ? `，失败 ${failed.length}` : ''}`,
    )

    return { total: ids.length, sent, failed, parts: parts.length }
  }
}

// 列出机器人待过的群，模型用它找 groupId
export function groupsReaderFor() {
  return async () => {
    const ids = groupLog.listGroups().map((group) => group.id)

    if (ids.length === 0) return '还没有群聊记录，等群里有消息进来才有。'

    const lines = ids.map((groupId) => {
      const info = groupLog.statsOf(groupId)
      const last = info.to ?? '-'
      return `${groupId}｜${info.count} 条｜最近 ${last}`
    })

    return (
      `待过的群（${ids.length} 个）：\n${lines.join('\n')}\n\n` +
      '发消息用 send_to_group，groupId 传上面那串。'
    )
  }
}

// 给模型读当前群聊记录用：只读本群，不跨群
export function historyReaderForGroup(groupId) {
  if (!groupId) return null

  return async (limit, mode) => {
    const count = Math.min(Math.max(Number(limit) || 30, 5), 200)
    const entries = groupLog.recent(groupId, count)

    if (entries.length === 0) {
      return (
        '这个群还没有任何聊天记录。' +
        '如果刚拉我进来，可能是群没开「机器人可获取的群聊消息范围 = 获取群内全部消息」，' +
        '那种情况下我只能看到 @ 我的消息。'
      )
    }

    const info = groupLog.statsOf(groupId)

    if (String(mode) === 'people') {
      const people = new Map()
      for (const entry of entries) {
        const id = String(entry.u ?? '')
        if (!id || id === 'bot') continue
        const current = people.get(id) ?? { name: '', count: 0 }
        current.count += 1
        if (entry.n) current.name = entry.n
        people.set(id, current)
      }

      const list = [...people.entries()].sort((a, b) => b[1].count - a[1].count)
      const lines = list.map(
        ([id, info], index) =>
          `${index + 1}. ${info.name || `用户${id.slice(-4)}`}（${info.count} 条） openid: ${id}`,
      )
      return `当前群最近 ${entries.length} 条记录里出现过 ${list.length} 个人（后面那串 openid 是 @ 人用的）：\n${lines.join('\n')}`
    }

    const table = groupLog.memberTable(entries)
    const tableBlock = table.length > 0 ? `\n\n【本群成员对照】（要 @ 谁就用后面这串 openid）\n${table.join('\n')}` : ''

    return (
      `当前群最近 ${entries.length} 条（库里共 ${info.count} 条，最早 ${info.from ?? '-'}）：\n` +
      groupLog.formatForSummary(entries) +
      tableBlock
    )
  }
}

// 群成员画像：只能看当前群
export function profileReaderFor(event) {
  const groupId = event?.group_id ?? event?.target?.id ?? ''
  if (!groupId) return null

  return async (member) => formatProfile(String(groupId), member ?? '')
}

// 按 target 主动发消息（定时任务、跨群播报都用它，不依赖 event）
export function sendToTarget(target, payload) {
  if (target?.type === 'group') {
    return withSendRetry(() => bot.group(target.id).send(payload), '主动群消息')
  }
  return withSendRetry(() => bot.user(target.id).send(payload), '主动私聊消息')
}

// 主对话用：从 event 取群 id
export function historyReaderFor(event) {
  return historyReaderForGroup(event?.group_id)
}

export function sessionKeyOf(event) {
  return event.message_type === 'group' ? `group:${event.group_id}` : `user:${event.user_id}`
}

// 群里被 @ 的判定。QQ 给过来的 mentions 有两种形态：
//   数组 [{ id, user_openid, ... }]，或对象 { bot: true, is_you: true, username }
// 只看 openid 比对会漏掉后一种，导致「@ 了但被当闲聊丢掉」
export function atMe(event) {
  const raw = event?.mentions
  if (!raw) return false

  const items = Array.isArray(raw) ? raw : [raw]
  const selfId = String(bot.self_id ?? process.env.QQ_APP_ID ?? '')
  const appId = String(env.appId ?? '')

  return items.some((item) => {
    if (!item || typeof item !== 'object') return false
    if (item.is_you === true) return true
    if (item.bot === true) return true

    const candidates = [item.id, item.user_openid, item.member_openid, item.user_id]
      .filter(Boolean)
      .map(String)

    return candidates.some((value) => value === selfId || value === appId)
  })
}

export function choiceSenderFor(event) {
  const sessionKey = sessionKeyOf(event)
  return async ({ question, options } = {}) => {
    const entry = putChoice(sessionKey, { question, options })
    if (!entry) throw new Error('至少给 2 个选项，最多 5 个')

    const text = choiceText(entry)
    await sendReply(event, text)
    return { count: entry.options.length, text }
  }
}

export function schedulerForTarget(sessionKey, target) {
  return {
    add: ({ cron, prompt }) => addSchedule({ sessionKey, target, cron, prompt }),
    list: () => listSchedules(sessionKey),
    remove: (id) => removeSchedule(id, sessionKey),
  }
}

export function schedulerFor(event) {
  const sessionKey = sessionKeyOf(event)
  const isGroup = event.message_type === 'group'
  const target = {
    type: isGroup ? 'group' : 'user',
    id: isGroup ? event.group_id : event.user_id,
  }

  return schedulerForTarget(sessionKey, target)
}

export function notifierFor(event) {
  const startedAt = Date.now()
  const isGroup = event.message_type === 'group'
  const groupId = event.group_id
  const userId = event.user_id
  let passiveUsed = 0

  return async (text) => {
    const body = clip(text)
    const canPassive = Date.now() - startedAt < 4 * 60_000 && passiveUsed < 3

    if (canPassive) {
      passiveUsed += 1
      try {
        await sendReply(event, body)
        return
      } catch (error) {
        console.warn('[任务通知] 被动回复失败，改用主动消息：', error?.message ?? error)
      }
    }

    try {
      if (isGroup) await bot.group(groupId).send(body)
      else await bot.user(userId).send(body)
    } catch (error) {
      console.error('[任务通知] 主动发送也失败：', error?.message ?? error)
    }
  }
}

export function toolsForScope(scope, actor = '') {
  if (!env.toolsEnabled) return []
  if (scope === 'group' && !env.groupToolsEnabled) return []
  return toDeepSeekTools(filterTools(getTools(), scope, actor))
}
