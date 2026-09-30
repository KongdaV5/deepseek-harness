/** Inspect one immutable official target; stdout is the default artifact destination. */
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import { assertHistory, cachedCatalog, inspectTarget, loadPolicy, loadRegistry, officialCatalog, refreshObjects, renderInspect, resolveTarget, writeIgnoredArtifact, type Report } from './upstream-maintenance.ts'

/** Run release inspection; master requires an explicit development flag. */
export function runUpstreamInspect(root = process.cwd(), args = process.argv.slice(2)): void {
  const { values } = parseArgs({ args, options: { tag: { type: 'string' }, master: { type: 'boolean' }, json: { type: 'boolean' }, offline: { type: 'boolean' }, refresh: { type: 'boolean' }, output: { type: 'string' } } })
  if (Boolean(values.tag) === Boolean(values.master)) throw new Error('Select exactly --tag <official-tag> or --master (development only)')
  if (values.offline && values.refresh) throw new Error('OFFLINE_REFRESH_REFUSED')
  const tag = values.master ? 'master' : values.tag as string
  assertHistory(root)
  const registry = loadRegistry(root); const policy = loadPolicy(root, registry)
  const catalog = values.offline ? cachedCatalog(root) : officialCatalog(root, policy)
  const observation = resolve(root, '.artifacts/upstream-maintenance/last-inspected.json')
  const previous = existsSync(observation) ? JSON.parse(readFileSync(observation, 'utf8')) as Report['identity'] : undefined
  const target = resolveTarget(catalog, tag, tag === 'master' ? undefined : previous)
  if (values.refresh) {
    refreshObjects(root, catalog, target.sha)
    writeIgnoredArtifact(root, '.artifacts/upstream-maintenance/catalog.json', catalog)
  }
  const report = inspectTarget(root, catalog, tag, tag === 'master' ? undefined : previous)
  if (values.output) {
    writeIgnoredArtifact(root, values.output, report)
    writeIgnoredArtifact(root, '.artifacts/upstream-maintenance/catalog.json', catalog)
    writeIgnoredArtifact(root, '.artifacts/upstream-maintenance/last-inspected.json', report.identity)
  }
  console.log(values.json ? JSON.stringify(report, null, 2) : renderInspect(report))
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { runUpstreamInspect() } catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1 }
}
