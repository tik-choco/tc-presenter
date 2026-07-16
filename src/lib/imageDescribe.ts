// Vision-LLM description generator for editor-uploaded images
// (features/editor's image upload flow, ImageRefBlock.description in
// src/types.ts). Mirrors lib/evaluator/visionJudge.ts's multimodal request
// shape (ChatContentPart image_url part, connection: 'api' since images
// can't travel over the AI Network's text-only protocol — see llm.ts's
// requestChatCompletion network-branch guard).
//
// lib/ must not import from features/ (see CLAUDE.md), so this module takes
// a plain `presetId` rather than resolving the shared "vision preset"
// setting itself — the caller (features/editor) reads
// features/settings/localPrefs.ts's loadVisionPresetId() and passes the
// result through opts.presetId.
import { requestChatCompletion, type ChatContentPart, type MultimodalChatMessage } from './llm'

const DESCRIBE_TIMEOUT_MS = 90_000

export interface DescribeImageOptions {
  /** tc-shared-llm-config-v1 preset id for the vision-capable model; "" /
   * omitted falls back to the config's defaultPresetId (which may not be
   * vision-capable — callers should prefer passing their resolved vision
   * preset here). */
  presetId?: string
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
 * null (never throws) on any failure: no/non-vision preset configured,
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
      presetId: opts.presetId,
      connection: 'api',
      signal: opts.signal,
      temperature: 0.3,
      timeoutMs: DESCRIBE_TIMEOUT_MS,
    })
    const text = raw.trim()
    return text ? text : null
  } catch {
    return null
  }
}
