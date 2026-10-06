/** Exact llama.cpp text-prompt admission after provider serialization, before inference. */
import { CONTEXT_WINDOW_EXCEEDED_CODE, LlmError } from '@deepseek-ai/dsh-llm'
import type { Api, Model } from '@earendil-works/pi-ai'
import type { ResolvedPiAiProviderProfile } from './config.ts'

const LLAMA_PROGRESS_POLL_MS = 1_000
const LLAMA_PROGRESS_FETCH_TIMEOUT_MS = 1_000

interface LlamaSlotProgress {
  readonly id: number
  readonly task: number
  readonly processing: boolean
  readonly promptLength: number
  readonly promptTokens: number
}

/** Stop a best-effort watcher and wait for its request and timer to settle. */
export interface LlamaCppProgressMonitor {
  stop(): Promise<void>
}

interface LlamaCppProgressMonitorOptions {
  readonly model: Pick<Model<Api>, 'baseUrl'>
  readonly profile: Pick<ResolvedPiAiProviderProfile, 'headers'>
  readonly signal: AbortSignal
  readonly expectedPromptTokens: number
  readonly pulse: () => void
  readonly fetch?: typeof fetch
  readonly waitForPoll?: (signal: AbortSignal) => Promise<void>
}

function slotProgress(value: unknown): readonly LlamaSlotProgress[] | undefined {
  if (!Array.isArray(value)) return undefined
  const slots: LlamaSlotProgress[] = []
  for (const slot of value) {
    if (!record(slot)
      || typeof slot['id'] !== 'number' || !Number.isSafeInteger(slot['id'])
      || typeof slot['id_task'] !== 'number' || !Number.isSafeInteger(slot['id_task'])
      || typeof slot['is_processing'] !== 'boolean'
      || typeof slot['n_prompt_tokens'] !== 'number' || !Number.isSafeInteger(slot['n_prompt_tokens'])
      || typeof slot['n_prompt_tokens_processed'] !== 'number'
      || !Number.isSafeInteger(slot['n_prompt_tokens_processed'])) return undefined
    slots.push({
      id: slot['id'], task: slot['id_task'], processing: slot['is_processing'],
      promptLength: slot['n_prompt_tokens'],
      promptTokens: slot['n_prompt_tokens_processed'],
    })
  }
  return slots
}

function waitForProgressPoll(signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve()
      return
    }
    const finish = (): void => {
      clearTimeout(timer)
      signal.removeEventListener('abort', finish)
      resolve()
    }
    const timer = setTimeout(finish, LLAMA_PROGRESS_POLL_MS)
    signal.addEventListener('abort', finish, { once: true })
  })
}

async function readSlotProgress(
  endpoint: URL,
  headers: Record<string, string>,
  signal: AbortSignal,
  fetcher: typeof fetch,
): Promise<readonly LlamaSlotProgress[] | undefined> {
  try {
    const response = await fetcher(endpoint, {
      signal: AbortSignal.any([signal, AbortSignal.timeout(LLAMA_PROGRESS_FETCH_TIMEOUT_MS)]),
      headers,
    })
    if (!response.ok) return undefined
    return slotProgress(await response.json())
  } catch (_progressUnavailable: unknown) {
    // Observation is optional; the normal stream idle timeout remains authoritative.
    return undefined
  }
}

/**
 * Refresh an outstanding stream idle timeout only when a newly dispatched Local
 * request's llama.cpp prompt-evaluation counter advances. llama.cpp's
 * `n_prompt_tokens` is a live count during prompt evaluation and grows as tokens are
 * processed; it is not the final prompt size until evaluation completes. The tokenized
 * admission length is therefore an upper bound while binding to the new task.
 * @param options - the frozen Local request and its stream liveness signal.
 * @returns a quiescent disposer, or undefined when slot observation is unavailable.
 */
export async function startLlamaCppProgressMonitor(
  options: LlamaCppProgressMonitorOptions,
): Promise<LlamaCppProgressMonitor | undefined> {
  const base = new URL(options.model.baseUrl.endsWith('/') ? options.model.baseUrl : `${options.model.baseUrl}/`)
  const endpoint = new URL('../slots', base)
  const fetcher = options.fetch ?? fetch
  const wait = options.waitForPoll ?? waitForProgressPoll
  const baseline = await readSlotProgress(endpoint, options.profile.headers ?? {}, options.signal, fetcher)
  if (baseline === undefined || options.signal.aborted) return undefined

  const originalTasks = new Map(baseline.map(slot => [slot.id, slot.task]))
  const observedTasks = new Map<number, number>()
  const seenProgress = new Map<number, number>()
  const stop = new AbortController()
  const signal = AbortSignal.any([options.signal, stop.signal])
  const observe = async (): Promise<void> => {
    while (true) {
      await wait(signal)
      if (signal.aborted) return
      const slots = await readSlotProgress(endpoint, options.profile.headers ?? {}, signal, fetcher)
      if (slots === undefined) continue
      for (const slot of slots) {
        if (!slot.processing || slot.promptLength > options.expectedPromptTokens) continue
        let observedTask = observedTasks.get(slot.id)
        if (observedTask === undefined) {
          if (originalTasks.get(slot.id) === slot.task) continue
          observedTask = slot.task
          observedTasks.set(slot.id, observedTask)
        }
        if (observedTask !== slot.task) continue
        const previous = seenProgress.get(slot.id) ?? 0
        if (slot.promptTokens <= previous) continue
        seenProgress.set(slot.id, slot.promptTokens)
        options.pulse()
      }
    }
  }
  const completion = observe()
  return {
    async stop(): Promise<void> {
      stop.abort('Local progress observation stopped')
      await completion
    },
  }
}

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
 * @param onAdmitted Optional callback receiving the exact input length after successful admission.
 * @returns The same request with its output cap bounded by the exact remaining capacity.
 */
export async function admitLlamaCppRequest(
  payload: unknown, model: Model<Api>, profile: ResolvedPiAiProviderProfile,
  requestedOutput: number, signal: AbortSignal, onAdmitted?: (inputTokens: number) => void,
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
  onAdmitted?.(inputTokens)
  // The serialized field is provider-owned; replace pi-ai's heuristic one-token floor only after exact admission.
  const field = 'max_tokens' in payload ? 'max_tokens' : 'max_completion_tokens'
  return { ...payload, [field]: effectiveOutput }
}
