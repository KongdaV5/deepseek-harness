/** The Computer Use bundle inserts the four rows the shipped Web composition leaves out, safety first. */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import * as yaml from 'js-yaml'
import { entryListSchema } from '@deepseek-ai/cordis-plugin-include'

const root = fileURLToPath(new URL('..', import.meta.url))

interface Manifest {
  name?: string
  icon?: string
  private?: boolean
  publishConfig?: { access?: string }
  exports?: Record<string, unknown>
  dependencies?: Record<string, string>
  dsh?: { bundle?: { patch?: string } }
}

describe('Computer Use bundle', () => {
  const manifest = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as Manifest

  it('publishes as an optional bundle with plugin-manager display metadata', () => {
    expect(manifest.name).toBe('@deepseek-ai/dsh-computer-use-bundle')
    expect(manifest.private).toBeUndefined()
    expect(manifest.publishConfig?.access).toBe('public')
    expect(manifest.icon).toBe('./icon.svg')
    expect(manifest.dsh?.bundle?.patch).toBe('./cordis.patch.yml')
    expect(manifest.exports?.['./locale/*.json']).toBe('./locale/*.json')
    expect(manifest.exports?.['./cordis.patch.yml']).toBe('./cordis.patch.yml')
    // Every inserted row names a package this bundle depends on, so the rows resolve from the bundle.
    expect(Object.keys(manifest.dependencies ?? {}).sort()).toEqual([
      '@deepseek-ai/dsh-client-ui-custom-computer-use',
      '@deepseek-ai/dsh-computer-use',
      '@deepseek-ai/dsh-custom-computer-use-safety',
      '@deepseek-ai/dsh-experimental-computer-use-cua-driver-mcp',
    ])
  })

  it('inserts the provider, its registration, and the safety layer switched on', () => {
    const parsed = yaml.load(readFileSync(resolve(root, './cordis.patch.yml'), 'utf8'), { schema: entryListSchema })
    expect(parsed).toEqual([{
      insert: [
        { id: 'computer-use', name: '@deepseek-ai/dsh-computer-use' },
        { id: 'computer-use-safety', name: '@deepseek-ai/dsh-custom-computer-use-safety' },
        {
          id: 'computer-use-cua-driver-mcp',
          name: '@deepseek-ai/dsh-experimental-computer-use-cua-driver-mcp',
          config: {
            failOnStartupError: false,
            command: 'cua-driver',
            args: ['mcp'],
            env: { CUA_DRIVER_RS_PERMISSIONS_GATE: '0' },
            reconnect: { enabled: true, initialDelayMs: 500, maxDelayMs: 30000, maxAttempts: 10 },
          },
        },
        { id: 'ui-custom-computer-use', name: '@deepseek-ai/dsh-client-ui-custom-computer-use' },
      ],
    }])
  })

  it('installs the admission gate before any desktop tool can be called', () => {
    const parsed = yaml.load(readFileSync(resolve(root, './cordis.patch.yml'), 'utf8'), { schema: entryListSchema }) as
      { insert: { id: string }[] }[]
    const inserted = parsed.flatMap(patch => patch.insert).map(row => row.id)
    expect(inserted.indexOf('computer-use-safety')).toBeLessThan(inserted.indexOf('computer-use-cua-driver-mcp'))
  })
})
