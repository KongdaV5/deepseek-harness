/**
 * The bundle's substance is its patch file: the `dsh.bundle.patch` manifest
 * field must name a real, parseable patch list, and that list must mount
 * exactly the DS Harness capability rows over the inherited surface.
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import * as yaml from 'js-yaml'
import { entryListSchema } from '@deepseek-ai/cordis-plugin-include'

interface InsertRow {
  readonly id?: string
  readonly name?: string
  readonly disabled?: boolean
  readonly config?: Record<string, unknown>
}

interface PatchRow {
  readonly id?: string
  readonly disabled?: boolean
  readonly config?: Record<string, unknown>
  readonly insert?: readonly InsertRow[]
  readonly name?: string
}

const root = fileURLToPath(new URL('..', import.meta.url))

function readPatch(): readonly PatchRow[] {
  const manifest = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as {
    dsh?: { bundle?: { patch?: string } }
  }
  expect(manifest.dsh?.bundle?.patch).toBe('./cordis.patch.yml')
  const parsed: unknown = yaml.load(
    readFileSync(resolve(root, manifest.dsh!.bundle!.patch!), 'utf8'),
    { schema: entryListSchema },
  )
  if (!Array.isArray(parsed)) throw new TypeError('desktop-custom patch must parse to a patch list')
  return parsed as readonly PatchRow[]
}

/**
 * The rows this layer inserts, in patch order. The order is load-bearing for a
 * reader rather than for the Loader — every row's own `inject` decides
 * activation — so it groups a service with the adapter that feeds it and keeps
 * the Run Details host half before its browser half.
 */
const INSERTED_IDS = [
  'task-checkpoint',
  'agent-codex',
  'agent-run-policy',
  'compaction-task-aware-policy',
  'runtime-diagnostics-controller',
  'compaction-task-aware-diagnostics-transport',
  'run-details',
  'ui-run-details',
] as const

/** The module each inserted row resolves, position for position. */
const INSERTED_NAMES = [
  '@deepseek-ai/dsh-task-checkpoint',
  '@deepseek-ai/dsh-agent-codex',
  '@deepseek-ai/dsh-agent-run-policy',
  '@deepseek-ai/dsh-compaction-task-aware-policy',
  '@deepseek-ai/dsh-api-runtime-diagnostics-controller',
  '@deepseek-ai/dsh-compaction-task-aware-policy/diagnostics-transport',
  '@deepseek-ai/dsh-run-details',
  '@deepseek-ai/dsh-client-ui-run-details',
] as const

/** The row's module name, or an empty string when the row names none. */
function nameOf(row: InsertRow): string {
  return row.name ?? ''
}

describe('dsh-desktop-custom bundle', () => {
  it('declares a parseable patch list through the dsh.bundle.patch manifest field', () => {
    expect(readPatch().length).toBeGreaterThan(0)
  })

  it('mounts the DS Harness capability rows and nothing else', () => {
    const inserted = readPatch().flatMap(patch => patch.insert ?? [])
    expect(inserted.map(row => row.id)).toEqual([...INSERTED_IDS])
    expect(inserted.map(row => row.name)).toEqual([...INSERTED_NAMES])
    // The layer enables every row it mounts: a row that shipped disabled would
    // occupy its id while providing nothing a surface could read.
    for (const row of inserted) expect(row.disabled).toBeUndefined()
  })

  it('reaches the diagnostics adapter through a subpath of its own package', () => {
    const inserted = readPatch().flatMap(patch => patch.insert ?? [])
    // The adapter is a second entry of the policy package rather than a package
    // of its own, so the transport gains no second service identity, the row
    // list gains no fourth dependency for it, and the topic's provider cannot
    // drift from the policy that publishes it.
    expect(inserted.map(nameOf).filter(name => name.split('/').length > 2)).toEqual([
      '@deepseek-ai/dsh-compaction-task-aware-policy/diagnostics-transport',
    ])
  })

  it('carries exactly one client row: the read-only Run Details strip', () => {
    const inserted = readPatch().flatMap(patch => patch.insert ?? [])
    // The transport, both policies, and the projection are host rows; only the
    // browser surface is a `dsh.client` row, and a second one would put a second
    // browser entry in the roster without a surface to justify it.
    expect(inserted.filter(row => nameOf(row).startsWith('@deepseek-ai/dsh-client-'))).toEqual([
      { id: 'ui-run-details', name: '@deepseek-ai/dsh-client-ui-run-details' },
    ])
  })

  it('declares the mounted services as real dependencies of the layer', () => {
    const manifest = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>
    }
    for (const name of [
      '@deepseek-ai/dsh-task-checkpoint',
      '@deepseek-ai/dsh-agent-codex',
      '@deepseek-ai/dsh-agent-run-policy',
      '@deepseek-ai/dsh-compaction-task-aware-policy',
      '@deepseek-ai/dsh-api-runtime-diagnostics-controller',
      '@deepseek-ai/dsh-run-details',
      '@deepseek-ai/dsh-client-ui-run-details',
    ]) {
      expect(manifest.dependencies).toHaveProperty(name)
    }
  })

  it('restates the inherited compaction executor with the DS semantic-validation budget', () => {
    const rows = readPatch().filter(patch => patch.insert === undefined)
    const row = rows.find(candidate => candidate.id === 'compaction-basic')!
    // The Web surface disables this row because a preset owns the backend; the
    // DS product owns it on the host plane, and a patch replaces the whole
    // `config`, so both keys are restated here.
    expect(row.disabled).toBe(false)
    expect(row.config).toEqual({ maxSummaryValidationRetries: 1 })
  })

  it('uses a fail-closed local-first default and disables built-in DeepSeek calls', () => {
    const rows = readPatch().filter(patch => patch.insert === undefined)
    expect(rows.find(row => row.id === 'agent-default-model')).toMatchObject({
      config: { provider: 'dsh-local-unconfigured', model: 'select-local-model', localFirst: true },
    })
    expect(rows.find(row => row.id === 'llm-deepseek')?.disabled).toBe(true)
    expect(rows.find(row => row.id === 'web-search-deepseek')?.disabled).toBe(true)
    expect(rows.find(row => row.id === 'web')?.config).toEqual({ fetchProvider: 'http' })
    expect(rows.find(row => row.id === 'tool-web')?.config).toMatchObject({ search: false, fetch: true })
    expect(rows.find(row => row.id === 'settings-controller')?.config).toEqual({
      localModelRuntime: true,
      codexSubscription: true,
    })
  })
})
