import test from 'node:test'
import assert from 'node:assert/strict'
import { assertPublicUrl, isBlockedAddress } from '../src/mcp-server/net-guard.js'

// 出网地址校验：一次 SSRF 就能拿到云实例的临时凭证，所以这里只测「该拦的拦住」

const blocked = (url, hint) => {
  assert.throws(
    () => assertPublicUrl(url),
    (error) => (hint ? hint.test(error.message) : true),
    `应该拦住：${url}`,
  )
}

const allowed = (url) => {
  assert.doesNotThrow(() => assertPublicUrl(url), `应该放行：${url}`)
}

test('云元数据地址拦住', () => {
  blocked('http://169.254.169.254/latest/meta-data/')
  blocked('http://100.100.100.200/latest/meta-data/ram/security-credentials/')
  blocked('http://metadata.google.internal/computeMetadata/v1/')
})

test('IPv4 映射的 IPv6 也要拦住', () => {
  // 这两种写法 Node 的 URL 不会自动还原，靠正则单独处理
  blocked('http://[::ffff:169.254.169.254]/latest/meta-data/')
  blocked('http://[::ffff:a9fe:a9fe]/latest/meta-data/')
  blocked('http://[::ffff:100.100.100.200]/')
  blocked('http://[::1]/')
})

test('私网段拦住', () => {
  blocked('http://10.0.0.1/')
  blocked('http://172.16.0.1/')
  blocked('http://192.168.1.1/')
  blocked('http://127.0.0.1/')
  blocked('http://100.64.0.1/')
  blocked('http://[fe80::1]/')
  blocked('http://[fd00::1]/')
})

test('localhost 和各种内网域名拦住', () => {
  blocked('http://localhost:8080/')
  blocked('http://app.localhost/')
  blocked('http://db.local/')
  blocked('http://internal.internal/')
})

test('公网地址放行', () => {
  allowed('https://www.baidu.com/')
  allowed('https://api.github.com/repos')
  allowed('http://8.8.8.8/')
})

test('协议和格式限制', () => {
  blocked('ftp://example.com/x', /只支持/)
  blocked('file:///etc/passwd', /只支持/)
  blocked('not a url', /格式不对/)
  blocked('')
})

test('单个 IP 判定：内网和元数据段', () => {
  assert.equal(isBlockedAddress('169.254.169.254'), true)
  assert.equal(isBlockedAddress('100.100.100.200'), true)
  assert.equal(isBlockedAddress('127.0.0.1'), true)
  assert.equal(isBlockedAddress('10.1.2.3'), true)
  assert.equal(isBlockedAddress('::ffff:a9fe:a9fe'), true)
  assert.equal(isBlockedAddress('8.8.8.8'), false)
  assert.equal(isBlockedAddress('1.1.1.1'), false)
})

test('返回的是 URL 对象', () => {
  const url = assertPublicUrl('https://www.baidu.com/a/b?x=1')
  assert.equal(url.hostname, 'www.baidu.com')
  assert.equal(url.pathname, '/a/b')
})

test('IPv4 兼容写法的 IPv6 也要拦住', () => {
  // [::127.0.0.1] 会被 URL 规范化成 [::7f00:1]，字面量看不出是内网
  blocked('http://[::127.0.0.1]/')
  blocked('http://[::7f00:1]/')
  blocked('http://[::ffff:0:127.0.0.1]/')
  blocked('http://[::ffff:0:a9fe:a9fe]/')
})

test('公网 IPv6 放行', () => {
  allowed('http://[2400:3200::1]/')
})
