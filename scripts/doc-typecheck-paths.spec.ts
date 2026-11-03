import { describe, expect, it } from 'vitest'
import { builtDeclarationPath } from './doc-typecheck-paths.ts'

describe('builtDeclarationPath', () => {
  it('maps package source directories and exact entry files to built declarations', () => {
    expect(builtDeclarationPath('./packages/*/*/src')).toBe('./packages/*/*/lib/types')
    expect(builtDeclarationPath('./packages/core/session/src/index.ts'))
      .toBe('./packages/core/session/lib/types/index.d.ts')
    expect(builtDeclarationPath('./packages/core/session/src/types.ts'))
      .toBe('./packages/core/session/lib/types/types.d.ts')
    expect(builtDeclarationPath('./packages/experimental/claude-code-mods/examples/*'))
      .toBe('./packages/experimental/claude-code-mods/examples/*')
  })

  it('preserves the generated Remote and Host declarations already selected by workspace aliases', () => {
    for (const face of ['remote-client', 'host']) {
      const path = `./packages/core/agent-codex/lib/typert.${face}.d.ts`
      expect(builtDeclarationPath(path)).toBe(path)
    }
  })

  it('rejects aliases without a supported source target', () => {
    expect(() => builtDeclarationPath('./packages/core/session/source/index.ts'))
      .toThrow('cannot map workspace source path')
  })
})
