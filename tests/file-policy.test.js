import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { SENSITIVE_PREFIXES, sensitiveReason } from '../src/ops/file-policy.js'

// 读取（read_document）和发送（send_file / markdown 图片上传）共用这一份黑名单。
// 群聊里任何人都能触发这两个动作，所以这里漏一个就等于漏一路。

test('密钥、记忆、日志、备份、脚本目录一律拒绝', () => {
  for (const rel of [
    '.env',
    '.env.local',
    'data/memory.json',
    'data/groups/123.jsonl',
    'backups/20261106/memory.json',
    'logs/out.log',
    'tmp/evil.js',
    'node_modules/exceljs/x.js',
    '.git/config',
    '.ssh/id_rsa',
  ]) {
    assert.ok(sensitiveReason(rel), `${rel} 应该被拦下`)
  }
})

test('正常可发路径不误伤', () => {
  for (const rel of [
    'downloads/a.png',
    'downloads/incoming/abc.jpg',
    'tools/group-speakers.js',
    'src/index.js',
    'README.md',
    'package.json',
    'datax/report.csv', // 只匹配 data/ 前缀，不该命中 datax
    'logsx/a.txt',
  ]) {
    assert.equal(sensitiveReason(rel), '', `${rel} 不该被拦`)
  }
})

test('黑名单里的每一项都能被自己命中', () => {
  for (const prefix of SENSITIVE_PREFIXES) {
    const sample = prefix.endsWith('/') ? `${prefix}x` : prefix
    assert.ok(sensitiveReason(sample), `${sample} 应该命中 ${prefix}`)
  }
})

test('sendWithKeyboard 出站前必须过滤（防止新增路径又绕过）', () => {
  // 这条路径不经过 postMessage()，是全项目唯一手工发 markdown 的口子。
  // 过滤一旦被删掉，题干的 <qqbot-at-everyone /> 会原样发给平台。
  const file = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src/channel/qq.js')
  const source = fs.readFileSync(file, 'utf8')
  const start = source.indexOf('export async function sendWithKeyboard')
  assert.ok(start > 0, 'sendWithKeyboard 应该存在')

  const body = source.slice(start, start + 800)
  assert.match(body, /sanitizeText\(/, '出站前要剥协议标签')
  assert.match(body, /rewriteMarkdownImages\(/, '本地图片要先上传成素材引用')
})
