import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

// 代码同步：把服务器上的改动提交回仓库，实现「自己改代码 → 自己留痕」
// 触发时机：进程退出前、定时器、手动 git_sync
// 全部走异步执行——git push 卡几秒不能把整个机器人堵住
const projectRoot = process.env.REPO_ROOT || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

const execFileAsync = promisify(execFile)
const GIT_TIMEOUT = 60_000

// 双保险：.gitignore 已经挡了这些，但代码里再挡一次——漏一次就是密钥上公网
// .github/ 改的是 CI 的执行环境，package.json 改的是 scripts 和依赖——
// 这两个被自动 push 出去，等于把「模型写的代码」直接接进流水线。
const BLOCKED_PATHS = [
  /^\.env/,
  /^data\//,
  /^logs\//,
  /^downloads\//,
  /^node_modules\//,
  /^tmp\//,
  /^backups\//,
  /^\.github\//,
  /^package\.json$/,
  /^pnpm-lock\.yaml$/,
]

// 提交内容里出现这些模式就拒绝提交
const SECRET_PATTERNS = [
  /sk-[A-Za-z0-9]{16,}/,
  /QQ_APP_SECRET\s*[=:]\s*\S+/,
  /DEEP_SEEK_API_KEY\s*[=:]\s*\S+/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
]

async function git(args, { allowFail = false } = {}) {
  try {
    const { stdout } = await execFileAsync('git', args, {
      cwd: projectRoot,
      encoding: 'utf8',
      timeout: GIT_TIMEOUT,
      maxBuffer: 4 * 1024 * 1024,
    })
    return { ok: true, out: String(stdout ?? '').trim() }
  } catch (error) {
    const detail = String(error?.stderr || error?.stdout || error?.message || error).trim()
    if (!allowFail) throw new Error(`git ${args.join(' ')} 失败：${detail.slice(0, 300)}`)
    return { ok: false, out: detail }
  }
}

// 没装 git 或不是仓库时不要反复报错：安静跳过，只在启动日志里提示一次
export async function isRepo() {
  const probe = await git(['rev-parse', '--is-inside-work-tree'], { allowFail: true })
  return probe.ok && probe.out === 'true'
}

// 提交信息里用本地时间，别用 toISOString（那是 UTC，差 8 小时）
function localStamp(date = new Date()) {
  const pad = (value) => String(value).padStart(2, '0')
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}`
  )
}

export async function repoStatus() {
  const branch = (await git(['rev-parse', '--abbrev-ref', 'HEAD'], { allowFail: true })).out || 'unknown'
  const dirty = (await git(['status', '--porcelain'], { allowFail: true })).out
  const changes = dirty ? dirty.split('\n').filter(Boolean) : []

  let ahead = 0
  let behind = 0
  const counted = await git(['rev-list', '--left-right', '--count', '@{u}...HEAD'], { allowFail: true })
  if (counted.ok && counted.out) {
    const [b, a] = counted.out.split(/\s+/).map(Number)
    behind = Number.isFinite(b) ? b : 0
    ahead = Number.isFinite(a) ? a : 0
  }

  return { branch, changes, ahead, behind, hasUpstream: Boolean(counted.ok) }
}

async function assertSafeStaged() {
  const staged = (await git(['diff', '--cached', '--name-only'], { allowFail: true })).out
  const files = staged ? staged.split('\n').filter(Boolean) : []

  for (const file of files) {
    if (BLOCKED_PATHS.some((pattern) => pattern.test(file))) {
      throw new Error(`暂存区里出现了不该提交的路径：${file}（密钥/运行时数据一律不进仓库）`)
    }
  }

  // 扫一遍新增内容，防止硬编码的密钥被写进源码
  const diff = (await git(['diff', '--cached', '-U0'], { allowFail: true })).out
  if (diff && diff.length < 2_000_000) {
    for (const pattern of SECRET_PATTERNS) {
      if (pattern.test(diff)) {
        throw new Error('暂存内容里疑似有密钥，已拒绝提交。请把密钥挪进 .env 再重试')
      }
    }
  }

  return files
}

export async function commitAndPush(reason = 'auto sync') {
  if (!(await isRepo())) {
    return { ok: true, skipped: true, reason: '服务器上不是 git 仓库，改动只留在本机' }
  }

  const status = await repoStatus()
  if (status.changes.length === 0) return { ok: true, skipped: true, reason: '没有改动' }

  await git(['add', '-A'])

  let files
  try {
    files = await assertSafeStaged()
  } catch (error) {
    // 别留半提交状态：清掉暂存区，否则下次可能把敏感文件一起带上去
    await git(['reset'], { allowFail: true })
    throw error
  }

  if (files.length === 0) return { ok: true, skipped: true, reason: '过滤后没有可提交的文件' }

  const stamp = localStamp()
  const statLine = (await git(['diff', '--cached', '--stat'], { allowFail: true })).out.split('\n').pop()?.trim() ?? ''

  const subject = `${reason}（${stamp}）`
  const body = [
    statLine,
    `改动 ${files.length} 个文件：`,
    ...files.slice(0, 20).map((file) => `- ${file}`),
    files.length > 20 ? `- …还有 ${files.length - 20} 个` : '',
  ]
    .filter(Boolean)
    .join('\n')

  await git(['commit', '-m', `${subject}\n\n${body}`])

  const pushed = await git(['push', 'origin', 'HEAD'], { allowFail: true })
  if (pushed.ok) {
    return { ok: true, committed: true, pushed: true, files: files.length, branch: status.branch }
  }

  // 推送被拒（远端有新提交）：拉一把再试一次，冲突就放手，别把本地改动搞乱
  const rebased = await git(['pull', '--rebase', '--autostash', 'origin', status.branch], { allowFail: true })
  if (!rebased.ok) {
    return {
      ok: false,
      committed: true,
      pushed: false,
      files: files.length,
      reason: `已本地提交，但拉取远端失败：${rebased.out.slice(0, 200)}`,
    }
  }

  const retry = await git(['push', 'origin', 'HEAD'], { allowFail: true })
  return {
    ok: retry.ok,
    committed: true,
    pushed: retry.ok,
    files: files.length,
    branch: status.branch,
    reason: retry.ok ? '' : `已本地提交，推送仍失败：${retry.out.slice(0, 200)}`,
  }
}

export async function pullLatest() {
  if (!(await isRepo())) throw new Error('服务器上不是 git 仓库，没法拉取。先按部署文档初始化')

  const status = await repoStatus()
  const pulled = await git(['pull', '--rebase', '--autostash', 'origin', status.branch], { allowFail: true })

  if (!pulled.ok) {
    return { ok: false, reason: pulled.out.slice(0, 300) }
  }

  return { ok: true, branch: status.branch, output: pulled.out.slice(0, 300) }
}

export async function describeStatus() {
  if (!(await isRepo())) return '服务器上不是 git 仓库：自动同步已跳过，改动只留在本机'

  const status = await repoStatus()
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
