/** Public contracts for deterministic reasoning selection and context-pressure observation. */

/** Policy vocabulary before one backend maps it to its supported request values. */
export type ReasoningLevel = 'none' | 'off' | 'low' | 'medium' | 'high' | 'xhigh'

/** Canonical policy levels which may become an exact backend request value. */
export type CanonicalReasoningLevel = Exclude<ReasoningLevel, 'off'>

/** Why a decision won, or why a backend normalization changed it. */
export type ReasoningDecisionSource =
  | 'user-override'
  | 'benchmark-lock'
  | 'task-policy'
  | 'profile-default'
  | 'global-default'
  | 'gguf-template-confirmed'
  | 'gguf-backend-capability-fallback'
  | 'gguf-alias-normalization'
  | 'compaction-policy'
  | 'backend-default'

/** Deterministic request classes; none requires an LLM classification call. */
export type ReasoningTaskClass = 'simple' | 'normal' | 'complex' | 'long-output'

/** Stable, exact-model reasoning declaration supplied by an audited backend capability. */
export interface ModelReasoningCapability {
  /** Exact provider route that owns this capability declaration. */
  readonly provider: string
  /** Exact model identifier accepted by that provider route. */
  readonly model: string
  /** Canonical policy levels proven acceptable for this exact route. */
  readonly supported: readonly CanonicalReasoningLevel[]
  /** Optional policy aliases accepted before a backend request is formed. */
  readonly aliases?: Readonly<Partial<Record<ReasoningLevel, CanonicalReasoningLevel>>>
  /** Explicit allowed policy fallback when the backend lacks a selected level. */
  readonly fallbacks?: Readonly<Partial<Record<CanonicalReasoningLevel, CanonicalReasoningLevel>>>
  /** Exact wire spelling for every canonical policy level. */
  readonly wireValues: Readonly<Record<CanonicalReasoningLevel, string>>
  /** Whether a request value can override the backend's configured default. */
  readonly requestOverrideSupported: boolean
  /** Backend default when the request omits a supported value. */
  readonly backendDefault?: CanonicalReasoningLevel
  /** Audit certainty for this declared provider/model capability. */
  readonly confidence: 'confirmed' | 'provisional'
  /** Evidence source that established this capability declaration. */
  readonly source: string
}

/** One complete decision after exact-backend normalization. */
export interface ResolvedReasoningDecision {
  readonly requested?: ReasoningLevel
  readonly policySelected: CanonicalReasoningLevel
  readonly resolved: CanonicalReasoningLevel
  readonly wireValue: string
  readonly backendDefault?: CanonicalReasoningLevel
  readonly source: ReasoningDecisionSource
  readonly capabilityConfidence: 'confirmed' | 'provisional'
  readonly capabilitySource: string
}

/** Configurable state boundaries over projected prompt pressure. */
export interface ContextPressureThresholds {
  /** Ratio at which diagnostics first report `watch`. */
  readonly watch: number
  /** Ratio at which diagnostics report `prepare`. */
  readonly prepare: number
  /** Ratio at which diagnostics report `compact`. */
  readonly compact: number
  /** Ratio at which diagnostics report `critical`. */
  readonly critical: number
}

/** Deterministic output reserve and provider safety configuration. */
export interface ContextPressureConfig {
  /** Tokens retained outside the estimated prompt budget for provider/template uncertainty. */
  readonly providerSafetyMargin: number
  /** Base expected output reserve for each resolved reasoning level. */
  readonly reserve: Readonly<Record<CanonicalReasoningLevel, number>>
  /** Additional reserve for deterministic complex-work classification. */
  readonly complexReserve: number
  /** Additional reserve for deterministic long-output classification. */
  readonly longOutputIncrement: number
  /** Maximum total expected output reserve after increments. */
  readonly maxReserve: number
  /** Strictly ascending read-only projected-prompt ratios. */
  readonly thresholds: ContextPressureThresholds
}

/** Complete configuration for the opt-in reasoning and pressure policy service. */
export interface ReasoningPolicyConfig {
  /** Unique owner id for this process-local diagnostics observer. */
  readonly observerId: string
  /** Provider routes that require an audited exact-model capability declaration. */
  readonly governedProviders: readonly string[]
  /** Backend-specific reasoning capability declarations keyed by provider and model. */
  readonly capabilities: readonly ModelReasoningCapability[]
  /** Canonical fallback policy when no higher-priority selection applies. */
  readonly globalDefault: CanonicalReasoningLevel
  /** Optional exact route defaults indexed by the internal provider/model key. */
  readonly profileDefaults?: Readonly<Record<string, CanonicalReasoningLevel>>
  /** Optional deterministic selections for recognized current-text task classes. */
  readonly taskPolicies?: Readonly<Partial<Record<ReasoningTaskClass, CanonicalReasoningLevel>>>
  /** Read-only context-pressure reserves, margin, and classification thresholds. */
  readonly contextPressure: ContextPressureConfig
  /** Optional compaction-only auxiliary-request policy. Omission preserves the base compactor behavior. */
  readonly compaction?: CompactionReasoningPolicyConfig
  /** Explicit reproducibility locks for hidden or otherwise non-routine benchmark presets. */
  readonly benchmarkPresets?: readonly BenchmarkPresetPolicy[]
}

/** One explicitly named benchmark preset's fixed execution requirements. */
export interface BenchmarkPresetPolicy {
  /** Agent-preset id; ordinary Profile names have no inherent reasoning meaning. */
  readonly preset: string
  /** Exact fixed reasoning policy for this benchmark condition. */
  readonly reasoning: CanonicalReasoningLevel
  /** Optional route that must match rather than being silently rewritten. */
  readonly provider?: string
  /** Optional exact model id paired with `provider`. */
  readonly model?: string
  /** Whether this run requires its original model-visible context and therefore rejects automatic compaction. */
  readonly preserveRawContext: boolean
}

/** Deployment controls for the optional compaction auxiliary-request policy. */
export interface CompactionReasoningPolicyConfig {
  /** Enable explicit low/medium compaction reasoning and semantic validation. */
  readonly enabled: boolean
  /** Let this capability invoke the existing compaction executor at compact or critical pressure. */
  readonly autoTrigger: boolean
  /** Preserve benchmark runs' original context by refusing automatic compaction while a benchmark lock is set. */
  readonly preserveBenchmarkContext: boolean
}

/** Read-only latest compaction-policy fact for one Session. */
export interface CompactionPolicyDiagnostics {
  readonly pressureState: ContextPressureDecision['pressureState']
  readonly eligibility: 'eligible' | 'ineligible' | 'unknown'
  readonly triggerReason?: 'pressure' | 'context-overflow'
  readonly reasoning?: Pick<ResolvedReasoningDecision, 'requested' | 'resolved' | 'wireValue' | 'source'>
  readonly attempt?: {
    readonly ordinal: number
    readonly validation: 'pending' | 'passed' | 'failed'
    readonly failureReason?: string
  }
  /** `unknown` means the existing pruner did not expose a per-transaction read fact. */
  readonly taskFactsInjected: boolean
  readonly toolResultsPruned: boolean | 'unknown'
}

/** Pure context-pressure result; this is observation only, not a compaction action. */
export interface ContextPressureDecision {
  readonly contextWindow?: number
  readonly projectedPromptTokens?: number
  readonly resumeContextTokens?: number
  readonly expectedOutputReserve: number
  readonly providerSafetyMargin: number
  readonly effectivePromptBudget?: number
  readonly pressureRatio?: number
  readonly pressureState: 'unknown' | 'normal' | 'watch' | 'prepare' | 'compact' | 'critical'
}

/** Explicit policy controls an entry point may attach to one live Agent. */
export interface ReasoningPolicyControl {
  readonly userOverride?: ReasoningLevel
  readonly benchmarkLock?: CanonicalReasoningLevel
  readonly taskPolicy?: CanonicalReasoningLevel
}
