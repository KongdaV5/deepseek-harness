/**
 * Host-side safety layer for Computer Use.
 *
 * The official registry and the official Cua Driver MCP provider supply the
 * desktop tools; this plugin supplies the coordination the provider deliberately
 * does not: one desktop-controlling turn at a time, a bounded release that
 * proves quiescence, a Host stop that cancels rather than merely forgets,
 * admission that refuses scheduled and external turns, an action approval
 * routed through the canonical approval channel, and a user-facing control
 * surface built from the existing slash-command registry.
 *
 * Nothing here forks a driver, captures a screen, synthesizes an input event,
 * or stores a screenshot. Every desktop effect still leaves through the official
 * provider and every image still leaves through the official admission path.
 *
 * @module @deepseek-ai/dsh-custom-computer-use-safety
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { CommandDefinitionId } from '@deepseek-ai/dsh-commands'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { type ToolCallId } from '@deepseek-ai/dsh-llm/brand'
import { TOOL_ABORTED_BEFORE_DISPATCH } from '@deepseek-ai/dsh-tools'
import type { ToolExecutionFailure } from '@deepseek-ai/dsh-tools'
import { ToolTaxonomy } from './classify.ts'
import type { ClassifiedTool } from './classify.ts'
import { COMPUTER_USE_SAFETY_GUIDANCE } from './guidance.ts'
import { DesktopLease } from './lease.ts'
import type { AdmissionVerdict, DesktopLeaseOwner, DesktopLeaseSnapshot } from './lease.ts'
import { TurnOrigin } from './origin.ts'
import { ComputerUseController } from './controller.ts'
export { ComputerUseController } from './controller.ts'
export type { ComputerUseStatus, PermissionState } from './types.ts'

// Side-effect type imports: declaration-merge the services and events this plugin reads.
import type {} from '@deepseek-ai/dsh-computer-use'
import type {} from '@deepseek-ai/dsh-commands'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-tools'

/** Cordis plugin identity for the Custom Computer Use safety layer. */
export const name = 'custom-computer-use-safety'

/**
 * The registry this plugin instruments, the prompt it appends to, and the
 * command surface it publishes the Host stop through. These services are required:
 * a deployment that cannot offer the stop affordance must not offer Computer
 * Use at all.
 */
export const inject = ['tools', 'systemPrompt', 'commands', 'agents']

/** Driver tool-name prefixes and the conservative classification overrides. */
export interface Config {
  /**
   * Public tool-name prefixes owned by the configured Computer Use provider.
   * Defaults to the official Cua Driver MCP provider's namespace.
   */
  toolPrefixes: string[]
  /**
   * Bounded window, in milliseconds, to prove that every accounted desktop call
   * settled before the lease is released. Exceeding it poisons the lease.
   */
  drainTimeoutMs: number
  /** Reviewed read-only names; cannot widen the built-in observation catalog. */
  observeTools: string[]
  /** Driver-owned names forced to desktop actions; wins over every read-only rule. */
  actTools: string[]
}

/** Validate and default the safety layer's classification and drain bounds. */
export const Config: z<Partial<Config>, Config> = z.object({
  toolPrefixes: z.array(String).default(['mcp__cua-driver-mcp__']),
  drainTimeoutMs: z.number().min(0).default(5_000),
  observeTools: z.array(String).default([]),
  actTools: z.array(String).default([]),
})

/** Permission query whose `prompt` flag raises the macOS prompt, and its read-only form. */
const PERMISSION_TOOL = 'check_permissions'

/** Only pre-dispatch failures establish that no physical action ran. */
const PROVEN_UNRUN: ReadonlySet<string> = new Set([
  'UNKNOWN_TOOL',
  TOOL_ABORTED_BEFORE_DISPATCH,
])

/**
 * Install the desktop lease, the admission gate, the turn-origin tracker, the
 * guidance section, and the user control commands.
 * @param ctx - context providing the tool registry, the prompt, and the command registry.
 * @param config - resolved provider prefixes, classification overrides, and drain bounds.
 */
export function apply(ctx: Context, config: Config): void {
  const taxonomy = new ToolTaxonomy({
    prefixes: config.toolPrefixes,
    observeTools: config.observeTools,
    actTools: config.actTools,
  })
  const lease = ctx.root.get('desktopLease') ?? new DesktopLease(ctx.root, { drainTimeoutMs: config.drainTimeoutMs })
  ctx.effect(() => () => lease.stopAll('Computer Use bundle disabled'), 'computer-use-safety: disable drain')
  const origin = new TurnOrigin()
  const admittedEpochs = new Map<ToolCallId, number>()
  const permissionCalls = new Set<ToolCallId>()
  new ComputerUseController(ctx, lease, taxonomy, permissionCalls)

  ctx.effect(() => ctx.systemPrompt.section({
    name: 'computer-use:custom-safety',
    order: ctx.systemPrompt.getSectionOrder('TOOL_COMPUTER_USE'),
    text: COMPUTER_USE_SAFETY_GUIDANCE,
  }), 'computer-use-safety: guidance')

  // The origin tracker runs first in the step waterfall: admission reads the
  // recorded kind for the turn the step belongs to.
  ctx.effect(() => ctx.on('agent/pre-step', async ({ agent, messages, turn }, next) => {
    origin.note(agent, messages, turn)
    return next()
  }), 'computer-use-safety: turn origin')

  // An external route is announced before its first step, so the marker is
  // recorded and consumed by that same turn.
  ctx.effect(() => ctx.on('agent/resolve-external-turn', async ({ agent }, next) => {
    const executor = await next()
    if (executor !== undefined) origin.markExternal(agent)
    return executor
  }), 'computer-use-safety: external route')

  ctx.effect(() => ctx.on('agent/turn-stopping', async ({ agent, turn }) => {
    if (origin.turnOf(String(agent.id)) === turn) origin.forget(String(agent.id))
    const released = await lease.endTurn(String(agent.id), turn)
    if (released !== undefined) {
      ctx.logger.info(`computer-use-safety: released desktop on turn end: ${describeSnapshot(released)}`)
    }
  }), 'computer-use-safety: turn end')

  ctx.effect(() => ctx.on('agent/disposed', ({ agent }) => {
    origin.forget(String(agent.id))
  }), 'computer-use-safety: disposed session')

  // Admission. A denial short-circuits the waterfall because this layer owns a
  // safety property no later listener may re-open; an approval escalation
  // consults later listeners first so their denials still win.
  ctx.effect(() => ctx.on('tools/pre-execute', async (exec, next) => {
    const classified = taxonomy.classify(exec.name)
    if (classified === undefined) return next()
    const verdict = admit(lease, origin, exec.agent, classified, exec.arguments, exec.callId)
    if (verdict.kind === 'deny') return verdict
    admittedEpochs.set(exec.callId, lease.admissionEpoch)
    const downstream = await next()
    if (downstream.kind !== 'allow') return downstream
    return verdict
  }), 'computer-use-safety: admission')

  ctx.effect(() => ctx.tools.guard((exec) => {
    const classified = taxonomy.classify(exec.name)
    if (classified === undefined) return undefined
    const epoch = admittedEpochs.get(exec.callId)
    if (epoch !== lease.admissionEpoch) return 'Computer Use admission was retired by Stop; this call will not be replayed'
    if (['replay_trajectory', 'clipboard_read', 'clipboard_write', 'start_recording', 'stop_recording',
      'install_ffmpeg', 'get_config', 'set_config', 'get_recording_state'].includes(classified.rawName)) {
      return 'This capability is outside Computer Use V1; use user takeover instead'
    }
    return lease.check(ownerOf(origin, exec.agent, ctx), classified.class)
  }), 'computer-use-safety: final authority guard')

  ctx.effect(() => ctx.on('tools/result', (exec) => { admittedEpochs.delete(exec.callId) }), 'computer-use-safety: retired admissions')

  // Accounting. A wrapper rather than a post-execute observer, so a call that
  // never settles keeps the desktop attributed and the lease un-released.
  ctx.effect(() => ctx.on('tools/execute', async (exec, next) => {
    const classified = taxonomy.classify(exec.name)
    if (classified === undefined) return next()
    // The official scheduler may hold a prepared call after approval. Recheck at
    // actual dispatch, so Stop/resume cannot revive that retired preparation.
    const epoch = admittedEpochs.get(exec.callId)
    admittedEpochs.delete(exec.callId)
    const denial = epoch !== lease.admissionEpoch
      ? 'Computer Use dispatch was retired by Stop; it will not be replayed'
      : lease.check(ownerOf(origin, exec.agent, ctx), classified.class)
    if (denial !== undefined) throw new Error(denial)
    const upstream = exec.signal
    const call = lease.enterCall(upstream, classified.class)
    exec.signal = call.signal
    try {
      const result = await next()
      // The pipeline reports a failed tool as an `isError` result, not as a
      // rejection, so the outcome has to be read from the result itself. Only an
      // action is uncertain: a failed read changed no desktop state.
      if (result.isError && classified.class === 'act' && isUnconfirmed(result)) {
        const snapshot = lease.markUncertain(
          `the desktop action ${classified.rawName} failed without reporting whether it reached the application, so the desktop is unattestable; the lease is poisoned; check the desktop and verify old work has stopped before restarting the Host and driver`,
        )
        ctx.logger.warn(`computer-use-safety: ${describeSnapshot(snapshot)}`)
      }
      return result
    } catch (error: unknown) {
      if (classified.class === 'act') lease.markUncertain('Driver action rejected without a confirmed physical outcome')
      throw error
    } finally {
      lease.leaveCall(call.token)
      exec.signal = upstream
    }
  }), 'computer-use-safety: call accounting')

  ctx.effect(() => ctx.commands.register({
    definitionId: CommandDefinitionId('@deepseek-ai/dsh-custom-computer-use-safety'),
    name: 'computer-use-status',
    description: 'Report the Computer Use desktop owner, provider, and stop state',
    handler: () => ({ kind: 'success', text: statusReport(ctx, taxonomy, lease, origin) }),
  }), 'computer-use-safety: status command')

  ctx.effect(() => ctx.commands.register({
    definitionId: CommandDefinitionId('@deepseek-ai/dsh-custom-computer-use-safety'),
    name: 'computer-use-stop',
    description: 'Stop Computer Use: refuse new calls, cancel and drain, then release or poison',
    handler: async (invocation) => {
      const after = await lease.stopAll(`stopped by the user in session ${String(invocation.agent.id)}`)
      return { kind: 'success', text: stopReport(after) }
    },
  }), 'computer-use-safety: stop command')

  ctx.effect(() => ctx.commands.register({
    definitionId: CommandDefinitionId('@deepseek-ai/dsh-custom-computer-use-safety'),
    name: 'computer-use-resume',
    description: 'Resume a proven-idle Computer Use stop; uncertain work stays blocked',
    handler: () => {
      const recovered = lease.snapshot()
      const after = lease.resume('recovery requested by the user')
      if (after.state !== 'released' || after.stop !== 'running') return { kind: 'error', text: 'Computer Use cannot resume: outstanding or uncertain physical work requires a verified driver/Host restart, then a fresh observation. Nothing was replayed.' }
      return { kind: 'success', text: resumeReport(recovered, after) }
    },
  }), 'computer-use-safety: resume command')

  ctx.effect(() => ctx.commands.register({
    definitionId: CommandDefinitionId('@deepseek-ai/dsh-custom-computer-use-safety'),
    name: 'computer-use-permissions',
    description: 'Request the macOS Accessibility and Screen Recording grants Computer Use needs',
    handler: async () => {
      if (ctx.computerUseController.status().driver === 'driver-unavailable') {
        return { kind: 'error', text: 'Computer Use provider is unavailable. Install the driver and enable the Computer Use bundle.' }
      }
      try {
        await ctx.computerUseController.requestPermissions()
        return { kind: 'success', text: 'Requested macOS Accessibility and Screen Recording; check Computer Use settings.' }
      } catch {
        return { kind: 'error', text: 'Computer Use permission request failed. Check CuaDriver in System Settings → Privacy & Security.' }
      }
    },
  }), 'computer-use-safety: permission command')

  /** One admission decision, resolving the calling turn's canonical owner identity. */
  function admit(
    target: DesktopLease,
    turnOrigin: TurnOrigin,
    agent: Agent | undefined,
    classified: ClassifiedTool,
    args: unknown,
    callId: ToolCallId,
  ): AdmissionVerdict {
    const owner = ownerOf(turnOrigin, agent, ctx)
    if (classified.class === 'observe' && classified.rawName.toLowerCase() === PERMISSION_TOOL) {
      const wantsPrompt = readPromptFlag(args)
      if (wantsPrompt === undefined) return { kind: 'deny', reason: 'Permission reads require explicit prompt:false; provider defaults cannot authorize a system dialog' }
      if (wantsPrompt && !(permissionCalls.delete(callId))) {
        return {
          kind: 'deny',
          reason: 'only the user may start the macOS permission prompt, because the system dialog must be attributed to a deliberate request. The model may read permission state without prompting; ask the user to run /computer-use-permissions, or to grant the permission in System Settings.',
        }
      }
    }
    return target.admit(owner, classified.class, classified.reconfirm)
  }
}

/** Every failure after dispatch has an unknown physical outcome, including cancellation. */
function isUnconfirmed(result: ToolExecutionFailure): boolean {
  return !PROVEN_UNRUN.has(result.error.info?.code ?? '')
}

/** Resolve the desktop owner identity of the calling turn. */
function ownerOf(origin: TurnOrigin, agent: Agent | undefined, ctx: Context): DesktopLeaseOwner | undefined {
  if (agent === undefined) return undefined
  if (!isLocalRoute(agent)) return { sessionId: String(agent.id), turn: 0, kind: 'external' }
  const kind = origin.kindOf(String(agent.id))
  if (kind === 'schedule' || kind === 'external') return { sessionId: String(agent.id), turn: origin.turnOf(String(agent.id)), kind }
  let root = agent
  const seen = new Set<string>()
  while (root.session.header.parentSession !== undefined) {
    if (seen.has(String(root.id))) return { sessionId: String(agent.id), turn: 0, kind: 'external' }
    seen.add(String(root.id))
    const parent = ctx.get('agents')?.get(root.session.header.parentSession)
    if (parent === undefined || !ctx.agents.isOwnedBy(root.id, parent)) {
      return { sessionId: String(agent.id), turn: 0, kind: 'external' }
    }
    if (!isLocalRoute(parent)) return { sessionId: String(agent.id), turn: 0, kind: 'external' }
    root = parent
  }
  const sessionId = String(root.id)
  return Object.freeze({ sessionId, turn: origin.turnOf(sessionId), kind: origin.kindOf(sessionId) })
}

/** Use the canonical in-force request route, as the upstream image admission does. */
function isLocalRoute(agent: Agent): boolean {
  return (agent.session.requestHeader()?.config.provider ?? agent.options.provider) === 'dsh-local-huihui'
}

/** Whether a permission call asked the driver to raise the system prompt. */
function readPromptFlag(args: unknown): boolean | undefined {
  if (typeof args !== 'object' || args === null || !('prompt' in args) || typeof args.prompt !== 'boolean') return undefined
  return args.prompt
}

/** Compose the status report from Host state only. */
function statusReport(ctx: Context, taxonomy: ToolTaxonomy, lease: DesktopLease, origin: TurnOrigin): string {
  const snapshot = lease.snapshot()
  const provider = ctx.get('computerUse')?.providerName
  const tools = ctx.tools.schemas().filter(schema => taxonomy.classify(schema.name) !== undefined)
  const lines = [
    `Computer Use: ${provider === undefined ? 'provider unavailable (driver not connected)' : `provider ${String(provider)}`}`,
    `Desktop lease: ${snapshot.state}${snapshot.owner === undefined ? '' : ` — held by session ${snapshot.owner.sessionId} (turn ${snapshot.owner.turn}, ${snapshot.owner.kind})`}`,
    `Stop state: ${snapshot.stop}`,
    `Registered desktop tools: ${tools.length}`,
    `In-flight accounting: ${String(snapshot.inFlight)} call(s); the holding turn's action approval is ${snapshot.actApproved ? 'granted' : 'not granted'}`,
    ...snapshot.detail === undefined ? [] : [`Detail: ${snapshot.detail}`],
  ]
  const scheduled = snapshot.owner === undefined ? undefined : origin.kindOf(snapshot.owner.sessionId)
  if (scheduled !== undefined && scheduled !== 'foreground') {
    lines.push(`Note: the holding session's current turn is ${scheduled}.`)
  }
  return lines.join('\n')
}

/** Render the outcome of a Host stop. */
function stopReport(after: DesktopLeaseSnapshot): string {
  const drained = after.state === 'poisoned'
    // The lease may have been poisoned before this stop, by an action whose
    // outcome never came back. The snapshot's own detail names the actual cause,
    // so the report quotes it rather than assuming a timed-out drain.
    ? `The desktop could not be proven safe to hand over, so the lease is ${after.state} and every new Computer Use action is refused until old work has been verified stopped and the Host and driver restarted. ${after.detail ?? ''} Check the desktop before resuming.`
    : `Every accounted Computer Use call settled and the desktop is ${after.state}.`
  return `Computer Use stopped.\n\nNew desktop actions are refused. In-flight desktop calls were cancelled. ${drained}\n\nA stop cannot undo an action that already reached an application: a click, a keystroke, a submission, or a deletion that the application already processed stays processed. Verify the desktop before continuing.`
}

/** Render the outcome of a recovery. */
function resumeReport(before: DesktopLeaseSnapshot, after: DesktopLeaseSnapshot): string {
  return `Computer Use resumed.\n\nPrevious stop state: ${before.stop}; previous lease state: ${before.state}. New desktop actions are admitted again and the desktop is ${after.state}.`
}

/** Render a snapshot for a Host log line. */
function describeSnapshot(snapshot: DesktopLeaseSnapshot): string {
  return `${snapshot.state}, ${String(snapshot.inFlight)} in flight${snapshot.detail === undefined ? '' : `, ${snapshot.detail}`}`
}
