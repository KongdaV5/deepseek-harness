/** Create the Dev-only local-runtime settings and preset fixtures. */

import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { DevelopmentComposition } from './development-project.ts'

const IQ3_S_MODEL = '/Users/kongda/Models/Qwen3.8-27B-GSQ-RCO-GGUF/Qwen3.8-27B-GSQ-RCO-IQ3_S.gguf'
const DEV_PROVIDER = 'local-qwen-dev'
const DEV_BASE_URL = 'http://127.0.0.1:8081/v1'

/** Static identity emitted beside the isolated settings so a Dev session can be audited. */
export interface DevelopmentFixtureMetadata {
  readonly desktopFlavor: 'development'
  readonly composition: DevelopmentComposition
  readonly runtimeVersion: string
  readonly sourceCommit: string
  readonly sourceDirty: boolean
  readonly provider: typeof DEV_PROVIDER
  readonly model: typeof IQ3_S_MODEL
  readonly baseUrl: typeof DEV_BASE_URL
}

/** Inputs required to create the fixed Phase 2–6 local-runtime fixtures. */
export interface DevelopmentFixtureOptions {
  readonly home: string
  readonly repositoryRoot: string
  readonly runtimeVersion: string
  readonly composition: DevelopmentComposition
}

function git(repositoryRoot: string, args: readonly string[]): string {
  return execFileSync('git', args, { cwd: repositoryRoot, encoding: 'utf8' }).trim()
}

function writeOwnedFile(path: string, contents: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  writeFileSync(path, contents, { encoding: 'utf8', mode: 0o600 })
}

function settings(): string {
  return `# Development-only local runtime. This file is never read by the released Desktop.\nllm-pi-ai:\n  providers:\n    ${DEV_PROVIDER}:\n      displayName: Dev Local Qwen IQ3_S\n      apiKeyEnv: LOCAL_QWEN_API_KEY\n      api: openai-completions\n      baseURL: ${DEV_BASE_URL}\n      streamIdleTimeoutMs: 3600000\n      models:\n        - id: ${IQ3_S_MODEL}\n          name: Qwen3.8-27B IQ3_S (Dev llama.cpp)\n          contextWindow: 65536\n          maxTokens: 24576\n          reasoningEfforts:\n            off:\n            low: low\n            medium: medium\n            xhigh: xhigh\nagent-default-model:\n  provider: ${DEV_PROVIDER}\n  model: ${IQ3_S_MODEL}\nagent-presets:\n  default: lite-general\n`
}

const LITE_GENERAL = '# Disposable development preset. The host owns runtime services and route selection.\n- id: compaction\n  name: cordis:group\n  group: true\n  isolate:\n    compaction: true\n    toolResultPruner: true\n  config:\n    - id: compaction-basic\n      name: \'@deepseek-ai/dsh-compaction-basic\'\n\n    - id: command-compact\n      name: \'@deepseek-ai/dsh-command-compact\'\n\n    - id: tool-result-pruner\n      name: \'@deepseek-ai/dsh-compaction-tool-result-pruner\'\n      config:\n        thresholdChars: 8192\n        headChars: 4096\n        tailChars: 1024\n'

const BENCHMARK = '# Hidden fixture for an explicit reproducibility route; it is not a daily preset.\n- id: compaction\n  name: cordis:group\n  group: true\n  isolate:\n    compaction: true\n    toolResultPruner: true\n  config:\n    - id: compaction-basic\n      name: \'@deepseek-ai/dsh-compaction-basic\'\n\n    - id: command-compact\n      name: \'@deepseek-ai/dsh-command-compact\'\n\n    - id: tool-result-pruner\n      name: \'@deepseek-ai/dsh-compaction-tool-result-pruner\'\n      config:\n        thresholdChars: 8192\n        headChars: 4096\n        tailChars: 1024\n'

/**
 * Write only the isolated Desktop Dev home used by the explicit Phase 2–6 composition.
 * @param options - Dev home, checkout identity, release, and selected allowlisted composition.
 * @returns the audit metadata recorded in the Dev home.
 */
export function prepareDevelopmentFixtures(options: DevelopmentFixtureOptions): DevelopmentFixtureMetadata {
  const metadata: DevelopmentFixtureMetadata = {
    desktopFlavor: 'development',
    composition: options.composition,
    runtimeVersion: options.runtimeVersion,
    sourceCommit: git(options.repositoryRoot, ['rev-parse', 'HEAD']),
    sourceDirty: git(options.repositoryRoot, ['status', '--porcelain']).length > 0,
    provider: DEV_PROVIDER,
    model: IQ3_S_MODEL,
    baseUrl: DEV_BASE_URL,
  }
  writeOwnedFile(join(options.home, 'settings.yaml'), settings())
  writeOwnedFile(join(options.home, '.agent-presets', 'lite-general', 'preset.yml'), 'name: Dev Lite General\ndescription: Isolated local IQ3_S development fixture.\n')
  writeOwnedFile(join(options.home, '.agent-presets', 'lite-general', 'agent.cordis.yml'), LITE_GENERAL)
  writeOwnedFile(join(options.home, '.agent-presets', 'benchmark', 'preset.yml'), 'name: Dev Benchmark\ndescription: Explicit reproducibility fixture.\nvisibility: hidden\n')
  writeOwnedFile(join(options.home, '.agent-presets', 'benchmark', 'agent.cordis.yml'), BENCHMARK)
  writeOwnedFile(join(options.home, '.desktop-dev-metadata.json'), `${JSON.stringify(metadata, undefined, 2)}\n`)
  return metadata
}

export { DEV_BASE_URL, DEV_PROVIDER, IQ3_S_MODEL }
