// Converts a tc-note `note-doc-index` entry (lib/noteDocIndex.ts) plus its
// resolved markdown body into a SourceMaterial. Body resolution (storage_get
// by CID) is async and can fail, so it's kept out of this pure conversion —
// see the NoteDocPicker component in index.tsx for the resolve-then-convert
// flow and its error handling.
//
// Id convention mirrors newsArticleAdapter.ts's `tc-news-cid-${cid}`
// scheme: keying on the content CID (rather than the note's stable id)
// means re-selecting an unedited note is a harmless dedupe no-op in
// ingestMaterial, while a later edit (new cid) is ingested as a fresh
// SourceMaterial instead of silently overwriting the earlier snapshot.

import type { NoteDocIndexEntry } from '../../lib/noteDocIndex'
import type { SourceMaterial } from '../../types'

export function sourceMaterialFromNoteDocEntry(entry: NoteDocIndexEntry, body: string, untitledLabel: string): SourceMaterial {
  const trimmedBody = body.trim()
  const title = entry.title.trim() || untitledLabel
  return {
    id: `tc-note-cid-${entry.cid}`,
    title,
    body: trimmedBody,
    origin: 'tc-note',
    // "Added to tc-presenter" time, not the note's own updatedAt — the note
    // may have been written long ago; what matters here is when the user
    // pulled it into this deck's source list.
    addedAt: new Date().toISOString(),
  }
}
