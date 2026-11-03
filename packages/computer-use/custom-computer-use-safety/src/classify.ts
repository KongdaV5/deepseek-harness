/** Exact read-only driver catalog names; every unknown tool is an action requiring approval. */

/** Whether one Computer Use tool reads desktop state or changes it. */
export type ComputerUseToolClass = 'observe' | 'act'

/** One classified Computer Use call target. */
export interface ClassifiedTool {
  /** Whether the tool may run without an action approval. */
  readonly class: ComputerUseToolClass
  /** Public registry name the call used, including its provider prefix. */
  readonly publicName: string
  /** Driver-owned name with the provider prefix removed. */
  readonly rawName: string
  /** Whether an explicit operator rule decided this class instead of the name family. */
  readonly explicit: boolean
  /**
   * Whether this action must be confirmed even after the lease's first action.
   * V1 reviews every mutation because generic input names cannot reliably
   * establish the intent or risk of a physical action.
   */
  readonly reconfirm: boolean
}

/** Operator-supplied classification input; every field is resolved by the plugin schema. */
export interface ToolTaxonomyConfig {
  /** Public name prefixes owned by the configured Computer Use provider. */
  readonly prefixes: readonly string[]
  /** Driver names proven read-only; narrows the reviewed catalog. */
  readonly observeTools: readonly string[]
  /** Driver names forced to actions; wins over every read-only rule. */
  readonly actTools: readonly string[]
}

/** Exact read-only names verified against the installed cua-driver catalog.
 * Unknown names remain actions. Clipboard, configuration and recording data are excluded.
 */
const OBSERVE_TOOLS: ReadonlySet<string> = new Set([
  'screenshot', 'check_permissions', 'get_accessibility_tree', 'get_window_state',
  'get_desktop_state', 'get_browser_state', 'get_cursor_position', 'get_screen_size',
  'list_apps', 'list_windows', 'get_agent_cursor_state', 'list_sessions', 'get_session', 'zoom',
])

/**
 * Classify driver tools by provider-owned name prefix and reviewed read-only catalog.
 * One instance is built per plugin activation from the resolved config, so the
 * vocabulary answers the same way for scheduling, admission, and diagnostics.
 */
export class ToolTaxonomy {
  private readonly prefixes: readonly string[]
  private readonly observe: ReadonlySet<string>
  private readonly act: ReadonlySet<string>

  /**
   * @param config - provider prefixes and explicit operator overrides.
   */
  constructor(config: ToolTaxonomyConfig) {
    // Trim before testing emptiness: a whitespace-only prefix would otherwise
    // survive as an owner that matches a name beginning with that whitespace.
    this.prefixes = config.prefixes
      .map(prefix => prefix.trim().toLowerCase())
      .filter(prefix => prefix !== '')
    this.observe = new Set(config.observeTools.map(name => name.toLowerCase()))
    this.act = new Set(config.actTools.map(name => name.toLowerCase()))
  }

  /** Provider prefixes this taxonomy owns, lowercased. */
  get ownedPrefixes(): readonly string[] {
    return this.prefixes
  }

  /**
   * Classify one public registry name.
   * @param publicName - the name a tool call used.
   * @returns the classification, or `undefined` when the name belongs to no configured provider.
   */
  classify(publicName: string): ClassifiedTool | undefined {
    const lower = publicName.toLowerCase()
    const prefix = this.prefixes.find(candidate => lower.startsWith(candidate))
    if (prefix === undefined) return undefined
    const rawName = publicName.slice(prefix.length)
    if (rawName === '') return undefined
    const raw = rawName.toLowerCase()
    if (this.act.has(raw)) {
      return { class: 'act', publicName, rawName, explicit: true, reconfirm: true }
    }
    if (this.observe.has(raw) && OBSERVE_TOOLS.has(raw)) {
      return { class: 'observe', publicName, rawName, explicit: true, reconfirm: false }
    }
    if (OBSERVE_TOOLS.has(raw)) {
      return { class: 'observe', publicName, rawName, explicit: false, reconfirm: false }
    }
    return {
      class: 'act',
      publicName,
      rawName,
      explicit: false,
      // Generic input names cannot prove intent. Every subsequent mutation is reviewed too.
      reconfirm: true,
    }
  }
}
