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

function isBlockedIPv6(host) {
  if (!host.includes(':')) return false

  const mapped = ipv4FromMappedIPv6(host)
  if (mapped) return isBlockedIPv4(mapped)

  if (host === '::1' || host === '::') return true
  if (/^fe[89ab]/i.test(host)) return true // fe80::/10 link-local
  if (/^f[cd]/i.test(host)) return true // fc00::/7 unique local

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
