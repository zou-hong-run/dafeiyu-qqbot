#!/usr/bin/env node
// 找「导出但没人用」的符号。
// 用法：node scripts/dead-code.js
//
// 判定口径：某个 export 的名字，在它自己的定义文件之外一次都没出现过。
// 这样能覆盖 import { } / import * as / 动态 import 解构 / 同文件内部调用，
// 代价是可能有极少数误报（同名局部变量），所以列出来之后要人工确认再删。
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

function collectFiles(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) collectFiles(full, out)
    else if (entry.name.endsWith('.js')) out.push(full)
  }
  return out
}

const srcFiles = collectFiles(path.join(projectRoot, 'src'))
const testFiles = collectFiles(path.join(projectRoot, 'tests'))
const scriptFiles = collectFiles(path.join(projectRoot, 'scripts'))
const sources = new Map()

for (const file of [...srcFiles, ...testFiles, ...scriptFiles]) {
  sources.set(file, fs.readFileSync(file, 'utf8'))
}

// 导出只在 src 里统计，测试文件只当引用来源
const exportsMap = new Map()
for (const file of srcFiles) {
  const text = sources.get(file)
  for (const matched of text.matchAll(/export\s+(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/g)) {
    exportsMap.set(matched[1], file)
  }
  for (const matched of text.matchAll(/export\s+const\s+([A-Za-z_$][\w$]*)/g)) {
    exportsMap.set(matched[1], file)
  }
  for (const matched of text.matchAll(/export\s*\{([^}]+)\}/g)) {
    for (const item of matched[1].split(',')) {
      const name = item.trim().split(/\s+as\s+/).pop().trim()
      if (/^[A-Za-z_$][\w$]*$/.test(name)) exportsMap.set(name, file)
    }
  }
}

const dead = []

for (const [name, definedIn] of exportsMap) {
  // 入口文件和 bot.js 这类纯出口文件不算死代码
  if (/(^|[\\/])(index|bot)\.js$/.test(definedIn)) continue

  const pattern = new RegExp(`\\b${name}\\b`)
  let usedElsewhere = false

  for (const [file, text] of sources) {
    if (file === definedIn) continue
    if (pattern.test(text)) {
      usedElsewhere = true
      break
    }
  }

  if (!usedElsewhere) {
    // 同文件里除了定义那一行还在用几次：>0 说明只是多写了 export
    const sameFileCount = [
      ...sources.get(definedIn).matchAll(new RegExp(`\\b${name}\\b`, 'g')),
    ].length
    dead.push({ name, file: path.relative(projectRoot, definedIn), internal: sameFileCount - 1 })
  }
}

if (dead.length === 0) {
  console.log('没有发现未被引用的导出。')
  process.exit(0)
}

const onlyExport = dead.filter((item) => item.internal > 0)
const reallyDead = dead.filter((item) => item.internal <= 0)

console.log(`共 ${dead.length} 个导出没有跨文件引用：\n`)

if (onlyExport.length > 0) {
  console.log(`── 文件内部还在用，只是多写了 export（${onlyExport.length} 个）：去掉 export 即可 ──`)
  const grouped = new Map()
  for (const item of onlyExport) {
    if (!grouped.has(item.file)) grouped.set(item.file, [])
    grouped.get(item.file).push(item.name)
  }
  for (const [file, names] of [...grouped].sort()) console.log(`${file}\n  ${names.join(' ')}`)
  console.log('')
}

if (reallyDead.length > 0) {
  console.log(`── 整个项目都没用过（${reallyDead.length} 个）：可以直接删 ──`)
  const grouped = new Map()
  for (const item of reallyDead) {
    if (!grouped.has(item.file)) grouped.set(item.file, [])
    grouped.get(item.file).push(item.name)
  }
  for (const [file, names] of [...grouped].sort()) console.log(`${file}\n  ${names.join(' ')}`)
  console.log('')
}

console.log('注意：同名局部变量会造成误报，删之前搜一遍确认。')
