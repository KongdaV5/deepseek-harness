/**
 * A fake Cua Driver MCP server over stdio, for Host integration tests.
 *
 * It speaks just enough of the MCP wire protocol for the official
 * `@deepseek-ai/dsh-mcp-client` to discover and call it, and it never reads or
 * controls the host desktop: every "display", "window", and "click" is a string
 * written to a JSON-RPC response.
 *
 * Usage: `node driver.mjs <recordDir> [mode]`
 *
 * Modes:
 *   ok        (default) answer every tool call.
 *   fail      exit non-zero during `initialize`, standing in for a machine where
 *             the driver is not installed or cannot start.
 *   hang      never answer `click`, and ignore its cancellation, standing in for
 *             a driver that has gone away mid-action.
 *   drop      exit without answering `click`, standing in for a driver that dies
 *             while an action is in flight, so the action's outcome is lost.
 */
import { appendFileSync } from 'node:fs'
import { join } from 'node:path'
import { createInterface } from 'node:readline'

const root = process.argv[2]
const mode = process.argv[3] ?? 'ok'
/** One transparent pixel, so an admitted screenshot stores a real 1x1 PNG. */
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADElEQVQImWNgZGIGAAAOAAeCcsnOAAAAAElFTkSuQmCC'

const record = (event, data = {}) =>
  appendFileSync(join(root, 'driver.ndjson'), JSON.stringify({ event, pid: process.pid, ...data }) + '\n')

record('start')
process.once('exit', () => record('exit'))

/** The driver catalog the safety layer classifies: reads, one action, one teardown. */
const TOOLS = [
  {
    name: 'check_permissions',
    description: 'Report the Accessibility and Screen Recording grants.',
    inputSchema: {
      type: 'object',
      properties: { prompt: { type: 'boolean' } },
      additionalProperties: false,
    },
  },
  {
    name: 'screenshot',
    description: 'Capture the selected display.',
    inputSchema: {
      type: 'object',
      properties: { display: { type: 'integer', minimum: 0 } },
      required: ['display'],
      additionalProperties: false,
    },
  },
  {
    name: 'accessibility_tree',
    description: 'Return the accessibility tree of the frontmost window.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'click',
    description: 'Click one point of the desktop.',
    inputSchema: {
      type: 'object',
      properties: { x: { type: 'integer' }, y: { type: 'integer' } },
      required: ['x', 'y'],
      additionalProperties: false,
    },
  },
  {
    name: 'disconnect',
    description: 'Disconnect this driver.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
]

/** The structured result one tool call returns, before MCP content framing. */
function callResult(name, args) {
  switch (name) {
    case 'check_permissions':
      return { text: JSON.stringify({ accessibility: true, screen_recording: true, prompted: args.prompt === true }) }
    case 'screenshot':
      return { text: `Display ${args.display}`, image: true }
    case 'accessibility_tree':
      return { text: '0 AXWindow "Fixture"\n  1 AXButton "Continue"' }
    case 'click':
      return { text: `Clicked ${args.x},${args.y}` }
    case 'disconnect':
      return { text: 'Disconnected.' }
    default:
      throw new Error(`Unexpected fixture tool ${name}`)
  }
}

const lines = createInterface({ input: process.stdin })
lines.once('close', () => process.exit(0))
lines.on('line', (line) => {
  const request = JSON.parse(line)
  if (request.id === undefined) {
    // A notification, including cancellation. Recorded so a test can prove that
    // a Host stop actually reached the transport.
    if (request.method === 'notifications/cancelled') record('cancelled', request.params)
    return
  }
  let result
  switch (request.method) {
    case 'server/discover':
      // The client probes this optional method first; the driver does not
      // implement it, which is the real driver's own answer.
      record('discover')
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, error: { code: -32601, message: 'Method not found' } }) + '\n')
      return
    case 'initialize':
      record('initialize')
      if (mode === 'fail') process.exit(1)
      result = {
        protocolVersion: request.params.protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: 'cua-driver-fixture', version: '1.0.0' },
      }
      break
    case 'tools/list':
      record('tools/list')
      result = { tools: TOOLS }
      break
    case 'tools/call': {
      const name = request.params.name
      const args = request.params.arguments ?? {}
      record('call', { name, arguments: args })
      if (name === 'click' && mode === 'drop') {
        // The driver dies after the request was written but before it answered,
        // so whether the click reached the application is unknowable.
        process.exit(7)
      }
      if (mode === 'hang' && name === 'click') {
        // No response at all, and no reaction to cancellation: the outcome of
        // this action can never be learned.
        return
      }
      const outcome = callResult(name, args)
      result = {
        content: outcome.image === true
          ? [{ type: 'text', text: outcome.text }, { type: 'image', mimeType: 'image/png', data: png }]
          : [{ type: 'text', text: outcome.text }],
        structuredContent: { text: outcome.text },
      }
      break
    }
    default:
      throw new Error(`Unexpected fixture method ${request.method}`)
  }
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\n', () => {
    if (request.method === 'tools/call' && request.params.name === 'disconnect') process.exit(0)
  })
})
