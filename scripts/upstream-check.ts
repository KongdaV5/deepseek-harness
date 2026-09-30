/** Watch published official channels without advancing the source integration pin. */
import { parseArgs } from 'node:util'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { assertHistory, cachedCatalog, checkUpstream, customHead, loadPolicy, loadRegistry, officialCatalog, refreshObjects, writeIgnoredArtifact } from './upstream-maintenance.ts'

/** Run the fast status command; network refs are read-only unless refresh is explicit. */
export function runUpstreamCheck(root = process.cwd(), args = process.argv.slice(2)): void {
  const { values } = parseArgs({ args, options: { json: { type: 'boolean' }, refresh: { type: 'boolean' }, offline: { type: 'boolean' }, output: { type: 'string' } } })
  if (values.offline && values.refresh) throw new Error('OFFLINE_REFRESH_REFUSED')
  assertHistory(root)
  const registry = loadRegistry(root); const policy = loadPolicy(root, registry)
  const catalog = values.offline ? cachedCatalog(root) : officialCatalog(root, policy)
  if (values.refresh) {
    const release = catalog.releases.find(item => !item.prerelease || /-rc\.\d+$/u.test(item.tag))
    refreshObjects(root, catalog, release?.sha ?? policy.lastSynced.sha)
    writeIgnoredArtifact(root, '.artifacts/upstream-maintenance/catalog.json', catalog)
    writeIgnoredArtifact(root, '.artifacts/upstream-maintenance/fetch.json', { customHead: customHead(root), fetchedAt: catalog.fetchedAt, object: release?.sha ?? policy.lastSynced.sha })
  }
  const report = checkUpstream(root, catalog)
  if (values.output) {
    writeIgnoredArtifact(root, values.output, report)
    writeIgnoredArtifact(root, '.artifacts/upstream-maintenance/catalog.json', catalog)
  }
  console.log(values.json ? JSON.stringify(report, null, 2) : Object.entries(report).map(([key, value]) => `${key}: ${typeof value === 'string' ? value : JSON.stringify(value)}`).join('\n'))
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { runUpstreamCheck() } catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1 }
}
