// Narration transport: HTTP speech or a mistai room selected by the voice ref.
import { rooms } from './aiNetwork'
import { MistaiError, isTtsSpeed, isTtsResponseFormat } from '@tik-choco/mistai'
import { isNetworkProviderBaseUrl, roomIdFromBaseUrl, networkVoiceModelParam, loadLlmConfig, resolveVoice } from './llmConfig'

export type VoiceConnection = {
  baseUrl: string
  apiKey: string
}

/** Default timeout for a direct TTS HTTP request, applied only when the
 * caller doesn't pass its own `signal` — speech synthesis of a full slide's
 * speaker notes can legitimately take a while, so this is generous relative
 * to lib/llm.ts's DEFAULT_LLM_TIMEOUT_MS. */
export const DEFAULT_TTS_TIMEOUT_MS = 120_000

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
  speed?: number
  responseFormat?: string
  signal?: AbortSignal
}): Promise<Blob> {
  if (!params.connection.baseUrl.trim()) {
    throw new MistaiError('ENDPOINT_NOT_CONFIGURED', 'No TTS provider is configured yet (see Settings).')
  }

  if (isNetworkProviderBaseUrl(params.connection.baseUrl)) {
    return rooms.requestRoomTts(roomIdFromBaseUrl(params.connection.baseUrl), { text: params.text, model: networkVoiceModelParam(params.model), voice: params.voice || undefined,
      ...(params.speed !== undefined ? { speed: params.speed } : {}),
      ...(params.responseFormat !== undefined ? { responseFormat: params.responseFormat } : {}),
    })
  }
  const config = loadLlmConfig()
  const speed = params.speed ?? (config ? resolveVoice(config, 'tts')?.speed : undefined)
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
      ...(isTtsResponseFormat(params.responseFormat) ? { response_format: params.responseFormat } : {}),
      ...(isTtsSpeed(speed) ? { speed } : {}),
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
