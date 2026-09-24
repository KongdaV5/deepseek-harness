/** Apply Electron Builder's dependency-manifest transform before sealing the runtime inventory. */

import { readdirSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'

const require = createRequire(import.meta.url)
const builderRequire = createRequire(require.resolve('app-builder-lib/package.json'))
const { createTransformer } = builderRequire('app-builder-lib/out/fileTransformer.js') as {
  createTransformer: (source: string, configuration: object, metadata: undefined, extraTransformer: null) =>
  (file: string) => string | null | undefined | Promise<string | null | undefined>
}

/**
 * Apply the pinned Electron Builder dependency-manifest transform before runtime hashes are recorded.
 * @param root - Prepared Desktop runtime root.
 * @returns Number of dependency manifests whose bytes were changed.
 */
export async function prepareDesktopRuntimePackageManifests(root: string): Promise<number> {
  const transform = createTransformer(root, {}, undefined, null)
  let changed = 0
  const visit = async (directory: string): Promise<void> => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) await visit(path)
      else if (entry.isFile() && entry.name === 'package.json') {
        const transformed = await transform(path)
        if (typeof transformed === 'string') {
          writeFileSync(path, transformed)
          changed++
        }
      }
    }
  }
  await visit(join(root, 'node_modules'))
  return changed
}
