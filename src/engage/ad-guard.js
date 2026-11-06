// 群里的广告检测。
//
// 原则：只做「明显是广告」的拦截——广告词 + 链接/联系方式同时出现才算，
// 光提一句「优惠」不算。误伤一个正常群友，比放过十条广告更糟。
//
// 判断纯规则、不调模型：群里每条消息都过一遍，用模型等于每句话烧一次额度。

// 促销类词汇
const PROMO_WORDS = [
  '优惠',
  '特价',
  '秒杀',
  '折扣',
  '清仓',
  '代购',
  '批发',
  '招代理',
  '代理招募',
  '招加盟',
  '返利',
  '免费领',
  '限时',
  '降价',
  '包邮',
  '低价出',
  '一手货源',
  '日入',
  '月入',
  '躺赚',
  '兼职赚',
  '刷单',
  '点赞赚钱',
  '推广',
  '招商',
  '内部渠道',
]

// 拉人加好友这一类，本身就带「离开这个群」的意图，命中即可判定
const PULL_WORDS = ['扫码进', '拉你进', '进群领取', '戳我头像', '私聊我', '主页有联系方式']

// 链接 / 联系方式：只靠广告词容易误伤，必须同时出现其一
const LINK_PATTERN = /https?:\/\/|www\.|[a-z0-9-]+\.(?:com|cn|net|org|top|xyz|vip)\b/i
const WECHAT_PATTERN = /(?:微信|vx|wx|v信|威信)[\s:：]*[a-zA-Z][-_a-zA-Z0-9]{4,19}/i
const PHONE_PATTERN = /(?<!\d)1[3-9]\d{9}(?!\d)/
const QQ_PATTERN = /(?:qq|扣扣|企鹅)[\s号:：]*[1-9]\d{4,10}/i

// 「加我 / 联系我 / 私聊」这类动作词。单有号码不算，配上它才算在拉人。
// 注意别把「找我」收进来——「我的 qq 是 xxx，有事找我」是正常留联系方式。
const CONTACT_INTENT = /(加我|联系我|私聊我|扣我|戳我|加一下|扫码)/

// 太短的不判（「优惠」两个字单独发不算广告）
const MIN_LENGTH = 8

/**
 * 判定为广告：
 * - 「扫码进群」「私聊我」这类拉人话术单独就够，不看长度
 * - 微信号 + 账号：营销最常见的形式，强信号
 * - 链接 / 手机号 / QQ +（广告词 或 拉人动作）：两者都要有
 *
 * 「有人加微信吗」「我的电话是 xxx」「我的 qq 是 xxx，有事找我」都不会被冤枉。
 */
export function isLikelyAd(text) {
  const raw = String(text ?? '').trim()
  if (!raw) return false

  if (PULL_WORDS.some((word) => raw.includes(word))) return true
  if (raw.length < MIN_LENGTH) return false

  // 微信号带着账号，本身就是拉客信号
  if (WECHAT_PATTERN.test(raw)) return true

  const hasPromo = PROMO_WORDS.some((word) => raw.includes(word))
  const hasContact = LINK_PATTERN.test(raw) || PHONE_PATTERN.test(raw) || QQ_PATTERN.test(raw)
  if (!hasContact) return false

  return hasPromo || CONTACT_INTENT.test(raw)
}

// 委婉但不含糊。别用「违反群规」这种口气，也别训人。
const AD_REPLIES = [
  '这条看着像广告哈，群里就不太合适了，下次别发啦 🙏',
  '广告就免了吧，这个群主要是聊天用的～',
  '提醒一下：群里不太欢迎推广内容，大家互相体谅下哈',
  '这个像是带货广告，我就不帮它扩散了。想聊点别的随时来',
]

export function pickAdReply(seed = Date.now()) {
  return AD_REPLIES[Math.abs(Math.floor(seed)) % AD_REPLIES.length]
}

// 限频：同一个人 24 小时只提醒一次，同一个群一小时最多 3 次。
// 不设限的话，广告党连着刷十条就会被我们连 @ 十次，反而变成刷屏。
const USER_COOLDOWN_MS = 24 * 60 * 60 * 1000
const GROUP_WINDOW_MS = 60 * 60 * 1000
const GROUP_LIMIT = 3

const userWarnedAt = new Map()
const groupWarns = new Map()

function pruneGroup(groupId, now) {
  const list = (groupWarns.get(groupId) ?? []).filter((at) => now - at < GROUP_WINDOW_MS)
  groupWarns.set(groupId, list)
  return list
}

/** 这一次能不能提醒：能就占住名额并返回 true */
export function takeWarnSlot(groupId, userId, now = Date.now()) {
  const last = userWarnedAt.get(userId)
  if (last && now - last < USER_COOLDOWN_MS) return false

  const recent = pruneGroup(groupId, now)
  if (recent.length >= GROUP_LIMIT) return false

  userWarnedAt.set(userId, now)
  recent.push(now)
  groupWarns.set(groupId, recent)

  // 长期运行的进程别让这两个 Map 无限长
  if (userWarnedAt.size > 2000) {
    for (const [key, at] of userWarnedAt) {
      if (now - at > USER_COOLDOWN_MS) userWarnedAt.delete(key)
    }
  }
  if (groupWarns.size > 500) {
    for (const key of [...groupWarns.keys()]) {
      if (pruneGroup(key, now).length === 0) groupWarns.delete(key)
    }
  }

  return true
}

/** 测试用：清掉限频状态 */
export function resetAdGuard() {
  userWarnedAt.clear()
  groupWarns.clear()
}
