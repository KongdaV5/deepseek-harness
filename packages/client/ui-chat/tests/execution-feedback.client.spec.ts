import { describe, expect, it } from 'vitest'
import type { ChatNode } from '../src/client/contract/chat-nodes.ts'
import { chatSnapshotFixture } from './chat-snapshot-fixture.client.ts'
import { executionFeedback } from '../src/client/conversation-nodes/execution-feedback.ts'
import type {} from '../src/client/conversation-nodes/assistant.ts'
import type {} from '../src/client/conversation-nodes/request-prompt.ts'
import type {} from '../src/client/conversation-nodes/tool.ts'
import type { RunningToolCall } from '@deepseek-ai/dsh-client-ui-conversation/client'

const turn = chatSnapshotFixture({ partial: { turn: 1, step: 1, blocks: [] } }).timeline.turns.get(1)
if (turn === undefined) throw new Error('fixture must create an open Turn')
const location = { kind: 'turn' as const, turn }
const base = { target: 'chat' as const, location, visibility: 'hidden' as const }

function route(provider: string, seq: number): ChatNode<'system-prompt'> {
  return {
    ...base, kind: 'system-prompt', key: `route:${seq}`, id: `route:${seq}`, anchorSeq: seq,
    data: { text: '', request: { provider, model: 'model', seq } },
  }
}

function assistant(blocks: ChatNode<'assistant-step'>['data']['blocks']): ChatNode<'assistant-step'> {
  return {
    ...base, kind: 'assistant-step', key: 'assistant:1:1', id: '1:1', anchorSeq: 2,
    data: { status: 'running', turn: 1, step: 1, blocks, time: 2 },
  }
}

describe('live execution feedback', () => {
  it('shows a Local wait after the canonical request route before Assistant streaming starts', () => {
    expect(executionFeedback([route('local', 1)], { turn: 1, assistant: undefined }))
      .toEqual({ kind: 'waiting-local' })
    expect(executionFeedback([route('dsh-local-huihui', 1)], { turn: 1, assistant: undefined }))
      .toEqual({ kind: 'waiting-local' })
    expect(executionFeedback([route('local-huihui-qwen', 1)], { turn: 1, assistant: undefined }))
      .toEqual({ kind: 'waiting-local' })
    expect(executionFeedback([route('codex', 1)], { turn: 1, assistant: undefined }))
      .toEqual({ kind: 'preparing' })
  })

  it('distinguishes Local wait, model reasoning, and reply generation without exposing reasoning text', () => {
    const local = route('local', 1)
    expect(executionFeedback([local], { turn: 1, assistant: assistant([]).data })).toEqual({ kind: 'waiting-local' })
    const secretReasoning = assistant([{ kind: 'reasoning', text: 'private model reasoning' }])
    expect(executionFeedback([local], { turn: 1, assistant: secretReasoning.data })).toEqual({ kind: 'thinking' })
    expect(JSON.stringify(executionFeedback([local], { turn: 1, assistant: secretReasoning.data })))
      .not.toContain('private model reasoning')
    expect(executionFeedback([local], {
      turn: 1, assistant: assistant([{ kind: 'text', text: 'OK' }]).data,
    })).toEqual({ kind: 'responding' })
  })

  it('uses a live Tool call while it runs', () => {
    const emptyAssistant = assistant([])
    const call: RunningToolCall = {
      phase: 'start', callId: 'read-1', name: 'read', turn: 1, step: 1, time: 3, argsRaw: '{}', subCalls: [],
    }
    const tool: ChatNode<'tool-call'> = {
      ...base, kind: 'tool-call', key: 'tool:read-1', id: 'read-1', anchorSeq: 3,
      data: { root: call },
    }
    expect(executionFeedback([route('local', 1), tool], { turn: 1, assistant: emptyAssistant.data }))
      .toEqual({ kind: 'tool', activity: 'read' })
  })
})
