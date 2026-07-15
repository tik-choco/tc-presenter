// Quota-safe localStorage writes. tik-choco.github.io serves every tc-* app
// from the same origin, so all of them share a single (~5MB) localStorage
// quota — decks and their slide bodies can grow large, and once the quota is
// full even a tiny unguarded setItem throws an uncaught QuotaExceededError.
// All tc-presenter setItem calls should go through safeSetItem so a full
// quota degrades to evicting our own re-derivable/least-important caches
// instead of crashing the caller. Modeled on tc-news's src/lib/safeStorage.ts.
//
// Vendored shared-contract modules (sharedBus/appManifest/llmConfig) are
// deliberately NOT migrated to reference this file directly for their own
// internal writes beyond what the canonical copy already does — llmConfig.ts
// imports safeSetItem from here (see its header comment), matching every
// other family app's vendored copy.

/** tc-presenter keys that are pure re-derivable caches, cheapest-to-lose
 * first. Evicted one at a time (with a retry between each) when a write hits
 * the quota. Only tc-presenter's own keys — other apps' data on the shared
 * origin is never touched. */
const EVICTABLE_KEYS: string[] = [
  // Deck index/details are user data, not caches, so nothing goes here yet.
  // Add re-derivable caches (e.g. evaluation results) here as they appear.
]

/** Per-item cache key prefixes, evicted after the exact keys above. */
const EVICTABLE_PREFIXES = ['tc-presenter:score-cache:']

/** Quota errors are reported inconsistently across browsers — match by name
 * and the two legacy codes rather than instanceof alone. */
function isQuotaError(err: unknown): boolean {
  if (!(err instanceof DOMException)) return false
  return (
    err.name === 'QuotaExceededError' ||
    err.name === 'NS_ERROR_DOM_QUOTA_REACHED' ||
    err.code === 22 ||
    err.code === 1014
  )
}

function keysWithPrefix(prefix: string): string[] {
  const keys: string[] = []
  for (let i = 0; i < localStorage.length; i += 1) {
    const key = localStorage.key(i)
    if (key && key.startsWith(prefix)) keys.push(key)
  }
  return keys
}

/** setItem that survives a full quota: on QuotaExceededError it evicts
 * tc-presenter cache keys one at a time (retrying after each) and, if the
 * quota is still exhausted, drops the write with a console.warn instead of
 * throwing. Returns false when the write was dropped. Non-quota errors
 * (e.g. localStorage disabled entirely) also return false — persistence
 * here is always best-effort. */
export function safeSetItem(key: string, value: string): boolean {
  const attempt = (): boolean | 'quota' => {
    try {
      localStorage.setItem(key, value)
      return true
    } catch (err) {
      return isQuotaError(err) ? 'quota' : false
    }
  }

  let result = attempt()
  if (result !== 'quota') return result

  let evictable: string[]
  try {
    evictable = [...EVICTABLE_KEYS, ...EVICTABLE_PREFIXES.flatMap(keysWithPrefix)]
  } catch {
    return false
  }
  // Note: `key` itself is not filtered out — when a cache re-saves itself,
  // removing its own (old) persisted value is exactly what frees the space.
  for (const evictKey of evictable) {
    try {
      if (localStorage.getItem(evictKey) === null) continue
      localStorage.removeItem(evictKey)
    } catch {
      return false
    }
    result = attempt()
    if (result !== 'quota') return result
  }

  console.warn(
    `tc-presenter: localStorage quota exceeded even after evicting caches — dropped write to "${key}" (${value.length} chars). ` +
      'The origin-wide quota is shared with every tc-* app.',
  )
  return false
}
