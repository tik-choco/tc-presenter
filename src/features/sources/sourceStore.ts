// Local persistence for SourceMaterial[], owned by features/sources. Mirrors
// lib/kv.ts's convention (safeSetItem-backed, defensive parse, never throws)
// but lives here rather than in lib/kv.ts because kv.ts only models Deck
// persistence today (see PLAN.md) and lib/** is out of this worker's owned
// area — this module is the sources-side equivalent, not a duplicate.
//
// app.tsx owns the in-memory `sources` array (passed down as SourcesTabProps)
// but never itself loads/saves it, so this module's `loadSources()` is called
// once on SourcesTab mount to bootstrap app.tsx's state, and `saveSources()`
// is called on every mutation so a reload doesn't lose ingested/manual
// sources.

import { safeSetItem } from '../../lib/safeStorage'
import type { SourceMaterial } from '../../types'

const STORAGE_KEY = 'tc-presenter:sources'

/** Keeps the persisted list from growing unbounded as tc-news articles stream in. */
const MAX_SOURCES = 300

function isSourceMaterialLink(value: unknown): value is { title: string; url: string } {
  if (value === null || typeof value !== 'object') return false
  const record = value as Record<string, unknown>
  return typeof record.title === 'string' && typeof record.url === 'string'
}

function isSourceMaterial(value: unknown): value is SourceMaterial {
  if (value === null || typeof value !== 'object') return false
  const record = value as Record<string, unknown>
  const originOk =
    record.origin === 'manual' ||
    record.origin === 'tc-news' ||
    record.origin === 'tc-note' ||
    record.origin === 'file' ||
    record.origin === 'url'
  return (
    typeof record.id === 'string' &&
    typeof record.title === 'string' &&
    typeof record.body === 'string' &&
    originOk &&
    typeof record.addedAt === 'string' &&
    (record.excerpt === undefined || typeof record.excerpt === 'string') &&
    (record.sourceUrl === undefined || typeof record.sourceUrl === 'string') &&
    (record.tags === undefined || (Array.isArray(record.tags) && record.tags.every((t) => typeof t === 'string'))) &&
    (record.sourceLinks === undefined ||
      (Array.isArray(record.sourceLinks) && record.sourceLinks.every(isSourceMaterialLink)))
  )
}

/** Loads the persisted source list. Returns `[]` if missing/malformed (never throws). */
export function loadSources(): SourceMaterial[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return []
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter(isSourceMaterial)
  } catch {
    return []
  }
}

/** Persists `sources`, most-recently-added first, capped to MAX_SOURCES. */
export function saveSources(sources: SourceMaterial[]): void {
  const sorted = [...sources].sort((a, b) => b.addedAt.localeCompare(a.addedAt)).slice(0, MAX_SOURCES)
  safeSetItem(STORAGE_KEY, JSON.stringify(sorted))
}
