import { Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Session, UserMessage } from '@deepseek-ai/dsh-session'
import { SessionId, SessionStore } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import TaskCheckpoint from '@deepseek-ai/dsh-task-checkpoint'
import { afterEach, describe, expect, it, vi } from 'vitest'

const contexts: Context[] = []

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
})

async function runtime(maxAutoContinuations = 2): Promise<{ ctx: Context; session: Session }> {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(TaskCheckpoint, { maxAutoContinuations })
  return { ctx, session: ctx.sessions.create(SessionId(`auto-continuation-${contexts.length}`)) }
}

function humanMessage(text: string): UserMessage {
  return createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
}

async function stopAtLimit(ctx: Context, agent: Agent, turn: number, kind: 'max-tokens' | 'completed' = 'max-tokens') {
  await ctx.serial('agent/turn-stopping', {
    agent,
    turn,
    reason: { kind },
    signal: new AbortController().signal,
  })
}

describe('bounded automatic continuation', () => {
  it('queues at most the configured number of new turns and records each attempt durably', async () => {
    const { ctx, session } = await runtime(2)
    session.append('user/message', humanMessage('Implement a multi-step change.'), { surfaceOp: 'append' })
    const pending: UserMessage[] = []
    const followup = vi.fn((message: UserMessage) => { pending.push(message) })
    const agent = { session, inbox: { nextTurn: pending, nextStep: [] }, followup } as unknown as Agent

    const prompt = await ctx.systemPrompt.assemble()
    const guidance = prompt.sections.find(section => section.name === 'task-checkpoint:auto-continuation')?.text ?? ''
    expect(guidance).toContain('.tmp/dsh-task-progress.md')
    expect(guidance).toContain('Update the file after each completed phase')
    expect(guidance).toContain('Keep user-facing progress to one short sentence')

    await stopAtLimit(ctx, agent, 1)
    expect(followup).toHaveBeenCalledTimes(1)
    expect(pending[0]).toMatchObject({
      source: { kind: 'task-auto-continuation', attempt: 1, maxAttempts: 2 },
    })
    expect(pending[0]?.content[0]).toMatchObject({ type: 'text' })
    const firstBlock = pending[0]?.content[0]
    expect(firstBlock?.type === 'text' ? firstBlock.text : '').toContain('1/2')

    session.append('user/message', pending.shift()!, { surfaceOp: 'append' })
    await stopAtLimit(ctx, agent, 2)
    expect(followup).toHaveBeenCalledTimes(2)
    expect(pending[0]).toMatchObject({
      source: { kind: 'task-auto-continuation', attempt: 2, maxAttempts: 2 },
    })

    session.append('user/message', pending.shift()!, { surfaceOp: 'append' })
    await stopAtLimit(ctx, agent, 3)
    expect(followup).toHaveBeenCalledTimes(2)
    expect(ctx.sessionProjections.stateOf(session, 'taskAutoContinuation')).toMatchObject({ attempt: 2, maxAttempts: 2, failure: null })
  })

  it('does not continue completed turns or compete with a pending user turn', async () => {
    const { ctx, session } = await runtime(2)
    session.append('user/message', humanMessage('Continue this task.'), { surfaceOp: 'append' })
    const pending: UserMessage[] = []
    const followup = vi.fn((message: UserMessage) => { pending.push(message) })
    const agent = { session, inbox: { nextTurn: pending, nextStep: [] }, followup } as unknown as Agent

    await stopAtLimit(ctx, agent, 1, 'completed')
    expect(followup).not.toHaveBeenCalled()

    pending.push(humanMessage('I have a new instruction.'))
    await stopAtLimit(ctx, agent, 1)
    expect(followup).not.toHaveBeenCalled()
  })

  it('leaves automatic continuation and its prompt disabled by default', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(TaskCheckpoint)
    const session = ctx.sessions.create(SessionId(`auto-continuation-off-${contexts.length}`))
    session.append('user/message', humanMessage('A long task.'), { surfaceOp: 'append' })
    const followup = vi.fn()
    const agent = { session, inbox: { nextTurn: [], nextStep: [] }, followup } as unknown as Agent

    await stopAtLimit(ctx, agent, 1)
    expect(followup).not.toHaveBeenCalled()
    const prompt = await ctx.systemPrompt.assemble()
    expect(prompt.sections.some(section => section.name === 'task-checkpoint:auto-continuation')).toBe(false)
  })
})
