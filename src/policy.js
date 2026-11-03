import { env } from './env.js'

const OPEN = { scopes: ['private', 'group'], readOnly: false }
const READ_ONLY = { scopes: ['private', 'group'], readOnly: true }
const PRIVATE_ONLY = { scopes: ['private'], readOnly: false }
const GROUP_ONLY = { scopes: ['group'], readOnly: true }

// 高危工具：能执行命令、改文件、装包、挂 MCP、写技能（会影响后续提示词）的一律走白名单
// 另外 start_task / schedule_task 也在这里：否则群友能借子 agent 或定时任务绕过限制
export const DANGEROUS_TOOLS = new Set([
  'shell',
  'run_script',
  'write_file',
  'edit_file',
  'write_skill',
  'install_package',
  'add_mcp',
  'start_task',
  'schedule_task',
  'restart_self',
  'send_to_group',
  'broadcast',
  'git_sync',
])

// 管理员判定：配了白名单就只认名单，没配就只认私聊
export function isAdmin(scope, actor) {
  const admins = env.adminOpenIds
  if (admins.length > 0) return Boolean(actor) && admins.includes(String(actor))
  return scope === 'private'
}

function dangerAllowed(scope, actor) {
  // 定时任务到点执行，视为建任务的人已授权
  if (actor === 'scheduler') return true

  const admins = env.adminOpenIds
  if (admins.length > 0) return Boolean(actor) && admins.includes(String(actor))
  if (scope === 'group') return env.shellGroupEnabled
  return true
}

const SHELL = {
  scopes: ['private', 'group'],
  readOnly: false,
}

export const TOOL_POLICY = {
  search: READ_ONLY,
  fetch: READ_ONLY,
  now: READ_ONLY,
  weather: READ_ONLY,
  exchange: READ_ONLY,
  calc: READ_ONLY,
  timezone: READ_ONLY,
  dns: READ_ONLY,

  remember: OPEN,
  note_situation: OPEN,
  ask_choice: OPEN,
  todo_write: OPEN,
  read_group_history: GROUP_ONLY,
  read_profile: GROUP_ONLY,
  list_groups: READ_ONLY,
  send_to_group: OPEN,
  broadcast: OPEN,
  git_sync: OPEN,
  goal: OPEN,
  send_image: OPEN,
  send_audio: OPEN,
  send_video: OPEN,
  send_file: OPEN,
  send_card: OPEN,
  draw_pixel: OPEN,
  fortune: OPEN,
  song: READ_ONLY,
  group_recent_speakers: READ_ONLY,
  speak: OPEN,
  clear_memory: OPEN,
  download: OPEN,
  read_document: READ_ONLY,

  shell: SHELL,
  run_script: SHELL,
  restart_self: SHELL,

  start_task: OPEN,
  schedule_task: OPEN,
  list_schedules: READ_ONLY,
  remove_schedule: OPEN,

  write_file: OPEN,
  edit_file: OPEN,
  read_file: READ_ONLY,
  list_dir: READ_ONLY,

  write_skill: OPEN,
  list_skills: READ_ONLY,
  add_mcp: OPEN,
  list_mcp: READ_ONLY,
  install_package: OPEN,
}

export const SCOPE_LABEL = {
  private: '私聊',
  group: '群聊',
}

export function isToolAllowed(toolName, scope, actor = '') {
  const rule = TOOL_POLICY[toolName]
  if (!rule) return scope === 'private'
  if (!rule.scopes.includes(scope)) return false
  if (DANGEROUS_TOOLS.has(toolName)) return dangerAllowed(scope, actor)
  return true
}

// 被拒时给出可执行的原因，别只回一句「不可用」
export function denyReason(toolName, scope, actor = '') {
  const rule = TOOL_POLICY[toolName]

  if (rule && !rule.scopes.includes(scope)) {
    const allowed = rule.scopes.map((item) => SCOPE_LABEL[item] ?? item).join('、')
    return `工具 ${toolName} 只能在${allowed}用，当前是${SCOPE_LABEL[scope] ?? scope}`
  }

  if (DANGEROUS_TOOLS.has(toolName)) {
    if (env.adminOpenIds.length > 0) {
      return (
        `工具 ${toolName} 需要管理员权限：你的 openid ${actor || '未知'} 不在 ADMIN_OPENIDS 名单里。` +
        '让管理员把这串 openid 加进 .env 后重启。'
      )
    }
    return `工具 ${toolName} 需要管理员权限：服务器还没配 ADMIN_OPENIDS，群里默认禁用（私聊可用）`
  }

  return `工具 ${toolName} 在${SCOPE_LABEL[scope] ?? scope}场景不可用`
}

export function filterTools(tools, scope, actor = '') {
  return tools.filter((tool) => isToolAllowed(tool.name, scope, actor))
}

export function describePolicy(toolNames) {
  return toolNames
    .map((name) => {
      const rule = TOOL_POLICY[name] ?? PRIVATE_ONLY
      const scopes = rule.scopes.map((scope) => SCOPE_LABEL[scope]).join('/')
      const guard = DANGEROUS_TOOLS.has(name) ? '/仅管理员' : ''
      return `${name}(${scopes}${guard})`
    })
    .join(' ')
}

export function describeAdminPolicy() {
  const admins = env.adminOpenIds

  if (admins.length > 0) return `高危工具仅限 ${admins.length} 个白名单 openid（ADMIN_OPENIDS）`
  if (env.shellGroupEnabled) return '未设 ADMIN_OPENIDS，高危工具已对所有人放开（含群聊），风险很高'
  return '未设 ADMIN_OPENIDS，高危工具只在私聊可用，群里禁用；建议配 ADMIN_OPENIDS'
}
