// tc-presenter-local UI preferences that don't belong in the co-owned
// tc-shared-llm-config-v1 record (lib/llmConfig.ts) because they aren't
// shared across the tik-choco app family — just this app's "should the AI
// Network consumer be active" toggle. `network.roomId` itself *does* live in
// the shared config (see llmConfig.ts's SharedLlmConfigV1.network); this is
// only the on/off switch layered on top of it.

const AI_NETWORK_ENABLED_KEY = 'tc-presenter:ai-network-enabled'

export function loadNetworkEnabled(): boolean {
  try {
    return localStorage.getItem(AI_NETWORK_ENABLED_KEY) === '1'
  } catch {
    return false
  }
}

export function saveNetworkEnabled(enabled: boolean): void {
  try {
    if (enabled) localStorage.setItem(AI_NETWORK_ENABLED_KEY, '1')
    else localStorage.removeItem(AI_NETWORK_ENABLED_KEY)
  } catch {
    // best-effort persistence only
  }
}

// "Become an AI Network provider" role (lib/aiNetwork.ts's re-exported
// useNetworkProvider) — independent of the consumer toggle above, mirroring
// tc-translate's networkProviderEnabled. Local-only: which of this app's own
// shared presets get advertised into the room is a per-device choice, not
// something other tc-* apps need to see.
const AI_NETWORK_PROVIDER_ENABLED_KEY = 'tc-presenter:ai-network-provider-enabled'

export function loadNetworkProviderEnabled(): boolean {
  try {
    return localStorage.getItem(AI_NETWORK_PROVIDER_ENABLED_KEY) === '1'
  } catch {
    return false
  }
}

export function saveNetworkProviderEnabled(enabled: boolean): void {
  try {
    if (enabled) localStorage.setItem(AI_NETWORK_PROVIDER_ENABLED_KEY, '1')
    else localStorage.removeItem(AI_NETWORK_PROVIDER_ENABLED_KEY)
  } catch {
    // best-effort persistence only
  }
}

// Preset ids from tc-shared-llm-config-v1 that this device advertises to the
// AI Network room while providerEnabled is on. Never includes a
// `mist-network://`-origin preset (lib/networkModels.ts's
// isNetworkProviderBaseUrl) — callers are responsible for filtering those out
// before offering them in the share checklist, same re-share-loop guard as
// tc-translate.
const AI_NETWORK_PROVIDER_PRESET_IDS_KEY = 'tc-presenter:ai-network-provider-preset-ids'

export function loadNetworkProviderPresetIds(): string[] {
  try {
    const raw = localStorage.getItem(AI_NETWORK_PROVIDER_PRESET_IDS_KEY)
    if (!raw) return []
    const parsed: unknown = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string') : []
  } catch {
    return []
  }
}

export function saveNetworkProviderPresetIds(ids: string[]): void {
  try {
    localStorage.setItem(AI_NETWORK_PROVIDER_PRESET_IDS_KEY, JSON.stringify(ids))
  } catch {
    // best-effort persistence only
  }
}

// tc-shared-llm-config-v1 preset id to use for the vision judge (lib/
// evaluator/visionJudge.ts). Local, not shared with the rest of the
// tik-choco app family (unlike the presets themselves) — this is purely
// "which of my already-configured presets is vision-capable", set once in
// Settings so the editor's generate form can turn useVisionJudge on "for
// free" without asking the user to pick a preset every time (task brief:
// "「LLM設定するだけで」動くこと").
const VISION_PRESET_ID_KEY = 'tc-presenter:vision-preset-id'

export function loadVisionPresetId(): string {
  try {
    return localStorage.getItem(VISION_PRESET_ID_KEY) ?? ''
  } catch {
    return ''
  }
}

export function saveVisionPresetId(presetId: string): void {
  try {
    if (presetId) localStorage.setItem(VISION_PRESET_ID_KEY, presetId)
    else localStorage.removeItem(VISION_PRESET_ID_KEY)
  } catch {
    // best-effort persistence only
  }
}

// Orchestrator/worker role defaults for the generate pipeline (types.ts's
// GenerateOptions.presetId / workerPresetId / workerConcurrency). Like
// visionPresetId above, this is purely "which of my already-configured
// shared presets plays which role" — the presets themselves live in the
// co-owned tc-shared-llm-config-v1 record. Set once in Settings; the
// editor's generate form seeds its pickers from this so a run needs zero
// per-run model configuration (and can still override per-run).
const GENERATE_ROLES_KEY = 'tc-presenter:generate-roles'

export type PipelineMode = 'plan_fanout' | 'script_first'

export interface GenerateRolePrefs {
  /** Which pipeline shape generation runs (types.ts's
   * GenerateOptions.pipelineMode): 'plan_fanout' (default — the
   * tc-translate-style split: the orchestrator emits only a compact segment
   * plan and each fan-out worker writes its segment's narration + slide,
   * keeping the expensive orchestrator preset's token spend to the one plan
   * call) or 'script_first' (legacy: the orchestrator writes the full
   * narration up front and workers only visualize). */
  pipelineMode: PipelineMode
  /** Preset for the planning/orchestrator calls. In 'plan_fanout' this is
   * ONLY the single deck-plan call; in 'script_first' it also covers the
   * full-script write, evaluation and batch refine. "" = the shared
   * config's defaultPresetId. */
  orchestratorPresetId: string
  /** Preset for the fan-out worker calls (per-segment narration+slides in
   * 'plan_fanout' / slides only in 'script_first', plus per-slide refine).
   * "" = same as the orchestrator. */
  workerPresetId: string
  /** How many segment workers run concurrently (1 = sequential).
   * Clamped to generateDeck.ts's own 1..8 bound. */
  workerConcurrency: number
}

export const DEFAULT_GENERATE_ROLE_PREFS: GenerateRolePrefs = {
  pipelineMode: 'plan_fanout',
  orchestratorPresetId: '',
  workerPresetId: '',
  workerConcurrency: 1,
}

export function clampWorkerConcurrency(value: number): number {
  if (!Number.isFinite(value)) return 1
  return Math.max(1, Math.min(8, Math.trunc(value)))
}

export function loadGenerateRolePrefs(): GenerateRolePrefs {
  try {
    const raw = localStorage.getItem(GENERATE_ROLES_KEY)
    if (!raw) return { ...DEFAULT_GENERATE_ROLE_PREFS }
    const parsed: unknown = JSON.parse(raw)
    if (parsed === null || typeof parsed !== 'object') return { ...DEFAULT_GENERATE_ROLE_PREFS }
    const record = parsed as Record<string, unknown>
    return {
      pipelineMode: record.pipelineMode === 'script_first' ? 'script_first' : 'plan_fanout',
      orchestratorPresetId: typeof record.orchestratorPresetId === 'string' ? record.orchestratorPresetId : '',
      workerPresetId: typeof record.workerPresetId === 'string' ? record.workerPresetId : '',
      workerConcurrency: clampWorkerConcurrency(typeof record.workerConcurrency === 'number' ? record.workerConcurrency : 1),
    }
  } catch {
    return { ...DEFAULT_GENERATE_ROLE_PREFS }
  }
}

export function saveGenerateRolePrefs(prefs: GenerateRolePrefs): void {
  try {
    localStorage.setItem(
      GENERATE_ROLES_KEY,
      JSON.stringify({ ...prefs, workerConcurrency: clampWorkerConcurrency(prefs.workerConcurrency) }),
    )
  } catch {
    // best-effort persistence only
  }
}

// PresentPlayer's speakerNotes caption overlay toggle (features/present/
// PresentPlayer.tsx). Off by default — presenting already shows the slide
// full-screen, so captions are an opt-in accessibility/reference aid.
const CAPTIONS_ENABLED_KEY = 'tc-presenter:captions-enabled'

export function loadCaptionsEnabled(): boolean {
  try {
    return localStorage.getItem(CAPTIONS_ENABLED_KEY) === '1'
  } catch {
    return false
  }
}

export function saveCaptionsEnabled(enabled: boolean): void {
  try {
    if (enabled) localStorage.setItem(CAPTIONS_ENABLED_KEY, '1')
    else localStorage.removeItem(CAPTIONS_ENABLED_KEY)
  } catch {
    // best-effort persistence only
  }
}

// PresentPlayer's narration playback speed (features/present/PresentPlayer.
// tsx). 1x is the default, so it's stored only when the presenter picks a
// non-default speed — same "omit the default" shape as the other prefs here.
export const PLAYBACK_SPEEDS = [0.75, 1, 1.25, 1.5, 2] as const
export type PlaybackSpeed = (typeof PLAYBACK_SPEEDS)[number]

const PLAYBACK_SPEED_KEY = 'tc-presenter:playback-speed'

export function loadPlaybackSpeed(): PlaybackSpeed {
  try {
    const value = Number(localStorage.getItem(PLAYBACK_SPEED_KEY))
    return (PLAYBACK_SPEEDS as readonly number[]).includes(value) ? (value as PlaybackSpeed) : 1
  } catch {
    return 1
  }
}

export function savePlaybackSpeed(speed: PlaybackSpeed): void {
  try {
    if (speed === 1) localStorage.removeItem(PLAYBACK_SPEED_KEY)
    else localStorage.setItem(PLAYBACK_SPEED_KEY, String(speed))
  } catch {
    // best-effort persistence only
  }
}

// PresentPlayer's caption translation target language (lib/
// captionTranslation.ts's dual-language subtitle cache/translator). Off
// ('') by default — translation costs an LLM call per slide, so it's opt-in
// only, layered on top of the captionsEnabled toggle above rather than
// replacing it.
export const CAPTION_TRANSLATION_LANGS = ['en', 'ja', 'zh', 'ko', 'es', 'fr', 'de', 'pt'] as const
export type CaptionTranslationLang = (typeof CAPTION_TRANSLATION_LANGS)[number]

export const CAPTION_LANG_LABELS: Record<CaptionTranslationLang, string> = {
  en: 'English',
  ja: '日本語',
  zh: '中文',
  ko: '한국어',
  es: 'Español',
  fr: 'Français',
  de: 'Deutsch',
  pt: 'Português',
}

const CAPTION_TRANSLATION_LANG_KEY = 'tc-presenter:caption-translation-lang'

export function loadCaptionTranslationLang(): CaptionTranslationLang | '' {
  try {
    const value = localStorage.getItem(CAPTION_TRANSLATION_LANG_KEY) ?? ''
    return (CAPTION_TRANSLATION_LANGS as readonly string[]).includes(value) ? (value as CaptionTranslationLang) : ''
  } catch {
    return ''
  }
}

export function saveCaptionTranslationLang(lang: CaptionTranslationLang | ''): void {
  try {
    if (lang) localStorage.setItem(CAPTION_TRANSLATION_LANG_KEY, lang)
    else localStorage.removeItem(CAPTION_TRANSLATION_LANG_KEY)
  } catch {
    // best-effort persistence only
  }
}
