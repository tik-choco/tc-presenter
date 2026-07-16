// Wave2 C owns this feature: deck/slide editor UI (reorder, edit bullets,
// pick a generated deck to revise, trigger features/generate for new decks).
//
// Contract (types.ts): default-export a Preact component accepting
// `EditorTabProps { deck, onDeckChange, sources }`. `deck` may be null
// (nothing generated/loaded yet); `sources` is read-only here (owned by the
// Sources tab). Persistence to lib/kv.ts (listDecks/saveDeck/deleteDeck) is
// this feature's responsibility, not app.tsx's.
//
// Cross-wave dependencies: `SlideView` (Wave2 B, components/slides) landed
// before this file did, so it's used directly rather than as a pending stub.
// Deck generation itself is queued through `lib/generateJobs.ts` rather than
// awaited here — the job runner owns calling features/generate + lib/evaluator
// and persisting the result (saveDeck/theme/score); this feature only
// enqueues a job and reacts to `subscribeGenerateJobs` once one completes.
// Progress display is a global toast owned by app.tsx, not this file.
//
// "Present" hook: EditorTabProps has no onPresent-style callback (types.ts is
// authoritative and out of this worker's file ownership), so there is no
// prop-based way to switch app.tsx's active tab from here. The Present
// button below persists the deck and dispatches a
// `window` CustomEvent('tc-presenter:navigate', { detail: { tab: 'present' } })
// as a decoupled, additive hook — the Wave3 integrator (who owns app.tsx)
// can wire a `window.addEventListener('tc-presenter:navigate', ...)` in
// app.tsx to call `setTab('present')`. Until that's wired, the button still
// saves the deck and shows a "switch to Present" hint so the flow degrades
// gracefully to one extra manual click.
import { useEffect, useState } from 'preact/hooks'
import type { JSX } from 'preact'
import { FileDown, FileText, Film } from 'lucide-preact'
import './editor.css'
import { t } from '../../i18n'
import { deleteDeck, listDecks, loadDeck, saveDeck } from '../../lib/kv'
import { loadLlmConfig, subscribeLlmConfig, type SharedLlmConfigV1 } from '../../lib/llmConfig'
import { enqueueGenerateJob, subscribeGenerateJobs, getGenerateJobs } from '../../lib/generateJobs'
import { enqueueExportJob } from '../../lib/exportJobs'
import SlideView from '../../components/slides/SlideView'
import { DECK_THEME_PRESETS } from './deckThemePresets'
import { loadVisionPresetId } from '../settings/localPrefs'
import {
  DEFAULT_MAX_REFINE_ITERATIONS,
  DEFAULT_QUALITY_THRESHOLD,
  type BulletForm,
  type Deck,
  type DeckScore,
  type DeckSummary,
  type DeckTheme,
  type EditorTabProps,
  type GenerateOptions,
  type GenerateProgressEvent,
  type Slide,
  type SlideBullet,
  type SlideLayout,
  type SlideType,
} from '../../types'

const SLIDE_TYPES: SlideType[] = [
  'title',
  'agenda',
  'content',
  'diagram',
  'quote',
  'summary',
  'data_table',
  'chart',
  'section_break',
]

const SLIDE_LAYOUTS: SlideLayout[] = [
  'single_column',
  'two_column_text_diagram',
  'diagram_centered',
  'full_bleed_image',
  'grid',
]

function newId(): string {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID()
  } catch {
    // fall through
  }
  return `slide-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleString()
  } catch {
    return iso
  }
}

// ---------------------------------------------------------------------------
// Slide quality score panel

function ScorePanel({ score }: { score: DeckScore }) {
  const sorted = [...score.metrics].sort((a, b) => a.score - b.score)
  return (
    <div class="edt-score">
      <div class="edt-score__total">
        {t('editor.score.total', { score: Math.round(score.total) })}
        <span class={`edt-score__gate ${score.gate ? 'edt-score__gate--fail' : 'edt-score__gate--pass'}`}>
          {score.gate ? t('editor.score.gateFailed') : t('editor.score.gatePassed')}
        </span>
      </div>
      <div class="edt-score__metrics">
        {sorted.map((metric) => (
          <div class="edt-score__metric" key={metric.id}>
            <span class="edt-score__metric-label" title={metric.label}>
              {metric.label}
            </span>
            <span class="edt-score__metric-bar">
              <span style={{ width: `${Math.round(metric.score * 100)}%` }} />
            </span>
            <span>{Math.round(metric.score * 100)}%</span>
            {metric.reason && <span class="edt-score__metric-reason">{metric.reason}</span>}
          </div>
        ))}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Slide body sub-editors

interface BulletsEditorProps {
  bullets: SlideBullet[]
  onChange: (next: SlideBullet[]) => void
}

function BulletsEditor({ bullets, onChange }: BulletsEditorProps) {
  function update(i: number, patch: Partial<SlideBullet>) {
    onChange(bullets.map((b, idx) => (idx === i ? { ...b, ...patch } : b)))
  }

  return (
    <div class="edt-field">
      <label>{t('editor.slide.bullets')}</label>
      {bullets.map((bullet, i) => (
        <div class="edt-bullet-row" key={i}>
          <input
            type="text"
            value={bullet.text}
            placeholder={t('editor.slide.bulletText')}
            onChange={(e) => update(i, { text: e.currentTarget.value })}
          />
          <input
            type="number"
            min={0}
            max={4}
            value={bullet.level}
            title={t('editor.slide.bulletLevel')}
            onChange={(e) => update(i, { level: Math.max(0, Number(e.currentTarget.value) || 0) })}
          />
          <select
            value={bullet.form ?? 'noun_phrase'}
            title={t('editor.slide.bulletForm')}
            onChange={(e) => update(i, { form: e.currentTarget.value as BulletForm })}
          >
            <option value="noun_phrase">{t('editor.slide.bulletForm.noun_phrase')}</option>
            <option value="verb_phrase">{t('editor.slide.bulletForm.verb_phrase')}</option>
          </select>
          <button
            type="button"
            class="edt-btn edt-btn--danger"
            onClick={() => onChange(bullets.filter((_, idx) => idx !== i))}
          >
            {t('editor.slide.removeBullet')}
          </button>
        </div>
      ))}
      <button type="button" class="edt-btn" onClick={() => onChange([...bullets, { text: '', level: 0 }])}>
        {t('editor.slide.addBullet')}
      </button>
    </div>
  )
}

function ParagraphsField({ paragraphs, onChange }: { paragraphs: string[]; onChange: (next: string[]) => void }) {
  return (
    <div class="edt-field">
      <label>{t('editor.slide.paragraphs')}</label>
      <textarea
        rows={3}
        value={paragraphs.join('\n')}
        onChange={(e) =>
          onChange(
            e.currentTarget.value
              .split('\n')
              .map((line) => line.trim())
              .filter(Boolean),
          )
        }
      />
    </div>
  )
}

// ---------------------------------------------------------------------------
// One slide's editor card (preview + fields)

interface SlideEditorCardProps {
  slide: Slide
  theme: DeckTheme
  pageTotal: number
  onChange: (patch: Partial<Slide>) => void
  onMoveUp: () => void
  onMoveDown: () => void
  onDelete: () => void
  canMoveUp: boolean
  canMoveDown: boolean
}

function SlideEditorCard({
  slide,
  theme,
  pageTotal,
  onChange,
  onMoveUp,
  onMoveDown,
  onDelete,
  canMoveUp,
  canMoveDown,
}: SlideEditorCardProps) {
  return (
    <div class="edt-slide">
      <div class="edt-slide__preview">
        <SlideView slide={slide} theme={theme} scale={0.24} pageTotal={pageTotal} />
      </div>

      <div class="edt-slide__fields">
        <div class="edt-slide__toolbar">
          <span class="edt-slide__index">#{slide.index}</span>
          <div class="edt-panel__actions">
            <button type="button" class="edt-btn" disabled={!canMoveUp} onClick={onMoveUp}>
              {t('editor.deck.moveUp')}
            </button>
            <button type="button" class="edt-btn" disabled={!canMoveDown} onClick={onMoveDown}>
              {t('editor.deck.moveDown')}
            </button>
            <button type="button" class="edt-btn edt-btn--danger" onClick={onDelete}>
              {t('editor.deck.deleteSlide')}
            </button>
          </div>
        </div>

        <div class="edt-field">
          <label>{t('editor.slide.title')}</label>
          <input
            type="text"
            value={slide.title.text}
            onChange={(e) => onChange({ title: { ...slide.title, text: e.currentTarget.value } })}
          />
        </div>

        <div class="edt-grid">
          <div class="edt-field">
            <label>{t('editor.slide.type')}</label>
            <select value={slide.type} onChange={(e) => onChange({ type: e.currentTarget.value as SlideType })}>
              {SLIDE_TYPES.map((ty) => (
                <option value={ty} key={ty}>
                  {ty}
                </option>
              ))}
            </select>
          </div>
          <div class="edt-field">
            <label>{t('editor.slide.layout')}</label>
            <select value={slide.layout} onChange={(e) => onChange({ layout: e.currentTarget.value as SlideLayout })}>
              {SLIDE_LAYOUTS.map((la) => (
                <option value={la} key={la}>
                  {la}
                </option>
              ))}
            </select>
          </div>
        </div>

        <BulletsEditor
          bullets={slide.body.bullets}
          onChange={(bullets) => onChange({ body: { ...slide.body, bullets } })}
        />
        <ParagraphsField
          paragraphs={slide.body.paragraphs}
          onChange={(paragraphs) => onChange({ body: { ...slide.body, paragraphs } })}
        />

        <div class="edt-field">
          <label>{t('editor.slide.speakerNotes')}</label>
          <textarea
            rows={3}
            value={slide.speakerNotes}
            onChange={(e) => onChange({ speakerNotes: e.currentTarget.value })}
          />
        </div>

        <div class="edt-grid">
          <div class="edt-field">
            <label>{t('editor.slide.citationText')}</label>
            <input
              type="text"
              value={slide.citation?.text ?? ''}
              onChange={(e) => {
                const text = e.currentTarget.value
                onChange({ citation: text.trim() ? { text, url: slide.citation?.url } : undefined })
              }}
            />
          </div>
          <div class="edt-field">
            <label>{t('editor.slide.citationUrl')}</label>
            <input
              type="text"
              value={slide.citation?.url ?? ''}
              disabled={!slide.citation?.text}
              onChange={(e) => {
                if (!slide.citation?.text) return
                const url = e.currentTarget.value.trim()
                onChange({ citation: { text: slide.citation.text, ...(url ? { url } : {}) } })
              }}
            />
          </div>
        </div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------

export default function EditorTab({ deck, onDeckChange, sources }: EditorTabProps) {
  const [decks, setDecks] = useState<DeckSummary[]>(() => listDecks())
  const [mode, setMode] = useState<'library' | 'edit'>(deck ? 'edit' : 'library')
  const [creating, setCreating] = useState(false)

  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [language, setLanguage] = useState('en')
  const [slideCountMode, setSlideCountMode] = useState<'auto' | 'cap'>('auto')
  const [maxSlides, setMaxSlides] = useState('12')
  const [themeId, setThemeId] = useState(DECK_THEME_PRESETS[0].id)
  const [audience, setAudience] = useState('')
  const [tone, setTone] = useState('')
  const [advancedOpen, setAdvancedOpen] = useState(false)
  const [useLlmJudge, setUseLlmJudge] = useState(true)
  // Vision judging needs a vision-capable preset configured once in Settings
  // (features/settings's "Vision judge" section) — when one is set, default
  // this on so generation "just works" without extra per-run configuration,
  // matching the task brief's "configuring the LLM alone is enough" goal.
  const [useVisionJudge, setUseVisionJudge] = useState(() => Boolean(loadVisionPresetId()))
  const [threshold, setThreshold] = useState(String(DEFAULT_QUALITY_THRESHOLD))
  const [maxRefine, setMaxRefine] = useState(String(DEFAULT_MAX_REFINE_ITERATIONS))
  const [presetId, setPresetId] = useState('')
  const [useNetwork, setUseNetwork] = useState(false)
  const [compactPrompt, setCompactPrompt] = useState(false)
  const [batchRefine, setBatchRefine] = useState(false)
  // Orchestrator/worker split (types.ts GenerateOptions.workerPresetId doc):
  // '' = same preset as the main one; concurrency stays '1' (sequential)
  // unless the user raises it — local LLM servers are single-request anyway.
  const [workerPresetId, setWorkerPresetId] = useState('')
  const [workerConcurrency, setWorkerConcurrency] = useState('1')

  const [llmConfig, setLlmConfig] = useState<SharedLlmConfigV1 | null>(() => loadLlmConfig())
  useEffect(() => subscribeLlmConfig(setLlmConfig), [])

  const [genError, setGenError] = useState<string | null>(null)
  const [queuedNotice, setQueuedNotice] = useState(false)
  const [score, setScore] = useState<DeckScore | null>(null)
  const [presentHint, setPresentHint] = useState(false)

  // Live view of the deck being generated right now: the running job's
  // latest partial-deck snapshot (skeleton placeholders included), streamed
  // via GenerateProgressEvent.partialDeck. Purely ephemeral — rendered
  // read-only below and never written to the kv.ts library (only the job
  // runner's final saveDeck promotes a FINISHED deck there). Not every
  // progress event carries a partialDeck (start-of-segment ticks don't), so
  // the last snapshot is kept until the SAME job emits a newer one — keyed
  // by job id so one job's stale snapshot never lingers into the next job.
  const [liveProgress, setLiveProgress] = useState<{ jobId: number; evt: GenerateProgressEvent } | null>(null)
  useEffect(
    () =>
      subscribeGenerateJobs(() => {
        setLiveProgress((prev) => {
          const running = getGenerateJobs().find((j) => j.status === 'running')
          if (!running) return null
          if (running.progress?.partialDeck) return { jobId: running.id, evt: running.progress }
          return prev && prev.jobId === running.id ? prev : null
        })
      }),
    [],
  )
  const liveEvent = liveProgress?.evt ?? null

  useEffect(() => {
    if (!queuedNotice) return
    const timer = setTimeout(() => setQueuedNotice(false), 4000)
    return () => clearTimeout(timer)
  }, [queuedNotice])

  // Deck list + score panel both need to react to job completion without the
  // editor itself awaiting generation — the job runner (lib/generateJobs.ts)
  // does the actual work and mutates its own job list; this just listens.
  useEffect(() => {
    const seenComplete = new Set<number>()
    const unsubscribe = subscribeGenerateJobs(() => {
      let decksChanged = false
      for (const job of getGenerateJobs()) {
        if (job.status !== 'complete' || !job.deckId || seenComplete.has(job.id)) continue
        seenComplete.add(job.id)
        decksChanged = true
        if (deck && job.deckId === deck.id && job.score) setScore(job.score)
      }
      if (decksChanged) refreshDecks()
    })
    return unsubscribe
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deck])

  function refreshDecks() {
    setDecks(listDecks())
  }

  function commitDeck(next: Deck): Deck {
    const stamped: Deck = { ...next, updatedAt: new Date().toISOString() }
    saveDeck(stamped)
    refreshDecks()
    onDeckChange(stamped)
    return stamped
  }

  function toggleSource(id: string) {
    setSelectedIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  function handleGenerate(event: JSX.TargetedEvent<HTMLFormElement>) {
    event.preventDefault()
    const selected = sources.filter((s) => selectedIds.has(s.id))
    if (selected.length === 0) {
      setGenError(t('editor.create.error.noSources'))
      return
    }

    setGenError(null)

    const maxSlidesNum = slideCountMode === 'cap' && maxSlides.trim() ? Number(maxSlides.trim()) : undefined
    const thresholdNum = Number(threshold.trim())
    const maxRefineNum = Number(maxRefine.trim())
    const visionPresetId = loadVisionPresetId()

    const opts: GenerateOptions = {
      language,
      useLlmJudge,
      qualityThreshold: Number.isFinite(thresholdNum) ? thresholdNum : DEFAULT_QUALITY_THRESHOLD,
      maxRefineIterations: Number.isFinite(maxRefineNum) ? maxRefineNum : DEFAULT_MAX_REFINE_ITERATIONS,
    }
    if (maxSlidesNum !== undefined && Number.isFinite(maxSlidesNum) && maxSlidesNum > 0) opts.maxSlides = maxSlidesNum
    if (audience.trim()) opts.audience = audience.trim()
    if (tone.trim()) opts.tone = tone.trim()
    if (presetId) opts.presetId = presetId
    if (useNetwork) opts.connection = 'network'
    if (useVisionJudge) {
      opts.useVisionJudge = true
      if (visionPresetId) opts.visionPresetId = visionPresetId
    }
    if (compactPrompt) opts.promptProfile = 'compact'
    if (batchRefine) opts.refineStrategy = 'batch'
    if (workerPresetId) opts.workerPresetId = workerPresetId
    const workerConcurrencyNum = Number(workerConcurrency.trim())
    if (Number.isFinite(workerConcurrencyNum) && workerConcurrencyNum > 1) {
      opts.workerConcurrency = Math.trunc(workerConcurrencyNum)
    }

    const preset = DECK_THEME_PRESETS.find((p) => p.id === themeId)
    const theme = preset && preset.id !== 'default' ? preset.theme : undefined
    const label = selected[0]?.title || 'deck'

    enqueueGenerateJob({ label, sources: selected, opts, theme })
    setCreating(false)
    setQueuedNotice(true)
  }

  function handleOpenDeck(id: string) {
    const loaded = loadDeck(id)
    if (loaded) {
      onDeckChange(loaded)
      setMode('edit')
      setScore(null)
    }
  }

  function handleDeleteDeck(id: string) {
    deleteDeck(id)
    refreshDecks()
  }

  function updateSlide(id: string, patch: Partial<Slide>) {
    if (!deck) return
    commitDeck({ ...deck, slides: deck.slides.map((s) => (s.id === id ? { ...s, ...patch } : s)) })
  }

  function moveSlide(id: string, direction: -1 | 1) {
    if (!deck) return
    const idx = deck.slides.findIndex((s) => s.id === id)
    const swapIdx = idx + direction
    if (idx < 0 || swapIdx < 0 || swapIdx >= deck.slides.length) return
    const slides = [...deck.slides]
    const tmp = slides[idx]
    slides[idx] = slides[swapIdx]
    slides[swapIdx] = tmp
    commitDeck({ ...deck, slides: slides.map((s, i) => ({ ...s, index: i + 1 })) })
  }

  function addSlide() {
    if (!deck) return
    const slide: Slide = {
      id: newId(),
      index: deck.slides.length + 1,
      type: 'content',
      layout: 'single_column',
      title: { text: '' },
      body: { bullets: [], paragraphs: [] },
      visual: { kind: 'none', elements: [] },
      speakerNotes: '',
      buildStage: { isBuildSlide: false, groupId: null, stageIndex: null },
    }
    commitDeck({ ...deck, slides: [...deck.slides, slide] })
  }

  function deleteSlide(id: string) {
    if (!deck) return
    const slides = deck.slides.filter((s) => s.id !== id).map((s, i) => ({ ...s, index: i + 1 }))
    commitDeck({ ...deck, slides })
  }

  function handlePresent() {
    if (!deck) return
    commitDeck(deck)
    setPresentHint(true)
    try {
      window.dispatchEvent(new CustomEvent('tc-presenter:navigate', { detail: { tab: 'present', autoStart: true } }))
    } catch {
      // CustomEvent should always be available in a browser context; if not,
      // the deck is still saved and the user can switch tabs manually.
    }
  }

  function handleExportPdf() {
    if (!deck) return
    enqueueExportJob('pdf', deck)
  }

  function handleExportPptx() {
    if (!deck) return
    enqueueExportJob('pptx', deck)
  }

  function handleExportVideo() {
    if (!deck) return
    enqueueExportJob('video', deck)
  }

  return (
    <div class="edt-tab">
      <div class="edt-panel">
        <div class="edt-panel__header">
          <span class="edt-panel__title">{t('editor.decks.title')}</span>
          <div class="edt-panel__actions">
            {deck && mode === 'edit' && (
              <button type="button" class="edt-btn" onClick={() => setMode('library')}>
                {t('editor.decks.title')}
              </button>
            )}
            <button
              type="button"
              class="edt-btn edt-btn--primary"
              onClick={() => {
                setCreating((v) => !v)
                setMode('library')
              }}
            >
              {t('editor.decks.newButton')}
            </button>
          </div>
        </div>

        {decks.length === 0 ? (
          <div class="edt-empty">{t('editor.decks.empty')}</div>
        ) : (
          <div class="edt-deck-list">
            {decks.map((d) => (
              <div class="edt-deck-item" key={d.id}>
                <div class="edt-deck-item__main">
                  <div class="edt-deck-item__title">{d.title}</div>
                  <div class="edt-deck-item__meta">
                    {t('editor.decks.slidesCount', { count: d.slideCount })} ·{' '}
                    {t('editor.decks.updatedAt', { date: formatDate(d.updatedAt) })}
                  </div>
                </div>
                <button type="button" class="edt-btn" onClick={() => handleOpenDeck(d.id)}>
                  {t('editor.decks.load')}
                </button>
                <button type="button" class="edt-btn edt-btn--danger" onClick={() => handleDeleteDeck(d.id)}>
                  {t('editor.decks.delete')}
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      {liveEvent?.partialDeck && (
        <div class="edt-panel">
          <div class="edt-panel__header">
            <span class="edt-panel__title">{t('editor.live.title')}</span>
            {liveEvent.segmentsTotal !== undefined && (
              <span class="edt-live-count">
                {liveEvent.segmentsDone ?? 0}/{liveEvent.segmentsTotal}
              </span>
            )}
          </div>
          <div class="edt-live-list">
            {liveEvent.partialDeck.slides.map((s) => {
              const pending = liveEvent.pendingSlideIds?.includes(s.id) ?? false
              return (
                <div key={s.id} class={`edt-live-slide${pending ? ' edt-live-slide--pending' : ''}`}>
                  <span class="edt-live-slide__num">{s.index}</span>
                  <span class="edt-live-slide__title">{s.title.text || '…'}</span>
                  <span class="edt-live-slide__type">{s.type}</span>
                  {pending && <span class="edt-live-slide__badge">{t('editor.live.pending')}</span>}
                </div>
              )
            })}
          </div>
        </div>
      )}

      {creating && (
        <form class="edt-panel" onSubmit={handleGenerate}>
          <div class="edt-panel__header">
            <span class="edt-panel__title">{t('editor.create.title')}</span>
          </div>

          <div class="edt-field">
            <label>{t('editor.create.selectSources', { selected: selectedIds.size, total: sources.length })}</label>
            {sources.length === 0 ? (
              <div class="edt-empty">{t('editor.create.noSources')}</div>
            ) : (
              <div class="edt-source-list">
                {sources.map((s) => (
                  <label class="edt-source-item" key={s.id}>
                    <input type="checkbox" checked={selectedIds.has(s.id)} onChange={() => toggleSource(s.id)} />
                    <span>{s.title}</span>
                  </label>
                ))}
              </div>
            )}
          </div>

          <div class="edt-grid">
            <div class="edt-field">
              <label>{t('editor.create.language')}</label>
              <select value={language} onChange={(e) => setLanguage(e.currentTarget.value)}>
                <option value="en">English</option>
                <option value="ja">日本語</option>
                <option value="zh">中文</option>
                <option value="es">Español</option>
                <option value="fr">Français</option>
              </select>
            </div>
            <div class="edt-field">
              <label>{t('editor.create.slideCount')}</label>
              <select value={slideCountMode} onChange={(e) => setSlideCountMode(e.currentTarget.value as 'auto' | 'cap')}>
                <option value="auto">{t('editor.create.slideCount.auto')}</option>
                <option value="cap">{t('editor.create.slideCount.cap')}</option>
              </select>
              {slideCountMode === 'cap' && (
                <input
                  type="number"
                  min={1}
                  max={60}
                  value={maxSlides}
                  onChange={(e) => setMaxSlides(e.currentTarget.value)}
                />
              )}
            </div>
            <div class="edt-field">
              <label>{t('editor.create.theme')}</label>
              <select value={themeId} onChange={(e) => setThemeId(e.currentTarget.value)}>
                {DECK_THEME_PRESETS.map((p) => (
                  <option value={p.id} key={p.id}>
                    {p.label}
                  </option>
                ))}
              </select>
            </div>
            {llmConfig && llmConfig.presets.length > 0 && (
              <div class="edt-field">
                <label>{t('editor.create.preset')}</label>
                <select value={presetId} onChange={(e) => setPresetId(e.currentTarget.value)}>
                  <option value="">{t('editor.create.presetDefault')}</option>
                  {llmConfig.presets.map((p) => (
                    <option value={p.id} key={p.id}>
                      {p.label}
                    </option>
                  ))}
                </select>
              </div>
            )}
          </div>

          <button type="button" class="edt-advanced-toggle" onClick={() => setAdvancedOpen((v) => !v)}>
            {t('editor.create.advanced')} {advancedOpen ? '▲' : '▼'}
          </button>

          {advancedOpen && (
            <div class="edt-grid">
              <div class="edt-field">
                <label>{t('editor.create.audience')}</label>
                <input type="text" value={audience} onChange={(e) => setAudience(e.currentTarget.value)} />
              </div>
              <div class="edt-field">
                <label>{t('editor.create.tone')}</label>
                <input type="text" value={tone} onChange={(e) => setTone(e.currentTarget.value)} />
              </div>
              <div class="edt-field">
                <label>{t('editor.create.threshold')}</label>
                <input
                  type="number"
                  min={0}
                  max={100}
                  value={threshold}
                  onChange={(e) => setThreshold(e.currentTarget.value)}
                />
              </div>
              <div class="edt-field">
                <label>{t('editor.create.maxRefine')}</label>
                <input
                  type="number"
                  min={0}
                  max={10}
                  value={maxRefine}
                  onChange={(e) => setMaxRefine(e.currentTarget.value)}
                />
              </div>
              <label class="edt-field" style={{ flexDirection: 'row', alignItems: 'center', gap: '8px' }}>
                <input type="checkbox" checked={useLlmJudge} onChange={(e) => setUseLlmJudge(e.currentTarget.checked)} />
                <span>{t('editor.create.useLlmJudge')}</span>
              </label>
              <label class="edt-field" style={{ flexDirection: 'row', alignItems: 'center', gap: '8px' }}>
                <input
                  type="checkbox"
                  checked={useVisionJudge}
                  onChange={(e) => setUseVisionJudge(e.currentTarget.checked)}
                />
                <span>{t('editor.create.useVisionJudge')}</span>
              </label>
              <label class="edt-field" style={{ flexDirection: 'row', alignItems: 'center', gap: '8px' }}>
                <input type="checkbox" checked={useNetwork} onChange={(e) => setUseNetwork(e.currentTarget.checked)} />
                <span>{t('editor.create.useNetwork')}</span>
              </label>
              <label class="edt-field" style={{ flexDirection: 'row', alignItems: 'center', gap: '8px' }}>
                <input
                  type="checkbox"
                  checked={compactPrompt}
                  onChange={(e) => setCompactPrompt(e.currentTarget.checked)}
                />
                <span>{t('editor.create.promptProfileCompact')}</span>
              </label>
              <label class="edt-field" style={{ flexDirection: 'row', alignItems: 'center', gap: '8px' }}>
                <input type="checkbox" checked={batchRefine} onChange={(e) => setBatchRefine(e.currentTarget.checked)} />
                <span>{t('editor.create.refineBatch')}</span>
              </label>
              {llmConfig && llmConfig.presets.length > 0 && (
                <div class="edt-field">
                  <label>{t('editor.create.workerPreset')}</label>
                  <select value={workerPresetId} onChange={(e) => setWorkerPresetId(e.currentTarget.value)}>
                    <option value="">{t('editor.create.workerPresetDefault')}</option>
                    {llmConfig.presets.map((p) => (
                      <option value={p.id} key={p.id}>
                        {p.label}
                      </option>
                    ))}
                  </select>
                </div>
              )}
              <div class="edt-field">
                <label>{t('editor.create.workerConcurrency')}</label>
                <input
                  type="number"
                  min={1}
                  max={8}
                  value={workerConcurrency}
                  onChange={(e) => setWorkerConcurrency(e.currentTarget.value)}
                />
              </div>
            </div>
          )}

          <div class="edt-panel__actions">
            <button type="submit" class="edt-btn edt-btn--primary" disabled={selectedIds.size === 0}>
              {t('editor.create.submit')}
            </button>
            <button type="button" class="edt-btn" onClick={() => setCreating(false)}>
              {t('editor.create.cancel')}
            </button>
          </div>

          {genError && <div class="edt-error">{genError}</div>}
        </form>
      )}

      {queuedNotice && <div class="edt-present-hint">{t('editor.create.queued')}</div>}

      {/* Rendered outside the `creating` form: generation now runs as a
          background job (lib/generateJobs.ts), so `score` is populated
          asynchronously — possibly well after `creating` is already false —
          by the subscribeGenerateJobs effect above when a job completes for
          the currently-open deck. Gating ScorePanel on `creating` would hide
          it by the time the score actually arrives. */}
      {score && <ScorePanel score={score} />}

      {mode === 'edit' && deck && (
        <div class="edt-panel">
          <div class="edt-deck-meta">
            <div class="edt-field">
              <label>{t('editor.deck.titleLabel')}</label>
              <input
                type="text"
                value={deck.title}
                onChange={(e) => commitDeck({ ...deck, title: e.currentTarget.value })}
              />
            </div>
            <div class="edt-field">
              <label>{t('editor.deck.langLabel')}</label>
              <input
                type="text"
                value={deck.lang}
                onChange={(e) => commitDeck({ ...deck, lang: e.currentTarget.value })}
              />
            </div>
          </div>

          <div class="edt-panel__header">
            <span class="edt-panel__title">{t('editor.deck.slideCount', { count: deck.slides.length })}</span>
            <div class="edt-panel__actions">
              <button type="button" class="edt-btn" onClick={addSlide}>
                {t('editor.deck.addSlide')}
              </button>
              <button type="button" class="edt-btn" onClick={handleExportPdf}>
                <FileText size={16} aria-hidden="true" />
                {t('editor.export.pdf')}
              </button>
              <button type="button" class="edt-btn" onClick={handleExportPptx}>
                <FileDown size={16} aria-hidden="true" />
                {t('editor.export.pptx')}
              </button>
              <button type="button" class="edt-btn" onClick={handleExportVideo}>
                <Film size={16} aria-hidden="true" />
                {t('editor.export.video')}
              </button>
              <button type="button" class="edt-btn edt-btn--primary" onClick={handlePresent}>
                {t('editor.deck.present')}
              </button>
            </div>
          </div>
          {presentHint && <div class="edt-present-hint">{t('editor.deck.presentHint')}</div>}

          <div class="edt-slide-list">
            {deck.slides.map((slide, i) => (
              <SlideEditorCard
                key={slide.id}
                slide={slide}
                theme={deck.theme}
                pageTotal={deck.slides.length}
                onChange={(patch) => updateSlide(slide.id, patch)}
                onMoveUp={() => moveSlide(slide.id, -1)}
                onMoveDown={() => moveSlide(slide.id, 1)}
                onDelete={() => deleteSlide(slide.id)}
                canMoveUp={i > 0}
                canMoveDown={i < deck.slides.length - 1}
              />
            ))}
          </div>
        </div>
      )}

      {mode === 'edit' && !deck && <div class="edt-empty">{t('editor.deck.noDeck')}</div>}
    </div>
  )
}
