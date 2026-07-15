// Wave2 C owns this feature: sources ingestion (manual entry, subscribing to
// the sharedBus `note-article` topic — see lib/sharedBus.ts and
// notes-tc-news.md §3(b) — and subscribing to tc-note's `note-doc-index`
// topic — see lib/noteDocIndex.ts and notes-tc-note.md) into
// `SourceMaterial[]`.
//
// Contract (types.ts): default-export a Preact component accepting
// `SourcesTabProps { sources, onSourcesChange }`. app.tsx owns the actual
// state array and lazy-imports this module; this component reads/writes it
// only through the two props, so app.tsx never has to know how sources are
// produced internally. Since app.tsx doesn't persist that array itself, this
// component is also responsible for bootstrapping it from sourceStore.ts on
// first mount and keeping sourceStore.ts in sync on every change.
import { useCallback, useEffect, useRef, useState } from 'preact/hooks'
import type { JSX } from 'preact'
import './sources.css'
import { t } from '../../i18n'
import { readShared, subscribeShared, type SharedRecord } from '../../lib/sharedBus'
import { NOTE_DOC_INDEX_TOPIC, parseNoteDocEntries, resolveNoteDocBody, type NoteDocIndexEntry } from '../../lib/noteDocIndex'
import type { SourceMaterial, SourceMaterialOrigin, SourcesTabProps } from '../../types'
import { loadSources, saveSources } from './sourceStore'
import { sourceMaterialFromNoteArticle } from './newsArticleAdapter'
import { sourceMaterialFromNoteDocEntry } from './noteDocAdapter'
import {
  loadGlobalArticlesOptIn,
  saveGlobalArticlesOptIn,
  startGlobalArticlesSubscription,
  type GlobalArticlesConnectionState,
} from './globalArticlesOptIn'

const NOTE_ARTICLE_TOPIC = 'note-article'

function newId(): string {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID()
  } catch {
    // fall through
  }
  return `src-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleString()
  } catch {
    return iso
  }
}

type ManualMode = 'text' | 'url' | 'markdown'

interface SourceCardProps {
  source: SourceMaterial
  onDelete: (id: string) => void
}

function SourceCard({ source, onDelete }: SourceCardProps) {
  const [expanded, setExpanded] = useState(false)
  const originKey = `sources.origin.${source.origin}` as const

  return (
    <div class="src-card">
      <div class="src-card__top">
        <span class={`src-badge src-badge--${source.origin}`}>{t(originKey)}</span>
        <span class="src-card__title">{source.title}</span>
      </div>
      <div class="src-card__meta">{t('sources.list.addedAt', { date: formatDate(source.addedAt) })}</div>
      {source.excerpt && <p class="src-card__excerpt">{source.excerpt}</p>}
      {expanded && <div class="src-card__body">{source.body}</div>}
      {source.sourceLinks && source.sourceLinks.length > 0 && (
        <div class="src-card__links">
          <strong>{t('sources.list.links')}:</strong>
          {source.sourceLinks.map((link) => (
            <a key={link.url} href={link.url} target="_blank" rel="noreferrer">
              {link.title}
            </a>
          ))}
        </div>
      )}
      <div class="src-card__actions">
        <button type="button" class="src-btn" onClick={() => setExpanded((v) => !v)}>
          {expanded ? t('sources.list.collapse') : t('sources.list.viewFull')}
        </button>
        <button type="button" class="src-btn src-btn--danger" onClick={() => onDelete(source.id)}>
          {t('sources.list.delete')}
        </button>
      </div>
    </div>
  )
}

interface ManualAddFormProps {
  onAdd: (source: SourceMaterial) => void
}

function ManualAddForm({ onAdd }: ManualAddFormProps) {
  const [mode, setMode] = useState<ManualMode>('text')
  const [title, setTitle] = useState('')
  const [url, setUrl] = useState('')
  const [body, setBody] = useState('')
  const [error, setError] = useState<string | null>(null)

  const bodyPlaceholder =
    mode === 'url'
      ? t('sources.addManual.bodyPlaceholderUrl')
      : mode === 'markdown'
        ? t('sources.addManual.bodyPlaceholderMarkdown')
        : t('sources.addManual.bodyPlaceholderText')

  function handleSubmit(event: JSX.TargetedEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!title.trim()) {
      setError(t('sources.addManual.error.missingTitle'))
      return
    }
    if (!body.trim()) {
      setError(t('sources.addManual.error.missingBody'))
      return
    }
    if (mode === 'url' && !url.trim()) {
      setError(t('sources.addManual.error.missingUrl'))
      return
    }

    const origin: SourceMaterialOrigin = mode === 'url' ? 'url' : 'manual'
    const material: SourceMaterial = {
      id: newId(),
      title: title.trim(),
      body: body.trim(),
      origin,
      addedAt: new Date().toISOString(),
    }
    if (mode === 'url' && url.trim()) material.sourceUrl = url.trim()

    onAdd(material)
    setTitle('')
    setUrl('')
    setBody('')
    setError(null)
  }

  return (
    <form class="src-panel" onSubmit={handleSubmit}>
      <div class="src-panel__header">
        <span class="src-panel__title">{t('sources.addManual.title')}</span>
      </div>

      <div class="src-mode-tabs" role="tablist">
        {(['text', 'url', 'markdown'] as ManualMode[]).map((m) => (
          <button
            key={m}
            type="button"
            role="tab"
            aria-selected={mode === m}
            class={`src-mode-tabs__item${mode === m ? ' is-active' : ''}`}
            onClick={() => setMode(m)}
          >
            {t(`sources.addManual.mode.${m}`)}
          </button>
        ))}
      </div>

      <div class="src-field">
        <label for="src-add-title">{t('sources.addManual.titleLabel')}</label>
        <input
          id="src-add-title"
          type="text"
          value={title}
          placeholder={t('sources.addManual.titlePlaceholder')}
          onInput={(e) => setTitle(e.currentTarget.value)}
        />
      </div>

      {mode === 'url' && (
        <div class="src-field">
          <label for="src-add-url">{t('sources.addManual.urlLabel')}</label>
          <input
            id="src-add-url"
            type="url"
            value={url}
            placeholder={t('sources.addManual.urlPlaceholder')}
            onInput={(e) => setUrl(e.currentTarget.value)}
          />
        </div>
      )}

      <div class="src-field">
        <label for="src-add-body">{t('sources.addManual.bodyLabel')}</label>
        <textarea
          id="src-add-body"
          rows={6}
          value={body}
          placeholder={bodyPlaceholder}
          onInput={(e) => setBody(e.currentTarget.value)}
        />
      </div>

      {error && <div class="src-field-error">{error}</div>}

      <button type="submit" class="src-btn src-btn--primary">
        {t('sources.addManual.submit')}
      </button>
    </form>
  )
}

interface GlobalArticlesOptInProps {
  onIngest: (material: SourceMaterial) => void
}

function GlobalArticlesOptIn({ onIngest }: GlobalArticlesOptInProps) {
  const [enabled, setEnabled] = useState(loadGlobalArticlesOptIn)
  const [connection, setConnection] = useState<GlobalArticlesConnectionState | null>(null)
  const [receivedCount, setReceivedCount] = useState(0)
  const onIngestRef = useRef(onIngest)
  useEffect(() => {
    onIngestRef.current = onIngest
  }, [onIngest])

  // Subscribes to the tc-global-articles P2P room only while opted in;
  // leaves the room (via the returned unsubscribe) the moment the toggle
  // flips off or the tab unmounts. Resets the session-local received count
  // on every fresh (re-)subscription rather than persisting it — this is a
  // "how much came in since you enabled this" indicator, not a durable stat.
  useEffect(() => {
    if (!enabled) {
      setConnection(null)
      setReceivedCount(0)
      return
    }
    setReceivedCount(0)
    const unsubscribe = startGlobalArticlesSubscription(
      (material) => {
        onIngestRef.current(material)
        setReceivedCount((n) => n + 1)
      },
      (state) => setConnection(state),
    )
    return unsubscribe
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled])

  function toggle() {
    const next = !enabled
    setEnabled(next)
    saveGlobalArticlesOptIn(next)
  }

  return (
    <div class="src-panel">
      <div class="src-panel__header">
        <span class="src-panel__title">{t('sources.globalFeed.title')}</span>
      </div>
      <p class="src-panel__hint">{t('sources.globalFeed.description')}</p>
      <label class="src-toggle-row">
        <input type="checkbox" checked={enabled} onChange={toggle} />
        <span>{t('sources.globalFeed.toggle')}</span>
      </label>
      {enabled && (
        <>
          <p class="src-note">{t('sources.globalFeed.experimentalNote')}</p>
          {connection?.phase === 'connecting' && <p class="src-note src-note--connecting">{t('sources.globalFeed.status.connecting')}</p>}
          {connection?.phase === 'connected' && (
            <p class="src-note src-note--connected">{t('sources.globalFeed.status.connected', { count: receivedCount })}</p>
          )}
          {connection?.phase === 'error' && (
            <p class="src-note src-note--error">{t('sources.globalFeed.status.error', { message: connection.message ?? '' })}</p>
          )}
        </>
      )}
    </div>
  )
}

type NoteDocStatus = 'idle' | 'loading' | 'error'

interface NoteDocPickerProps {
  entries: NoteDocIndexEntry[]
  sources: SourceMaterial[]
  onIngest: (material: SourceMaterial) => void
}

/** Lets the user browse tc-note's live `note-doc-index` listing (see
 * lib/noteDocIndex.ts) and pull any note straight into Sources. Selecting a
 * note resolves its markdown body on demand via mistlib storage_get — the
 * index itself never carries bodies — and per-note loading/error state keeps
 * one slow/failed CID resolution from blocking the rest of the list. */
function NoteDocPicker({ entries, sources, onIngest }: NoteDocPickerProps) {
  const [filter, setFilter] = useState('')
  const [status, setStatus] = useState<Record<string, NoteDocStatus>>({})
  const [errors, setErrors] = useState<Record<string, string>>({})

  // Notes already pulled in, keyed by content CID (see noteDocAdapter.ts's
  // `tc-note-cid-${cid}` id scheme) so a re-edited note (new cid) still
  // shows as addable rather than permanently "already added".
  const addedCids = new Set(
    sources
      .filter((s) => s.origin === 'tc-note' && s.id.startsWith('tc-note-cid-'))
      .map((s) => s.id.slice('tc-note-cid-'.length)),
  )

  const trimmedFilter = filter.trim().toLowerCase()
  const filtered = trimmedFilter ? entries.filter((e) => e.title.toLowerCase().includes(trimmedFilter)) : entries

  async function handleSelect(entry: NoteDocIndexEntry) {
    setStatus((s) => ({ ...s, [entry.id]: 'loading' }))
    setErrors((prev) => {
      if (!(entry.id in prev)) return prev
      const next = { ...prev }
      delete next[entry.id]
      return next
    })
    try {
      const body = await resolveNoteDocBody(entry.cid)
      const material = sourceMaterialFromNoteDocEntry(entry, body, t('sources.tcNote.untitled'))
      onIngest(material)
      setStatus((s) => ({ ...s, [entry.id]: 'idle' }))
    } catch (error) {
      setStatus((s) => ({ ...s, [entry.id]: 'error' }))
      const message = error instanceof Error ? error.message : String(error)
      setErrors((prev) => ({ ...prev, [entry.id]: message }))
    }
  }

  return (
    <div class="src-panel">
      <div class="src-panel__header">
        <span class="src-panel__title">{t('sources.tcNote.title')}</span>
        <span class="src-count">{t('sources.count', { count: entries.length })}</span>
      </div>
      <p class="src-panel__hint">{t('sources.tcNote.hint')}</p>
      {entries.length === 0 ? (
        <div class="src-empty">{t('sources.tcNote.empty')}</div>
      ) : (
        <>
          <div class="src-field">
            <input
              type="text"
              value={filter}
              placeholder={t('sources.tcNote.filterPlaceholder')}
              onInput={(e) => setFilter(e.currentTarget.value)}
            />
          </div>
          <div class="src-notedoc-list">
            {filtered.map((entry) => {
              const entryStatus = status[entry.id] ?? 'idle'
              const alreadyAdded = addedCids.has(entry.cid)
              return (
                <div key={entry.id} class="src-notedoc-item">
                  <div class="src-notedoc-item__info">
                    <span class="src-notedoc-item__title">{entry.title.trim() || t('sources.tcNote.untitled')}</span>
                    <span class="src-notedoc-item__meta">
                      {t('sources.list.addedAt', { date: formatDate(new Date(entry.updatedAt).toISOString()) })}
                    </span>
                  </div>
                  <button
                    type="button"
                    class="src-btn"
                    disabled={entryStatus === 'loading'}
                    onClick={() => handleSelect(entry)}
                  >
                    {entryStatus === 'loading'
                      ? t('common.loading')
                      : alreadyAdded
                        ? t('sources.tcNote.addAgain')
                        : t('sources.tcNote.add')}
                  </button>
                  {entryStatus === 'error' && (
                    <div class="src-field-error">{t('sources.tcNote.error', { message: errors[entry.id] ?? '' })}</div>
                  )}
                </div>
              )
            })}
          </div>
        </>
      )}
    </div>
  )
}

export default function SourcesTab({ sources, onSourcesChange }: SourcesTabProps) {
  const sourcesRef = useRef(sources)
  const onChangeRef = useRef(onSourcesChange)
  useEffect(() => {
    sourcesRef.current = sources
  }, [sources])
  useEffect(() => {
    onChangeRef.current = onSourcesChange
  }, [onSourcesChange])

  // Bootstrap from localStorage once: app.tsx's in-memory `sources` state has
  // no persistence of its own, so this is the only place that loads it.
  useEffect(() => {
    if (sourcesRef.current.length === 0) {
      const persisted = loadSources()
      if (persisted.length > 0) {
        sourcesRef.current = persisted
        onChangeRef.current(persisted)
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Shared de-dupe-and-prepend used by every ingestion channel (sharedBus
  // note-article below, and the tc-global-articles P2P feed via
  // GlobalArticlesOptIn's onIngest prop). Reads/writes only through the
  // refs above so it never needs to be in an effect's dependency array.
  const ingestMaterial = useCallback((material: SourceMaterial) => {
    const current = sourcesRef.current
    if (current.some((s) => s.id === material.id)) return
    const next = [material, ...current]
    sourcesRef.current = next
    saveSources(next)
    onChangeRef.current(next)
  }, [])

  // Subscribe to the `note-article` sharedBus channel (published by both
  // tc-news's chatShare.ts and tc-note's shareArticle.ts — see
  // newsArticleAdapter.ts's header comment). Registered once (refs avoid
  // needing to resubscribe on every `sources` change); an initial
  // readShared() call also covers the case where a publisher fired before
  // this tab ever mounted. Body resolution can involve an async CID fetch
  // (tc-note's path), so failures are caught and warned rather than left as
  // an uncaught rejection — this is a passive background subscription, not
  // a user-triggered action, so there's no per-item UI to surface it in;
  // the next bus event (or note-doc-index picker below) gives the user
  // another chance.
  useEffect(() => {
    function ingest(record: SharedRecord) {
      sourceMaterialFromNoteArticle(record)
        .then((material) => {
          if (material) ingestMaterial(material)
        })
        .catch((error) => {
          console.warn('tc-presenter: failed to resolve note-article body', error)
        })
    }

    const initial = readShared(NOTE_ARTICLE_TOPIC)
    if (initial) ingest(initial)
    return subscribeShared(NOTE_ARTICLE_TOPIC, ingest)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Subscribe to tc-note's `note-doc-index` sharedBus channel: a live
  // listing (id/title/cid/updatedAt, no bodies) that NoteDocPicker below
  // renders as a pick list. Mirrors the note-article effect's
  // readShared-then-subscribeShared bootstrap shape.
  const [noteDocEntries, setNoteDocEntries] = useState<NoteDocIndexEntry[]>([])
  useEffect(() => {
    function applyRecord(record: SharedRecord) {
      setNoteDocEntries(parseNoteDocEntries(record.meta))
    }

    const initial = readShared(NOTE_DOC_INDEX_TOPIC)
    if (initial) applyRecord(initial)
    return subscribeShared(NOTE_DOC_INDEX_TOPIC, applyRecord)
  }, [])

  function handleAdd(material: SourceMaterial) {
    const next = [material, ...sources]
    saveSources(next)
    onSourcesChange(next)
  }

  function handleDelete(id: string) {
    const next = sources.filter((s) => s.id !== id)
    saveSources(next)
    onSourcesChange(next)
  }

  return (
    <div class="src-tab">
      <div class="src-panel">
        <div class="src-panel__header">
          <span class="src-panel__title">{t('tabs.sources')}</span>
          <span class="src-count">{t('sources.count', { count: sources.length })}</span>
        </div>
        <p class="src-panel__hint">{t('sources.tcNews.hint')}</p>
        {sources.length === 0 ? (
          <div class="src-empty">{t('sources.empty')}</div>
        ) : (
          <div class="src-list">
            {sources.map((source) => (
              <SourceCard key={source.id} source={source} onDelete={handleDelete} />
            ))}
          </div>
        )}
      </div>

      <NoteDocPicker entries={noteDocEntries} sources={sources} onIngest={ingestMaterial} />
      <ManualAddForm onAdd={handleAdd} />
      <GlobalArticlesOptIn onIngest={ingestMaterial} />
    </div>
  )
}
