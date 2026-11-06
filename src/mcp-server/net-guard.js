import dns from 'node:dns/promises'
import net from 'node:net'

// 出网地址校验：download 和视频工具共用这一份。
// 目标是「内网和云元数据一律访问不了」——一次 SSRF 就能拿到实例角色的临时凭证，
// 而 download 是群聊里任何人都能触发的工具。

const BLOCKED_NAMES = ['localhost', 'metadata.google.internal', 'metadata']

function normalizeHost(hostname) {
  return String(hostname ?? '')
    .toLowerCase()
    .replace(/^\[|\]$/g, '')
}

function isBlockedIPv4(host) {
  const matched = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/)
  if (!matched) return false

  const [a, b] = [Number(matched[1]), Number(matched[2])]
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 169 && b === 254) || // link-local，AWS / 腾讯云元数据
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127) || // 运营商 NAT，阿里云元数据 100.100.100.200
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224 // 组播和保留段
  )
}

/** ::ffff:169.254.169.254 和 ::ffff:a9fe:a9fe 两种写法都要还原成 IPv4 再判 */
function ipv4FromMappedIPv6(host) {
  const dotted = host.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i)
  if (dotted) return dotted[1]

  const hex = host.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i)
  if (hex) {
    const high = parseInt(hex[1], 16)
    const low = parseInt(hex[2], 16)
    return [high >> 8, high & 0xff, low >> 8, low & 0xff].join('.')
  }

  return null
}

/**
 * 把 IPv6 文本展开成 8 组 16 位整数，失败返回 null。
 * 只为了判断「这个地址实质上是不是内网」，不做完整实现。
 */
function expandIPv6(host) {
  let text = String(host).toLowerCase()
  if (!text.includes(':')) return null

  // 末尾的 IPv4 写法（::ffff:1.2.3.4）先转成两段十六进制
  const tail = text.match(/^(.*:)(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/)
  if (tail) {
    const octets = tail[2].split('.').map(Number)
    if (octets.some((n) => !Number.isFinite(n) || n < 0 || n > 255)) return null
    text = `${tail[1]}${((octets[0] << 8) | octets[1]).toString(16)}:${((octets[2] << 8) | octets[3]).toString(16)}`
  }

  const halves = text.split('::')
  if (halves.length > 2) return null

  const left = halves[0] ? halves[0].split(':').filter(Boolean) : []
  const right = halves.length === 2 && halves[1] ? halves[1].split(':').filter(Boolean) : []
  const fill = 8 - left.length - right.length
  if (halves.length === 1 && fill !== 0) return null
  if (fill < 0) return null

  const groups = [...left, ...Array(fill).fill('0'), ...right].map((item) => parseInt(item, 16))
  if (groups.length !== 8 || groups.some((n) => !Number.isFinite(n))) return null
  return groups
}

function isBlockedIPv6(host) {
  if (!host.includes(':')) return false

  const mapped = ipv4FromMappedIPv6(host)
  if (mapped) return isBlockedIPv4(mapped)

  if (host === '::1' || host === '::') return true
  if (/^fe[89ab]/i.test(host)) return true // fe80::/10 link-local
  if (/^f[cd]/i.test(host)) return true // fc00::/7 unique local

  // IPv4 兼容写法：::7f00:1 其实就是 127.0.0.1，URL 解析会把 [::127.0.0.1] 变成这个样子。
  // 规则：前 6 组全空时，最后两组按 IPv4 处理。
  const groups = expandIPv6(host)
  if (!groups) return false

  const headEmpty = groups.slice(0, 6).every((n) => n === 0)
  if (headEmpty) {
    const ipv4 = [groups[6] >> 8, groups[6] & 0xff, groups[7] >> 8, groups[7] & 0xff].join('.')
    if (isBlockedIPv4(ipv4)) return true
  }

  // ::ffff:0:127.0.0.1 这种「翻译过的」，展开成 [0,0,0,0,ffff,0,7f00,1]
  if (groups.slice(0, 4).every((n) => n === 0) && groups[4] === 0xffff && groups[5] === 0) {
    const ipv4 = [groups[6] >> 8, groups[6] & 0xff, groups[7] >> 8, groups[7] & 0xff].join('.')
    if (isBlockedIPv4(ipv4)) return true
  }

  // ::ffff:127.0.0.1 展开成 [0,0,0,0,0,ffff,7f00,1]
  if (groups.slice(0, 5).every((n) => n === 0) && groups[5] === 0xffff) {
    const ipv4 = [groups[6] >> 8, groups[6] & 0xff, groups[7] >> 8, groups[7] & 0xff].join('.')
    if (isBlockedIPv4(ipv4)) return true
  }

  return false
}

function assertHostAllowed(host) {
  if (!host) throw new Error('网址里没有主机名')

  if (
    BLOCKED_NAMES.includes(host) ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    host.endsWith('.internal')
  ) {
    throw new Error('不允许访问内网或云元数据地址')
  }

  if (isBlockedIPv4(host) || isBlockedIPv6(host)) {
    throw new Error('不允许访问内网或云元数据地址')
  }
}

/** 单个 IP 是否落在内网或元数据段（导出给测试用） */
export function isBlockedAddress(ip) {
  const host = normalizeHost(ip)
  return isBlockedIPv4(host) || isBlockedIPv6(host)
}

/**
 * 校验一个地址能不能出网。返回 URL 对象，调用方可以直接用。
 * @throws {Error} 格式不对或指向内网时
 */
export function assertPublicUrl(raw) {
  let url
  try {
    url = new URL(String(raw ?? '').trim())
  } catch {
    throw new Error('网址格式不对，需要完整的 http:// 或 https:// 链接')
  }

  if (!/^https?:$/.test(url.protocol)) throw new Error('只支持 http 和 https 链接')

  assertHostAllowed(normalizeHost(url.hostname))
  return url
}

const DEFAULT_MAX_REDIRECTS = 5

/**
 * 字面量校验 + 域名解析校验，返回 URL 对象。
 *
 * 用于「把地址交给第三方去下载」的场景（send_image / send_video / send_audio）：
 * 我们不会亲自请求它，所以没法用 fetchPublic 逐跳复核，但至少能挡住
 * 直接写内网 IP、以及解析到内网的域名。
 */
export async function assertPublicUrlResolved(raw) {
  const url = assertPublicUrl(raw)
  await assertResolvesPublic(url.hostname)
  return url
}

/**
 * 域名解析后逐个 IP 再判一次。
 * 只校验字面量的话，`127.0.0.1.nip.io`、`localtest.me` 这类解析到内网的域名
 * 会原样通过——这就是 DNS rebinding。
 *
 * 注意：这里和实际建立连接是两次解析，理论上存在 TOCTOU 窗口。
 * 挡死它需要把连接钉在校验过的 IP 上（自定义 dispatcher），
 * 或者干脆在宿主机防火墙上封掉元数据地址——那才是硬边界。
 */
async function assertResolvesPublic(hostname) {
  const host = normalizeHost(hostname)
  if (net.isIP(host)) return // 字面量 IP 已经在 assertHostAllowed 里判过

  let addresses
  try {
    addresses = await dns.lookup(host, { all: true })
  } catch {
    throw new Error(`域名解析失败：${host}`)
  }

  if (addresses.length === 0) throw new Error(`域名没有解析结果：${host}`)

  for (const { address } of addresses) {
    if (isBlockedIPv4(normalizeHost(address)) || isBlockedIPv6(normalizeHost(address))) {
      throw new Error('不允许访问内网或云元数据地址')
    }
  }
}

/**
 * 带逐跳校验的 fetch：每一跳都重新过 assertPublicUrl，并检查域名解析结果。
 * 不能直接用 redirect: 'follow'——它只校验第一跳，302 到元数据地址就绕过去了。
 */
export async function fetchPublic(rawUrl, init = {}, { maxRedirects = DEFAULT_MAX_REDIRECTS } = {}) {
  let current = assertPublicUrl(rawUrl)
  const visited = [current.toString()]

  for (let hop = 0; hop <= maxRedirects; hop += 1) {
    await assertResolvesPublic(current.hostname)

    const response = await fetch(current, { ...init, redirect: 'manual' })

    if (response.status < 300 || response.status >= 400) return response

    const location = response.headers.get('location')
    if (!location) return response

    // 重定向的响应体要丢掉，否则连接一直挂着
    try {
      await response.body?.cancel()
    } catch {
      // 取消失败不影响后续
    }

    let next
    try {
      next = new URL(location, current)
    } catch {
      throw new Error(`重定向地址不合法：${location}`)
    }

    current = assertPublicUrl(next.toString())
    visited.push(current.toString())

    // 转圈重定向直接掐掉
    if (visited.filter((item) => item === current.toString()).length > 1) {
      throw new Error('重定向成了环，停止')
    }
  }

  throw new Error(`重定向超过 ${maxRedirects} 次，停止`)
}
