// 统计 src 下所有 js 文件的行数、函数数量、import 依赖
const fs = require('fs');
const path = require('path');

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith('.js')) out.push(p);
  }
  return out;
}

const files = walk('src').sort();

function stripCommentsAndStrings(src) {
  // 粗略去除注释与字符串，便于匹配函数
  let out = '';
  let i = 0;
  while (i < src.length) {
    const c = src[i], n = src[i + 1];
    if (c === '/' && n === '/') { while (i < src.length && src[i] !== '\n') i++; continue; }
    if (c === '/' && n === '*') { i += 2; while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) i++; i += 2; continue; }
    if (c === '"' || c === "'" || c === '`') {
      const q = c; out += ' '; i++;
      while (i < src.length) {
        if (src[i] === '\\') { i += 2; continue; }
        if (src[i] === q) { i++; break; }
        i++;
      }
      continue;
    }
    out += c; i++;
  }
  return out;
}

const report = [];

for (const f of files) {
  const raw = fs.readFileSync(f, 'utf8');
  const lines = raw.split(/\r?\n/);
  const totalLines = lines.length;
  const codeLines = lines.filter(l => l.trim() !== '').length;

  const code = stripCommentsAndStrings(raw);

  const fns = [];

  // function foo(...)
  let m;
  const reFunc = /(?:^|\n)\s*(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)\s*\(/g;
  while ((m = reFunc.exec(code))) fns.push({ name: m[1], kind: 'function' });

  // 顶层 const foo = (…) => / function
  const reVarFn = /(?:^|\n)\s*(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s+)?(?:function\s*\(|\([^)]*\)\s*=>|[A-Za-z_$][\w$]*\s*=>)/g;
  while ((m = reVarFn.exec(code))) fns.push({ name: m[1], kind: 'arrow/var-fn' });

  // 对象方法 / 类方法： name(...) {    （排除 if/for/while/switch/catch 等）
  const KEYWORDS = new Set(['if','for','while','switch','catch','function','return','typeof','new','do','else','try','with','await','in','of','constructor']);
  const reMethod = /(?:^|\n)\s*(?:static\s+|async\s+|get\s+|set\s+)*([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*\{/g;
  while ((m = reMethod.exec(code))) {
    if (!KEYWORDS.has(m[1])) fns.push({ name: m[1], kind: 'method' });
  }

  // 去重（同名同类型只留一个计数，但保留所有出现位置统计）
  const seen = new Set();
  const uniq = [];
  for (const fn of fns) {
    const k = fn.kind + ':' + fn.name;
    if (seen.has(k)) continue;
    seen.add(k);
    uniq.push(fn);
  }

  // import 依赖
  const localImports = [];
  const npmImports = [];
  const nodeImports = [];
  const reImp = /(?:import\s+(?:[\s\S]*?)\s+from\s+|import\s+|require\(\s*)['"`]([^'"`]+)['"`]/g;
  while ((m = reImp.exec(raw))) {
    const dep = m[1];
    if (dep.startsWith('./') || dep.startsWith('../')) localImports.push(dep);
    else if (dep.startsWith('node:') || require('module').builtinModules.includes(dep.split('/')[0])) nodeImports.push(dep);
    else npmImports.push(dep);
  }

  report.push({
    file: f.replace(/\\/g, '/'),
    totalLines,
    codeLines,
    fnCount: uniq.length,
    fns: uniq,
    local: [...new Set(localImports)],
    npm: [...new Set(npmImports)],
    node: [...new Set(nodeImports)],
  });
}

fs.writeFileSync('reports-src.json', JSON.stringify(report, null, 2), 'utf8');

// 输出摘要
console.log('文件 | 总行 | 非空行 | 函数 | import');
let sumL = 0, sumC = 0, sumF = 0;
for (const r of report) {
  sumL += r.totalLines; sumC += r.codeLines; sumF += r.fnCount;
  console.log(`${r.file} | ${r.totalLines} | ${r.codeLines} | ${r.fnCount} | ${r.local.length + r.npm.length + r.node.length}`);
}
console.log(`合计 | ${sumL} | ${sumC} | ${sumF}`);
