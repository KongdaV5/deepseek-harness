/** Managed-range lifetime evidence independent of health endpoint caches. */
import { Context } from '@deepseek-ai/cordis'
import { expect, it, onTestFinished } from 'vitest'
import { SubprocessRuntime, type SubprocessHandle, type SubprocessOutcome, type SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import { OwnedLocalProcessDriver } from '../src/owned-local-driver.ts'
class Provider extends SubprocessRuntime {
  readonly outcome = Promise.withResolvers<SubprocessOutcome>()
  empty = false
  calls = 0
  terminated = 0
  readonly specs: SubprocessSpawnSpec[] = []
  resolveExecutable(): never { throw new Error('No lookup') }
  terminalEnvironment(): never { throw new Error('No terminal') }
  spawnTerminal(): never { throw new Error('No terminal') }
  spawn(spec: SubprocessSpawnSpec): SubprocessHandle {
    this.calls++; this.specs.push(spec)
    return { stdin: undefined, stdout: undefined, stderr: undefined, control: undefined, collected: {}, done: this.outcome.promise,
      terminate: () => { this.terminated++ }, waitForExit: async () => this.empty }
  }
}
async function fixture() {
  const ctx = new Context(); onTestFinished(() => ctx.fiber.dispose()); await ctx.plugin(Provider)
  const provider = ctx.subprocess
  if (!(provider instanceof Provider)) throw new Error('Fixture provider unavailable')
  const driver = new OwnedLocalProcessDriver(ctx, { binary: '/fixture/llama', cwd: '/fixture', args: [], endpoint: 'http://127.0.0.1:1/v1' },
    () => [{ id: 'huihui', name: 'Huihui', modality: 'text', modelId: '/fixture/gguf' }])
  return { provider, driver }
}
it('does not relinquish a live managed range after a failed stop', async () => {
  const { provider, driver } = await fixture(); await driver.run('runtime-start', 'huihui')
  await expect(driver.run('stop')).rejects.toThrow('did not terminate')
  await expect(driver.run('runtime-start', 'huihui')).rejects.toThrow('cannot start another child')
  expect(provider.calls).toBe(1)
  provider.empty = true; provider.outcome.resolve({ exitCode: 0, signal: null })
  await driver.run('stop'); expect((await driver.probe()).managed).toBe(false)
})
it('retains a crashed command handle until its same managed range is joined', async () => {
  const { provider, driver } = await fixture(); await driver.run('runtime-start', 'huihui')
  provider.outcome.resolve({ exitCode: 1, signal: null }); await provider.outcome.promise
  expect((await driver.probe()).managed).toBe(true)
  await expect(driver.run('runtime-start', 'huihui')).rejects.toThrow('cannot start another child')
  provider.empty = true; await driver.dispose(); expect(provider.terminated).toBe(1)
  await expect(driver.run('runtime-start', 'huihui')).rejects.toThrow('cannot start another child')
})
it('rejects deployment overrides of controller-owned model and serving resource', async () => {
  const { driver, provider } = await fixture()
  await driver.run('runtime-start', 'huihui')
  expect(provider.specs[0]?.argv).toEqual(['/fixture/llama', '--model', '/fixture/gguf', '--alias', '/fixture/gguf', '--host', '127.0.0.1', '--port', '1'])
  provider.empty = true; provider.outcome.resolve({ exitCode: 0, signal: null }); await driver.dispose()
  const ctx = new Context(); onTestFinished(() => ctx.fiber.dispose())
  expect(() => new OwnedLocalProcessDriver(ctx, { binary: '/fixture/llama', cwd: '/fixture', args: ['--port=8080'], endpoint: 'http://127.0.0.1:1/v1' }, () => [])).toThrow('cannot override')
})
