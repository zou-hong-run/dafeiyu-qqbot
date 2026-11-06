import * as groupLog from './group-log.js'

// 群成员画像：从原始群聊记录里聚合出「谁在群里、什么人、什么时候活跃」
// 不落盘，查询时实时算——数据源就是 groupLog，永远是最新的
const ANALYSIS_WINDOW = 800
const TOP_MEMBERS = 20

function dayKey(ts) {
  if (!ts) return ''
  const date = new Date(ts)
  const pad = (value) => String(value).padStart(2, '0')
  return `${date.getMonth() + 1}-${pad(date.getDate())}`
}

function hourBand(hours) {
  if (hours.length === 0) return ''
  const bucket = { 凌晨: 0, 上午: 0, 下午: 0, 晚上: 0 }
  for (const hour of hours) {
    if (hour < 6) bucket.凌晨 += 1
    else if (hour < 12) bucket.上午 += 1
    else if (hour < 18) bucket.下午 += 1
    else bucket.晚上 += 1
  }

  const top = Object.entries(bucket).sort((a, b) => b[1] - a[1])[0]
  if (!top || top[1] === 0) return ''

  // 占比不到 40% 就说明分布很散，别硬说「常在某个时段」
  return top[1] / hours.length >= 0.4 ? top[0] : ''
}

/**
 * 聚合一个群的成员画像
 * @returns {{ groupId, analyzed, span, members }}
 */
function buildProfile(groupId, window = ANALYSIS_WINDOW) {
  const entries = groupLog.recent(groupId, window)
  if (entries.length === 0) {
    return { groupId, analyzed: 0, span: null, members: [] }
  }

  const people = new Map()

  for (const entry of entries) {
    const id = String(entry.u ?? '')
    if (!id || id === 'bot') continue

    if (!people.has(id)) {
      people.set(id, {
        userId: id,
        name: entry.n || `用户${id.slice(-4)}`,
        count: 0,
        firstAt: entry.t,
        lastAt: entry.t,
        hours: [],
        days: new Set(),
        samples: [],
      })
    }

    const person = people.get(id)
    person.count += 1
    person.lastAt = Math.max(person.lastAt, entry.t)
    person.firstAt = Math.min(person.firstAt, entry.t)
    person.hours.push(new Date(entry.t).getHours())
    person.days.add(dayKey(entry.t))

    const text = String(entry.c ?? '').trim()
    if (text && text !== '[附件]' && person.samples.length < 3) {
      person.samples.push(text.slice(0, 60))
    }

    // 昵称可能改过，取最新的
    if (entry.n) person.name = entry.n
  }

  const members = [...people.values()]
    .map((person) => ({
      userId: person.userId,
      name: person.name,
      count: person.count,
      activeDays: person.days.size,
      lastAt: person.lastAt,
      firstAt: person.firstAt,
      peak: hourBand(person.hours),
      samples: person.samples,
      share: Math.round((person.count / entries.length) * 100),
    }))
    .sort((a, b) => b.count - a.count)
    .slice(0, TOP_MEMBERS)

  const times = entries.map((entry) => entry.t).filter(Boolean)

  return {
    groupId,
    analyzed: entries.length,
    span: {
      from: Math.min(...times),
      to: Math.max(...times),
    },
    members,
  }
}

function formatTime(ms) {
  if (!ms) return '-'
  return new Date(ms).toLocaleString('zh-CN', { hour12: false, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
}

/**
 * 渲染成给模型看的文本
 * @param {string} groupId
 * @param {string} [member] 名字或 openid，不传就列全员
 */
export function formatProfile(groupId, member = '') {
  const profile = buildProfile(groupId)

  if (profile.analyzed === 0) {
    return (
      '这个群还没有聊天记录，画不出画像。' +
      '如果刚把我拉进来，可能是群没开「机器人可获取的群聊消息范围 = 获取群内全部消息」。'
    )
  }

  const target = String(member ?? '').trim()

  if (target) {
    const found = profile.members.find(
      (item) =>
        item.name === target ||
        item.userId === target ||
        item.name.includes(target) ||
        target.includes(item.name),
    )

    if (!found) {
      const names = profile.members.slice(0, 8).map((item) => item.name).join('、')
      return `最近 ${profile.analyzed} 条记录里没找到「${target}」。出现过的人是：${names}`
    }

    const lines = [
      `${found.name}（${found.userId}）`,
      `发言 ${found.count} 条，占这段记录的 ${found.share}%`,
      `活跃 ${found.activeDays} 天，${found.peak ? `常在${found.peak}` : '时段不定'}`,
      `第一次 ${formatTime(found.firstAt)}，最近一次 ${formatTime(found.lastAt)}`,
    ]

    if (found.samples.length > 0) {
      lines.push('最近说过：')
      for (const sample of found.samples) lines.push(`  · ${sample}`)
    }

    return lines.join('\n')
  }

  const lines = [
    `本群画像（最近 ${profile.analyzed} 条记录，${formatTime(profile.span.from)} ~ ${formatTime(profile.span.to)}）`,
    `活跃成员 ${profile.members.length} 人：`,
  ]

  for (const [index, item] of profile.members.entries()) {
    lines.push(
      `${index + 1}. ${item.name}｜${item.count} 条（${item.share}%）｜${item.activeDays} 天｜${item.peak ? `常在${item.peak}` : '时段不定'}｜openid: ${item.userId}`,
    )
  }

  lines.push('', '想看某个人的细节，把名字传进来。')
  return lines.join('\n')
}
