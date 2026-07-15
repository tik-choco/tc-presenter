// Reader/decoder for tc-note's `note-doc-index` sharedBus topic — the
// "publish, don't peek" list of every note tc-note currently has saved
// (id/title/cid/updatedAt, no body). tc-note republishes the full
// (capped-at-500) index wholesale on every save/delete/restore (~1s
// debounce), so a fresh `readShared`/`subscribeShared` callback always
// reflects the current note set. See tc-note/src/lib/noteDocExport.ts (the
// writer), tc-storage/src/app/appNoteDocInbox.ts (the reference reader this
// module's parsing mirrors), and
// protocol/docs/data-contracts/docs/SHARED_BUS.md (registered as
// `note-doc-index`).
//
// This module only knows how to parse the index and resolve one note's
// markdown body by CID via mistlib storage_get (lib/mistNode.ts's shared
// node) — it holds no UI/ingestion policy; that lives in features/sources
// (noteDocAdapter.ts + index.tsx).

import { getNode, storage_get } from './mistNode'

export const NOTE_DOC_INDEX_TOPIC = 'note-doc-index'

/** Mirrors tc-note's noteDocExport.ts MAX_NOTE_DOC_INDEX_ITEMS. */
const MAX_NOTE_DOC_INDEX_ITEMS = 500

/** One entry in tc-note's published index (mirrors tc-note's NoteDocIndexEntry). */
export interface NoteDocIndexEntry {
  id: string
  title: string
  /** mistlib storage_add CID of the note's markdown bytes (plaintext). */
  cid: string
  /** Epoch milliseconds — tc-note's NoteMeta.updatedAt, NOT an ISO string. */
  updatedAt: number
}

/**
 * Defensively parses `meta.notes` out of a `note-doc-index` SharedRecord,
 * dropping anything that doesn't match the published shape and capping at
 * the same 500-entry limit the writer enforces. Never throws — a malformed
 * or future-shaped record just yields fewer (or zero) entries.
 */
export function parseNoteDocEntries(meta: Record<string, unknown>): NoteDocIndexEntry[] {
  const rawNotes = (meta as { notes?: unknown }).notes
  if (!Array.isArray(rawNotes)) return []
  const entries: NoteDocIndexEntry[] = []
  for (const raw of rawNotes) {
    if (entries.length >= MAX_NOTE_DOC_INDEX_ITEMS) break
    if (raw === null || typeof raw !== 'object') continue
    const note = raw as Record<string, unknown>
    if (typeof note.id !== 'string' || !note.id) continue
    if (typeof note.title !== 'string') continue
    if (typeof note.cid !== 'string' || !note.cid) continue
    if (typeof note.updatedAt !== 'number' || !Number.isFinite(note.updatedAt)) continue
    entries.push({ id: note.id, title: note.title, cid: note.cid, updatedAt: note.updatedAt })
  }
  return entries
}

/**
 * Resolves a note's plaintext markdown body by CID via the app's single
 * shared mistlib node (lib/mistNode.ts). Rejects (never resolves to a
 * placeholder) on any failure — mistlib not loadable, the CID not
 * resolvable, etc. — so callers can decide how to surface that: a
 * background sync path can warn-and-skip, a user-triggered selection should
 * show it in the UI (never let it become an uncaught rejection).
 */
export async function resolveNoteDocBody(cid: string): Promise<string> {
  await getNode()
  const bytes = await storage_get(cid)
  return new TextDecoder().decode(bytes)
}
