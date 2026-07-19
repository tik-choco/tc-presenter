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
import { useEffect, useRef, useState } from 'preact/hooks'
import type { JSX } from 'preact'
import { FileDown, FileText, Film, ImagePlus, Trash2 } from 'lucide-preact'
import './editor.css'
import { t } from '../../i18n'
import { deleteDeck, listDecks, loadDeck, saveDeck } from '../../lib/kv'
import { loadLlmConfig, subscribeLlmConfig, type SharedLlmConfigV1 } from '../../lib/llmConfig'
import { enqueueGenerateJob, subscribeGenerateJobs, getGenerateJobs } from '../../lib/generateJobs'
import { enqueueExportJob } from '../../lib/exportJobs'
import { deleteImageAsset, getCachedImageAsset, getImageAsset, putImageAsset } from '../../lib/imageStore'
import { describeImage } from '../../lib/imageDescribe'
import SlideView from '../../components/slides/SlideView'
import { DECK_THEME_PRESETS } from './deckThemePresets'
import { loadGenerateRolePrefs, loadVisionPresetId } from '../settings/localPrefs'
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
  type ImageRefBlock,
  type PositionedBlock,
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
// Image blocks: upload UI + editing for Slide.blocks' imageRef entries. See
// types.ts's ImageRefBlock — assetId points into lib/imageStore.ts
// (IndexedDB), description is vision-LLM-generated (lib/imageDescribe.ts).

const MAX_IMAGE_DIMENSION = 1600
const IMAGE_JPEG_QUALITY = 0.85

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result as string)
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(file)
  })
}

function loadImageElement(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error('image decode failed'))
    img.src = src
  })
}

/** Downscales `file` to at most MAX_IMAGE_DIMENSION on its long edge and
 * re-encodes it (PNG source stays PNG for transparency, everything else
 * becomes JPEG) — keeps the IndexedDB-backed asset small. Returns null on any
 * failure (unsupported file, decode error, no canvas 2d context, etc). */
async function resizeImageForUpload(file: File): Promise<string | null> {
  try {
    const original = await readFileAsDataUrl(file)
    const img = await loadImageElement(original)
    const scale = Math.min(1, MAX_IMAGE_DIMENSION / Math.max(img.naturalWidth, img.naturalHeight))
    const width = Math.max(1, Math.round(img.naturalWidth * scale))
    const height = Math.max(1, Math.round(img.naturalHeight * scale))

    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const ctx = canvas.getContext('2d')
    if (!ctx) return null
    ctx.drawImage(img, 0, 0, width, height)

    const isPng = file.type === 'image/png'
    return canvas.toDataURL(isPng ? 'image/png' : 'image/jpeg', isPng ? undefined : IMAGE_JPEG_QUALITY)
  } catch {
    return null
  }
}

/** A slide with `blocks` empty renders exclusively from `body`/`visual` (see
 * types.ts's Slide.blocks doc) — adding the first image block would silently
 * switch that slide to block-rendering and drop its existing bullets/visual.
 * Carries them over as equivalent blocks so the switch is lossless. */
function migrateBodyToBlocks(slide: Slide): PositionedBlock[] {
  const blocks: PositionedBlock[] = []
  for (const paragraph of slide.body.paragraphs) blocks.push({ kind: 'paragraph', text: paragraph })
  if (slide.body.bullets.length > 0) blocks.push({ kind: 'bulletList', bullets: slide.body.bullets })
  if (slide.visual.kind !== 'none') blocks.push({ kind: 'visual', visual: slide.visual })
  return blocks
}

interface ImageBlockEditorProps {
  block: ImageRefBlock
  describing: boolean
  onChange: (patch: Partial<ImageRefBlock>) => void
  onDelete: () => void
}

function ImageBlockEditor({ block, describing, onChange, onDelete }: ImageBlockEditorProps) {
  const [dataUri, setDataUri] = useState<string | null>(block.assetId ? getCachedImageAsset(block.assetId) : null)

  useEffect(() => {
    const assetId = block.assetId
    if (!assetId) {
      setDataUri(null)
      return
    }
    const cached = getCachedImageAsset(assetId)
    if (cached) {
      setDataUri(cached)
      return
    }
    let cancelled = false
    getImageAsset(assetId).then((uri) => {
      if (!cancelled) setDataUri(uri)
    })
    return () => {
      cancelled = true
    }
  }, [block.assetId])

  return (
    <div class="edt-image-block">
      {dataUri && <img src={dataUri} alt={block.caption} class="edt-image-block__preview" />}
      <div class="edt-image-block__fields">
        <div class="edt-field">
          <label>{t('editor.slide.imageCaption')}</label>
          <input type="text" value={block.caption} onChange={(e) => onChange({ caption: e.currentTarget.value })} />
        </div>
        <div class="edt-field">
          <label>
            {t('editor.slide.imageDescription')}
            {describing && <span class="edt-image-block__spinner" aria-hidden="true" />}
          </label>
          <textarea
            rows={2}
            value={block.description ?? ''}
            placeholder={describing ? t('editor.slide.imageDescribing') : ''}
            onChange={(e) => onChange({ description: e.currentTarget.value })}
          />
        </div>
        <div class="edt-field">
          <label>{t('editor.slide.imageFit')}</label>
          <select value={block.fit ?? 'contain'} onChange={(e) => onChange({ fit: e.currentTarget.value as 'contain' | 'cover' })}>
            <option value="contain">{t('editor.slide.imageFit.contain')}</option>
            <option value="cover">{t('editor.slide.imageFit.cover')}</option>
          </select>
        </div>
        <button type="button" class="edt-btn edt-btn--danger" onClick={onDelete}>
          <Trash2 size={14} aria-hidden="true" />
          {t('editor.slide.imageRemove')}
        </button>
      </div>
    </div>
  )
}

interface ImageBlocksFieldProps {
  slide: Slide
  deckLang: string
  onChange: (patch: Partial<Slide>) => void
  onDescribed: (assetId: string, description: string) => void
}

function ImageBlocksField({ slide, deckLang, onChange, onDescribed }: ImageBlocksFieldProps) {
  const [uploading, setUploading] = useState(false)
  const [describingIds, setDescribingIds] = useState<Set<string>>(new Set())
  const fileInputRef = useRef<HTMLInputElement>(null)

  const blocks = slide.blocks ?? []

  async function handleFiles(files: FileList | null) {
    const file = files?.[0]
    if (!file) return
    setUploading(true)
    try {
      const resized = await resizeImageForUpload(file)
      if (!resized) return
      const assetId = await putImageAsset(resized)
      if (!assetId) return

      const newBlock: PositionedBlock = {
        kind: 'imageRef',
        caption: file.name.replace(/\.[^.]+$/, ''),
        assetId,
        fit: 'contain',
      }
      const base = blocks.length > 0 ? blocks : migrateBodyToBlocks(slide)
      onChange({ blocks: [...base, newBlock] })

      setDescribingIds((prev) => new Set(prev).add(assetId))
      const visionPresetId = loadVisionPresetId()
      describeImage(resized, { lang: deckLang, presetId: visionPresetId || undefined })
        .then((description) => {
          if (description) onDescribed(assetId, description)
        })
        .finally(() => {
          setDescribingIds((prev) => {
            const next = new Set(prev)
            next.delete(assetId)
            return next
          })
        })
    } finally {
      setUploading(false)
    }
  }

  function handleBlockChange(index: number, patch: Partial<ImageRefBlock>) {
    onChange({ blocks: blocks.map((b, i) => (i === index && b.kind === 'imageRef' ? { ...b, ...patch } : b)) })
  }

  function handleBlockDelete(index: number) {
    const target = blocks[index]
    if (target?.kind === 'imageRef' && target.assetId) void deleteImageAsset(target.assetId)
    onChange({ blocks: blocks.filter((_, i) => i !== index) })
  }

  return (
    <div class="edt-field">
      <label>{t('editor.slide.images')}</label>
      {blocks.map((block, i) =>
        block.kind === 'imageRef' ? (
          <ImageBlockEditor
            key={block.assetId ?? i}
            block={block}
            describing={block.assetId ? describingIds.has(block.assetId) : false}
            onChange={(patch) => handleBlockChange(i, patch)}
            onDelete={() => handleBlockDelete(i)}
          />
        ) : null,
      )}
      <div
        class="edt-image-dropzone"
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => {
          e.preventDefault()
          void handleFiles(e.dataTransfer?.files ?? null)
        }}
      >
        <input
          type="file"
          accept="image/*"
          ref={fileInputRef}
          style={{ display: 'none' }}
          onChange={(e) => {
            void handleFiles(e.currentTarget.files)
            e.currentTarget.value = ''
          }}
        />
        <button type="button" class="edt-btn" disabled={uploading} onClick={() => fileInputRef.current?.click()}>
          <ImagePlus size={14} aria-hidden="true" />
          {uploading ? t('editor.slide.imageUploading') : t('editor.slide.addImage')}
        </button>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Responsive fit-scale for the detail pane preview: watches the container's
// width via ResizeObserver and derives a SlideView `scale` so the fixed
// 1280px-wide canvas always fits, capped at 0.55 so it never blows up past a
// "readable but still a preview" size on very wide panes.

function useFitScale(baseWidth: number) {
  const ref = useRef<HTMLDivElement>(null)
  const [scale, setScale] = useState(0.35)

  useEffect(() => {
    const el = ref.current
    if (!el) return
    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width
      if (!width) return
      setScale(Math.min(0.55, width / baseWidth))
    })
    observer.observe(el)
    return () => observer.disconnect()
  }, [baseWidth])

  return { ref, scale }
}

// ---------------------------------------------------------------------------
// Detail pane: the selected slide's large preview + edit form (right side of
// the master/detail edt-workspace layout — thumbnails live in the rail).

interface SlideDetailCardProps {
  slide: Slide
  theme: DeckTheme
  pageTotal: number
  deckLang: string
  onChange: (patch: Partial<Slide>) => void
  onImageDescribed: (assetId: string, description: string) => void
  onMoveUp: () => void
  onMoveDown: () => void
  onDelete: () => void
  canMoveUp: boolean
  canMoveDown: boolean
}

function SlideDetailCard({
  slide,
  theme,
  pageTotal,
  deckLang,
  onChange,
  onImageDescribed,
  onMoveUp,
  onMoveDown,
  onDelete,
  canMoveUp,
  canMoveDown,
}: SlideDetailCardProps) {
  const { ref: previewRef, scale } = useFitScale(1280)

  return (
    <div class="edt-detail-card">
      <div class="edt-detail-card__toolbar">
        <span class="edt-detail-card__index">#{slide.index}</span>
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

      <div class="edt-detail-card__preview" ref={previewRef}>
        <SlideView slide={slide} theme={theme} scale={scale} pageTotal={pageTotal} />
      </div>

      <div class="edt-detail-card__fields">
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

        <ImageBlocksField slide={slide} deckLang={deckLang} onChange={onChange} onDescribed={onImageDescribed} />

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
  // Rule-based narration-script check (features/generate/scriptCheck.ts) run
  // right after the script is written, before any slide generates from it —
  // on by default like useLlmJudge above; unchecking sets
  // GenerateOptions.scriptCheck: false to skip the check (and its possible
  // one-shot LLM repair call) entirely.
  const [scriptCheck, setScriptCheck] = useState(true)
  // Vision judging needs a vision-capable preset configured once in Settings
  // (features/settings's "Vision judge" section) — when one is set, default
  // this on so generation "just works" without extra per-run configuration,
  // matching the task brief's "configuring the LLM alone is enough" goal.
  const [useVisionJudge, setUseVisionJudge] = useState(() => Boolean(loadVisionPresetId()))
  const [threshold, setThreshold] = useState(String(DEFAULT_QUALITY_THRESHOLD))
  const [maxRefine, setMaxRefine] = useState(String(DEFAULT_MAX_REFINE_ITERATIONS))
  // Orchestrator/worker role defaults set once in Settings (localPrefs.ts's
  // GenerateRolePrefs): the pickers below start from them so a run needs no
  // per-run model configuration — matching the vision judge's "configure it
  // once and generation just works" precedent (useVisionJudge above). Each
  // picker remains a per-run override; changing it here never writes back to
  // the saved prefs (Settings stays the single place that edits defaults).
  const [roleDefaults] = useState(loadGenerateRolePrefs)
  const [presetId, setPresetId] = useState(roleDefaults.orchestratorPresetId)
  const [useNetwork, setUseNetwork] = useState(false)
  const [compactPrompt, setCompactPrompt] = useState(false)
  const [batchRefine, setBatchRefine] = useState(false)
  // Orchestrator/worker split (types.ts GenerateOptions.workerPresetId doc):
  // '' = same preset as the main one; concurrency stays at 1 (sequential)
  // unless raised — local LLM servers are single-request anyway.
  const [workerPresetId, setWorkerPresetId] = useState(roleDefaults.workerPresetId)
  const [workerConcurrency, setWorkerConcurrency] = useState(String(roleDefaults.workerConcurrency))

  const [llmConfig, setLlmConfig] = useState<SharedLlmConfigV1 | null>(() => loadLlmConfig())
  useEffect(() => subscribeLlmConfig(setLlmConfig), [])

  const [genError, setGenError] = useState<string | null>(null)
  const [queuedNotice, setQueuedNotice] = useState(false)
  const [score, setScore] = useState<DeckScore | null>(null)
  const [presentHint, setPresentHint] = useState(false)

  // Master/detail edit-mode selection. Derived (not effect-synced) so a
  // deleted slide or a whole deck switch falls back to the first slide for
  // free, without an extra useEffect to keep it in bounds.
  const [selectedSlideId, setSelectedSlideId] = useState<string | null>(null)
  const selectedSlide = deck?.slides.find((s) => s.id === selectedSlideId) ?? deck?.slides[0] ?? null
  const railRef = useRef<HTMLDivElement>(null)

  // Mirrors `deck` for the image-description fire-and-forget callback below:
  // that promise resolves well after the render that started it, possibly
  // after other edits landed, so it must read the latest deck rather than
  // whatever was captured in its own closure.
  const deckRef = useRef<Deck | null>(deck)
  useEffect(() => {
    deckRef.current = deck
  }, [deck])

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

  // Keep the selected thumbnail visible in the rail whenever selection
  // changes (click, keyboard nav, add/delete fallback) — not on every
  // render, so scrolling the rail manually doesn't get fought.
  useEffect(() => {
    if (!selectedSlide) return
    const el = railRef.current?.querySelector<HTMLElement>(`[data-slide-id="${selectedSlide.id}"]`)
    el?.scrollIntoView({ block: 'nearest' })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedSlide?.id])

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
    // Only set when off — true is generateDeck.ts's own default (opts.
    // scriptCheck === false is the sole check it makes), so an unchanged
    // (checked) toggle leaves opts.scriptCheck unset like the other
    // default-true knobs above.
    if (!scriptCheck) opts.scriptCheck = false
    // Always set explicitly from the saved prefs (no per-run UI for this):
    // the GenerateOptions-level default stays 'script_first' (safe for
    // non-UI callers), while the prefs default is 'plan_fanout' — so an
    // unset field would silently flip modes.
    opts.pipelineMode = roleDefaults.pipelineMode
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

  function setImageBlockDescription(slideId: string, assetId: string, description: string) {
    const current = deckRef.current
    if (!current) return
    commitDeck({
      ...current,
      slides: current.slides.map((s) =>
        s.id !== slideId
          ? s
          : {
              ...s,
              blocks: (s.blocks ?? []).map((b) => (b.kind === 'imageRef' && b.assetId === assetId ? { ...b, description } : b)),
            },
      ),
    })
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
    setSelectedSlideId(slide.id)
  }

  function deleteSlide(id: string) {
    if (!deck) return
    if (selectedSlide?.id === id) {
      const idx = deck.slides.findIndex((s) => s.id === id)
      const neighbor = deck.slides[idx + 1] ?? deck.slides[idx - 1] ?? null
      setSelectedSlideId(neighbor?.id ?? null)
    }
    const slides = deck.slides.filter((s) => s.id !== id).map((s, i) => ({ ...s, index: i + 1 }))
    commitDeck({ ...deck, slides })
  }

  function handleRailKeyDown(event: JSX.TargetedEvent<HTMLDivElement, KeyboardEvent>) {
    if (!deck || deck.slides.length === 0) return
    const currentIdx = deck.slides.findIndex((s) => s.id === selectedSlide?.id)
    const baseIdx = currentIdx < 0 ? 0 : currentIdx
    let nextIdx: number | null = null
    if (event.key === 'ArrowDown' || event.key === 'ArrowRight') nextIdx = Math.min(deck.slides.length - 1, baseIdx + 1)
    else if (event.key === 'ArrowUp' || event.key === 'ArrowLeft') nextIdx = Math.max(0, baseIdx - 1)
    if (nextIdx === null) return
    event.preventDefault()
    const nextSlide = deck.slides[nextIdx]
    setSelectedSlideId(nextSlide.id)
    railRef.current?.querySelector<HTMLElement>(`[data-slide-id="${nextSlide.id}"]`)?.focus()
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
                <input type="checkbox" checked={scriptCheck} onChange={(e) => setScriptCheck(e.currentTarget.checked)} />
                <span>{t('editor.create.scriptCheck')}</span>
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

          <div class="edt-workspace">
            <div
              class="edt-rail"
              role="listbox"
              aria-label={t('editor.deck.slideListLabel')}
              ref={railRef}
              onKeyDown={handleRailKeyDown}
            >
              {deck.slides.map((slide) => {
                const isSelected = selectedSlide?.id === slide.id
                return (
                  <button
                    type="button"
                    role="option"
                    aria-selected={isSelected}
                    class={`edt-thumb${isSelected ? ' is-selected' : ''}`}
                    data-slide-id={slide.id}
                    key={slide.id}
                    onClick={() => setSelectedSlideId(slide.id)}
                  >
                    <span class="edt-thumb__num">{slide.index}</span>
                    <span class="edt-thumb__frame">
                      <SlideView slide={slide} theme={deck.theme} scale={0.155} pageTotal={deck.slides.length} />
                    </span>
                    <span class="edt-thumb__title">{slide.title.text || '…'}</span>
                  </button>
                )
              })}
              <button type="button" class="edt-btn edt-rail__add" onClick={addSlide}>
                {t('editor.deck.addSlide')}
              </button>
            </div>

            <div class="edt-detail">
              {selectedSlide ? (
                <SlideDetailCard
                  key={selectedSlide.id}
                  slide={selectedSlide}
                  theme={deck.theme}
                  pageTotal={deck.slides.length}
                  deckLang={deck.lang}
                  onChange={(patch) => updateSlide(selectedSlide.id, patch)}
                  onImageDescribed={(assetId, description) => setImageBlockDescription(selectedSlide.id, assetId, description)}
                  onMoveUp={() => moveSlide(selectedSlide.id, -1)}
                  onMoveDown={() => moveSlide(selectedSlide.id, 1)}
                  onDelete={() => deleteSlide(selectedSlide.id)}
                  canMoveUp={deck.slides.findIndex((s) => s.id === selectedSlide.id) > 0}
                  canMoveDown={deck.slides.findIndex((s) => s.id === selectedSlide.id) < deck.slides.length - 1}
                />
              ) : (
                <div class="edt-empty">{t('editor.deck.noSlides')}</div>
              )}
            </div>
          </div>
        </div>
      )}

      {mode === 'edit' && !deck && <div class="edt-empty">{t('editor.deck.noDeck')}</div>}
    </div>
  )
}
