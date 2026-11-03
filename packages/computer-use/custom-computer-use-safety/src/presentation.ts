/** Reviewed Local V1 presentation over the provider's complete discovered catalog. */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ToolTaxonomy } from './classify.ts'

/** Classification of the installed CuaDriver catalog; only the two core groups are presented. */
export const V1_TOOL_GROUPS = {
  OBSERVE_CORE: ['get_accessibility_tree', 'list_windows', 'get_window_state'],
  ACT_CORE: ['click', 'type_text', 'press_key', 'scroll', 'bring_to_front'],
  ADVANCED: ['double_click', 'drag', 'hotkey', 'invoke_menu', 'move_cursor', 'page', 'right_click',
    'set_value', 'set_window_frame', 'verify_state', 'zoom'],
  UNSUPPORTED_V1: ['browser_click', 'browser_dialog', 'browser_download', 'browser_navigate',
    'browser_pointer', 'browser_prepare', 'browser_set_input_files', 'browser_type',
    'get_browser_state', 'get_desktop_state', 'get_agent_cursor_state', 'get_cursor_position',
    'get_screen_size', 'get_session', 'get_session_state', 'list_apps', 'list_sessions',
    'start_session', 'end_session', 'escalate_session', 'health_report', 'check_permissions',
    'set_agent_cursor_enabled', 'set_agent_cursor_motion', 'set_agent_cursor_theme'],
  SENSITIVE_EXCLUDED: ['clipboard_read', 'clipboard_write', 'get_config', 'set_config',
    'get_recording_state', 'start_recording', 'stop_recording', 'replay_trajectory',
    'install_ffmpeg', 'check_for_update', 'kill_app', 'launch_app'],
} as const

const presented: ReadonlySet<string> = new Set([
  ...V1_TOOL_GROUPS.OBSERVE_CORE, ...V1_TOOL_GROUPS.ACT_CORE,
])

/** Unknown future driver tools are not presented until explicitly reviewed. */
export function isV1PresentedTool(rawName: string): boolean {
  return presented.has(rawName.toLowerCase())
}

/**
 * Restrict only provider-owned inherited tools in each Agent scope. Global discovery
 * remains complete for the Host permission controller. Refresh synchronously on
 * registry changes so reconnects and newly discovered tools cannot widen V1.
 * Non-CU tools, including subsequently registered capabilities, are never masked.
 */
export function installV1Presentation(ctx: Context, taxonomy: ToolTaxonomy): void {
  const scopes = new Map<Agent, { key: string; dispose: () => void }>()
  let refreshing = false
  const refresh = (): void => {
    if (refreshing) return
    refreshing = true
    try {
      const deny = ctx.tools.schemas().filter((tool) => {
        const classified = taxonomy.classify(tool.name)
        return classified !== undefined && !isV1PresentedTool(classified.rawName)
      }).map(tool => tool.name).sort()
      const key = JSON.stringify(deny)
      for (const [agent, previous] of scopes) {
        if (previous.key === key) continue
        // Install the successor before removing the old mask; there is no
        // transient widening during a synchronous tools/change notification.
        const dispose = agent.ctx.tools.restrict({ deny })
        scopes.set(agent, { key, dispose })
        previous.dispose()
      }
    } finally {
      refreshing = false
    }
  }
  const add = (agent: Agent): void => {
    if (scopes.has(agent)) return
    scopes.set(agent, { key: '', dispose: () => {} })
    refresh()
  }
  ctx.effect(() => ctx.on('agent/created', ({ agent }) => { add(agent) }), 'computer-use: scoped presentation')
  ctx.effect(() => ctx.on('tools/change', refresh), 'computer-use: presentation catalog refresh')
  ctx.effect(() => ctx.on('agent/disposed', ({ agent }) => {
    const scope = scopes.get(agent)
    scopes.delete(agent)
    scope?.dispose()
  }), 'computer-use: presentation scope disposal')
  // Scope-local shadows cannot evade the policy even though ToolRuntime masks
  // intentionally govern inherited tools. The existing safety pipeline still
  // decides every permitted ACT; this guard can only deny.
  ctx.effect(() => ctx.tools.guard((exec) => {
    if (exec.agent === undefined) return undefined
    const classified = taxonomy.classify(exec.name)
    return classified !== undefined && !isV1PresentedTool(classified.rawName)
      ? 'This driver capability is not presented by Computer Use V1'
      : undefined
  }), 'computer-use: presentation boundary')
  for (const agent of ctx.agents.list()) add(agent)
  ctx.effect(() => () => {
    const previous = [...scopes.values()]
    scopes.clear()
    for (const scope of previous) scope.dispose()
  }, 'computer-use: release presentation masks')
}
