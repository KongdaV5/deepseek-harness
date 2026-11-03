/** Renderer-safe subscription controls; authentication and turn state stay owned by the runtime. */
import type { Context } from '@deepseek-ai/cordis'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type { CodexRuntimePreference, CodexSubscriptionStatus, CodexLoginStartResult } from './types.ts'
import type { CodexSubscriptionRuntime } from './runtime.ts'

/** Explicit user operations on the one subscription runtime; no credentials cross this API. */
export class CodexSubscriptionController extends TypertRemoteService {
  /** Mount subscription Remote operations.
   * @param ctx Owning profile context.
   * @param runtime Canonical App Server and authentication owner.
   */
  constructor(ctx: Context, private readonly runtime: CodexSubscriptionRuntime) {
    super(ctx, 'codexSubscriptionController', { namespace: 'codexSubscription' })
  }
  /** Read redacted connectivity and compatibility facts.
   * @returns Current subscription status without authentication material.
   */
  @Remote
  status(): Promise<CodexSubscriptionStatus> { return this.runtime.status() }
  /** Apply an explicit runtime preference at an idle boundary.
   * @param preference Verified System, Bundled, or Automatic choice.
   * @returns Refreshed subscription status.
   */
  @Remote
  selectRuntime(preference: CodexRuntimePreference): Promise<CodexSubscriptionStatus> { return this.runtime.selectRuntime(preference) }
  /** Reconnect the owned App Server without changing authentication generation.
   * @returns Refreshed subscription status.
   */
  @Remote
  reconnect(): Promise<CodexSubscriptionStatus> { return this.runtime.reconnect() }
  /** Begin official browser authentication after an explicit user action.
   * @returns Pending or completed official sign-in status.
   */
  @Remote
  connect(): Promise<CodexLoginStartResult> { return this.runtime.connectChatGPT() }
  /** Cancel the currently owned login attempt.
   * @returns Refreshed subscription status.
   */
  @Remote
  cancelLogin(): Promise<CodexSubscriptionStatus> { return this.runtime.cancelLogin() }
  /** Explicitly disconnect only the dedicated subscription runtime home.
   * @returns Refreshed subscription status after the durable auth transaction.
   */
  @Remote
  disconnect(): Promise<CodexSubscriptionStatus> { return this.runtime.disconnect() }
}
