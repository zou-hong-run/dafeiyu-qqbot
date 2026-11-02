import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const pkgFile = path.join(projectRoot, 'package.json')

const args = process.argv.slice(2)
const dryRun = args.includes('--dry-run')
const bump = args.find((arg) => !arg.startsWith('-')) ?? 'patch'

function git(...argv) {
  return execFileSync('git', argv, { cwd: projectRoot, encoding: 'utf8' }).trim()
}

function fail(message) {
  console.error(`\n[发版中止] ${message}\n`)
  process.exit(1)
}

function nextVersion(current, kind) {
  if (/^\d+\.\d+\.\d+$/.test(kind)) return kind

  const [major, minor, patch] = current.split('.').map(Number)
  if (kind === 'major') return `${major + 1}.0.0`
  if (kind === 'minor') return `${major}.${minor + 1}.0`
  if (kind === 'patch') return `${major}.${minor}.${patch + 1}`

  fail(`不认识版本参数 "${kind}"，可用 patch / minor / major / 1.2.3`)
}

const raw = fs.readFileSync(pkgFile, 'utf8')
const current = JSON.parse(raw).version
const version = nextVersion(current, bump)
const tag = `v${version}`

if (git('status', '--porcelain')) {
  fail('工作区还有没提交的改动，先提交或 stash 再发版')
}

const branch = git('rev-parse', '--abbrev-ref', 'HEAD')
if (branch !== 'main') {
  fail(`当前在 ${branch} 分支，发版请切回 main`)
}

if (git('tag', '-l', tag)) {
  fail(`tag ${tag} 已经存在`)
}

let previous = ''
try {
  previous = git('describe', '--tags', '--abbrev=0')
} catch {
  // 还没有任何 tag，首次发版
}

const commits = previous
  ? git('log', '--no-merges', '--pretty=format:- %s', `${previous}..HEAD`)
  : git('log', '--no-merges', '--pretty=format:- %s', '-10')

console.log(`\n版本：${current} → ${version}（tag ${tag}）`)
console.log(`提交：\n${commits || '- （无新提交）'}\n`)

if (dryRun) {
  console.log('[dry-run] 没有改动任何文件，去掉 --dry-run 才会真的发版\n')
  process.exit(0)
}

fs.writeFileSync(pkgFile, raw.replace(/"version":\s*"[^"]+"/, `"version": "${version}"`))

const note = [`${tag} 发布`, '', commits || '- （无新提交）'].join('\n')

try {
  git('add', 'package.json')
  git('commit', '-m', `chore: release ${tag}`)
  git('tag', '-a', tag, '-m', note)
  console.log(`[本地] 已提交并打 tag ${tag}`)
} catch (error) {
  fail(`本地提交或打 tag 失败：${error?.message ?? error}`)
}

try {
  git('push', 'origin', `HEAD:${branch}`)
  git('push', 'origin', tag)
  console.log(`[远程] 已推送 ${branch} 和 ${tag}\n`)
  console.log('下一步建议：在 GitHub 仓库 Releases 里基于这个 tag 发布说明。\n')
} catch (error) {
  console.error(`[远程] 推送失败：${error?.message ?? error}`)
  console.error(`       本地提交和 tag ${tag} 都已经存在，网络恢复后执行：`)
  console.error(`       git push origin ${branch} && git push origin ${tag}\n`)
  process.exit(1)
}
