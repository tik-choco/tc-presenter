import type { ModelRefV1 } from '@tik-choco/mistai/llm-config'
import { taskSettings } from '../../lib/aiSettings'
export function loadVisionRef() { return taskSettings('vision').ref }
// Pipeline shape and concurrency stay app-local; model refs come from task settings.
const GENERATE_ROLES_KEY = 'tc-presenter:generate-roles'

export type PipelineMode = 'plan_fanout' | 'script_first'

export interface GenerateRolePrefs {
  /** Planning and slide-authoring pipeline shape. */
  pipelineMode: PipelineMode
  /** Saved planning task model. */
  orchestratorRef?: ModelRefV1
  /** Saved slide generation task model. */
  workerRef?: ModelRefV1
  /** How many segment workers run concurrently (1 = sequential).
   * Clamped to generateDeck.ts's own 1..8 bound. */
  workerConcurrency: number
}

export const DEFAULT_GENERATE_ROLE_PREFS: GenerateRolePrefs = {
  pipelineMode: 'plan_fanout',
  workerConcurrency: 1,
}

export function clampWorkerConcurrency(value: number): number {
  if (!Number.isFinite(value)) return 1
  return Math.max(1, Math.min(8, Math.trunc(value)))
}

export function loadGenerateRolePrefs(): GenerateRolePrefs {
  try {
    const raw = localStorage.getItem(GENERATE_ROLES_KEY)
    if (!raw) return { ...DEFAULT_GENERATE_ROLE_PREFS, orchestratorRef: taskSettings('orchestrator').ref, workerRef: taskSettings('worker').ref }
    const parsed: unknown = JSON.parse(raw)
    if (parsed === null || typeof parsed !== 'object') return { ...DEFAULT_GENERATE_ROLE_PREFS, orchestratorRef: taskSettings('orchestrator').ref, workerRef: taskSettings('worker').ref }
    const record = parsed as Record<string, unknown>
    return {
      pipelineMode: record.pipelineMode === 'script_first' ? 'script_first' : 'plan_fanout',
      orchestratorRef: taskSettings('orchestrator').ref,
      workerRef: taskSettings('worker').ref,
      workerConcurrency: clampWorkerConcurrency(typeof record.workerConcurrency === 'number' ? record.workerConcurrency : 1),
    }
  } catch {
    return { ...DEFAULT_GENERATE_ROLE_PREFS, orchestratorRef: taskSettings('orchestrator').ref, workerRef: taskSettings('worker').ref }
  }
}

export function saveGenerateRolePrefs(prefs: GenerateRolePrefs): void {
  try {
    localStorage.setItem(
      GENERATE_ROLES_KEY,
      JSON.stringify({ pipelineMode: prefs.pipelineMode, workerConcurrency: clampWorkerConcurrency(prefs.workerConcurrency) }),
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
