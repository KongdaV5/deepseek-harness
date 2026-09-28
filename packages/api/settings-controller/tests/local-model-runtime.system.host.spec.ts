import { afterEach, describe, expect, it, vi } from 'vitest'
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SystemLocalModelRuntimeDriver, localModelProfileCatalog } from '../src/local-model-runtime.ts'

const roots: string[] = []

async function fakeHome(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), 'dsh-local-runtime-system-'))
  roots.push(home)
  const manager = join(home, '.local', 'bin', 'local-model')
  const plist = join(home, 'Library', 'LaunchAgents', 'com.kongda.local-mlx.plist')
  const config = join(home, '.config', 'local-model')
  const huihui = localModelProfileCatalog(home)[0]!.modelId
  const original = localModelProfileCatalog(home).find(profile => profile.id === '38')!.modelId
  await Promise.all([
    mkdir(join(home, '.local', 'bin'), { recursive: true }),
    mkdir(join(home, 'Library', 'LaunchAgents'), { recursive: true }),
    mkdir(config, { recursive: true }),
    mkdir(join(home, 'Models', 'Qwen-Image-2.1-mflux-8bit'), { recursive: true }),
    mkdir(join(home, 'Models', 'Qwen3.8-27B-GSQ-RCO-GGUF'), { recursive: true }),
    mkdir(join(home, 'Models', 'Huihui-Qwen3.8-27B-abliterated-GGUF'), { recursive: true }),
  ])
  await Promise.all([
    writeFile(manager, '#!/bin/sh\nexit 0\n'),
    writeFile(plist, 'test fixture'),
    writeFile(huihui, 'model fixture'),
    writeFile(original, 'original model fixture'),
    writeFile(join(home, 'Models', 'Qwen3.8-27B-GSQ-RCO-GGUF', 'mmproj-Qwen3.8-27B-BF16.gguf'), 'mmproj fixture'),
  ])
  await chmod(manager, 0o755)
  return home
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

function plistFor(home: string): string {
  const manager = join(home, '.local', 'bin', 'local-model')
  return JSON.stringify({
    Label: 'com.kongda.local-mlx',
    ProgramArguments: [manager, 'serve'],
    RunAtLoad: false,
    WorkingDirectory: join(home, '.config', 'local-model'),
  })
}

describe('the System local-model manager driver', () => {
  it('recognizes only the matching LaunchAgent and checks the loopback model endpoint', async () => {
    const home = await fakeHome()
    const execute = vi.fn(async (file: string) => {
      if (file === '/usr/bin/plutil') return plistFor(home)
      return 'state = running'
    })
    const portOpen = vi.fn(async () => true)
    const fetchModels = vi.fn(async () => [localModelProfileCatalog(home)[0]!.modelId])
    const driver = new SystemLocalModelRuntimeDriver({
      home, platform: 'darwin', uid: 501, execute, portOpen, fetchModels,
    })

    await expect(driver.probe()).resolves.toMatchObject({
      available: true, managed: true, launchState: 'running', listening: true,
      modelIds: [localModelProfileCatalog(home)[0]!.modelId],
    })
    expect(execute).toHaveBeenCalledWith('/bin/launchctl', ['print', 'gui/501/com.kongda.local-mlx'], 3000)
    expect(portOpen).toHaveBeenCalledOnce()
    expect(fetchModels).toHaveBeenCalledOnce()
    await expect(driver.profiles()).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'huihui', available: true, modality: 'text' }),
      expect.objectContaining({ id: 'img21', available: true, modality: 'image' }),
      expect.objectContaining({ id: '38', available: true, manageable: true, modality: 'text' }),
    ]))
  })

  it('does not inspect or stop an unrelated LaunchAgent when manager identity differs', async () => {
    const home = await fakeHome()
    const execute = vi.fn(async (file: string) => file === '/usr/bin/plutil'
      ? JSON.stringify({ Label: 'com.other.service', ProgramArguments: ['/tmp/other'], RunAtLoad: false })
      : 'state = running')
    const portOpen = vi.fn(async () => true)
    const driver = new SystemLocalModelRuntimeDriver({
      home, platform: 'darwin', uid: 501, execute, portOpen,
      fetchModels: async () => ['foreign-model'],
    })

    await expect(driver.probe()).resolves.toMatchObject({
      available: false, managed: false, listening: false, modelIds: [],
    })
    expect(execute).toHaveBeenCalledTimes(1)
    expect(execute).toHaveBeenCalledWith(
      '/usr/bin/plutil', ['-convert', 'json', '-o', '-', join(home, 'Library', 'LaunchAgents', 'com.kongda.local-mlx.plist')], 3000,
    )
    expect(portOpen).not.toHaveBeenCalled()
  })

  it('delegates runtime-only profile starts to the existing manager without a shell', async () => {
    const home = await fakeHome()
    const execute = vi.fn(async () => '')
    const driver = new SystemLocalModelRuntimeDriver({ home, platform: 'darwin', execute })

    await driver.run('runtime-start', 'huihui')
    expect(execute).toHaveBeenNthCalledWith(1, join(home, '.local', 'bin', 'local-model'), ['runtime-start', 'huihui'], 240_000)
    await driver.run('runtime-start', '38')
    expect(execute).toHaveBeenNthCalledWith(2, join(home, '.local', 'bin', 'local-model'), ['runtime-start', '38'], 240_000)
    await expect(driver.run('runtime-start', 'unknown' as never)).rejects.toThrow('unsupported local model profile')
    expect(execute).toHaveBeenCalledTimes(2)
  })
})
