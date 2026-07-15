// Chat-completion entry point for tc-presenter. Callers (features/generate's
// outline/slide/refine pipeline, lib/evaluator's LLM-judged metrics) call
// requestChatCompletion() with a preset id (resolved against the shared
// tc-shared-llm-config-v1 config, see lib/llmConfig.ts) and don't care
// whether the request goes direct-to-API (via @tik-choco/mistai's
// streamChatCompletion) or over the AI Network room (via lib/aiNetwork.ts).
// Modeled on tc-news's src/lib/llm.ts, simplified to Pattern A.
//
// requestTimeoutMs always has a default (DEFAULT_LLM_TIMEOUT_MS): both the
// AI Network path (aiNetwork.ts's ConsumerClient) and the direct-API path
// (via AbortSignal.timeout when the caller doesn't pass its own signal) are
// bounded, so a stuck upstream can never hang the generate/refine loop
// forever — see PLAN.md's "requestTimeoutMs を必ず設定(永久ハング防止)".

import {
  MistaiError,
  streamChatCompletion,
  type ChatMessage,
  type OpenAIConfig,
} from '@tik-choco/mistai'
import { emptyLlmConfig, loadLlmConfig, normalizeBaseUrl, resolvePreset, type ResolvedLlmTargetV1 } from './llmConfig'
import { localizeNetworkError, networkClient, requestNetworkChat } from './aiNetwork'

export type { ChatMessage }

/** One part of a multimodal message's `content` array, matching the
 * OpenAI-compatible vision request shape (`content: [{type:"text",...},
 * {type:"image_url",...}]`) that Ollama/LM Studio/vision-capable OpenAI
 * endpoints all accept. */
export type ChatContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } }

/** Widened `ChatMessage`: `content` may be a plain string (the vendored
 * `@tik-choco/mistai` `ChatMessage` shape every existing call site already
 * uses) or an array of parts for vision requests (lib/evaluator/
 * visionJudge.ts). Every plain `ChatMessage` is structurally a valid
 * `MultimodalChatMessage`, so this is a non-breaking widening of
 * requestChatCompletion's parameter type. */
export type MultimodalChatMessage = { role: 'system' | 'user' | 'assistant'; content: string | ChatContentPart[] }

/** Default timeout for a direct (non-network) chat completion request, used
 * to build an AbortSignal when the caller doesn't supply their own. */
export const DEFAULT_LLM_TIMEOUT_MS = 120_000

export type LlmConnection = 'api' | 'network'

export interface RequestChatOptions {
  /** tc-shared-llm-config-v1 preset id. "" / omitted = the config's defaultPresetId. */
  presetId?: string
  /** "api" (default): call the preset's provider directly over HTTP.
   * "network": route through the AI Network room (lib/aiNetwork.ts),
   * omitting `model` so the connected peer falls back to its own config. */
  connection?: LlmConnection
  onDelta?: (delta: string, full: string) => void
  temperature?: number
  /** Overrides DEFAULT_LLM_TIMEOUT_MS for the direct-API path. Ignored for
   * "network" (see aiNetwork.ts's DEFAULT_NETWORK_TIMEOUT_MS instead). */
  timeoutMs?: number
  /** Caller-supplied abort, combined with the default timeout below. */
  signal?: AbortSignal
}

// Maps a resolved preset+provider onto the shared library's upstream config.
// reasoningEffort is forwarded only when set and non-empty.
function apiConfig(target: ResolvedLlmTargetV1, temperature?: number): OpenAIConfig {
  const reasoningEffort = target.reasoningEffort?.trim()
  return {
    baseUrl: normalizeBaseUrl(target.baseUrl),
    apiKey: target.apiKey,
    model: target.model.trim(),
    temperature: temperature ?? target.temperature ?? 0.7,
    ...(reasoningEffort ? { reasoningEffort } : {}),
  }
}

/** Combines an optional caller signal with a default timeout so direct-API
 * calls are never truly unbounded, without forcing every call site to build
 * its own AbortController. Falls back to the caller's own signal verbatim
 * when the runtime lacks AbortSignal.any/timeout (very old browsers). */
function withDefaultTimeout(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal | undefined {
  if (typeof AbortSignal === 'undefined' || typeof AbortSignal.timeout !== 'function') return signal
  const timeout = AbortSignal.timeout(timeoutMs)
  if (!signal) return timeout
  if (typeof AbortSignal.any === 'function') return AbortSignal.any([signal, timeout])
  return signal
}

/**
 * Resolves `presetId` (or, if "" / not found, the shared config's
 * defaultPresetId) against tc-shared-llm-config-v1 and requests a chat
 * completion. Throws a (localized, for network errors) Error if no
 * preset/provider can be resolved, or on network/HTTP/empty-response
 * failure.
 */
export async function requestChatCompletion(
  messages: MultimodalChatMessage[],
  options?: RequestChatOptions,
): Promise<string> {
  const cfg = loadLlmConfig() ?? emptyLlmConfig()
  const resolved = resolvePreset(cfg, options?.presetId || undefined)
  if (!resolved) {
    throw new Error('No LLM provider is configured yet (see Settings).')
  }

  try {
    if (options?.connection === 'network') {
      // The AI Network wire protocol's ChatMessage.content is a plain
      // string (see @tik-choco/mistai's protocol.ts LlmRequestMsg) — it has
      // no image_url part, so a multimodal (vision) request can't be routed
      // through a peer this way. Callers that need vision (lib/evaluator's
      // visionJudge.ts) always pass connection: 'api' for this reason; this
      // check just makes the constraint explicit instead of silently
      // dropping the images.
      if (messages.some((m) => Array.isArray(m.content))) {
        throw new Error('Multimodal (image) requests are not supported over the AI Network connection.')
      }
      const content = await requestNetworkChat(cfg.network.roomId, messages as ChatMessage[], undefined, options.onDelta)
      if (!content.trim()) {
        throw new MistaiError('UPSTREAM_BAD_RESPONSE', 'The provider returned an empty response.')
      }
      return content
    }

    const signal = withDefaultTimeout(options?.signal, options?.timeoutMs ?? DEFAULT_LLM_TIMEOUT_MS)
    const fetchWithSignal: typeof fetch | undefined = signal
      ? (input, init) => fetch(input, { ...init, signal })
      : undefined

    // streamChatCompletion's onDelta hands us the fragment only; accumulate
    // the running text ourselves so callers get the (delta, full) pair.
    let full = ''
    const onDelta = options?.onDelta
    const content = await streamChatCompletion(
      apiConfig(resolved, options?.temperature),
      // @tik-choco/mistai's streamChatCompletion only ever JSON.stringifies
      // `messages` straight into the request body (see its openai.ts) — it
      // never inspects `content`'s shape, so an array `content` (multimodal)
      // passes through to the wire unchanged despite the narrower vendored
      // `ChatMessage` type. This cast documents that the widening is safe at
      // runtime, not just a type-system workaround.
      messages as unknown as ChatMessage[],
      onDelta
        ? (delta) => {
            full += delta
            onDelta(delta, full)
          }
        : undefined,
      fetchWithSignal,
    )

    if (!content.trim()) {
      throw new MistaiError('UPSTREAM_BAD_RESPONSE', 'The provider returned an empty response.')
    }

    return content
  } catch (err) {
    throw new Error(localizeNetworkError(err, 'The chat request failed.'))
  }
}

/**
 * Streaming variant used by the AI Network provider lifecycle (if
 * features/settings wires up `useNetworkProvider`, see lib/aiNetwork.ts) to
 * forward llm_request traffic from remote consumers to this app's configured
 * endpoint. Always calls the API directly — never routes back through
 * `networkClient`, which would loop the request into the room it came from.
 */
export async function requestApiChatCompletionStreaming(
  target: ResolvedLlmTargetV1,
  messages: ChatMessage[],
  model: string | undefined,
  onDelta: (delta: string) => void,
): Promise<string> {
  const config = apiConfig(target)
  const full = await streamChatCompletion({ ...config, model: (model ?? config.model ?? '').trim() }, messages, onDelta)

  if (!full.trim()) {
    throw new MistaiError('UPSTREAM_BAD_RESPONSE', 'The provider returned an empty response.')
  }

  return full
}

/** Re-exported so callers don't need a separate import just to check the
 * network consumer's current phase before deciding connection: 'network'. */
export function isNetworkConnected(): boolean {
  return networkClient.status.phase === 'connected'
}
