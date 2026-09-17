import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { prepareDevelopmentProject } from '../scripts/development-project.ts'
import { prepareDevelopmentFixtures } from '../scripts/development-fixtures.ts'
import { DESKTOP_HOST_PROTOCOL_VERSION } from '../src/host-protocol.ts'
import type { DesktopRelease } from '../src/release.ts'

const roots: string[] = []

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-desktop-development-test-'))
  roots.push(root)
  return root
}

function release(version = '1.2.3'): DesktopRelease {
  return {
    schemaVersion: 1,
    version,
    hostProtocolVersion: DESKTOP_HOST_PROTOCOL_VERSION,
    nodeVersion: '24.17.0',
    pnpmVersion: '11.7.0',
  }
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('desktop development project', () => {
  it('writes phase2-6 settings and presets only below the supplied Dev home', () => {
    const root = temporaryRoot()
    const home = join(root, 'development-home')
    const metadata = prepareDevelopmentFixtures({
      home,
      repositoryRoot: process.cwd(),
      runtimeVersion: '1.2.3',
      composition: 'phase2-6',
    })
    expect(metadata).toMatchObject({ desktopFlavor: 'development', provider: 'local-qwen-dev', runtimeVersion: '1.2.3' })
    expect(readFileSync(join(home, 'settings.yaml'), 'utf8')).toContain('contextWindow: 65536')
    expect(readFileSync(join(home, 'settings.yaml'), 'utf8')).toContain('maxTokens: 24576')
    expect(readFileSync(join(home, 'settings.yaml'), 'utf8')).toContain('apiKeyEnv: LOCAL_QWEN_API_KEY')
    expect(readFileSync(join(home, 'settings.yaml'), 'utf8')).toContain('xhigh: xhigh')
    expect(readFileSync(join(home, '.agent-presets', 'lite-general', 'preset.yml'), 'utf8')).toContain('Dev Lite General')
    expect(readFileSync(join(home, '.agent-presets', 'benchmark', 'preset.yml'), 'utf8')).toContain('visibility: hidden')
    expect(JSON.parse(readFileSync(join(home, '.desktop-dev-metadata.json'), 'utf8'))).toMatchObject({
      composition: 'phase2-6', baseUrl: 'http://127.0.0.1:8081/v1',
    })
  })

  it('projects the built dsh and Desktop Host applications with their dependency graph', () => {
    const root = temporaryRoot()
    const cli = join(root, 'apps', 'cli')
    const host = join(root, 'apps', 'desktop-host')
    const dependencies = join(root, 'workspace-dependencies')
    mkdirSync(join(cli, 'lib'), { recursive: true })
    mkdirSync(join(host, 'lib'), { recursive: true })
    mkdirSync(join(dependencies, '@scope'), { recursive: true })
    mkdirSync(join(dependencies, '@deepseek-ai', 'dsh'), { recursive: true })
    writeFileSync(join(cli, 'package.json'), '{"name":"@deepseek-ai/dsh","version":"1.2.3"}\n')
    writeFileSync(join(host, 'package.json'), '{"name":"@deepseek-ai/dsh-desktop-host","version":"1.2.3"}\n')
    writeFileSync(join(host, 'lib', 'index.js'), '')
    writeFileSync(join(dependencies, '@deepseek-ai', 'dsh', 'package.json'), '{}\n')
    mkdirSync(join(dependencies, 'plain-dependency'))
    writeFileSync(join(dependencies, 'plain-dependency', 'package.json'), '{}\n')
    mkdirSync(join(dependencies, '@scope', 'dependency'))
    writeFileSync(join(dependencies, '@scope', 'dependency', 'package.json'), '{}\n')

    const project = prepareDevelopmentProject({
      projectDir: join(root, 'development'),
      cliDir: cli,
      hostDir: host,
      dependencyDir: dependencies,
      release: release(),
    })
    expect(realpathSync(join(project, 'node_modules', '@deepseek-ai', 'dsh'))).toBe(realpathSync(cli))
    expect(realpathSync(join(project, 'node_modules', '@deepseek-ai', 'dsh-desktop-host'))).toBe(realpathSync(host))
    expect(realpathSync(join(project, 'node_modules', 'plain-dependency')))
      .toBe(realpathSync(join(dependencies, 'plain-dependency')))
    expect(realpathSync(join(project, 'node_modules', '@scope', 'dependency')))
      .toBe(realpathSync(join(dependencies, '@scope', 'dependency')))
    const manifest = JSON.parse(readFileSync(join(project, 'package.json'), 'utf8')) as {
      dependencies: Record<string, string>
    }
    expect(manifest.dependencies['@deepseek-ai/dsh']).toBe('1.2.3')
    expect(manifest.dependencies['@deepseek-ai/dsh-desktop-host']).toBe('1.2.3')
  })

  it('rejects a CLI package from another release', () => {
    const root = temporaryRoot()
    const cli = join(root, 'apps', 'cli')
    const host = join(root, 'apps', 'desktop-host')
    const dependencies = join(root, 'workspace-dependencies')
    mkdirSync(join(cli, 'lib'), { recursive: true })
    mkdirSync(join(host, 'lib'), { recursive: true })
    mkdirSync(dependencies, { recursive: true })
    writeFileSync(join(cli, 'package.json'), '{"name":"@deepseek-ai/dsh","version":"2.0.0"}\n')
    writeFileSync(join(host, 'package.json'), '{"name":"@deepseek-ai/dsh-desktop-host","version":"1.2.3"}\n')
    writeFileSync(join(host, 'lib', 'index.js'), '')
    expect(() => prepareDevelopmentProject({
      projectDir: join(root, 'development'),
      cliDir: cli,
      hostDir: host,
      dependencyDir: dependencies,
      release: release(),
    })).toThrow(/must be @deepseek-ai\/dsh@1\.2\.3/u)
  })

  it('adds only the fixed phase2-6 bundle when development composition is explicit', () => {
    const root = temporaryRoot()
    const cli = join(root, 'apps', 'cli')
    const host = join(root, 'apps', 'desktop-host')
    const dependencies = join(root, 'workspace-dependencies')
    const bundle = join(root, 'packages', 'bundle', 'desktop-dev-composition')
    mkdirSync(join(cli, 'lib'), { recursive: true })
    mkdirSync(join(host, 'lib'), { recursive: true })
    mkdirSync(dependencies, { recursive: true })
    mkdirSync(bundle, { recursive: true })
    writeFileSync(join(cli, 'package.json'), '{"name":"@deepseek-ai/dsh","version":"1.2.3"}\n')
    writeFileSync(join(host, 'package.json'), '{"name":"@deepseek-ai/dsh-desktop-host","version":"1.2.3"}\n')
    writeFileSync(join(host, 'lib', 'index.js'), '')
    mkdirSync(join(bundle, 'node_modules', '@deepseek-ai', 'dsh-phase-capability'), { recursive: true })
    writeFileSync(join(bundle, 'package.json'), JSON.stringify({
      name: '@deepseek-ai/dsh-desktop-dev-composition',
      version: '1.2.3',
      dependencies: { '@deepseek-ai/dsh-phase-capability': 'workspace:^' },
    }))
    writeFileSync(join(bundle, 'node_modules', '@deepseek-ai', 'dsh-phase-capability', 'package.json'), '{}\n')
    const project = prepareDevelopmentProject({
      projectDir: join(root, 'development'),
      cliDir: cli,
      hostDir: host,
      dependencyDir: dependencies,
      release: release(),
      composition: 'phase2-6',
    })
    const manifest = JSON.parse(readFileSync(join(project, 'package.json'), 'utf8')) as {
      dependencies: Record<string, string>
      dsh: { profile: { bundles: string[] } }
    }
    expect(manifest.dependencies['@deepseek-ai/dsh-desktop-dev-composition']).toBe('1.2.3')
    expect(manifest.dsh.profile.bundles).toEqual([
      '@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', '@deepseek-ai/dsh-desktop-dev-composition',
    ])
    expect(realpathSync(join(project, 'node_modules', '@deepseek-ai', 'dsh-desktop-dev-composition'))).toBe(realpathSync(bundle))
    expect(realpathSync(join(project, 'node_modules', '@deepseek-ai', 'dsh-phase-capability')))
      .toBe(realpathSync(join(bundle, 'node_modules', '@deepseek-ai', 'dsh-phase-capability')))
  })
})
