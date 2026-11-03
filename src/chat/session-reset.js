import { clearMerged } from './merge.js'
import { clearPending } from './pending.js'
import { clearTodos } from './todos.js'
import { clearChoice } from './choices.js'
import { reset as resetMemory } from '../memory/memory.js'
import { clearSituations } from '../memory/situations.js'

/**
 * 「忘掉之前的事」要清干净：记忆、任务清单、待选状态、没发完的分段、
 * 攒着的连发批次、还没了结的情绪记录——少清一样，下一轮就会串味。
 */
export function resetSession(sessionKey) {
  resetMemory(sessionKey)
  clearTodos(sessionKey)
  clearChoice(sessionKey)
  clearPending(sessionKey)
  clearSituations(sessionKey)
  clearMerged(sessionKey)
}
