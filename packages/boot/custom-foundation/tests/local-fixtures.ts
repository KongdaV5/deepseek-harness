import { join } from 'node:path'
import { customLocalPatches } from '../src/profile.ts'
import type { RuntimeProfile } from '../src/local-runtime.ts'
/** Production text defaults plus an explicitly registered image fixture. */
export function localModelProfileCatalog(home: string): RuntimeProfile[] {
  const config = customLocalPatches(home).find(row => row.id === 'custom-foundation')?.config as { localProfiles: RuntimeProfile[] }
  return [...config.localProfiles, { id: 'img21', name: 'Fixture image', modality: 'image' as const, engine: 'mflux-qwen21' as const, modelId: join(home, 'Models', 'Qwen-Image-2.1-mflux-8bit') }].map(profile => ({ ...profile, manageable: true }))
}
