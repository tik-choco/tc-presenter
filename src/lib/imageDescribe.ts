import type { ModelRefV1 } from '@tik-choco/mistai/llm-config'
// Image descriptions use the vision task ref, including room vision via the tunnel.
import { requestChatCompletion, type ChatContentPart, type MultimodalChatMessage } from './llm'

const DESCRIBE_TIMEOUT_MS = 90_000

export interface DescribeImageOptions {
  /** Optional per-call vision model; otherwise uses the configured vision task. */
  modelRef?: ModelRefV1 | null
  /** Output language for the description (e.g. "ja", "en"). Default 'ja'. */
  lang?: string
  signal?: AbortSignal
}

function systemPrompt(lang: string): string {
  return `You are describing an image that will be embedded in a slide deck. In ${lang}, write ONE to TWO short sentences describing what the image shows (for a diagram/screenshot, what it depicts/demonstrates) — plain text only, no markdown, no quotes, no preamble like "This image shows".`
}

/**
 * Describes `dataUri` (an image data: URI) with a vision-capable LLM, for use
 * as an ImageRefBlock.description — feeds the text-only generation/refine/
 * evaluation pipeline and doubles as the rendered <img>'s alt text. Returns
 * null (never throws) on any failure: no usable vision model configured,
 * timeout, or an empty response.
 */
export async function describeImage(dataUri: string, opts: DescribeImageOptions = {}): Promise<string | null> {
  const lang = opts.lang?.trim() || 'ja'

  const parts: ChatContentPart[] = [
    { type: 'text', text: 'Describe this image.' },
    { type: 'image_url', image_url: { url: dataUri } },
  ]
  const messages: MultimodalChatMessage[] = [
    { role: 'system', content: systemPrompt(lang) },
    { role: 'user', content: parts },
  ]

  try {
    const raw = await requestChatCompletion(messages, {
      modelRef: opts.modelRef, task: 'vision',
      signal: opts.signal,
      timeoutMs: DESCRIBE_TIMEOUT_MS,
    })
    const text = raw.trim()
    return text ? text : null
  } catch {
    return null
  }
}
