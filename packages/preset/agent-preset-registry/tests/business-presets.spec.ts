/** Shipped Web business presets reuse the AgentPreset composition contract. */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import * as yaml from 'js-yaml'
import { applyEntryPatches, entryListSchema } from '@deepseek-ai/cordis-plugin-include'

interface PluginRow {
  id?: string
  name?: string
  disabled?: boolean | { __jsExpr: string }
  config?: PresetConfig | PluginRow[]
  insert?: PluginRow[]
}

interface PresetConfig {
  id?: string
  order?: number
  path?: string
  patches?: Record<string, unknown>[]
  plugins?: PluginRow[]
  prefix?: string
  customSkillDirs?: { __jsExpr: string }[]
  includeDefaultRoots?: boolean
  mode?: string
}

const presetsDir = fileURLToPath(new URL('../../../bundle/web-app/presets/', import.meta.url))

function readList(path: string): PluginRow[] {
  return yaml.load(readFileSync(join(presetsDir, path), 'utf8'), { schema: entryListSchema }) as PluginRow[]
}

function declaredPresets(path: string): PluginRow[] {
  return readList(path).flatMap(row => row.insert ?? [])
}

function configOf(row: PluginRow | undefined): PresetConfig | undefined {
  return row === undefined || Array.isArray(row.config) ? undefined : row.config
}

function preset(path: string, id: string): PluginRow {
  const row = declaredPresets(path).find(candidate => configOf(candidate)?.id === id)
  expect(row, `${path} must declare ${id}`).toBeDefined()
  return row!
}

function effectiveStandardRows(presetRow: PluginRow): PluginRow[] {
  const include = configOf(presetRow)?.plugins?.[0]
  expect(include?.name).toBe('cordis:include')
  const includeConfig = configOf(include)
  expect(includeConfig?.path).toBe('compositions/standard.yml')
  return applyEntryPatches(
    readList('compositions/standard.yml') as never,
    (includeConfig?.patches ?? []) as never,
    () => {},
  ) as PluginRow[]
}

function findById(rows: PluginRow[], id: string): PluginRow | undefined {
  for (const candidate of rows) {
    if (candidate.id === id) return candidate
    if (Array.isArray(candidate.config)) {
      const nested = findById(candidate.config, id)
      if (nested !== undefined) return nested
    }
  }
  return undefined
}

function rowById(rows: PluginRow[], id: string): PluginRow {
  const row = findById(rows, id)
  expect(row, `composition must include ${id}`).toBeDefined()
  return row!
}

describe('shipped business AgentPreset compositions', () => {
  it('keeps the existing Standard and PTC modes on the shared composition source', () => {
    const standard = preset('standard.patch.yml', 'standard')
    const ptc = preset('ptc.patch.yml', 'ptc')
    const standardRows = effectiveStandardRows(standard)
    const ptcRows = effectiveStandardRows(ptc)

    expect(standardRows.map(row => row.id)).toContain('tool-fs')
    expect(standardRows.map(row => row.id)).toContain('tool-web')
    expect(findById(standardRows, 'tool-presentation')?.disabled).toBe(true)
    expect(findById(ptcRows, 'workflow-ptc')?.disabled).toBe(true)
    expect(findById(ptcRows, 'tool-workflow')?.disabled).toBe(true)
    expect(findById(ptcRows, 'tool-presentation')).toMatchObject({
      disabled: false,
      name: '@deepseek-ai/dsh-agent-tool-presentation',
      config: { mode: 'ptc' },
    })
  })

  it('offers General, AMZ, Development, and GitHub/Cloudflare with isolated real Skill roots', () => {
    const rows = declaredPresets('business.patch.yml')
    expect(rows.map(row => configOf(row)?.id)).toEqual([
      'general', 'amz', 'development', 'github-cloudflare',
    ])

    const expected: Record<string, string[]> = {
      general: ["'skill-scopes', 'general'"],
      amz: ["'skill-scopes', 'common'", "'skill-scopes', 'amazon'"],
      development: ["'skill-scopes', 'common'"],
      'github-cloudflare': ["'skill-scopes', 'common'", "'skill-scopes', 'cloudflare-dev'"],
    }

    for (const id of Object.keys(expected)) {
      const composed = effectiveStandardRows(preset('business.patch.yml', id))
      const skillSource = rowById(composed, 'skill-filesystem')
      expect(configOf(skillSource)?.includeDefaultRoots).toBe(false)
      const paths = (configOf(skillSource)?.customSkillDirs ?? []).map(value => value.__jsExpr)
      expect(paths).toHaveLength(expected[id]!.length)
      expect(paths.every(path => path.includes("process.getBuiltinModule('node:os').userInfo().homedir"))).toBe(true)
      expected[id]!.forEach(path => expect(paths.join('\n')).toContain(path))

      const ptc = id === 'development' || id === 'github-cloudflare'
      expect(findById(composed, 'tool-presentation')?.disabled).toBe(!ptc)
    }
  })
})
