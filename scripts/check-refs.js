#!/usr/bin/env node
// 静态引用检查：抓 node --check 抓不到的两类错误
//   1) 调用了但当前文件没定义的名字（改名/搬函数时最容易漏）
//   2) import 了但目标模块没导出的名字
// 用 pnpm check 跑，退出码非 0 表示有问题
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const srcDir = path.join(projectRoot, 'src')

const KEYWORDS = new Set([
  'if', 'for', 'while', 'switch', 'catch', 'function', 'return', 'typeof', 'await', 'new',
  'of', 'in', 'this', 'case', 'else', 'do', 'try', 'throw', 'delete', 'void', 'yield',
  'async', 'import', 'export', 'const', 'let', 'var', 'class', 'super', 'extends',
])

// Node 内置模块的常用别名 + 项目里容易漏 import 的关键导出。
// 用了却没 import，就是运行期 ReferenceError。
const CRITICAL_IMPORTS = [
  // Node 内置
  'fs', 'path', 'os', 'url', 'crypto', 'util', 'child_process', 'stream',
  // 项目里的高频名：漏一次就是「功能静默失效」
  'segment', 'bot', 'env',
]

const GLOBALS = new Set([
  'console', 'process', 'require', 'Math', 'JSON', 'Object', 'Array', 'String', 'Number',
  'Boolean', 'Date', 'Promise', 'Map', 'Set', 'WeakMap', 'WeakSet', 'Buffer', 'parseInt',
  'parseFloat', 'isNaN', 'setTimeout', 'setInterval', 'clearTimeout', 'clearInterval',
  'queueMicrotask', 'Error', 'TypeError', 'RangeError', 'RegExp', 'URL', 'URLSearchParams',
  'fetch', 'FormData', 'Blob', 'structuredClone', 'encodeURIComponent', 'decodeURIComponent',
  'Intl', 'AbortSignal', 'AbortController', 'TextEncoder', 'TextDecoder', 'Symbol', 'BigInt',
  'Reflect', 'Proxy', 'atob', 'btoa',
])

function collectFiles(dir) {
  const result = []

  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      result.push(...collectFiles(full))
      continue
    }
    if (entry.name.endsWith('.js')) result.push(full)
  }

  return result
}

// 剥掉字符串、模板串、注释和正则字面量，免得把文案里的词当成函数调用
function stripLiterals(source) {
  const BACKTICK = /`(?:[^`\\]|\\.)*`/g
  const SINGLE = /'(?:[^'\\\n]|\\.)*'/g
  const DOUBLE = /"(?:[^"\\\n]|\\.)*"/g
  const BLOCK = /\/\*[\s\S]*?\*\//g
  const LINE = /\/\/[^\n]*/g
  const REGEX_LITERAL = /(?<![)\w$\]])\/(?![*/])(?:[^/\\\n[]|\\.|\[[^\]]*\])+\/[gimsuy]*/g

  return source
    .replace(BACKTICK, '``')
    .replace(SINGLE, "''")
    .replace(DOUBLE, '""')
    .replace(BLOCK, '')
    .replace(LINE, '')
    .replace(REGEX_LITERAL, '//')
}

function addNamesFromList(list, into) {
  for (const part of String(list).split(',')) {
    const cleaned = part
      .trim()
      .replace(/=.*$/, '')
      .replace(/^\.\.\./, '')
      .trim()

    if (!cleaned) continue

    if (cleaned.startsWith('{') || cleaned.startsWith('[')) {
      for (const inner of cleaned.split(/[{}\[\]]/)) {
        for (const piece of inner.split(',')) {
          const name = piece.split(':').pop().split('=')[0].trim()
          if (/^[A-Za-z_$][\w$]*$/.test(name)) into.add(name)
        }
      }
      continue
    }

    if (/^[A-Za-z_$][\w$]*$/.test(cleaned)) into.add(cleaned)
  }
}

function collectParams(source, into) {
  for (const matched of source.matchAll(/function\s*[\w$]*\s*\(([^)]*)\)/g)) addNamesFromList(matched[1], into)
  for (const matched of source.matchAll(/\(([^)]*)\)\s*=>/g)) addNamesFromList(matched[1], into)
  for (const matched of source.matchAll(/\(?\s*([A-Za-z_$][\w$]*(?:\s*,\s*[A-Za-z_$][\w$]*)*)\s*\)?\s*=>/g)) {
    addNamesFromList(matched[1], into)
  }
  for (const matched of source.matchAll(/([A-Za-z_$][\w$]*)\s*=>/g)) into.add(matched[1])
  for (const matched of source.matchAll(/catch\s*\(([^)]*)\)/g)) addNamesFromList(matched[1], into)
}

function collectDefinitions(source, into) {
  for (const matched of source.matchAll(/function\s+([A-Za-z_$][\w$]*)/g)) into.add(matched[1])
  // 对象字面量里的方法简写：load() { ... }、save(state) { ... }
  for (const matched of source.matchAll(/(?:^|[{,]\s*)([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*\{/gm)) {
    into.add(matched[1])
  }
  for (const matched of source.matchAll(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g)) into.add(matched[1])

  // 解构赋值：const { a, b: c } = obj / const [x, y] = arr
  for (const matched of source.matchAll(/(?:const|let|var)\s*\{([^}]*)\}/g)) {
    for (const part of matched[1].split(',')) {
      const name = part.split(':').pop().split('=')[0].replace(/^\.{3}/, '').trim()
      if (/^[A-Za-z_$][\w$]*$/.test(name)) into.add(name)
    }
  }
  for (const matched of source.matchAll(/(?:const|let|var)\s*\[([^\]]*)\]/g)) {
    for (const part of matched[1].split(',')) {
      const name = part.split('=')[0].replace(/^\.{3}/, '').trim()
      if (/^[A-Za-z_$][\w$]*$/.test(name)) into.add(name)
    }
  }
  for (const matched of source.matchAll(/import\s+\{([^}]+)\}/g)) {
    for (const item of matched[1].split(',')) into.add(item.trim().split(/\s+as\s+/).pop().trim())
  }
  for (const matched of source.matchAll(/import\s+\*\s+as\s+([A-Za-z_$][\w$]*)/g)) into.add(matched[1])
  for (const matched of source.matchAll(/import\s+([A-Za-z_$][\w$]*)\s+from/g)) into.add(matched[1])
}

function collectExports(source) {
  const names = new Set()

  for (const matched of source.matchAll(/export\s+(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/g)) names.add(matched[1])
  for (const matched of source.matchAll(/export\s+(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g)) names.add(matched[1])
  for (const matched of source.matchAll(/export\s*\{([^}]+)\}/g)) {
    for (const item of matched[1].split(',')) names.add(item.trim().split(/\s+as\s+/).pop().trim())
  }

  return names
}

const files = collectFiles(srcDir)
const exportsOf = new Map()
for (const file of files) {
  exportsOf.set(file, collectExports(fs.readFileSync(file, 'utf8')))
}

const problems = []

for (const file of files) {
  const raw = fs.readFileSync(file, 'utf8')
  const src = stripLiterals(raw)
  const rel = path.relative(projectRoot, file)

  const defined = new Set()
  collectDefinitions(src, defined)
  collectParams(src, defined)

  // ① 调用了但没定义
  for (const matched of src.matchAll(/(?<![.\w$])([a-z][A-Za-z0-9_$]*)\s*\(/g)) {
    const name = matched[1]
    if (KEYWORDS.has(name) || GLOBALS.has(name) || defined.has(name)) continue
    problems.push(`${rel}: 调用了未定义的 ${name}()`)
  }

  // ③ 用了但没 import 的关键标识符。
  // ① 那条只抓 `name(` 形式，`fs.readdirSync(...)`、`segment.at(...)` 这种
  // 成员访问会整个漏掉——漏了就是运行期 ReferenceError，被 catch 吞掉后
  // 表现成「功能静默失效」，查起来极慢。
  //
  // 只查清单里的名字，不做「所有未定义标识符」的通用检查：那个误报太多，
  // 解构、剩余参数、for-of 都要精确识别才不误伤，维护成本高过收益。
  for (const name of CRITICAL_IMPORTS) {
    if (defined.has(name)) continue
    if (!new RegExp(`(?<![.\\w$])${name}\\s*[.(]`).test(src)) continue
    problems.push(`${rel}: 用了 ${name} 但当前文件没有 import / 定义`)
  }

  // ② import 的名字目标模块没导出
  for (const matched of raw.matchAll(/import\s+\{([^}]+)\}\s+from\s+'(\.[^']+)'/g)) {
    const target = path.resolve(path.dirname(file), matched[2])
    const exported = exportsOf.get(target)
    if (!exported) continue

    for (const item of matched[1].split(',')) {
      const name = item.trim().split(/\s+as\s+/)[0].trim()
      if (!name || exported.has(name)) continue
      problems.push(`${rel}: 从 ${path.relative(projectRoot, target)} 导入的 ${name} 没有导出`)
    }
  }
}

const unique = [...new Set(problems)]

if (unique.length === 0) {
  console.log(`引用检查通过（扫描 ${files.length} 个文件）`)
  process.exit(0)
}

console.error(`发现 ${unique.length} 处引用问题：`)
for (const line of unique) console.error(`  ${line}`)
process.exit(1)
