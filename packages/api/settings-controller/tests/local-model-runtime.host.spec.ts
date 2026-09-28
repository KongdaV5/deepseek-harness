import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { remoteMethods } from '@deepseek-ai/dsh-typert-protocol'
import {
  LocalModelRuntimeController, localModelProfileCatalog,
  type LocalModelRuntimeDriver, type LocalModelRuntimeProbe, type RuntimeProfile,
} from '../src/local-model-runtime.ts'

class MemoryDriver implements LocalModelRuntimeDriver {
  readonly profilesValue = localModelProfileCatalog('/models')
  readonly commands: Array<{ command: 'runtime-start' | 'stop'; profile?: string }> = []
  probeValue: LocalModelRuntimeProbe = {
    available: true, managed: false, listening: false, modelIds: [],
  }
  failHealth = false

  profiles(): Promise<RuntimeProfile[]> {
    return Promise.resolve(this.profilesValue.map(profile => ({ ...profile, available: true })))
  }

  probe(): Promise<LocalModelRuntimeProbe> {
    return Promise.resolve(this.probeValue)
  }

  run(command: 'runtime-start' | 'stop', profile?: RuntimeProfile['id']): Promise<void> {
    this.commands.push({ command, ...(profile === undefined ? {} : { profile }) })
    if (command === 'stop') {
      this.probeValue = { available: true, managed: false, listening: false, modelIds: [] }
    } else if (this.failHealth) {
      this.probeValue = { available: true, managed: true, launchState: 'waiting', listening: false, modelIds: [] }
    } else {
      const modelId = this.profilesValue.find(candidate => candidate.id === profile)!.modelId
      this.probeValue = { available: true, managed: true, launchState: 'running', listening: true, modelIds: [modelId] }
    }
    return Promise.resolve()
  }

  waitFor(predicate: (probe: LocalModelRuntimeProbe) => boolean): Promise<LocalModelRuntimeProbe> {
    void predicate
    return this.probe()
  }
}

async function boot(driver: MemoryDriver): Promise<{
  readonly controller: LocalModelRuntimeController
  readonly fiber: Context['fiber']
}> {
  class TestLocalModelRuntimeController extends LocalModelRuntimeController {
    constructor(ctx: Context) {
      super(ctx, { enabled: true }, driver)
    }
  }
  const ctx = new Context()
  const fiber = ctx.plugin(TestLocalModelRuntimeController)
  await fiber.await()
  return { controller: ctx.localModelRuntimeController, fiber }
}

describe('the existing local-model manager control', () => {
  it('publishes its own Remote namespace with only lifecycle operations', async () => {
    const driver = new MemoryDriver()
    const bench = await boot(driver)
    expect(bench.controller.typertRemote.namespace).toBe('localModels')
    expect(remoteMethods(bench.controller)).toEqual([
      { method: 'status', invocation: { kind: 'direct' } },
      { method: 'start', invocation: { kind: 'direct' } },
      { method: 'stop', invocation: { kind: 'direct' } },
      { method: 'restart', invocation: { kind: 'direct' } },
    ])
    await bench.fiber.dispose()
  })

  it('stays disabled unless the deployment explicitly enables local runtime controls', async () => {
    const ctx = new Context()
    const fiber = ctx.plugin(LocalModelRuntimeController)
    await fiber.await()
    await expect(ctx.localModelRuntimeController.status()).resolves.toMatchObject({
      enabled: false, available: false, state: 'stopped', canStop: false,
    })
    await fiber.dispose()
  })

  it('reports stopped even when local model files and DSH settings exist', async () => {
    const driver = new MemoryDriver()
    const bench = await boot(driver)
    await expect(bench.controller.status()).resolves.toMatchObject({ state: 'stopped', profile: null })
    await bench.fiber.dispose()
  })

  it('reports running only after the target model answers the health probe', async () => {
    const driver = new MemoryDriver()
    const bench = await boot(driver)
    await expect(bench.controller.start('huihui')).resolves.toMatchObject({ state: 'running', profile: 'huihui' })
    await expect(bench.controller.status()).resolves.toMatchObject({ state: 'running', profile: 'huihui' })
    await bench.fiber.dispose()
  })

  it('confirms manager shutdown and port release before returning stopped', async () => {
    const driver = new MemoryDriver()
    const bench = await boot(driver)
    await bench.controller.start('huihui')
    await expect(bench.controller.stop()).resolves.toMatchObject({ state: 'stopped' })
    expect(driver.probeValue.listening).toBe(false)
    await bench.fiber.dispose()
  })

  it('restarts through an ordered stop, port-release, and start', async () => {
    const driver = new MemoryDriver()
    const bench = await boot(driver)
    await bench.controller.start('huihui')
    await expect(bench.controller.restart('img21')).resolves.toMatchObject({ state: 'running', profile: 'img21' })
    expect(driver.commands.slice(-2)).toEqual([{ command: 'stop' }, { command: 'runtime-start', profile: 'img21' }])
    await bench.fiber.dispose()
  })

  it('reports a manager job whose process exited as error, not running', async () => {
    const driver = new MemoryDriver()
    const bench = await boot(driver)
    driver.probeValue = { available: true, managed: true, launchState: 'waiting', listening: false, modelIds: [] }
    await expect(bench.controller.status()).resolves.toMatchObject({ state: 'error' })
    await bench.fiber.dispose()
  })

  it('can stop an unhealthy model only when the verified manager owns it', async () => {
    const driver = new MemoryDriver()
    driver.probeValue = {
      available: true, managed: true, launchState: 'running', listening: true, modelIds: ['unknown-model'],
    }
    const bench = await boot(driver)
    await expect(bench.controller.status()).resolves.toMatchObject({ state: 'error', canStop: true })
    await expect(bench.controller.stop()).resolves.toMatchObject({ state: 'stopped', canStop: false })
    expect(driver.commands).toEqual([{ command: 'stop' }])
    await bench.fiber.dispose()
  })

  it('never starts a conflicting profile until the current one releases the shared port', async () => {
    const driver = new MemoryDriver()
    const bench = await boot(driver)
    await bench.controller.start('huihui')
    await expect(bench.controller.start('img21')).resolves.toMatchObject({ state: 'running', profile: 'img21' })
    expect(driver.commands.slice(-2)).toEqual([{ command: 'stop' }, { command: 'runtime-start', profile: 'img21' }])
    await bench.fiber.dispose()
  })

  it('starts Original Qwen through runtime-only selection and leaves foreign listeners untouched', async () => {
    const driver = new MemoryDriver()
    const bench = await boot(driver)
    await expect(bench.controller.start('38')).resolves.toMatchObject({ state: 'running', profile: '38' })
    expect(driver.commands).toEqual([{ command: 'runtime-start', profile: '38' }])
    driver.probeValue = { available: true, managed: false, listening: true, modelIds: ['foreign-model'] }
    await expect(bench.controller.stop()).rejects.toThrow(/outside the local-model manager/u)
    expect(driver.commands).toEqual([{ command: 'runtime-start', profile: '38' }])
    await bench.fiber.dispose()
  })

  it('switches between Huihui and Original Qwen only after the manager and shared port stop', async () => {
    const driver = new MemoryDriver()
    const bench = await boot(driver)
    await bench.controller.start('huihui')
    await expect(bench.controller.start('38')).resolves.toMatchObject({ state: 'running', profile: '38' })
    await expect(bench.controller.start('huihui')).resolves.toMatchObject({ state: 'running', profile: 'huihui' })
    expect(driver.commands).toEqual([
      { command: 'runtime-start', profile: 'huihui' },
      { command: 'stop' },
      { command: 'runtime-start', profile: '38' },
      { command: 'stop' },
      { command: 'runtime-start', profile: 'huihui' },
    ])
    await bench.fiber.dispose()
  })

  it('keeps a startup health failure visible in the next fresh status', async () => {
    const driver = new MemoryDriver()
    driver.failHealth = true
    const bench = await boot(driver)
    await expect(bench.controller.start('huihui')).rejects.toThrow(/health check/u)
    const status = await bench.controller.status()
    expect(status.state).toBe('error')
    expect(status.error).toMatch(/health check/u)
    await bench.fiber.dispose()
  })
})
