// Store for image assets referenced by ImageRefBlock.assetId (src/types.ts).
// Deck JSON lives in localStorage (lib/kv.ts) behind a ~5MB quota shared
// across every tc-* app on the origin — embedding image bytes (even as
// base64) directly on the block would blow that quota almost immediately.
// Instead the Deck only carries an opaque `assetId`; the actual `data:` URI
// is resolved at render time (components/slides/Blocks.tsx).
//
// Backend: mistlib's OPFS-backed CID store (storage_add_pinned/storage_get),
// per the tik-choco family's established shared-storage convention (see
// ../tc-docs/data-structures.md's "OPFS / mistlib CIDストア" layer and
// drafts/storage-audit-2026-07-13.md, whose #1 fix item was tc-books
// replacing a raw-dataUrl-in-localStorage field with exactly this CID-store
// pattern after it hit the shared quota). The CID returned by
// storage_add_pinned becomes the `assetId` — content-addressed, so the same
// image saved twice naturally dedupes to one CID, and any tc-* app on this
// origin can resolve it. The full `data:` URI (not raw image bytes) is what
// gets stored, UTF-8-encoded, so the CID payload is self-describing (mime +
// base64) without needing a second field on ImageRefBlock.
//
// Fallback: an IndexedDB store (this module's original implementation,
// pre-mistlib-migration) is kept for environments where mistlib can't
// initialize (wasm load failure, non-browser context, etc) and for reading
// back assets saved by that older code path. putImageAsset falls back to it
// on any mist failure; getImageAsset tries mist's storage_get first (an id
// that isn't a resolvable CID just rejects) and falls back to IndexedDB
// second — so IDs from either generation keep resolving.
//
// A small in-memory cache sits in front of both backends so the
// (synchronous) renderer can paint an already-loaded image without waiting
// on an async round-trip on every re-render; preloadImageAssets() is the way
// callers warm it in bulk (e.g. before offscreen PNG rasterization in
// lib/evaluator/visionRender.tsx, where a still-loading <img> would
// rasterize blank).
//
// Defensive throughout (never throws): matches every other lib/*.ts module's
// convention in this codebase (see lib/kv.ts's header) — a missing
// IndexedDB, an unavailable mistlib node, or a malformed record degrades to
// null/no-op rather than crashing the caller.

import { getNode, storage_get } from './mistNode'
import { storage_add, storage_add_pinned } from '../vendor/mistlib/wrappers/web/index.js'
import type { Deck } from '../types'

const DB_NAME = 'tc-presenter-images'
const DB_VERSION = 1
const STORE_NAME = 'images'

interface ImageAssetRecord {
  id: string
  dataUri: string
  createdAt: string
}

const memoryCache = new Map<string, string>()

function hasIndexedDb(): boolean {
  return typeof document !== 'undefined' && typeof indexedDB !== 'undefined'
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION)
    request.onupgradeneeded = () => {
      const db = request.result
      if (!db.objectStoreNames.contains(STORE_NAME)) db.createObjectStore(STORE_NAME, { keyPath: 'id' })
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

async function getRecord(id: string): Promise<ImageAssetRecord | undefined> {
  const db = await openDb()
  try {
    return await new Promise<ImageAssetRecord | undefined>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly')
      const request = tx.objectStore(STORE_NAME).get(id)
      request.onsuccess = () => resolve(request.result as ImageAssetRecord | undefined)
      request.onerror = () => reject(request.error)
    })
  } finally {
    db.close()
  }
}

async function putRecord(record: ImageAssetRecord): Promise<void> {
  const db = await openDb()
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite')
      tx.objectStore(STORE_NAME).put(record)
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error)
    })
  } finally {
    db.close()
  }
}

async function deleteRecord(id: string): Promise<void> {
  const db = await openDb()
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite')
      tx.objectStore(STORE_NAME).delete(id)
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error)
    })
  } finally {
    db.close()
  }
}

/** IndexedDB fallback for putImageAsset — same shape as the pre-mistlib
 * implementation. Returns null on any failure. */
async function putImageAssetFallback(dataUri: string): Promise<string | null> {
  if (!hasIndexedDb()) return null
  try {
    const id = crypto.randomUUID()
    await putRecord({ id, dataUri, createdAt: new Date().toISOString() })
    memoryCache.set(id, dataUri)
    return id
  } catch {
    return null
  }
}

/** IndexedDB fallback for getImageAsset. Returns null if missing or on any
 * failure. */
async function getImageAssetFallback(id: string): Promise<string | null> {
  if (!hasIndexedDb()) return null
  try {
    const record = await getRecord(id)
    if (!record) return null
    memoryCache.set(id, record.dataUri)
    return record.dataUri
  } catch {
    return null
  }
}

/** A short, human-readable `name` for storage_add(_pinned) — mistlib stores
 * this alongside the CID; it has no bearing on content-addressing. Derived
 * from the data URI's declared mime type when present. */
function nameForDataUri(dataUri: string): string {
  const match = /^data:image\/([a-zA-Z0-9+.-]+)/.exec(dataUri)
  return match ? `tc-presenter-image.${match[1]}` : 'tc-presenter-image'
}

/** Stores `dataUri` and returns its new asset id, or null on failure. Tries
 * mistlib's CID store first (see module header); falls back to IndexedDB
 * with a random id if mistlib can't be initialized or the write fails.
 * Also warms the in-memory cache so an immediately-following render can
 * paint it synchronously via getCachedImageAsset(). */
export async function putImageAsset(dataUri: string): Promise<string | null> {
  try {
    await getNode()
    const bytes = new TextEncoder().encode(dataUri)
    const name = nameForDataUri(dataUri)
    const add = typeof storage_add_pinned === 'function' ? storage_add_pinned : storage_add
    const cid = await add(name, bytes)
    memoryCache.set(cid, dataUri)
    return cid
  } catch {
    return putImageAssetFallback(dataUri)
  }
}

/** Loads an asset's data URI, checking the in-memory cache first, then
 * mistlib's CID store (see module header), then the IndexedDB fallback (for
 * ids saved by that path, or if `id` isn't a resolvable CID). Returns null
 * if missing everywhere or on any failure. */
export async function getImageAsset(id: string): Promise<string | null> {
  const cached = memoryCache.get(id)
  if (cached !== undefined) return cached

  try {
    await getNode()
    const bytes = await storage_get(id)
    const dataUri = new TextDecoder().decode(bytes)
    memoryCache.set(id, dataUri)
    return dataUri
  } catch {
    // Not a resolvable CID (or mistlib unavailable) — fall through.
  }

  return getImageAssetFallback(id)
}

/** Synchronous, memory-cache-only lookup — for renderers that need to know
 * whether an image is already available without awaiting. Returns null on a
 * cache miss even if the asset exists in the CID store or IndexedDB (call
 * getImageAsset or preloadImageAssets to populate the cache first). */
export function getCachedImageAsset(id: string): string | null {
  return memoryCache.get(id) ?? null
}

/** Warms the in-memory cache for every id in `ids` (already-cached ids are
 * skipped). Never throws; failures for individual ids are silently
 * dropped. */
export async function preloadImageAssets(ids: string[]): Promise<void> {
  const missing = [...new Set(ids)].filter((id) => !memoryCache.has(id))
  if (missing.length === 0) return
  await Promise.all(missing.map((id) => getImageAsset(id)))
}

/** Drops `id` from the in-memory cache and, if it was saved via the
 * IndexedDB fallback, from IndexedDB too. Does NOT delete from mistlib's CID
 * store: it's a shared, content-addressed store used by every tc-* app on
 * the origin, and orphaned-CID garbage collection isn't implemented anywhere
 * in the family yet (see tc-docs/drafts/storage-audit-2026-07-13.md) — an
 * unpin/delete here would be unilateral and could race a legitimate second
 * reference (e.g. the same image reused by another slide or deck). Never
 * throws. */
export async function deleteImageAsset(id: string): Promise<void> {
  memoryCache.delete(id)
  if (!hasIndexedDb()) return
  try {
    await deleteRecord(id)
  } catch {
    // best-effort, matches this module's never-throw contract
  }
}

/** Every imageRef assetId referenced anywhere in `deck`'s slides, deduped —
 * a helper for bulk-preloading before rendering/exporting a whole deck. */
export function collectImageAssetIds(deck: Deck): string[] {
  const ids = new Set<string>()
  for (const slide of deck.slides) {
    for (const block of slide.blocks ?? []) {
      if (block.kind === 'imageRef' && block.assetId) ids.add(block.assetId)
    }
  }
  return [...ids]
}
