/** Shared-runtime status/Light and explicitly requested synthetic Full maintenance. */
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { CodexAppServerClient, bundledCodexRuntime, inspectCodexRuntime, resolveSystemCodexRuntime } from '../packages/core/agent-codex/src/app-server.ts'
import { CodexCompatibilityMaintenance, CodexIncompatibleError, fullCodexCompatibility } from '../packages/core/agent-codex/src/compatibility.ts'
import { verifyCodexHome } from '../packages/core/agent-codex/src/home.ts'
import { spawnSubprocess } from '../packages/subprocess/subprocess-local/src/spawn.ts'

/** Run the same verifier used to admit Desktop connections, without account mutations.
 * @param args - status/light/full, system/bundled and json flags.
 * @returns nonzero for unverified required capabilities; output omits account/message payloads.
 */
export async function codexCompatCommand(args: readonly string[]): Promise<number> {
  const allowed = ['--status', '--light', '--full', '--system', '--bundled', '--json']
  if (args.some(a => !allowed.includes(a)) || args.filter(a => ['--status', '--light', '--full'].includes(a)).length > 1
    || args.includes('--system') && args.includes('--bundled')) throw new Error('Choose one mode and runtime, with optional --json.')
  const mode = args.includes('--full') ? 'full' : args.includes('--light') ? 'light' : 'status'
  const root = resolve(process.env.DSH_HOME ?? join(homedir(), 'Library/Application Support/@deepseek-ai/dsh-harness-custom'))
  const maintenance = new CodexCompatibilityMaintenance(root)
  const sources = args.includes('--system') ? ['system'] : args.includes('--bundled') ? ['bundled'] : ['system', 'bundled']
  const output: unknown[] = []
  let code = 0
  for (const source of sources) {
    let client: CodexAppServerClient | undefined
    const waiting = new Set<{
      method: string
      predicate: (p: Record<string, unknown>) => boolean
      resolve: (p: Record<string, unknown>) => void
      reject: (e: Error) => void
    }>()
    try {
      const runtime = source === 'system' ? resolveSystemCodexRuntime().runtime : bundledCodexRuntime()
      if (runtime === undefined) throw new Error('System official identity unavailable.')
      if (mode === 'status') {
        output.push({ source, version: runtime.version, identity: 'VERIFIED', evidence: await maintenance.status(runtime) ?? null })
        continue
      }
      const home = await verifyCodexHome(join(root, 'codex-subscription', 'codex-home'), root)
      await inspectCodexRuntime(runtime)
      client = CodexAppServerClient.start(spawnSubprocess, home, home, {
        onNotification: (method, p) => {
          for (const waiter of waiting) if (waiter.method === method && waiter.predicate(p)) { waiting.delete(waiter); waiter.resolve(p) }
        },
        onRequest: () => Promise.reject(new Error('Compatibility checks do not authorize tools or approvals.')),
        onExit: () => { for (const w of waiting) w.reject(new Error('Compatibility App Server exited.')); waiting.clear() },
      }, runtime)
      const initialized = await client.initialize()
      let evidence = await maintenance.light(runtime, client, initialized)
      if (mode === 'full') {
        evidence = await fullCodexCompatibility(evidence, client, async (method, predicate, action) => {
          let waiter: Parameters<typeof waiting.add>[0] | undefined
          let timer: ReturnType<typeof setTimeout> | undefined
          const event = new Promise<Record<string, unknown>>((resolveEvent, reject) => {
            waiter = { method, predicate, resolve: resolveEvent, reject }; waiting.add(waiter)
            timer = setTimeout(() =>{  reject(new Error('Compatibility event deadline exceeded.')) }, 90_000)
          })
          void event.catch(() => {})
          try { await action(); return await event }
          finally { if (waiter !== undefined) waiting.delete(waiter); clearTimeout(timer) }
        })
        await maintenance.persist(evidence)
      }
      output.push(evidence)
      if (evidence.lightStatus !== 'PASS' || mode === 'full' && evidence.fullStatus !== 'PASS') code = 1
    } catch (error) {
      code = 1
      output.push({ runtimeSource: source, status: error instanceof CodexIncompatibleError ? 'FAIL' : 'UNKNOWN',
        classification: error instanceof CodexIncompatibleError ? 'LEVEL_3_BREAKING' : null,
        failureClassification: error instanceof CodexIncompatibleError ? 'INCOMPATIBLE' : 'TEMPORARY_RPC',
        capability: error instanceof Error && error.name === 'CodexIncompatibleError' ? error.message : 'Verification unavailable or temporary RPC failure.' })
    } finally { await client?.dispose() }
  }
  console.log(JSON.stringify({ command: 'codex:compat', mode, results: output }, null, args.includes('--json') ? undefined : 2))
  return code
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await codexCompatCommand(process.argv.slice(2))
}
