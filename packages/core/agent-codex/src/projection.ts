/** Pure fold for the optional Codex provider mapping on each canonical DSH Session. */

import { z } from 'zod'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import type { CodexSessionMappingState } from './types.ts'

/** Strict non-secret mapping schema shared by native projection and incoming migration. */
export const mappingSchema: z.ZodType<CodexSessionMappingState> = z.object({
  runtimeFingerprint: z.string().length(64).nullable().optional(),
  generation: z.number().int().nonnegative(),
  authGeneration: z.string().min(1).nullable().default(null),
  activeThreadId: z.string().nullable(),
  retiredThreadIds: z.array(z.string()).max(16),
  workspaceIdentity: z.string().nullable().default(null),
  cwd: z.string().nullable(),
  latestTurnId: z.string().nullable().default(null),
  committedMessageId: z.string().min(1).nullable(),
  pendingSync: z.object({
    hash: z.string().length(64),
    fromMessageId: z.string().min(1).nullable(),
    toMessageId: z.string().min(1),
  }).strict().nullable(),
  dispatch: z.object({
    status: z.enum(['intent', 'accepted', 'uncertain']),
    threadId: z.string().min(1),
    turnId: z.string().nullable(),
    dshTurn: z.number().int().nonnegative(),
    dshStep: z.number().int().nonnegative().optional(),
    model: z.string().min(1),
    effort: z.string().min(1),
    inputHash: z.string().length(64),
    workspaceIdentity: z.string().min(1).nullable().default(null),
    cwd: z.string().min(1),
    clientUserMessageId: z.string().min(1).optional(),
    messageId: z.string().min(1).optional(),
  }).strict().nullable(),
  lastReconciliation: z.object({
    status: z.enum(['completed', 'interrupted', 'failed', 'unknown']),
    threadId: z.string().min(1),
    turnId: z.string().nullable(),
    clientUserMessageId: z.string().min(1),
    dshTurn: z.number().int().nonnegative(),
    dshStep: z.number().int().nonnegative().optional(),
    messageId: z.string().min(1),
    inputHash: z.string().length(64),
    model: z.string().min(1),
    effort: z.string().min(1),
    workspaceIdentity: z.string().min(1).nullable(),
    cwd: z.string().min(1),
    sideEffectCount: z.number().int().nonnegative(),
    sideEffectKinds: z.array(z.enum(['commandExecution', 'fileChange', 'other'])).max(16),
  }).strict().nullable().default(null),
  lastAssistantSettlement: z.object({
    turn: z.number().int().nonnegative(),
    step: z.number().int().nonnegative(),
  }).strict().nullable().default(null),
  bootstrap: z.object({
    fromMessageId: z.string().min(1).nullable(),
    toMessageId: z.string().min(1).nullable(),
    messageCount: z.number().int().nonnegative(),
    truncated: z.boolean(),
  }).strict().nullable(),
}).strict()

/** Empty projection used before a DSH Session owns a Codex App Server thread. */
export const EMPTY_CODEX_MAPPING: CodexSessionMappingState = {
  generation: 0,
  authGeneration: null,
  activeThreadId: null,
  retiredThreadIds: [],
  workspaceIdentity: null,
  cwd: null,
  latestTurnId: null,
  committedMessageId: null,
  pendingSync: null,
  dispatch: null,
  lastReconciliation: null,
  lastAssistantSettlement: null,
  bootstrap: null,
}

/** Fold the non-secret Codex thread mapping from ignorable Session events. */
export const codexSubscriptionProjection = {
  key: 'codexSubscription',
  stateVersion: 4,
  stateSchema: mappingSchema,
  init: () => EMPTY_CODEX_MAPPING,
  apply: (state, event) => {
    if (event.type === 'plugin:codex/subscription-state') {
      return {
        ...mappingSchema.parse(event.data.state),
        authGeneration: event.data.state.authGeneration ?? null,
        lastAssistantSettlement: event.data.state.lastAssistantSettlement ?? state.lastAssistantSettlement ?? null,
      }
    }
    if (event.type === 'assistant/message') {
      return { ...state, lastAssistantSettlement: { turn: event.data.turn, step: event.data.step } }
    }
    return state
  },
} satisfies ProjectionDefinition<'codexSubscription', CodexSessionMappingState>

/** Fail-closed persisted recovery classification for the future execution owner.
 * @param state Restored mapping at one canonical Session cursor.
 * @returns Recovery obligation; this function never authorizes or performs a dispatch.
 */
export function codexMappingRecovery(state: CodexSessionMappingState): 'unbound' | 'reconciliation-required' | 'settled' {
  if (state.dispatch !== null || state.pendingSync !== null) return 'reconciliation-required'
  const reconciliation = state.lastReconciliation
  const settlement = state.lastAssistantSettlement
  const delivered = reconciliation !== null && settlement?.turn === reconciliation.dshTurn
    && (reconciliation.dshStep === undefined || settlement.step === reconciliation.dshStep)
  if (reconciliation !== null && (reconciliation.status === 'unknown'
    || reconciliation.status === 'completed' && !delivered)) return 'reconciliation-required'
  return state.authGeneration === null ? 'unbound' : 'settled'
}
