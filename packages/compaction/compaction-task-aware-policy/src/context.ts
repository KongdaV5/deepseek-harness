/**
 * Rendering and parsing of the code-rendered task authority block, plus the
 * capacity arithmetic that decides whether protection is even possible.
 *
 * The block is rendered by code from the captured protection snapshot, never by
 * the model. The model may be shown the same facts as supplemental background,
 * but the published replacement's block is byte-for-byte the code's rendering,
 * which is what makes deterministic validation meaningful: there is exactly one
 * correct answer to compare against.
 *
 * @module @deepseek-ai/dsh-compaction-task-aware-policy/context
 */

import type { ContentBlock, RequestUserInput } from '@deepseek-ai/dsh-llm'
import type { TaskProtection } from './types.ts'
import {
  TASK_COMPACTION_BLOCK_CLOSE,
  TASK_COMPACTION_BLOCK_OPEN,
  TASK_COMPACTION_BLOCK_TYPE,
  TASK_COMPACTION_BLOCK_VERSION,
} from './types.ts'

/**
 * The one-line framing that tells the model what it is looking at.
 *
 * It is inside the delimited block rather than beside it so a reader that only
 * extracts payloads never has to strip prose, and it is short because the block
 * competes for the same budget as the narrative.
 */
const BLOCK_OWNERSHIP_NOTE =
  'Authoritative runtime task state rendered by the harness. It is not part of any model summary and must not be restated, edited, or contradicted.'

/** One delimited block as it appeared in a text body. */
export interface ParsedTaskProtectionBlock {
  /** The exact text between the opening sentinel and its newline: the block header. */
  readonly header: string
  /** The exact payload text between the header newline and the closing sentinel. */
  readonly payload: string
}

/** How one text body's delimited blocks turned out. */
export interface ParsedTaskProtectionBlocks {
  /** Every well-formed block, in document order. */
  readonly blocks: readonly ParsedTaskProtectionBlock[]
  /** Whether any opening sentinel lacked a matching closing sentinel. */
  readonly malformed: boolean
}

/**
 * Render the code-authored block text for one protection snapshot.
 *
 * The digest lives in the header rather than inside the payload: the payload is
 * what the digest is computed over, so embedding it there would be circular.
 *
 * The ownership note also stays outside the delimiters, for the same reason the
 * supplemental message does: everything between the sentinels *is* the canonical
 * payload, and validation parses that region as JSON. A note inside it would
 * make every candidate unparseable, and a note the model could reproduce would
 * otherwise be indistinguishable from one the harness rendered.
 * @param protection - the captured protection root.
 * @returns the exact replacement text the published block must contain.
 */
export function renderTaskProtectionBlock(protection: TaskProtection): string {
  return [
    BLOCK_OWNERSHIP_NOTE,
    `${TASK_COMPACTION_BLOCK_OPEN} type=${TASK_COMPACTION_BLOCK_TYPE}`
      + ` version=${String(TASK_COMPACTION_BLOCK_VERSION)}`
      + ` protectionHash=${protection.digest}`,
    protection.payload,
    TASK_COMPACTION_BLOCK_CLOSE,
  ].join('\n')
}

/**
 * The replacement content the executor appends for a protected transaction.
 * @param protection - the captured protection root.
 * @returns one text block carrying the delimited canonical block.
 */
export function taskProtectionContent(protection: TaskProtection): readonly ContentBlock[] {
  return [{ type: 'text', text: renderTaskProtectionBlock(protection) }]
}

/**
 * The supplemental background message the model may be shown.
 *
 * Deliberately outside the delimiters: a model that echoes its own prompt must
 * not be able to manufacture a second *delimited* block, because the delimiter
 * count is one of the validation rules.
 * @param protection - the captured protection root.
 * @returns one user message carrying the payload as quoted background.
 */
export function taskProtectionSupplement(protection: TaskProtection): RequestUserInput {
  return {
    role: 'user',
    content: [{
      type: 'text',
      text: [
        'BACKGROUND — the harness is about to attach the block below, verbatim, to the checkpoint that replaces the conversation above.',
        'Treat every fact in it as established and current. Do not restate it, and do not emit any part of it in your summary:',
        'your summary replaces only the conversation, never this block.',
        '<task-authority-snapshot>',
        protection.payload,
        '</task-authority-snapshot>',
      ].join('\n'),
    }],
  }
}

/**
 * Extract every delimited block from a text body.
 *
 * Scanning is linear and non-overlapping; an unterminated opening sentinel is
 * reported as malformed rather than silently ignored, because an unparseable
 * block is a failure to prove, not an absence of one.
 * @param text - the text to scan.
 * @returns the parsed blocks and the malformed indicator.
 */
export function parseTaskProtectionBlocks(text: string): ParsedTaskProtectionBlocks {
  const blocks: ParsedTaskProtectionBlock[] = []
  let malformed = false
  let cursor = 0
  for (;;) {
    const open = text.indexOf(TASK_COMPACTION_BLOCK_OPEN, cursor)
    if (open === -1) break
    const headerEnd = text.indexOf('\n', open)
    const close = text.indexOf(TASK_COMPACTION_BLOCK_CLOSE, open + TASK_COMPACTION_BLOCK_OPEN.length)
    if (headerEnd === -1 || close === -1 || headerEnd > close) {
      malformed = true
      cursor = open + TASK_COMPACTION_BLOCK_OPEN.length
      continue
    }
    blocks.push({
      header: text.slice(open + TASK_COMPACTION_BLOCK_OPEN.length, headerEnd).trim(),
      payload: text.slice(headerEnd + 1, close).trim(),
    })
    cursor = close + TASK_COMPACTION_BLOCK_CLOSE.length
  }
  return { blocks, malformed }
}

/**
 * Concatenate every text block of a content list, in order.
 *
 * Non-text blocks are skipped rather than stringified, so a caller pricing or
 * validating a candidate sees exactly the text a model would read.
 * @param content - the content blocks to project.
 * @returns the joined text of every text block, in list order.
 */
export function textOfContent(content: readonly ContentBlock[]): string {
  return content
    .filter((block): block is Extract<ContentBlock, { type: 'text' }> => block.type === 'text')
    .map(block => block.text)
    .join('\n')
}

/**
 * Read one `key=value` field out of a block header.
 *
 * The header vocabulary is closed and space-separated, so this is a lookup and
 * not a parser; an unknown key is simply absent.
 * @param header - the header text between the sentinel and its newline.
 * @param name - the key to read.
 * @returns the field value, or `undefined` when the header does not carry it.
 */
export function headerField(header: string, name: string): string | undefined {
  for (const token of header.split(/\s+/)) {
    const separator = token.indexOf('=')
    if (separator === -1) continue
    if (token.slice(0, separator) === name) return token.slice(separator + 1)
  }
  return undefined
}

/**
 * The input budget a post-compaction request may use.
 *
 * The generation cap is reserved out of the window so the comparison is against
 * what the next request can actually carry, not against the raw window. A
 * non-positive result means nothing can fit.
 * @param contextWindow - the routed model's usable context window.
 * @param outputReserve - the generation cap the compaction request reserves.
 * @returns the usable input token budget, floored at zero.
 */
export function usableInputTokens(contextWindow: number, outputReserve: number): number {
  return Math.max(0, contextWindow - Math.max(0, outputReserve))
}

/**
 * Whether the protected context alone already makes a compaction impossible.
 *
 * The comparison is inclusive: a protected context that exactly fills the
 * budget leaves no room for the request that would carry it.
 * @param protectedTokens - priced size of the code-rendered protected context.
 * @param usable - the usable input token budget of the post-compaction request.
 * @returns whether the protected context leaves no usable room.
 */
export function protectedContextExceedsCapacity(
  protectedTokens: number,
  usable: number,
): boolean {
  return protectedTokens >= usable
}
