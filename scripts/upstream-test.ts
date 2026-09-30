/** Revalidate report identity and print the affected-test plan; execution is opt-in. */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import { cachedCatalog, loadPolicy, loadRegistry, officialCatalog, renderPlan, runSafePlan, validatedPlan, type Report } from './upstream-maintenance.ts'

/** Recompute exact selected tests so a report cannot inject executable commands. */
export function runUpstreamTest(root = process.cwd(), args = process.argv.slice(2)): void {
  const { values } = parseArgs({ args, options: { report: { type: 'string' }, run: { type: 'boolean' }, json: { type: 'boolean' }, offline: { type: 'boolean' } } })
  if (!values.report) throw new Error('Expected --report <inspect-report.json>; default is DRY RUN')
  if (values.run && values.offline) throw new Error('RUN_REQUIRES_LIVE_OFFICIAL_SOURCE')
  const registry = loadRegistry(root); const policy = loadPolicy(root, registry)
  const catalog = values.offline ? cachedCatalog(root) : officialCatalog(root, policy)
  const report = validatedPlan(root, JSON.parse(readFileSync(resolve(root, values.report), 'utf8')) as Report, catalog)
  console.log(values.json ? JSON.stringify({ mode: values.run ? 'EXPLICIT_SAFE_UNIT_RUN' : 'DRY_RUN', identity: report.identity, affectedTests: report.affectedTests, evidence: report.evidence, qualificationGaps: report.qualificationGaps, staticValidation: report.staticValidation }, null, 2) : renderPlan(report, values.run ?? false))
  if (values.run) runSafePlan(root, report)
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { runUpstreamTest() } catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1 }
}
