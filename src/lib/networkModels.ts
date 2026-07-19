// Helpers for representing AI Network–discovered models in the shared llm
// config (lib/llmConfig.ts): they live under a pseudo-provider whose baseUrl
// uses the `mist-network://` scheme (one per Room ID), so other tik-choco
// apps see a syntactically valid provider entry while this app can recognize
// and special-case it (no HTTP model fetch, network transport routing,
// excluded from the "share to the room" checklist to avoid a re-share loop).
//
// tc-presenter doesn't implement its own network-model mirror (unlike
// tc-translate's useNetworkModelSync) — it only needs to recognize a
// pseudo-provider that another tik-choco app sharing this origin's
// localStorage may have already written into tc-shared-llm-config-v1, and to
// avoid accidentally re-advertising it. Ported (trimmed to what tc-presenter
// actually uses — no STT sentinel, this app has no STT feature) from
// tc-translate's src/lib/networkModels.ts; see
// tc-docs/drafts/llm-settings-common-v1.md §2.2/§4.1.
export const NETWORK_PROVIDER_LABEL = 'AI Network'
export const NETWORK_PROVIDER_URL_PREFIX = 'mist-network://'

export function networkProviderBaseUrl(roomId: string): string {
  return `${NETWORK_PROVIDER_URL_PREFIX}${roomId.trim() || 'default'}`
}

export function isNetworkProviderBaseUrl(baseUrl: string): boolean {
  return baseUrl.trim().startsWith(NETWORK_PROVIDER_URL_PREFIX)
}

/**
 * The name a shared preset is advertised under in `provider_hello.models`,
 * and the key an incoming model-specific request is matched back to a target
 * by: the preset's user-facing label, falling back to the raw model id when
 * the label is blank. Display name doubling as an opaque routing key, NOT
 * necessarily an upstream model id — see llm-settings-common-v1.md §4.2.
 */
export function advertisedModelName(target: { label: string; model: string }): string {
  return target.label.trim() || target.model
}

/** Sentinel voice-config model meaning "let the room's provider use its own
 * configured TTS model". Stored in the shared config's `tts.model` field
 * alongside a mist-network pseudo-provider id; stripped from outgoing
 * requests (an omitted wire model → provider's own default). */
export const NETWORK_VOICE_AUTO_MODEL = 'network-auto'

/** Maps a configured TTS model to the wire request param: the auto sentinel
 * becomes undefined (omit), anything else passes through (empty → undefined too). */
export function networkVoiceModelParam(model: string): string | undefined {
  const trimmed = model.trim()
  return !trimmed || trimmed === NETWORK_VOICE_AUTO_MODEL ? undefined : trimmed
}
