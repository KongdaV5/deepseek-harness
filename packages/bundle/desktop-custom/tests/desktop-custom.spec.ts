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

describe('dsh-desktop-custom bundle', () => {
  it('declares a parseable patch list through the dsh.bundle.patch manifest field', () => {
    expect(readPatch().length).toBeGreaterThan(0)
  })

  it('mounts the three DS Harness capability services and nothing else', () => {
    const inserted = readPatch().flatMap(patch => patch.insert ?? [])
    expect(inserted.map(row => row.id)).toEqual([
      'task-checkpoint',
      'agent-run-policy',
      'compaction-task-aware-policy',
    ])
    expect(inserted.map(row => row.name)).toEqual([
      '@deepseek-ai/dsh-task-checkpoint',
      '@deepseek-ai/dsh-agent-run-policy',
      '@deepseek-ai/dsh-compaction-task-aware-policy',
    ])
    // The layer introduces no client row and disables nothing the surface owns.
    expect(inserted.some(row => (row.name ?? '').startsWith('@deepseek-ai/dsh-client-'))).toBe(false)
    for (const row of inserted) expect(row.disabled).toBeUndefined()
  })

  it('declares the mounted services as real dependencies of the layer', () => {
    const manifest = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>
    }
    for (const name of [
      '@deepseek-ai/dsh-task-checkpoint',
      '@deepseek-ai/dsh-agent-run-policy',
      '@deepseek-ai/dsh-compaction-task-aware-policy',
    ]) {
      expect(manifest.dependencies).toHaveProperty(name)
    }
  })

  it('restates the inherited compaction executor with the DS semantic-validation budget', () => {
    const rows = readPatch().filter(patch => patch.insert === undefined)
    expect(rows.map(row => row.id)).toEqual(['compaction-basic'])
    const row = rows[0]!
    // The Web surface disables this row because a preset owns the backend; the
    // DS product owns it on the host plane, and a patch replaces the whole
    // `config`, so both keys are restated here.
    expect(row.disabled).toBe(false)
    expect(row.config).toEqual({ maxSummaryValidationRetries: 1 })
  })
})
