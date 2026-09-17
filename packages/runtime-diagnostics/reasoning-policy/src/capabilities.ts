/** Audited exact-model reasoning capability declarations. */

import type { ModelReasoningCapability } from './types.ts'

/** Exact GGUF path audited against llama.cpp 0.4.0 build 10809. */
export const IQ3_S_GGUF_MODEL = '/Users/kongda/Models/Qwen3.8-27B-GSQ-RCO-GGUF/Qwen3.8-27B-GSQ-RCO-IQ3_S.gguf'

/**
 * Build the audited IQ3_S declaration for one deployment-owned provider key.
 * It deliberately names one model rather than treating all GGUF models alike.
 * @param provider - configured DSH provider route owning the IQ3_S model.
 * @returns capability facts confirmed by the Phase 5 llama.cpp live audit.
 */
export function iq3sGgufReasoningCapability(provider: string): ModelReasoningCapability {
  return {
    provider,
    model: IQ3_S_GGUF_MODEL,
    supported: ['none', 'low', 'medium', 'xhigh'],
    aliases: { off: 'none' },
    fallbacks: { high: 'xhigh' },
    wireValues: { none: 'none', low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh' },
    requestOverrideSupported: true,
    backendDefault: 'xhigh',
    confidence: 'confirmed',
    source: 'gguf-live-audit',
  }
}
