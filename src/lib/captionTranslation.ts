// Caption translation for PresentPlayer's dual-language subtitle overlay
// (features/present/PresentPlayer.tsx renders a slide's original-language
// speakerNotes with a translated line beneath it, toggled by localPrefs.ts's
// captionTranslationLang pref). Translations are cached per (deckId,
// slideId, lang) in localStorage, keyed off a hash of the narration text so
// editing a slide's speakerNotes invalidates only that slide's cached
// translation, not the whole deck's. Modeled on lib/kv.ts's defensive-parse
// / safeSetItem convention: a corrupted cache entry is dropped rather than
// surfaced as an app crash. This module itself never throws except from
// translateCaption's own LLM call, which callers are expected to handle —
// see ensureDeckCaptionTranslations's per-slide try/catch below for the
// batch case.

import { requestChatCompletion } from './llm'
import { safeSetItem } from './safeStorage'
import type { Deck } from '../types'

function cacheKey(deckId: string): string {
  return `tc-presenter:caption-translations:${deckId}`
}

interface CachedTranslation {
  /** FNV-1a 32-bit hex hash of the (trimmed) narration text this
   * translation was produced from — a cheap stand-in for a full diff so a
   * slide's cached translation is invalidated exactly when its
   * speakerNotes changes. */
  hash: string
  text: string
}

type DeckTranslationCache = Record<string, Record<string, CachedTranslation>>

function isCachedTranslation(value: unknown): value is CachedTranslation {
  if (value === null || typeof value !== 'object') return false
  const record = value as Record<string, unknown>
  return typeof record.hash === 'string' && typeof record.text === 'string'
}

/** Defensive parse (never throws): a corrupted top-level blob yields an
 * empty cache, and a corrupted/foreign-shaped per-slide or per-lang entry is
 * dropped individually rather than discarding the whole deck's cache. */
function loadDeckCache(deckId: string): DeckTranslationCache {
  try {
    const raw = localStorage.getItem(cacheKey(deckId))
    if (!raw) return {}
    const parsed: unknown = JSON.parse(raw)
    if (parsed === null || typeof parsed !== 'object') return {}
    const result: DeckTranslationCache = {}
    for (const [slideId, byLang] of Object.entries(parsed as Record<string, unknown>)) {
      if (byLang === null || typeof byLang !== 'object') continue
      const langs: Record<string, CachedTranslation> = {}
      for (const [lang, entry] of Object.entries(byLang as Record<string, unknown>)) {
        if (isCachedTranslation(entry)) langs[lang] = entry
      }
      if (Object.keys(langs).length > 0) result[slideId] = langs
    }
    return result
  } catch {
    return {}
  }
}

function saveDeckCache(deckId: string, cache: DeckTranslationCache): void {
  safeSetItem(cacheKey(deckId), JSON.stringify(cache))
}

/** FNV-1a 32-bit hash, hex-encoded. No dependency pulled in just to detect
 * "has this slide's narration changed since it was last translated" — this
 * doesn't need to be cryptographically strong, only stable and cheap. */
function hashNarration(narration: string): string {
  const text = narration.trim()
  let hash = 0x811c9dc5
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(16)
}

/** Reads the cached translation for (deckId, slideId, lang) if present *and*
 * still fresh (its stored hash matches `narration`'s current text). Returns
 * null on any miss, staleness, or corruption — never throws. */
export function getCachedCaptionTranslation(
  deckId: string,
  slideId: string,
  lang: string,
  narration: string,
): string | null {
  const entry = loadDeckCache(deckId)[slideId]?.[lang]
  if (!entry) return null
  return entry.hash === hashNarration(narration) ? entry.text : null
}

function setCachedCaptionTranslation(
  deckId: string,
  slideId: string,
  lang: string,
  narration: string,
  text: string,
): void {
  const cache = loadDeckCache(deckId)
  cache[slideId] = { ...(cache[slideId] ?? {}), [lang]: { hash: hashNarration(narration), text } }
  saveDeckCache(deckId, cache)
}

// Dedupes concurrent translateCaption() calls for the same (deckId, slideId,
// lang) — e.g. ensureDeckCaptionTranslations's deck-wide sweep racing a
// direct call from the player when the presenter jumps to a slide that's
// already mid-translation — so only one LLM request is ever in flight per
// key. Module-level singleton by design: this cache key space is already
// process-global (localStorage), so there's nothing to gain from scoping the
// dedupe map any tighter.
const inFlight = new Map<string, Promise<string>>()

function inFlightKey(deckId: string, slideId: string, lang: string): string {
  return `${deckId}::${slideId}::${lang}`
}

export async function translateCaption(opts: {
  deckId: string
  slideId: string
  lang: string
  narration: string
  signal?: AbortSignal
}): Promise<string> {
  const { deckId, slideId, lang, narration, signal } = opts

  const cached = getCachedCaptionTranslation(deckId, slideId, lang, narration)
  if (cached !== null) return cached

  const key = inFlightKey(deckId, slideId, lang)
  const existing = inFlight.get(key)
  if (existing) return existing

  const promise = (async () => {
    const content = await requestChatCompletion(
      [
        {
          role: 'system',
          content:
            `You are a translator for a presentation's narration captions. ` +
            `Translate the user's narration text into the target language "${lang}" ` +
            `naturally and fluently, preserving its meaning and tone. ` +
            `Output ONLY the translated text — no quotes, no preamble, no explanations, ` +
            `no language names, and no other commentary.`,
        },
        { role: 'user', content: narration },
      ],
      { presetId: '', temperature: 0.2, signal },
    )
    const text = content.trim()
    setCachedCaptionTranslation(deckId, slideId, lang, narration, text)
    return text
  })()

  inFlight.set(key, promise)
  try {
    return await promise
  } finally {
    inFlight.delete(key)
  }
}

/** Matches generateJobs.ts/exportJobs.ts's isAbortError: a caller-triggered
 * cancellation (signal.aborted) should propagate out of
 * ensureDeckCaptionTranslations rather than being swallowed like an ordinary
 * per-slide translation failure. */
function isAbortError(err: unknown): boolean {
  if (err instanceof Error) return err.name === 'AbortError' || /cancel|abort/i.test(err.message)
  return false
}

/**
 * Translates every slide's speakerNotes in `deck` into `lang`, sequentially,
 * reusing fresh cache entries and re-translating only slides whose
 * speakerNotes changed since they were last cached. Slides with empty
 * speakerNotes are skipped entirely (never counted in `total`). A slide
 * whose translation fails is silently dropped from the result (not
 * retried, not thrown) so one bad slide doesn't block the rest of the
 * deck's captions — except cancellation (AbortError), which propagates
 * immediately so the caller's job/loop can stop.
 *
 * Also prunes the deck's on-disk cache of entries for slide ids no longer
 * present in `deck.slides`, so a deck that's been edited down doesn't carry
 * stale translations forever.
 */
export async function ensureDeckCaptionTranslations(
  deck: Deck,
  lang: string,
  opts?: { signal?: AbortSignal; onProgress?: (done: number, total: number) => void },
): Promise<Map<string, string>> {
  const signal = opts?.signal
  const onProgress = opts?.onProgress
  const result = new Map<string, string>()

  const targets = deck.slides.filter((slide) => slide.speakerNotes.trim() !== '')
  const total = targets.length
  let done = 0

  for (const slide of targets) {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')

    const narration = slide.speakerNotes
    const cached = getCachedCaptionTranslation(deck.id, slide.id, lang, narration)
    if (cached !== null) {
      result.set(slide.id, cached)
    } else {
      try {
        const text = await translateCaption({ deckId: deck.id, slideId: slide.id, lang, narration, signal })
        result.set(slide.id, text)
      } catch (err) {
        if (isAbortError(err)) throw err
        // Swallow: one slide's translation failure shouldn't block the rest.
      }
    }

    done += 1
    onProgress?.(done, total)
  }

  // Prune cache entries for slides no longer in the deck.
  const liveIds = new Set(deck.slides.map((slide) => slide.id))
  const cache = loadDeckCache(deck.id)
  let pruned = false
  for (const slideId of Object.keys(cache)) {
    if (!liveIds.has(slideId)) {
      delete cache[slideId]
      pruned = true
    }
  }
  if (pruned) saveDeckCache(deck.id, cache)

  return result
}
