/** High-level live execution stage derived from the current Chat nodes. */
import type {
  AssistantChatData, ChatConversationViewNode, ChatNode,
} from '../contract/chat-nodes.ts'
import type { ProcessActivity } from '../contract/process-groups.ts'
import type {} from './assistant.ts'
import type {} from './request-prompt.ts'
import type {} from './retry.ts'
import type {} from './tool.ts'
import { isLocalRequestProvider } from './request-prompt.ts'
import { processActivity, processActivityForTool } from './process-activity.ts'

/** A user-facing stage; it never contains model reasoning or tool arguments. */
export type ExecutionFeedback =
  | { readonly kind: 'preparing' }
  | { readonly kind: 'waiting-local' }
  | { readonly kind: 'retrying' }
  | { readonly kind: 'thinking' }
  | { readonly kind: 'responding' }
  | { readonly kind: 'tool'; readonly activity: ProcessActivity }

/** The current turn and Assistant-step projection already owned by the timeline. */
export interface ActiveExecutionStep {
  readonly turn: number
  readonly assistant: AssistantChatData | undefined
}

function openTurn(node: ChatConversationViewNode): number | undefined {
  const location = node.location
  return (location.kind === 'turn' || location.kind === 'step') && location.turn.status === 'open'
    ? location.turn.turn
    : undefined
}

function isAssistantStepNode(node: ChatNode): node is ChatNode<'assistant-step'> {
  return node.kind === 'assistant-step'
}

function latestAssistant(nodes: readonly ChatNode[]): ChatNode<'assistant-step'> | undefined {
  let latest: ChatNode<'assistant-step'> | undefined
  for (const node of nodes) {
    if (!isAssistantStepNode(node)) continue
    if (latest === undefined || node.data.step > latest.data.step
      || (node.data.step === latest.data.step && node.anchorSeq > latest.anchorSeq)) latest = node
  }
  return latest
}

function isRequestPromptNode(node: ChatConversationViewNode): node is ChatNode<'system-prompt'> {
  return node.kind === 'system-prompt'
}

function localRoute(nodes: readonly ChatConversationViewNode[]): boolean | undefined {
  let latestSeq = -1
  let local: boolean | undefined
  for (const node of nodes) {
    if (!isRequestPromptNode(node) || node.data.request === undefined) continue
    if (node.data.request.seq <= latestSeq) continue
    latestSeq = node.data.request.seq
    local = isLocalRequestProvider(node.data.request.provider)
  }
  return local
}

/**
 * Derive the active Session stage from Chat's existing event projections.
 * @param nodes - current Chat Nodes, including hidden Local route metadata.
 * @param active - current Turn and Assistant-step data from the Conversation timeline.
 * @returns the current high-level stage, or undefined when no Turn is open.
 */
export function executionFeedback(
  nodes: readonly ChatConversationViewNode[],
  active: ActiveExecutionStep | undefined,
): ExecutionFeedback | undefined {
  if (active === undefined) return undefined
  const turn = active.turn
  const current = nodes.filter((node): node is ChatNode => openTurn(node) === turn)
  const retry = current.some(node => node.kind === 'model-retry' && node.data.current.retryState === 'scheduled')
  if (retry) return { kind: 'retrying' }

  const activity = processActivity(current)
  if (activity.running !== undefined) return { kind: 'tool', activity: activity.running }

  const assistant = active.assistant ?? latestAssistant(current)?.data
  // request/header is recorded before the first Assistant stream event. Keep
  // the canonical Local route visible during prompt evaluation instead of
  // reporting request preparation for the whole prefill.
  if (assistant === undefined) {
    return localRoute(current) === true ? { kind: 'waiting-local' } : { kind: 'preparing' }
  }
  if (assistant.status !== 'running') return { kind: 'preparing' }
  const reasoning = assistant.blocks.some(block => block.kind === 'reasoning' && block.text.trim() !== '')
  if (reasoning) return { kind: 'thinking' }
  const response = assistant.blocks.some(block => block.kind === 'text' && block.text.trim() !== '')
  if (response) return { kind: 'responding' }
  const tool = assistant.blocks.findLast(block => block.kind === 'tool-call' && block.name !== '')
  if (tool?.kind === 'tool-call') return { kind: 'tool', activity: processActivityForTool(tool.name) }
  return localRoute(nodes) === true ? { kind: 'waiting-local' } : { kind: 'preparing' }
}
