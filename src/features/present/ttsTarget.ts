import { resolveVoice, type SharedLlmConfigV1, type ModelRefV1 } from '../../lib/llmConfig'
import type { VoiceConnection } from '../../lib/tts'
export interface ResolvedTtsTarget { connection: VoiceConnection; model: string; voice?: string; speed?: number }
export function resolveTtsTarget(config: SharedLlmConfigV1, modelRef?: ModelRefV1): ResolvedTtsTarget | null {
  const target = resolveVoice(modelRef && !config.tts?.providerId ? { ...config, defaultModel: modelRef } : config, 'tts')
  return target ? { connection: { baseUrl: target.baseUrl, apiKey: target.apiKey }, model: target.model, voice: target.voice, speed: target.speed } : null
}
export type ResolvedNarrationTarget = ({ kind: 'remote' } & ResolvedTtsTarget) | { kind: 'browser'; lang: string; voiceURI?: string; rate?: number; pitch?: number }
export function resolveNarrationTarget(config: SharedLlmConfigV1 | null, modelRef?: ModelRefV1, lang = 'en'): ResolvedNarrationTarget | null {
  if (!config?.tts?.model.trim()) return { kind: 'browser', lang, rate: config?.tts?.speed }
  const target = resolveTtsTarget(config, modelRef)
  return target ? { kind: 'remote', ...target } : null
}
