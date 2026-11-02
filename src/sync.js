import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

// 代码同步：把服务器上的改动提交回仓库，实现「自己改代码 → 自己留痕」
// 只在两种时机触发：进程优雅退出前（它就是改完代码要重启的时候）、以及手动调 git_sync
// REPO_ROOT 只给测试用，生产环境永远指向项目根
const projectRoot = process.env.REPO_ROOT || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const GIT_TIMEOUT = 60_000

// 双保险：.gitignore 已经挡了这些，但代码里再挡一次——漏一次就是密钥上公网
const BLOCKED_PATHS = [/^\.env/, /^data\//, /^logs\//, /^downloads\//, /^node_modules\//, /^tmp\//]

// 提交内容里出现这些模式就拒绝提交
const SECRET_PATTERNS = [
  /sk-[A-Za-z0-9]{16,}/,
  /QQ_APP_SECRET\s*[=:]\s*\S+/,
  /DEEP_SEEK_API_KEY\s*[=:]\s*\S+/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
]

function git(args, { allowFail = false } = {}) {
  try {
    return {
      ok: true,
      out: execFileSync('git', args, {
        cwd: projectRoot,
        encoding: 'utf8',
        timeout: GIT_TIMEOUT,
        stdio: ['ignore', 'pipe', 'pipe'],
      }).trim(),
    }
  } catch (error) {
    const detail = String(error?.stderr || error?.stdout || error?.message || error).trim()
    if (!allowFail) throw new Error(`git ${args.join(' ')} 失败：${detail.slice(0, 300)}`)
    return { ok: false, out: detail }
  }
}

export function repoStatus() {
  const branch = git(['rev-parse', '--abbrev-ref', 'HEAD'], { allowFail: true }).out || 'unknown'
  const dirty = git(['status', '--porcelain'], { allowFail: true }).out
  const changes = dirty ? dirty.split('\n').filter(Boolean) : []

  let ahead = 0
  let behind = 0
  const counted = git(['rev-list', '--left-right', '--count', '@{u}...HEAD'], { allowFail: true })
  if (counted.ok && counted.out) {
    const [b, a] = counted.out.split(/\s+/).map(Number)
    behind = Number.isFinite(b) ? b : 0
    ahead = Number.isFinite(a) ? a : 0
  }

  return { branch, changes, ahead, behind, hasUpstream: Boolean(counted.ok) }
}

function assertSafeStaged() {
  const staged = git(['diff', '--cached', '--name-only'], { allowFail: true }).out
  const files = staged ? staged.split('\n').filter(Boolean) : []

  for (const file of files) {
    if (BLOCKED_PATHS.some((pattern) => pattern.test(file))) {
      throw new Error(`暂存区里出现了不该提交的路径：${file}（密钥/运行时数据一律不进仓库）`)
    }
  }

  // 扫一遍新增内容，防止硬编码的密钥被写进源码
  const diff = git(['diff', '--cached', '-U0'], { allowFail: true }).out
  if (diff && diff.length < 2_000_000) {
    for (const pattern of SECRET_PATTERNS) {
      if (pattern.test(diff)) {
        throw new Error('暂存内容里疑似有密钥，已拒绝提交。请把密钥挪进 .env 再重试')
      }
    }
  }

  return files
}

export function commitAndPush(reason = 'auto sync') {
  const status = repoStatus()
  if (status.changes.length === 0) return { ok: true, skipped: true, reason: '没有改动' }

  git(['add', '-A'])

  let files
  try {
    files = assertSafeStaged()
  } catch (error) {
    // 别留半提交状态：清掉暂存区，否则下次可能把敏感文件一起带上去
    git(['reset'], { allowFail: true })
    throw error
  }

  if (files.length === 0) return { ok: true, skipped: true, reason: '过滤后没有可提交的文件' }

  const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ')
  const message = `${reason}（${stamp}）\n\n改动 ${files.length} 个文件：\n${files
    .slice(0, 20)
    .map((file) => `- ${file}`)
    .join('\n')}${files.length > 20 ? `\n- …还有 ${files.length - 20} 个` : ''}`

  git(['commit', '-m', message])

  const pushed = git(['push', 'origin', 'HEAD'], { allowFail: true })
  if (pushed.ok) {
    return { ok: true, committed: true, pushed: true, files: files.length, branch: status.branch }
  }

  // 推送被拒（远端有新提交）：拉一把再试一次，冲突就放手，别把本地改动搞乱
  const rebased = git(['pull', '--rebase', '--autostash', 'origin', status.branch], { allowFail: true })
  if (!rebased.ok) {
    return {
      ok: false,
      committed: true,
      pushed: false,
      files: files.length,
      reason: `已本地提交，但拉取远端失败：${rebased.out.slice(0, 200)}`,
    }
  }

  const retry = git(['push', 'origin', 'HEAD'], { allowFail: true })
  return {
    ok: retry.ok,
    committed: true,
    pushed: retry.ok,
    files: files.length,
    branch: status.branch,
    reason: retry.ok ? '' : `已本地提交，推送仍失败：${retry.out.slice(0, 200)}`,
  }
}

export function pullLatest() {
  const status = repoStatus()
  const pulled = git(['pull', '--rebase', '--autostash', 'origin', status.branch], { allowFail: true })

  if (!pulled.ok) {
    return { ok: false, reason: pulled.out.slice(0, 300) }
  }

  return { ok: true, branch: status.branch, output: pulled.out.slice(0, 300) }
}

export function describeStatus() {
  const status = repoStatus()
  const lines = [
    `分支 ${status.branch}｜未提交改动 ${status.changes.length} 个｜领先远端 ${status.ahead}｜落后远端 ${status.behind}`,
  ]

  if (status.changes.length > 0) {
    lines.push('改动：')
    for (const line of status.changes.slice(0, 15)) lines.push(`  ${line}`)
    if (status.changes.length > 15) lines.push(`  …还有 ${status.changes.length - 15} 个`)
  }

  return lines.join('\n')
}
