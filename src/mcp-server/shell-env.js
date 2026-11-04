// 子进程只需要最基本的环境变量。模型 key、QQ 密钥一个都不往里传：
// 拿到 key 就能冒充机器人调 API，拿到 QQ 密钥就能顶掉它的连接。
//
// 这份白名单同时被 shell、后台命令、装包、脚本执行使用。
// 每多放一个变量，就多一条从「能跑命令」到「能拿到凭据」的路。

const isWindows = process.platform === 'win32'

function pick(name) {
  const value = process.env[name]
  return typeof value === 'string' && value ? value : ''
}

export function shellSafeEnv(overrides = {}) {
  const base = {
    PATH: process.env.PATH ?? (isWindows ? '' : '/usr/local/bin:/usr/bin:/bin'),
    LANG: process.env.LANG ?? 'C.UTF-8',
    TERM: process.env.TERM ?? 'dumb',
  }

  if (isWindows) {
    // Windows 上缺这几个，cmd 和 pnpm 直接跑不起来
    for (const name of ['SYSTEMROOT', 'SystemRoot', 'PATHEXT', 'COMSPEC', 'APPDATA', 'LOCALAPPDATA', 'USERPROFILE', 'TEMP', 'TMP']) {
      const value = pick(name)
      if (value) base[name] = value
    }
  } else {
    base.HOME = process.env.HOME || '/tmp'
    base.TMPDIR = process.env.TMPDIR || '/tmp'
  }

  // pnpm / npm 靠这几个找缓存和全局目录，不给就会重新下载一遍
  for (const name of ['XDG_CACHE_HOME', 'PNPM_HOME', 'NODE_PATH', 'NPM_CONFIG_CACHE']) {
    const value = pick(name)
    if (value) base[name] = value
  }

  return { ...base, ...overrides }
}
