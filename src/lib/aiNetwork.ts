// App-side wiring for @tik-choco/mistai's "AI Network" (mistllm-wire P2P LLM/
// TTS/STT). Was originally Pattern A verbatim (see notes-mistlib.md §4): the
// vendored mistlib node injected directly into a single module-scoped
// ConsumerClient. Now shares lib/mistNode.ts's single app-wide MistNode via
// the SharedMistNode adapter instead of instantiating its own — mistlib-wasm
// only supports one active node per page, and lib/globalArticlesReader.ts
// (the tc-global-articles P2P subscription in features/sources) needs that
// same one node. See mistNode.ts's header comment for the full rationale;
// this is otherwise still the simplest correct integration (no collab-room
// multiplexing), matching tc-news's own lib/network.ts, which solves the
// identical one-node/two-consumers problem the same way.
//
// Also re-exports `useNetworkProvider` for the optional "become a provider"
// role (settings feature can wire this up to expose this app's own LLM/TTS
// config to the room; every callback is independently optional so partial
// capability advertisement — e.g. LLM only, no TTS — works out of the box).

import {
  ConsumerClient,
  MESSAGES_JA,
  MESSAGES_EN,
  formatMistaiError,
  type ConsumerStatus,
  type ConsumerStatusListener,
  type ChatMessage,
  type MistNodeLike,
} from '@tik-choco/mistai'
import { useNetworkProvider } from '@tik-choco/mistai/preact'
import { SharedMistNode } from './mistNode'
import { getLocale } from '../i18n'

export type { ConsumerStatus, ConsumerStatusListener }
export { useNetworkProvider }

/** localStorage key mistai resolves a nodeId from before handing it to
 * createMistNode below. The id itself goes unused now (see createMistNode's
 * comment) — the real node's identity is lib/mistNode.ts's own
 * localNodeId() — but the option is still threaded through so ConsumerClient
 * has *a* stable per-role id to key its internal bookkeeping on. */
export const NODE_ID_STORAGE_KEY = 'tc-presenter-mistllm-node-id-v1'

/** Default request timeout for AI Network chat/tts/stt requests. mistai's
 * ConsumerClient has NO default timeout of its own (see notes-mistlib.md
 * §"危険な失敗モード" #1) — a voice-only peer answering a chat request, or a
 * chat-only peer answering a tts request, can otherwise hang forever. */
export const DEFAULT_NETWORK_TIMEOUT_MS = 120_000

/** Factory the shared ConsumerClient (and useNetworkProvider) use to build a
 * mist node. `_nodeId` is intentionally unused: the real shared node's
 * identity is fixed by lib/mistNode.ts's localNodeId(), not by whatever id
 * mistai resolved from NODE_ID_STORAGE_KEY — see SharedMistNode. */
export function createMistNode(_nodeId: string): MistNodeLike {
  return new SharedMistNode()
}

/** Single long-lived consumer session for this app. */
export const networkClient = new ConsumerClient({
  createNode: createMistNode,
  nodeIdStorageKey: NODE_ID_STORAGE_KEY,
  requestTimeoutMs: DEFAULT_NETWORK_TIMEOUT_MS,
})

/** Subscribes to consumer connection status changes. Returns an unsubscribe function. */
export function onConsumerStatusChange(listener: ConsumerStatusListener): () => void {
  return networkClient.onStatusChange(listener)
}

/** Eagerly connects to the AI Network room; errors surface via status, never thrown. */
export function connectNetworkConsumer(roomId: string): Promise<void> {
  return networkClient.connect(roomId)
}

/** Tears down the active/pending consumer session and resets status to idle. */
export function disconnectNetworkConsumer(): void {
  networkClient.disconnect()
}

/**
 * Sends a chat request over the AI Network room and resolves with the full
 * reply text. `model` is intentionally optional and normally omitted by
 * callers — see notes-mistlib.md §"モデル選択": sending a model name the
 * provider doesn't have is silently passed through and only fails upstream
 * with a 400, so the family convention is to let the connected peer fall
 * back to its own configured model.
 */
export function requestNetworkChat(
  roomId: string,
  messages: ChatMessage[],
  model: string | undefined,
  onDelta?: (delta: string, full: string) => void,
): Promise<string> {
  return networkClient.requestChat(roomId, messages, { model, onDelta })
}

/** Requests speech synthesis over the AI Network room; resolves with the audio Blob. */
export function requestNetworkTts(
  roomId: string,
  params: { text: string; model?: string; voice?: string },
): Promise<Blob> {
  return networkClient.requestTts(roomId, params)
}

/** Sends audio for transcription over the AI Network room; resolves with the text. */
export function requestNetworkStt(
  roomId: string,
  params: { audio: Blob; model?: string; fileName?: string },
): Promise<string> {
  return networkClient.requestStt(roomId, params)
}

/**
 * Localizes any error from a network (or mixed network/API) code path using
 * the library's canonical message catalog, following the current UI locale
 * (see src/i18n). Non-MistaiError errors keep their own message.
 */
export function localizeNetworkError(err: unknown, fallback: string): string {
  const catalog = getLocale() === 'ja' ? MESSAGES_JA : MESSAGES_EN
  return formatMistaiError(err, catalog, fallback)
}
