import { customLocalPatches } from '../src/profile.ts'
import type { RuntimeProfile } from '../src/local-runtime.ts'
/** Fixture-only inventory derived from the canonical Custom profile translator. */
export function localModelProfileCatalog(home: string): RuntimeProfile[] {
  const config = customLocalPatches(home).find(row => row.id === 'custom-foundation')?.config as { localProfiles: RuntimeProfile[] }
  return config.localProfiles.map(profile => ({ ...profile, manageable: true }))
}
