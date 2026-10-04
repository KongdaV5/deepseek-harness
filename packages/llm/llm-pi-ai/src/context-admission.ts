/** Exact llama.cpp text-prompt admission after provider serialization, before inference. */
import { CONTEXT_WINDOW_EXCEEDED_CODE, LlmError } from '@deepseek-ai/dsh-llm'
import type { Api, Model } from '@earendil-works/pi-ai'
import type { ResolvedPiAiProviderProfile } from './config.ts'

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

async function json(endpoint: URL, body: unknown, signal: AbortSignal, headers: Record<string, string>): Promise<unknown> {
  const response = await fetch(endpoint, {
    signal, headers: { ...headers, 'Content-Type': 'application/json' },
    ...body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) },
  })
  if (!response.ok) throw new LlmError(`Local token admission ${endpoint.pathname} returned HTTP ${response.status}`, 'CONTEXT_ADMISSION_FAILED')
  return response.json()
}

/**
 * Admit the fully serialized text request using the server's chat template and tokenizer.
 * Cache usage never changes logical prompt capacity. The lower of declared and live
 * context capacities bounds generated output, including reasoning. Unknown metadata,
 * images, or insufficient answer room fail before the completion request is sent.
 * @param payload Serialized OpenAI chat-completion body.
 * @param model Frozen model descriptor.
 * @param profile Frozen route carrying explicit Local admission policy.
 * @param requestedOutput Caller cap, already resolved against deployment defaults.
 * @param signal Request lifecycle cancellation.
 * @returns The same request with its output cap bounded by the exact remaining capacity.
 */
export async function admitLlamaCppRequest(
  payload: unknown, model: Model<Api>, profile: ResolvedPiAiProviderProfile,
  requestedOutput: number, signal: AbortSignal,
): Promise<unknown> {
  const budget = profile.llamaCppContextAdmission
  if (budget === undefined) return payload
  if (!record(payload) || !Array.isArray(payload['messages'])) {
    throw new LlmError('Local context admission requires serialized chat messages', 'CONTEXT_ADMISSION_FAILED')
  }
  for (const message of payload['messages']) {
    if (!record(message) || (message['content'] !== null && message['content'] !== undefined && typeof message['content'] !== 'string')) {
      throw new LlmError('Local exact context admission supports text messages only', 'UNSUPPORTED_CONTENT')
    }
  }
  const base = new URL(model.baseUrl.endsWith('/') ? model.baseUrl : `${model.baseUrl}/`)
  if (!['http:', 'https:'].includes(base.protocol) || !['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname)) {
    throw new LlmError('Local context admission requires the resolved loopback endpoint', 'CONTEXT_ADMISSION_FAILED')
  }
  const headers = profile.headers ?? {}
  const props = await json(new URL('../props', base), undefined, signal, headers)
  const settings = record(props) ? props['default_generation_settings'] : undefined
  const nCtx = record(settings) ? settings['n_ctx'] : undefined
  if (typeof nCtx !== 'number' || !Number.isSafeInteger(nCtx) || nCtx < 1) {
    throw new LlmError('Local context admission requires a positive server n_ctx', 'CONTEXT_ADMISSION_FAILED')
  }
  const template = await json(new URL('../apply-template', base), payload, signal, headers)
  if (!record(template) || typeof template['prompt'] !== 'string') {
    throw new LlmError('Local context admission received no rendered prompt', 'CONTEXT_ADMISSION_FAILED')
  }
  const tokenized = await json(new URL('../tokenize', base), {
    content: template['prompt'], add_special: true, parse_special: true,
  }, signal, headers)
  if (!record(tokenized) || !Array.isArray(tokenized['tokens'])
    || !tokenized['tokens'].every(token => typeof token === 'number' && Number.isSafeInteger(token))) {
    throw new LlmError('Local context admission received invalid tokenizer output', 'CONTEXT_ADMISSION_FAILED')
  }
  const inputTokens = tokenized['tokens'].length
  const contextWindow = Math.min(model.contextWindow, nCtx)
  const available = contextWindow - inputTokens - budget.safetyMarginTokens
  const effectiveOutput = Math.min(requestedOutput, model.maxTokens, available)
  const minimumOutput = Math.min(requestedOutput, model.maxTokens, budget.minimumOutputTokens)
  if (effectiveOutput < minimumOutput) {
    throw new LlmError(
      `Local context admission rejected before inference: input=${inputTokens}, declared=${model.contextWindow}, server=${nCtx},`
      + ` margin=${budget.safetyMarginTokens}, requestedOutput=${requestedOutput}, availableOutput=${available}, minimumOutput=${minimumOutput}`,
      CONTEXT_WINDOW_EXCEEDED_CODE,
    )
  }
  // The serialized field is provider-owned; replace pi-ai's heuristic one-token floor only after exact admission.
  const field = 'max_tokens' in payload ? 'max_tokens' : 'max_completion_tokens'
  return { ...payload, [field]: effectiveOutput }
}
