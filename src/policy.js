import { env } from './env.js'

const OPEN = { scopes: ['private', 'group'], readOnly: false }
const READ_ONLY = { scopes: ['private', 'group'], readOnly: true }
const PRIVATE_ONLY = { scopes: ['private'], readOnly: false }

// 执行任意命令，默认只给私聊。要开放到群聊需在 .env 设 SHELL_GROUP_ENABLED=true
const SHELL = {
  scopes: env.shellGroupEnabled ? ['private', 'group'] : ['private'],
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
  goal: OPEN,
  send_image: OPEN,
  send_audio: OPEN,
  send_video: OPEN,
  send_file: OPEN,
  send_card: OPEN,
  speak: OPEN,
  clear_memory: OPEN,
  download: OPEN,

  shell: SHELL,
  run_script: SHELL,

  start_task: OPEN,
  schedule_task: OPEN,
  list_schedules: READ_ONLY,
  remove_schedule: OPEN,

  write_file: OPEN,
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

export function isToolAllowed(toolName, scope) {
  const rule = TOOL_POLICY[toolName]
  if (!rule) return scope === 'private'
  return rule.scopes.includes(scope)
}

export function filterTools(tools, scope) {
  return tools.filter((tool) => isToolAllowed(tool.name, scope))
}

export function describePolicy(toolNames) {
  return toolNames
    .map((name) => {
      const rule = TOOL_POLICY[name] ?? PRIVATE_ONLY
      const scopes = rule.scopes.map((scope) => SCOPE_LABEL[scope]).join('/')
      return `${name}(${scopes})`
    })
    .join(' ')
}
