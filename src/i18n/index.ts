// Minimal i18n: two flat catalogs (en/ja), en is both the default locale and
// the fallback for any key missing from ja. UI default is English (PLAN.md:
// "UI既定は en、世界向け") — this is the *interface* language, independent of
// `Deck.lang` (the *content* language a deck is generated in, see types.ts).

import en, { type TranslationKey } from './en'
import ja from './ja'

export type Locale = 'en' | 'ja'
export type { TranslationKey }

const STORAGE_KEY = 'tc-presenter-locale'
const CATALOGS: Record<Locale, Partial<Record<TranslationKey, string>>> = { en, ja }

function isLocale(value: string | null): value is Locale {
  return value === 'en' || value === 'ja'
}

function getStoredLocale(): Locale {
  try {
    const stored = localStorage.getItem(STORAGE_KEY)
    if (isLocale(stored)) return stored
  } catch {
    // localStorage unavailable (private mode etc.) — fall through to default
  }
  return 'en'
}

let currentLocale: Locale = getStoredLocale()
const listeners = new Set<(locale: Locale) => void>()

export function getLocale(): Locale {
  return currentLocale
}

export function setLocale(locale: Locale): void {
  currentLocale = locale
  try {
    localStorage.setItem(STORAGE_KEY, locale)
  } catch {
    // best-effort persistence only
  }
  for (const listener of listeners) listener(locale)
}

/** Subscribes to locale changes (e.g. so components can re-render on toggle). Returns an unsubscribe function. */
export function subscribeLocale(listener: (locale: Locale) => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** Simple `{name}`-style interpolation — no plurals/ICU, matching PLAN.md's "シンプルな t() 実装". */
function interpolate(template: string, vars?: Record<string, string | number>): string {
  if (!vars) return template
  return template.replace(/\{(\w+)\}/g, (match, key: string) => {
    const value = vars[key]
    return value === undefined ? match : String(value)
  })
}

/** Looks up `key` in the current locale, falling back to English, then to
 * the raw key itself (so a missing translation is visible/debuggable rather
 * than blank). */
export function t(key: TranslationKey, vars?: Record<string, string | number>): string {
  const template = CATALOGS[currentLocale][key] ?? en[key] ?? key
  return interpolate(template, vars)
}
