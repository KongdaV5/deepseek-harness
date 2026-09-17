/** Injected UI face for the compact Run status dock. */

import type { RemoteResult } from '@deepseek-ai/dsh-api-remotes/client'
import type { HostObservable } from '@deepseek-ai/dsh-client-ui-slots'
import type {
  DesktopRunDiagnosticsSnapshot,
  DesktopRunResumeRequest,
  DesktopRunResumeResult,
} from '@deepseek-ai/dsh-desktop-run-diagnostics/client'

/** Registrant-private live source and the one explicit user action. */
export interface RunDetailsInjected {
  readonly hooks: {
    readonly runDiagnostics: HostObservable<DesktopRunDiagnosticsSnapshot | undefined>
  }
  readonly resume: (request: DesktopRunResumeRequest) => Promise<RemoteResult<DesktopRunResumeResult>>
}
