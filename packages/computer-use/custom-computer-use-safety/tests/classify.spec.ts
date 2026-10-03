import { describe, expect, it } from 'vitest'
import { ToolTaxonomy } from '../src/classify.ts'
const prefix = 'mcp__cua-driver-mcp__'
function taxonomy(observeTools: string[] = [], actTools: string[] = []) {
  return new ToolTaxonomy({ prefixes: [prefix], observeTools, actTools })
}
describe('reviewed driver catalog', () => {
  it.each(['check_permissions', 'get_window_state', 'get_accessibility_tree', 'get_desktop_state',
    'list_windows', 'list_apps', 'get_screen_size', 'get_browser_state', 'zoom'])('observes %s without action approval', (name) => {
    expect(taxonomy().classify(prefix + name)).toMatchObject({ class: 'observe', reconfirm: false })
  })
  it.each(['click', 'type_text', 'press_key', 'drag', 'scroll', 'send_message', 'clipboard_read',
    'replay_trajectory', 'get_password', 'read_cookie', 'find_element', 'get_unknown_state', 'get_screen_and_delete'])('fails closed for %s', (name) => {
    expect(taxonomy().classify(prefix + name)).toMatchObject({ class: 'act', reconfirm: true })
  })
  it('an observation override cannot admit an unknown tool, and action overrides narrow read-only tools', () => {
    expect(taxonomy(['get_password']).classify(prefix + 'get_password')?.class).toBe('act')
    expect(taxonomy([], ['get_window_state']).classify(prefix + 'get_window_state')?.class).toBe('act')
  })
  it('ignores unrelated providers without widening an empty namespace', () => {
    expect(taxonomy().classify('read_file')).toBeUndefined()
    expect(taxonomy().classify(prefix)).toBeUndefined()
    expect(new ToolTaxonomy({ prefixes: ['  '], observeTools: [], actTools: [] }).classify('click')).toBeUndefined()
  })
})
