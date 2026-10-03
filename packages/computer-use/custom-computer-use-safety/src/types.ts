/** Pure Computer Use status contracts shared by Host and Client. */
/** Lifecycle of the single desktop controlling turn. */
export type DesktopLeaseState = 'released' | 'active' | 'draining' | 'poisoned'

/** Whether the Host is accepting Computer Use work at all. */
export type ComputerUseStopState = 'running' | 'stopping' | 'stopped'

/** Why a turn holds (or is denied) desktop authority. */
export type DesktopTurnKind = 'foreground' | 'schedule' | 'external' | 'subagent'

/** Identity of the turn that currently owns the desktop. */
export interface DesktopLeaseOwner {
  /** Root session identity of the owning turn. */
  readonly sessionId: string
  /** The owning turn number, the run identity DSH exposes for a session log. */
  readonly turn: number
  /** How that turn was started. */
  readonly kind: DesktopTurnKind
}

/** Immutable observation of the lease and the Host stop state. */
export interface DesktopLeaseSnapshot {
  /** Current controlling-turn lifecycle. */
  readonly state: DesktopLeaseState
  /** Whether new Computer Use work is admitted. */
  readonly stop: ComputerUseStopState
  /** Desktop calls this layer currently accounts for. */
  readonly inFlight: number
  /** The owning turn, when one holds the desktop. */
  readonly owner?: DesktopLeaseOwner
  /** Whether the owning turn already passed its action approval. */
  readonly actApproved: boolean
  /** Last stop, drain, or poison explanation. */
  readonly detail?: string
}

/** Admission verdict for one Computer Use call. */
export type AdmissionVerdict =
  | { readonly kind: 'allow' }
  | { readonly kind: 'deny'; readonly reason: string }
  | {
    readonly kind: 'ask'
    readonly reason: string
    readonly displayReason: { readonly en: string; readonly zh: string }
  }

/** One accounted in-flight desktop call. */
export interface InFlightCall {
  /** Correlation token returned by {@link DesktopLease.enterCall}. */
  readonly token: number
  /** Cancellation signal that settles when this lease is stopped. */
  readonly signal: AbortSignal
}

/** Permission facts reported by the owned MCP connection; no credential or screen content. */
export type PermissionState = 'not-requested' | 'granted' | 'denied' | 'needs-restart' | 'driver-unavailable'
/** Complete redacted Host observation. */
export interface ComputerUseStatus {
  readonly lease: DesktopLeaseSnapshot
  readonly driver: 'ready' | 'driver-unavailable'
  readonly accessibility: PermissionState
  readonly screenRecording: PermissionState
  readonly permissionOwner: string
}
