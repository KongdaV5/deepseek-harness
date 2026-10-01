import { clientBundle } from '../../client/tsdown.client.ts'

export default clientBundle(
  '@deepseek-ai/dsh-api-runtime-diagnostics-controller',
  ['lib/types/index.js'],
  { hostPhase: true },
)
