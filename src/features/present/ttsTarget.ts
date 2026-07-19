// Small local helper bridging `PresentPlayerProps.presetId` (types.ts: "used
// for TTS voice resolution; omitted falls back to the shared config's `tts`
// entry") into lib/llmConfig.ts's `resolveVoice`. `resolveVoice` itself only
// ever falls back to `config.defaultPresetId` (via `resolvePreset(config)`)
// when `config.tts.providerId` is absent — it has no way to honor an
// explicit, caller-supplied presetId. Rather than change that shared/vendored
// file (out of this feature's ownership — see PLAN.md ownership table), this
// re-implements just that one branch with `presetId` threaded through.
import { resolvePreset, type SharedLlmConfigV1 } from '../../lib/llmConfig'
import type { VoiceConnection } from '../../lib/tts'

export interface ResolvedTtsTarget {
  connection: VoiceConnection
  model: string
  voice?: string
  speed?: number
}

/**
 * Resolves `config.tts` to a concrete synthesis target. Returns null when no
 * `tts` entry is configured (or it has no model) or its provider can't be
 * found — callers should treat that as "TTS unavailable" and fall back to
 * estimated-duration auto-advance.
 */
export function resolveTtsTarget(config: SharedLlmConfigV1, presetId?: string): ResolvedTtsTarget | null {
  const cfg = config.tts
  if (!cfg || !cfg.model) return null

  const provider = cfg.providerId
    ? config.providers.find((p) => p.id === cfg.providerId)
    : (() => {
        const target = resolvePreset(config, presetId)
        return target ? config.providers.find((p) => p.id === target.providerId) : undefined
      })()
  if (!provider) return null

  const resolved: ResolvedTtsTarget = {
    connection: { baseUrl: provider.baseUrl, apiKey: provider.apiKey },
    model: cfg.model,
  }
  if (cfg.voice !== undefined) resolved.voice = cfg.voice
  if (cfg.speed !== undefined) resolved.speed = cfg.speed
  return resolved
}

/** Either a remote (OpenAI-compatible `/audio/speech`) target, tagged so
 * callers can keep using the existing `ResolvedTtsTarget` fields unchanged,
 * or a browser `SpeechSynthesis` target driven entirely client-side. */
export type ResolvedNarrationTarget =
  | ({ kind: 'remote' } & ResolvedTtsTarget)
  | { kind: 'browser'; lang: string; voiceURI?: string; rate?: number; pitch?: number }

/**
 * Resolves the narration target: the shared `config.tts` entry (via
 * `resolveTtsTarget`), tagged 'remote'. Returns null when nothing usable can
 * be resolved — callers should treat that as "narration unavailable" the
 * same way `resolveTtsTarget` already does. The per-language TTS rules layer
 * that used to sit in front of this (lib/ttsLangRules.ts, routing individual
 * deck languages to the browser's SpeechSynthesis or a per-language
 * provider) was removed to match tc-translate's settings shape — the
 * 'browser' variant below is kept only so the player's SpeechSynthesis
 * plumbing stays type-complete.
 */
export function resolveNarrationTarget(config: SharedLlmConfigV1, presetId?: string): ResolvedNarrationTarget | null {
  const target = resolveTtsTarget(config, presetId)
  return target ? { kind: 'remote', ...target } : null
}
