// Deck persistence, localStorage-backed for now (see PLAN.md: "大物のみ mist
// KV は後回し可"). Keeps a small index (`tc-presenter:decks`, an array of
// DeckSummary) alongside one full Deck per key (`tc-presenter:deck:<id>`),
// so listDecks() for the picker UI never has to load every deck's full slide
// bodies. All writes go through safeSetItem (lib/safeStorage.ts) so a full
// shared-origin quota degrades gracefully instead of throwing.
//
// Defensive-parse throughout (never throws): a corrupted index entry or deck
// record is dropped rather than surfaced as an app crash, matching every
// other vendored lib/*.ts module's convention in this codebase.

import { safeSetItem } from './safeStorage'
import type { Deck, DeckSummary } from '../types'

const INDEX_KEY = 'tc-presenter:decks'

function deckKey(id: string): string {
  return `tc-presenter:deck:${id}`
}

function isDeckSummary(value: unknown): value is DeckSummary {
  if (value === null || typeof value !== 'object') return false
  const record = value as Record<string, unknown>
  return (
    typeof record.id === 'string' &&
    typeof record.title === 'string' &&
    typeof record.lang === 'string' &&
    typeof record.slideCount === 'number' &&
    typeof record.updatedAt === 'string'
  )
}

function loadIndex(): DeckSummary[] {
  try {
    const raw = localStorage.getItem(INDEX_KEY)
    if (!raw) return []
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter(isDeckSummary)
  } catch {
    return []
  }
}

function saveIndex(index: DeckSummary[]): void {
  safeSetItem(INDEX_KEY, JSON.stringify(index))
}

function summarize(deck: Deck): DeckSummary {
  return {
    id: deck.id,
    title: deck.title,
    lang: deck.lang,
    slideCount: deck.slides.length,
    updatedAt: deck.updatedAt,
  }
}

/** Lightweight listing (no slide bodies) for pickers, sorted most-recently-updated first. */
export function listDecks(): DeckSummary[] {
  return [...loadIndex()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
}

/** Loads a full deck by id. Returns null if missing or malformed (never throws). */
export function loadDeck(id: string): Deck | null {
  try {
    const raw = localStorage.getItem(deckKey(id))
    if (!raw) return null
    // Deep structural validation of every Slide field is deliberately not
    // done here (the shape is large and this module has no evaluator-grade
    // sanitizer) — a corrupt individual deck record fails soft as null via
    // the catch below rather than crashing, but a *malformed-but-parseable*
    // JSON blob would pass through as-is. Callers that render untrusted decks
    // should treat this the same as any other same-origin localStorage read.
    return JSON.parse(raw) as Deck
  } catch {
    return null
  }
}

/** Persists `deck` (full record + index summary), stamping nothing itself —
 * callers are responsible for setting `updatedAt` before calling this. */
export function saveDeck(deck: Deck): void {
  safeSetItem(deckKey(deck.id), JSON.stringify(deck))

  const index = loadIndex()
  const next = index.filter((entry) => entry.id !== deck.id)
  next.push(summarize(deck))
  saveIndex(next)
}

/** Removes a deck's full record and its index entry. Never throws. */
export function deleteDeck(id: string): void {
  try {
    localStorage.removeItem(deckKey(id))
  } catch {
    // best-effort, matches safeSetItem's never-throw contract
  }
  saveIndex(loadIndex().filter((entry) => entry.id !== id))
}
