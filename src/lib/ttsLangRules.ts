// tc-presenter-local "per-language TTS engine" overrides. The shared
// tc-shared-llm-config-v1 record (lib/llmConfig.ts) is an app-family co-owned
// v1 contract with a single `tts` entry (one OpenAI-compatible voice for
// everything) — it is not touched here. This module layers a purely local
// mapping of normalized language code -> which engine/voice to use on top of
// it, so e.g. Japanese slides can use the browser's built-in speechSynthesis
// while everything else falls back to the shared OpenAI-compatible TTS
// config. See lib/browserTts.ts for the engine this unlocks.

type OpenaiTtsEngineRule = { engine: 'openai'; providerId?: string; model: string; voice?: string; speed?: number }
type BrowserTtsEngineRule = { engine: 'browser'; voiceURI?: string; rate?: number; pitch?: number }

/** One language's resolved TTS engine + its engine-specific options. */
export type TtsEngineRule = OpenaiTtsEngineRule | BrowserTtsEngineRule

export type TtsLangRulesV1 = {
  v: 1
  /** normalized lang code ('ja', 'en', ...) or '*' (all languages) -> rule */
  rules: Record<string, TtsEngineRule>
}

export const TTS_LANG_RULES_KEY = 'tc-presenter:tts-lang-rules-v1'

/** lowercase + primary subtag ('ja-JP' -> 'ja', 'EN' -> 'en'). `'*'` is returned unchanged. */
export function normalizeLang(lang: string): string {
  if (lang === '*') return lang
  const primary = lang.trim().toLowerCase().split(/[-_]/)[0]
  return primary
}

function isOpenaiRule(value: Record<string, unknown>): value is OpenaiTtsEngineRule {
  return (
    value.engine === 'openai' &&
    typeof value.model === 'string' &&
    (value.providerId === undefined || typeof value.providerId === 'string') &&
    (value.voice === undefined || typeof value.voice === 'string') &&
    (value.speed === undefined || typeof value.speed === 'number')
  )
}

function isBrowserRule(value: Record<string, unknown>): value is BrowserTtsEngineRule {
  return (
    value.engine === 'browser' &&
    (value.voiceURI === undefined || typeof value.voiceURI === 'string') &&
    (value.rate === undefined || typeof value.rate === 'number') &&
    (value.pitch === undefined || typeof value.pitch === 'number')
  )
}

function isTtsEngineRule(value: unknown): value is TtsEngineRule {
  if (value === null || typeof value !== 'object') return false
  const record = value as Record<string, unknown>
  return isOpenaiRule(record) || isBrowserRule(record)
}

/**
 * Field-by-field defensive parse of a raw `rules` map. Malformed entries are
 * dropped individually rather than invalidating the whole record.
 */
function sanitizeRules(value: unknown): Record<string, TtsEngineRule> {
  if (value === null || typeof value !== 'object') return {}
  const record = value as Record<string, unknown>
  const rules: Record<string, TtsEngineRule> = {}
  for (const key of Object.keys(record)) {
    const candidate = record[key]
    if (isTtsEngineRule(candidate)) rules[key] = candidate
  }
  return rules
}

/**
 * Reads and validates `tc-presenter:tts-lang-rules-v1`. Never throws: a
 * missing key, malformed JSON, or a top-level shape mismatch (including a
 * `v` other than 1) all fall back to `{ v: 1, rules: {} }`. Malformed
 * individual rule entries are dropped rather than invalidating the record.
 */
export function loadTtsLangRules(): TtsLangRulesV1 {
  try {
    const raw = localStorage.getItem(TTS_LANG_RULES_KEY)
    if (!raw) return { v: 1, rules: {} }
    const parsed: unknown = JSON.parse(raw)
    if (parsed === null || typeof parsed !== 'object') return { v: 1, rules: {} }
    const record = parsed as Record<string, unknown>
    if (record.v !== 1) return { v: 1, rules: {} }
    return { v: 1, rules: sanitizeRules(record.rules) }
  } catch {
    return { v: 1, rules: {} }
  }
}

/**
 * Best-effort persistence of `rules` to `tc-presenter:tts-lang-rules-v1`.
 * Removes the key entirely when `rules.rules` is empty. Storage failures
 * (quota, disabled storage, etc.) are swallowed silently.
 */
export function saveTtsLangRules(rules: TtsLangRulesV1): void {
  try {
    if (Object.keys(rules.rules).length === 0) {
      localStorage.removeItem(TTS_LANG_RULES_KEY)
      return
    }
    localStorage.setItem(TTS_LANG_RULES_KEY, JSON.stringify(rules))
  } catch {
    // best-effort persistence only
  }
}

/**
 * Resolves the rule to use for `lang`: an exact match on
 * `normalizeLang(lang)`, falling back to the `'*'` (all-languages) entry,
 * falling back to `null` when neither is configured.
 */
export function findRuleForLang(rules: TtsLangRulesV1, lang: string): TtsEngineRule | null {
  const normalized = normalizeLang(lang)
  return rules.rules[normalized] ?? rules.rules['*'] ?? null
}
