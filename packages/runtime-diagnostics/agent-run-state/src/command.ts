/** Opt-in human-command transport for the read-only Agent Run State developer view. */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-commands'
import type {} from './index.ts'
import { agentRunDiagnosticsView } from './view.ts'

export const name = 'agentRunStateCommand'
export const inject = ['agentRunState', 'commands']

/** Register `/agent_run_state` as an on-demand JSON diagnostics view. */
export function apply(ctx: Context): void {
  ctx.commands.register({
    name: 'agent_run_state',
    description: 'Show read-only diagnostics for the current agent run',
    handler: ({ agent, rawInput }) => {
      if (rawInput.trim().length > 0) {
        return { kind: 'error', text: '/agent_run_state does not accept input.' }
      }
      const diagnostics = ctx.agentRunState.diagnostics(agent.session)
      return {
        kind: 'success',
        text: JSON.stringify(agentRunDiagnosticsView(agent.session.header.id, diagnostics), null, 2),
      }
    },
  })
}
