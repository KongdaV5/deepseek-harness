/** Session-persisted, non-secret Codex thread ownership and recovery facts. */
export interface CodexSessionMappingState {
  /** Verified producer runtime; absent legacy mappings have no cross-runtime resume evidence. */
  readonly runtimeFingerprint?: string | null | undefined
  readonly generation: number
  /** Persistent DSH-managed authentication epoch; null denotes a legacy mapping. */
  readonly authGeneration: string | null
  readonly activeThreadId: string | null
  readonly retiredThreadIds: readonly string[]
  readonly workspaceIdentity: string | null
  readonly cwd: string | null
  readonly latestTurnId: string | null
  /** Last canonical DSH transcript message acknowledged in Codex's private thread. */
  readonly committedMessageId: string | null
  readonly pendingSync: {
    readonly hash: string
    readonly fromMessageId: string | null
    readonly toMessageId: string
  } | null
  readonly dispatch: {
    readonly status: 'intent' | 'accepted' | 'uncertain'
    readonly threadId: string
    readonly turnId: string | null
    readonly dshTurn: number
    /** DSH step which admitted this dispatch; absent only on older mappings. */
    readonly dshStep?: number | undefined
    readonly model: string
    readonly effort: string
    readonly inputHash: string
    readonly workspaceIdentity: string | null
    readonly cwd: string
    /** Stable correlation ID sent as App Server clientUserMessageId. */
    readonly clientUserMessageId?: string | undefined
    /** Canonical DSH user message represented by this external dispatch. */
    readonly messageId?: string | undefined
  } | null
  /** Last authoritative terminal resolution, retained to make recovery idempotent. */
  readonly lastReconciliation: {
    readonly status: 'completed' | 'interrupted' | 'failed' | 'unknown'
    readonly threadId: string
    readonly turnId: string | null
    readonly clientUserMessageId: string
    readonly dshTurn: number
    readonly dshStep?: number | undefined
    readonly messageId: string
    readonly inputHash: string
    readonly model: string
    readonly effort: string
    readonly workspaceIdentity: string | null
    readonly cwd: string
    readonly sideEffectCount: number
    readonly sideEffectKinds: readonly ('commandExecution' | 'fileChange' | 'other')[]
  } | null
  /** Latest committed assistant settlement; optional in older persisted mapping events. */
  readonly lastAssistantSettlement?: {
    readonly turn: number
    readonly step: number
  } | null
  readonly bootstrap: {
    readonly fromMessageId: string | null
    readonly toMessageId: string | null
    readonly messageCount: number
    readonly truncated: boolean
  } | null
}

/** Official ChatGPT subscription connectivity known to the isolated runtime. */
export type CodexAccountState = 'not-connected' | 'connected' | 'reauth-required' | 'error'
/** Lifecycle phase of the DSH-owned Codex App Server process. */
export type CodexRuntimeState =
  | 'stopped' | 'starting' | 'initializing' | 'auth-check' | 'catalog-loading'
  | 'ready' | 'stopping' | 'crashed' | 'error'

/** User preference for choosing one fixed App Server binary at connection start. */
export type CodexRuntimePreference = 'auto' | 'system' | 'bundled'
/** Runtime source pinned to the currently active App Server connection. */
export type CodexRuntimeSource = 'system' | 'bundled'

/** One usage window exposed by the official App Server without account identity. */
export interface CodexUsageWindow {
  readonly usedPercent: number
  readonly windowDurationMins?: number
  readonly resetsAt?: number
}

/** Optional usage-limit snapshot; unavailable quota data does not affect routing. */
export interface CodexUsageStatus {
  readonly state: 'available' | 'unavailable'
  readonly primary?: CodexUsageWindow
  readonly secondary?: CodexUsageWindow
}

/** Renderer-safe Codex subscription snapshot. It contains no auth material or URL. */
export interface CodexSubscriptionStatus {
  readonly enabled: boolean
  readonly runtime: CodexRuntimeState
  readonly runtimePreference: CodexRuntimePreference
  readonly runtimeSource?: CodexRuntimeSource
  readonly runtimeVersion?: string
  readonly systemRuntimeAvailable: boolean
  readonly systemRuntimeVersion?: string
  readonly bundledRuntimeVersion: string
  readonly runtimeSelectionNote?: string
  readonly account: CodexAccountState
  readonly login: 'idle' | 'signing-in'
  readonly accountLabel?: string
  readonly modelCount: number
  readonly usage: CodexUsageStatus
  readonly error?: string
}

/** Result of opening the official ChatGPT subscription sign-in flow. */
export interface CodexLoginStartResult {
  readonly status: 'signing-in' | 'connected'
}

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionStateMap {
    /** Private, non-secret mapping of one DSH Session to its Codex runtime projection. */
    codexSubscription: CodexSessionMappingState
  }
}

/** Legacy wire events may omit the auth epoch; projection readers normalize it to null. */
type CodexSessionMappingEvent = Omit<CodexSessionMappingState, 'authGeneration'> & {
  readonly authGeneration?: string | null | undefined
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /** Whole non-secret Codex mapping state; optional readers may skip it safely. */
    'plugin:codex/subscription-state': { readonly state: CodexSessionMappingEvent }
  }
  interface IgnorableSessionEventMap {
    'plugin:codex/subscription-state': { readonly state: CodexSessionMappingEvent }
  }
}
