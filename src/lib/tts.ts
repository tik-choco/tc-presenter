// TTS entry point for tc-presenter's auto-narration (features/present plays
// each slide's speakerNotes through this). Direct-HTTP OpenAI-compatible
// POST {baseUrl}/audio/speech only — this is the "/audio/speech part" of
// tc-translate's src/lib/voice.ts (STT/transcription is out of scope here,
// tc-presenter never needs to listen to the user). AI Network TTS (P2P) is
// available separately via lib/aiNetwork.ts's requestNetworkTts when a
// feature wants to route through a room instead of a direct endpoint.

import { MistaiError } from '@tik-choco/mistai'
import { resolveVoice, type SharedLlmConfigV1 } from './llmConfig'

export type VoiceConnection = {
  baseUrl: string
  apiKey: string
}

/** Default timeout for a direct TTS HTTP request, applied only when the
 * caller doesn't pass its own `signal` — speech synthesis of a full slide's
 * speaker notes can legitimately take a while, so this is generous relative
 * to lib/llm.ts's DEFAULT_LLM_TIMEOUT_MS. */
export const DEFAULT_TTS_TIMEOUT_MS = 120_000

// TTS connection info (baseUrl/apiKey) comes from the shared llm config's
// `tts` entry - explicit if set, otherwise the default preset's provider
// (see resolveVoice in lib/llmConfig.ts). Callers resolve through this
// helper rather than reading the shared config directly so a missing
// provider degrades to an empty (falsy) connection instead of throwing.
export function resolveTtsConnection(config: SharedLlmConfigV1): VoiceConnection {
  const resolved = resolveVoice(config, 'tts')
  return { baseUrl: resolved?.baseUrl ?? '', apiKey: resolved?.apiKey ?? '' }
}

function authHeaders(apiKey: string): HeadersInit {
  return apiKey.trim() ? { Authorization: `Bearer ${apiKey}` } : {}
}

function withDefaultTimeout(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal | undefined {
  if (typeof AbortSignal === 'undefined' || typeof AbortSignal.timeout !== 'function') return signal
  const timeout = AbortSignal.timeout(timeoutMs)
  if (!signal) return timeout
  if (typeof AbortSignal.any === 'function') return AbortSignal.any([signal, timeout])
  return signal
}

/**
 * Synthesizes `text` to speech via the configured OpenAI-compatible
 * `/audio/speech` endpoint. Throws `MistaiError('UPSTREAM_HTTP_ERROR', ...)`
 * on a non-2xx response. Always bounded by DEFAULT_TTS_TIMEOUT_MS unless the
 * caller supplies their own `signal`.
 */
export async function synthesizeSpeech(params: {
  connection: VoiceConnection
  model: string
  voice: string
  text: string
  signal?: AbortSignal
}): Promise<Blob> {
  if (!params.connection.baseUrl.trim()) {
    throw new MistaiError('ENDPOINT_NOT_CONFIGURED', 'No TTS provider is configured yet (see Settings).')
  }

  const response = await fetch(`${params.connection.baseUrl}/audio/speech`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...authHeaders(params.connection.apiKey),
    },
    signal: withDefaultTimeout(params.signal, DEFAULT_TTS_TIMEOUT_MS),
    body: JSON.stringify({
      model: params.model.trim(),
      input: params.text,
      voice: params.voice.trim() || 'alloy',
      response_format: 'mp3',
    }),
  })

  if (!response.ok) {
    const payload = await response.json().catch(() => undefined)
    const message =
      typeof payload?.error?.message === 'string'
        ? payload.error.message
        : `Speech request failed with ${response.status}`
    throw new MistaiError('UPSTREAM_HTTP_ERROR', message, { status: response.status })
  }

  return response.blob()
}
