/** One-way Custom settings import into the canonical profile patch, retaining the source archive. */
import { readFile, rename } from 'node:fs/promises'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { withFileLock, writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { Config as PiAiConfig } from '@deepseek-ai/dsh-llm-pi-ai'
import { parse, stringify } from 'yaml'
import { z } from 'zod'

const codex = z.object({ preference: z.enum(['auto', 'system', 'bundled']).optional(), authGeneration: z.string().min(1).optional(), authTransition: z.object({ id: z.string().min(1), kind: z.enum(['login', 'logout', 'invalidated']) }).strict().nullable().optional() }).strict()
const selection = z.object({ provider: z.string().min(1), model: z.string().min(1), reasoningEffort: z.string().optional() }).strict()
const controls = z.object({ localModelRuntime: z.boolean().optional(), codexSubscription: z.boolean().optional() }).strict()
const local = z.object({ localProfiles: z.array(z.object({ id: z.string().min(1), name: z.string().min(1), modality: z.enum(['text', 'image']), modelId: z.string().min(1) }).strict()).optional(), selectedLocalProfile: z.string().min(1).optional() }).strict()
interface ImportRow { id: string; config: Record<string, unknown> }

/** Translate known Custom sections; retain unknown sections only in the archived source.
 * @param document Parsed legacy YAML document.
 * @returns Validated plugin-owned values and unresolved section names.
 */
export function translateLegacyCustomSettings(document: unknown): { rows: ImportRow[]; unknownSections: string[] } {
  const sections = z.record(z.string(), z.unknown()).parse(document ?? {})
  const rows: ImportRow[] = []
  const unknownSections: string[] = []
  for (const [name, value] of Object.entries(sections)) {
    if (name === 'openai-codex-runtime') rows.push({ id: 'agent-codex', config: codex.parse(value) })
    else if (name === 'agent-default-model') {
      const next = selection.parse(value)
      // The legacy hosted default is an inherited default, never implicit routing authority for Custom.
      if (!['deepseek', 'deepseek-official', 'deepseek-account'].includes(next.provider)) rows.push({ id: name, config: next })
    } else if (name === 'llm-pi-ai') {
      const providers = z.object({ providers: z.record(z.string(), z.unknown()) }).strict().parse(value)
      PiAiConfig(providers as Parameters<typeof PiAiConfig>[0])
      rows.push({ id: name, config: providers })
    } else if (name === 'settings-controller') rows.push({ id: 'custom-foundation', config: controls.parse(value) })
    else if (name === 'custom-foundation') rows.push({ id: name, config: local.parse(value) })
    else if (name === 'ui-developer-tools' || name === 'ui-settings') rows.push({ id: 'ui-settings', config: z.object({ enabled: z.boolean().optional() }).strict().parse(value) })
    else if (name === 'ui-onboarding' || name === 'ui-settings-general') rows.push({ id: 'ui-settings-general', config: z.object({ welcomeNoticeVersion: z.string().optional() }).strict().parse(value) })
    else if (name === 'ui-theme') rows.push({ id: name, config: z.object({ preference: z.enum(['system', 'light', 'dark']).optional(), fontSize: z.number().int().min(10).max(22).optional() }).strict().parse(value) })
    else unknownSections.push(name)
  }
  return { rows, unknownSections }
}

/** Import validated sections in one atomic profile write, then archive the unchanged source.
 * A digest in the Custom-owned row recovers interruption after publication without applying the source twice.
 * Existing profile values win; conflicting auth lifecycle values refuse the import rather than rotate authority.
 * @param home Explicit candidate data root.
 * @param profileDir Active Custom profile directory, whose package lock serializes writes.
 * @returns Import status and unresolved sections; no authentication or Session operation occurs.
 */
export async function importLegacyCustomSettings(home: string, profileDir: string): Promise<{ status: 'absent' | 'imported' | 'already-imported'; unknownSections: string[] }> {
  return withFileLock(join(profileDir, 'package.json'), async () => {
    const path = join(home, 'settings.yaml')
    let source: string
    let archived = false
    try { source = await readFile(path, 'utf8') }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      try { source = await readFile(`${path}.imported`, 'utf8'); archived = true }
      catch (archiveError) {
        if ((archiveError as NodeJS.ErrnoException).code !== 'ENOENT') throw archiveError
        return { status: 'absent', unknownSections: [] }
      }
    }
    if (!archived) {
      try {
        if (await readFile(`${path}.imported`, 'utf8') !== source) throw new Error('Legacy settings archive conflicts with the pending source')
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
    }
    const digest = createHash('sha256').update(source).digest('hex')
    const translated = translateLegacyCustomSettings(parse(source))
    const patchPath = join(profileDir, 'cordis.patch.yml')
    const rows = z.array(z.object({ id: z.string(), config: z.record(z.string(), z.unknown()).optional() }).loose()).parse(parse(await readFile(patchPath, 'utf8')))
    const marker = rows.findLast(row => row.id === 'custom-foundation')
    if (marker?.config?.['legacyImportDigest'] === digest) {
      if (!archived) await rename(path, `${path}.imported`)
      return { status: 'already-imported', unknownSections: translated.unknownSections }
    }
    for (const row of translated.rows) {
      const existing = rows.findLast(value => value.id === row.id)
      const current = existing?.config ?? {}
      if (row.id === 'agent-codex') {
        for (const key of ['authGeneration', 'authTransition']) {
          if (Object.hasOwn(current, key) && Object.hasOwn(row.config, key) && !isDeepStrictEqual(current[key], row.config[key])) throw new Error('Legacy import conflicts with existing Codex authentication authority')
        }
      }
      const config = { ...row.config, ...current }
      if (existing === undefined) rows.push({ id: row.id, config })
      else existing.config = config
    }
    const owner = rows.findLast(row => row.id === 'custom-foundation')
    if (owner === undefined) rows.push({ id: 'custom-foundation', config: { legacyImportDigest: digest } })
    else owner.config = { ...owner.config, legacyImportDigest: digest }
    await writeFileAtomic(patchPath, stringify(rows), { mode: 0o600 })
    if (!archived) await rename(path, `${path}.imported`)
    return { status: 'imported', unknownSections: translated.unknownSections }
  })
}
