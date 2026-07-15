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
import { findRuleForLang, loadTtsLangRules } from '../../lib/ttsLangRules'

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
 * Resolves the narration target for `deckLang`: a per-language rule from
 * lib/ttsLangRules.ts takes priority (either routing to the browser's
 * built-in TTS or to a specific OpenAI-compatible provider/model/voice for
 * that language), falling back to the legacy shared `config.tts` entry (via
 * `resolveTtsTarget`, unchanged) when no rule matches. Returns null when
 * nothing usable can be resolved (no rule, no fallback tts config, or the
 * rule/config's provider can't be found) — callers should treat that as
 * "narration unavailable" the same way `resolveTtsTarget` already does.
 */
export function resolveNarrationTarget(
  config: SharedLlmConfigV1,
  deckLang: string,
  presetId?: string,
): ResolvedNarrationTarget | null {
  const rule = findRuleForLang(loadTtsLangRules(), deckLang)

  if (!rule) {
    const target = resolveTtsTarget(config, presetId)
    return target ? { kind: 'remote', ...target } : null
  }

  if (rule.engine === 'browser') {
    const resolved: ResolvedNarrationTarget = { kind: 'browser', lang: deckLang }
    if (rule.voiceURI !== undefined) resolved.voiceURI = rule.voiceURI
    if (rule.rate !== undefined) resolved.rate = rule.rate
    if (rule.pitch !== undefined) resolved.pitch = rule.pitch
    return resolved
  }

  // rule.engine === 'openai' — same providerId-or-preset resolution as resolveTtsTarget above.
  const provider = rule.providerId
    ? config.providers.find((p) => p.id === rule.providerId)
    : (() => {
        const target = resolvePreset(config, presetId)
        return target ? config.providers.find((p) => p.id === target.providerId) : undefined
      })()
  if (!provider) return null

  const resolved: ResolvedNarrationTarget = {
    kind: 'remote',
    connection: { baseUrl: provider.baseUrl, apiKey: provider.apiKey },
    model: rule.model,
  }
  if (rule.voice !== undefined) resolved.voice = rule.voice
  if (rule.speed !== undefined) resolved.speed = rule.speed
  return resolved
}
