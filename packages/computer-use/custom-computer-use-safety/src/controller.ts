/** Redacted Host control API; permission prompts are explicit human operations. */
import { randomUUID } from '@deepseek-ai/dsh-util-crypto'
import type { Context } from '@deepseek-ai/cordis'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { ToolCallId } from '@deepseek-ai/dsh-llm/brand'
import type { DesktopLease } from './lease.ts'
import type { ToolTaxonomy } from './classify.ts'
import type { ComputerUseStatus, PermissionState } from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context { computerUseController: ComputerUseController }
}

/** One profile's explicit Computer Use controls; the lease remains Host-wide. */
export class ComputerUseController extends TypertRemoteService {
  private accessibility: PermissionState = 'not-requested'
  private screenRecording: PermissionState = 'not-requested'
  /** @param ctx - Host profile context.
   * @param lease - Single Host-memory authority, retained across optional-bundle reloads.
   * @param taxonomy - Provider namespace and reviewed read-only tools.
   * @param permissionCalls - Exact human-request call identities; never an agent/session flag.
   */
  constructor(ctx: Context, private readonly lease: DesktopLease, private readonly taxonomy: ToolTaxonomy,
    private readonly permissionCalls: Set<ToolCallId>) {
    super(ctx, 'computerUseController', { namespace: 'computerUse' })
  }
  /** Observe current owner and last explicit permission check; does not launch or prompt.
   * @returns Redacted lease, driver and permission state. */
  @Remote
  status(): ComputerUseStatus {
    const available = this.permissionTool() !== undefined
    return { lease: this.lease.snapshot(), driver: available ? 'ready' : 'driver-unavailable',
      accessibility: available ? this.accessibility : 'driver-unavailable',
      screenRecording: available ? this.screenRecording : 'driver-unavailable',
      permissionOwner: 'CuaDriver (com.trycua.driver)' }
  }
  /** Reject new calls immediately, abort owned calls and await bounded quiescence.
   * @returns Redacted state after release or poison. */
  @Remote
  async stop(): Promise<ComputerUseStatus> {
    await this.lease.stopAll('Global Stop requested by the user')
    return this.status()
  }
  /** Resume a proven-idle stopped lease; poison and outstanding calls remain blocked.
   * @returns Current state; an uncertain lease remains blocked. */
  @Remote
  resume(): ComputerUseStatus {
    this.lease.resume('User requested resume after stop')
    return this.status()
  }
  /** Explicit read-only permission query; no system dialog or live capture probe.
   * @returns Verified grants and current lease state. */
  @Remote
  checkPermissions(): Promise<ComputerUseStatus> { return this.queryPermissions(false) }
  /** Explicit user permission request; agents cannot mint its one-shot call identity.
   * @returns Driver-reported grants after the explicit request. */
  @Remote
  requestPermissions(): Promise<ComputerUseStatus> { return this.queryPermissions(true) }

  private permissionTool(): string | undefined {
    return this.ctx.tools.schemas().find(tool => this.taxonomy.classify(tool.name)?.rawName === 'check_permissions')?.name
  }
  private async queryPermissions(prompt: boolean): Promise<ComputerUseStatus> {
    const name = this.permissionTool()
    if (name === undefined) return this.status()
    const callId = ToolCallId(`computer-use-permissions-${randomUUID()}`)
    if (prompt) this.permissionCalls.add(callId)
    try {
      const result = await this.ctx.tools.execute({ name, callId, arguments: { prompt, probe_direct_capture: false },
        signal: new AbortController().signal })
      if (result.isError) throw new Error('Computer Use permission check failed; no permission state was accepted')
      const value = result.value
      const facts = typeof value === 'object' && value !== null && 'structuredContent' in value
        ? value.structuredContent : undefined
      if (typeof facts !== 'object' || facts === null || !('accessibility' in facts) ||
        !('screen_recording' in facts) || typeof facts.accessibility !== 'boolean' || typeof facts.screen_recording !== 'boolean') {
        throw new Error('Driver permission response omitted required boolean grants; permission remains denied')
      }
      this.accessibility = facts.accessibility ? 'granted' : 'denied'
      this.screenRecording = facts.screen_recording ? 'granted' : 'denied'
      if ('needs_restart' in facts && facts.needs_restart === true) this.screenRecording = 'needs-restart'
      return this.status()
    } catch {
      this.accessibility = 'denied'
      this.screenRecording = 'denied'
      throw new Error('Could not verify Computer Use permissions. Check CuaDriver in System Settings → Privacy & Security.')
    } finally {
      this.permissionCalls.delete(callId)
    }
  }
}
