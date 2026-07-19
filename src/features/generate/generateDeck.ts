// GenerateDeckFn (types.ts) implementation, two pipeline shapes
// (GenerateOptions.pipelineMode):
//
// 'script_first' (legacy default at this API level): writes the full spoken
// narration BEFORE any slide exists (generateScript, one call, modeled on
// ../tc-news/src/lib/programGenerate.ts's "narration first" approach), then
// generates ONE visualized slide per script segment (generateSegmentSlide) —
// speakerNotes is always the segment's narration verbatim regardless of what
// the slide call returns — then evaluates -> refines.
//
// 'plan_fanout' (the settings UI's default, modeled on ../tc-translate's
// planTranslationFanOut -> per-language-worker split): the orchestrator
// preset makes ONE compact plan call (generatePlan — headings + terse
// briefs, no narration), then the fan-out workers each write their segment's
// narration AND slide in one call (generateAuthoredSegment) on the worker
// preset — so an expensive orchestrator preset's token spend is limited to
// the plan call while a cheaper worker preset carries the bulk of output
// tokens (evaluation and batch refine also run on the worker preset there).
//
// Pure service module (no Preact) so it can be unit tested and reused
// headlessly (e.g. by the editor tab's "generate" action) without pulling in
// any UI.
//
// Local-LLM-friendly by design (PLAN.md: "Local LLM 対応...プロンプトは簡潔・
// 構造化"): the script call and each segment's slide-generation call are
// separate, small, bounded-timeout requests rather than one huge "write the
// whole deck" prompt — a local model is far more likely to produce valid
// JSON for "one narration document" or "visualize this one paragraph" than
// for "40 slides for the whole deck" in a single completion. Every LLM call
// is wrapped so a failure (unconfigured/unreachable LLM, timeout, bad JSON)
// degrades to a placeholder slide/deck instead of throwing — generateDeck
// always resolves.
import { requestChatCompletion } from '../../lib/llm'
import { evaluateDeck } from '../../lib/evaluator'
import {
  DEFAULT_MAX_REFINE_ITERATIONS,
  DEFAULT_QUALITY_THRESHOLD,
  type Deck,
  type DeckScore,
  type GenerateDeckFn,
  type GenerateOptions,
  type GenerateProgressCallback,
  type MindmapNode,
  type PositionedBlock,
  type Slide,
  type SlideType,
  type SourceMaterial,
} from '../../types'
import { planLayoutHints } from './layoutPlan'
import { extractJson, newId, normalizeAuthoredSegment, normalizePlanScript, normalizeScript, normalizeSlide, type Script, type ScriptSegment } from './parse'
import {
  buildDeckPlanMessages,
  buildRefineMessages,
  buildScriptMessages,
  buildScriptRefineMessages,
  buildSegmentAuthorMessages,
  buildSegmentSlideMessages,
  buildSlideRefineMessages,
} from './prompts'
import { checkScript } from './scriptCheck'
import { DEFAULT_DECK_THEME } from './theme'

const SCRIPT_TIMEOUT_MS = 90_000
const SEGMENT_TIMEOUT_MS = 60_000
const REFINE_TIMEOUT_MS = 180_000
// plan_fanout mode: the plan call's output is a fraction of a full script's,
// but each worker call now writes narration + slide (roughly double a
// visualize-only segment call's output).
const PLAN_TIMEOUT_MS = 60_000
const SEGMENT_AUTHOR_TIMEOUT_MS = 90_000

// Fixed low temperature for every generation/refine call in this pipeline —
// JSON-shape stability matters more than creative variance here, mirroring
// lib/evaluator/llmJudge.ts's own 0.2 for the same reason.
const GENERATION_TEMPERATURE = 0.3

function chatOpts(opts: GenerateOptions, timeoutMs: number) {
  return { presetId: opts.presetId, connection: opts.connection, signal: opts.signal, timeoutMs, temperature: GENERATION_TEMPERATURE }
}

async function generateScript(sources: SourceMaterial[], opts: GenerateOptions): Promise<Script> {
  const fallbackTitle = sources[0]?.title.trim() || 'Untitled Deck'
  try {
    const raw = await requestChatCompletion(buildScriptMessages(sources, opts), chatOpts(opts, SCRIPT_TIMEOUT_MS))
    return normalizeScript(extractJson(raw), fallbackTitle, opts.maxSlides)
  } catch {
    return normalizeScript(null, fallbackTitle, opts.maxSlides)
  }
}

/** plan_fanout's orchestrator call (GenerateOptions.pipelineMode doc,
 * modeled on ../tc-translate's planTranslationFanOut): ONE compact call that
 * plans segment structure without writing narration — the fan-out workers
 * (generateAuthoredSegment) write it per segment instead. Same never-throws
 * fallback contract as generateScript. */
async function generatePlan(sources: SourceMaterial[], opts: GenerateOptions): Promise<Script> {
  const fallbackTitle = sources[0]?.title.trim() || 'Untitled Deck'
  try {
    const raw = await requestChatCompletion(buildDeckPlanMessages(sources, opts), chatOpts(opts, PLAN_TIMEOUT_MS))
    return normalizePlanScript(extractJson(raw), fallbackTitle, opts.maxSlides)
  } catch {
    return normalizePlanScript(null, fallbackTitle, opts.maxSlides)
  }
}

/** Rule-checks a freshly-written script (scriptCheck.ts's checkScript) and,
 * when it finds issues, attempts ONE bounded LLM repair call
 * (buildScriptRefineMessages) before the script is committed as the
 * checkpoint payload — see generateDeck's caller below, which runs this
 * between generateScript() and the 'script' onProgress emit that carries the
 * checkpoint-commit `script` field. A bad script poisons every downstream
 * per-segment slide, so catching structural defects (missing intro/
 * conclusion, bullet-fragment "narration", duplicate headings, interleaved
 * chapters, ...) here is far cheaper than relying on the per-slide refine
 * loop to notice something is off later.
 *
 * Never loops and never throws: at most one repair call is made, its result
 * is re-checked with checkScript, and the revision is kept ONLY if it has
 * strictly fewer issues than the original — otherwise (LLM failure, no
 * parseable JSON, no improvement) the original script is kept, matching this
 * file's "generateDeck always resolves" philosophy. `throwIfAborted` still
 * applies around the one await so a cancellation mid-repair-call surfaces as
 * an abort rather than silently finishing the repair. Skipped entirely when
 * `opts.scriptCheck` is false or the script already has no issues. Uses
 * `opts` (the orchestrator preset), not a worker preset — like the batch
 * refine call, fixing the script is an orchestrator-level responsibility. */
async function checkAndFixScript(script: Script, opts: GenerateOptions, onProgress?: GenerateProgressCallback): Promise<Script> {
  if (opts.scriptCheck === false) return script
  const issues = checkScript(script)
  if (issues.length === 0) return script

  onProgress?.({ stage: 'script', message: 'Checking & fixing script' })
  try {
    const raw = await requestChatCompletion(buildScriptRefineMessages(script, issues, opts), chatOpts(opts, SCRIPT_TIMEOUT_MS))
    throwIfAborted(opts.signal)
    const parsed = extractJson(raw)
    if (!parsed) return script
    const fallbackTitle = script.title.trim() || 'Untitled Deck'
    const revised = normalizeScript(parsed, fallbackTitle, opts.maxSlides)
    return checkScript(revised).length < issues.length ? revised : script
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') throw err
    return script
  }
}

/** The deck's cover slide is built directly from the script's title/subtitle
 * rather than through an LLM call — design-spec.md §4.1 bans the blocks
 * model on cover slides, so there is nothing for a per-segment "visualize
 * this" call to usefully add beyond what the script already states. */
function buildCoverSlide(script: Script): Slide {
  return normalizeSlide(
    {
      type: 'title',
      layout: 'single_column',
      title: { text: script.title.slice(0, 60) },
      body: { bullets: [], paragraphs: script.subtitle ? [script.subtitle.slice(0, 140)] : [] },
      speakerNotes: script.subtitle,
    },
    1,
  )
}

/** speakerNotes is set to `segment.narration` verbatim here too, so a
 * fallback slide (LLM call failed / returned nothing usable) still carries
 * the correct spoken script — the presenter can read from it even if its
 * visual is a bare placeholder. */
function fallbackSegmentSlide(segment: ScriptSegment, index: number): Slide {
  return normalizeSlide(
    {
      type: segment.section === 'conclusion' ? 'summary' : 'content',
      title: { text: segment.heading.slice(0, 25) },
      body: { bullets: [{ text: segment.narration.slice(0, 30), level: 0 }], paragraphs: [] },
      speakerNotes: segment.narration,
    },
    index,
  )
}

/** Coarse "shape" fingerprint of a slide — layout plus its dominant block
 * kind (or visual kind / plain "text" when there are no blocks) — passed as
 * `previousLayoutSignature` to the NEXT segment's buildSegmentSlideMessages
 * call so the prompt can steer away from repeating the same structure three
 * times running (layout_variety's monotony penalty). */
function layoutSignature(slide: Slide): string {
  const dominantBlockKind = slide.blocks?.[0]?.kind ?? (slide.visual.kind !== 'none' ? slide.visual.kind : 'text')
  return `${slide.layout}:${dominantBlockKind}`
}

/** `fallback: true` means the LLM call failed/returned garbage and `slide`
 * is a local placeholder — the checkpoint layer (lib/generateCheckpoint.ts
 * via lib/generateJobs.ts) must not mark that segment done, so an
 * interrupted-then-resumed run retries it instead of freezing the
 * placeholder in. An uninterrupted run still ships the placeholder, exactly
 * as before — generateDeck always resolves. */
async function generateSegmentSlide(
  segment: ScriptSegment,
  segmentNumber: number,
  totalSegments: number,
  sources: SourceMaterial[],
  opts: GenerateOptions,
  index: number,
  previousLayoutSignature?: string,
  layoutHint?: string,
): Promise<{ slide: Slide; fallback: boolean }> {
  try {
    const raw = await requestChatCompletion(
      buildSegmentSlideMessages(segment, segmentNumber, totalSegments, sources, opts, previousLayoutSignature, layoutHint),
      chatOpts(opts, SEGMENT_TIMEOUT_MS),
    )
    const parsed = extractJson(raw)
    if (!parsed) return { slide: fallbackSegmentSlide(segment, index), fallback: true }
    const slide = normalizeSlide(parsed, index)
    // Always the verbatim script segment, never whatever (if anything) the
    // slide-visualization call wrote — see this file's top comment and
    // design-spec.md's "speakerNotes carries the segment script verbatim".
    return { slide: { ...slide, speakerNotes: segment.narration }, fallback: false }
  } catch {
    return { slide: fallbackSegmentSlide(segment, index), fallback: true }
  }
}

/** plan_fanout's worker unit (mirroring ../tc-translate's
 * translateSegmentForLanguage): ONE call that writes this segment's full
 * spoken narration from the orchestrator's brief AND generates its slide —
 * vs. generateSegmentSlide, which only visualizes an already-written
 * narration. Returns the authored narration so the caller can promote it
 * into the slot's segment (speakerNotes, refine grounding, partial-deck
 * snapshots). On failure the fallback slide keeps the brief as its
 * speakerNotes — same "never mark a fallback done" checkpoint contract as
 * generateSegmentSlide. */
async function generateAuthoredSegment(
  segment: ScriptSegment,
  segmentNumber: number,
  totalSegments: number,
  script: Script,
  sources: SourceMaterial[],
  opts: GenerateOptions,
  index: number,
  layoutHint?: string,
): Promise<{ narration: string; slide: Slide; fallback: boolean }> {
  try {
    const raw = await requestChatCompletion(
      buildSegmentAuthorMessages(segment, segmentNumber, totalSegments, script, sources, opts, layoutHint),
      chatOpts(opts, SEGMENT_AUTHOR_TIMEOUT_MS),
    )
    const parsed = extractJson(raw)
    const authored = parsed !== null ? normalizeAuthoredSegment(parsed, index) : null
    if (!authored) return { narration: segment.narration, slide: fallbackSegmentSlide(segment, index), fallback: true }
    const narration = authored.narration || segment.narration
    return { narration, slide: { ...authored.slide, speakerNotes: narration }, fallback: false }
  } catch {
    return { narration: segment.narration, slide: fallbackSegmentSlide(segment, index), fallback: true }
  }
}

/** Raises the same AbortError shape fetch itself uses, so lib/
 * generateJobs.ts's isAbortError treats it as a cancellation. Needed because
 * every individual LLM call here swallows its own errors (abort included)
 * into a fallback value — without these explicit checks between units, a
 * cancelled run would sprint through the remaining segments generating
 * placeholder slides instead of stopping (and would then overwrite the
 * user's cancel with a bogus "complete"). Checked between atomic units, so
 * cancelling never loses already-committed progress. */
function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')
}

/** Skeleton stand-in for a segment whose slide hasn't generated yet, used
 * only inside GenerateProgressEvent.partialDeck snapshots (its id is listed
 * in pendingSlideIds so the UI renders it as a skeleton). Carries the
 * heading and narration so even the skeleton is meaningful to read. */
function pendingPlaceholderSlide(segment: ScriptSegment): Slide {
  return normalizeSlide(
    {
      type: segment.section === 'conclusion' ? 'summary' : 'content',
      title: { text: segment.heading.slice(0, 25) },
      speakerNotes: segment.narration,
    },
    0, // placeholder — partial-deck assembly renumbers
  )
}

// ---------------------------------------------------------------------------
// Deterministic structural slides (no LLM call) — inserted around the
// per-segment slides to fix the sample-deck analysis's top structural gap:
// no agenda, no chapter dividers, no guaranteed closing summary. Modeled on
// buildCoverSlide above: built directly from already-known script data, since
// there's nothing for an LLM "visualize this" call to usefully add.

/** Ordered, de-duplicated list of every `chapter` label the script writer
 * assigned to a "body" segment (see prompts.ts's buildScriptMessages
 * grouping instruction and parse.ts's ScriptSegment.chapter doc).
 * Intro/conclusion segments are never chapter members. */
function collectChapters(segmentSlides: { segment: ScriptSegment; slide: Slide }[]): string[] {
  const chapters: string[] = []
  for (const { segment } of segmentSlides) {
    if (segment.section === 'body' && segment.chapter && !chapters.includes(segment.chapter)) {
      chapters.push(segment.chapter)
    }
  }
  return chapters
}

/** Agenda slide listing every chapter, inserted right after the cover. */
function buildAgendaSlide(chapters: string[], opts: GenerateOptions): Slide {
  return normalizeSlide(
    {
      type: 'agenda',
      layout: 'single_column',
      title: { text: 'Agenda' },
      blocks: [
        {
          kind: 'pillRow',
          direction: 'vertical',
          items: chapters.map((c) => ({ text: c.slice(0, 24) })),
        },
      ],
      // Locale-agnostic: just lists the (already opts.language) chapter
      // labels rather than composing a full sentence in a fixed language.
      speakerNotes: chapters.join(opts.language.toLowerCase().startsWith('ja') ? '、' : ', '),
    },
    0, // placeholder — the caller's final renumbering pass assigns the real index.
  )
}

/** Chapter-divider slide inserted at each chapter boundary. */
function buildSectionBreakSlide(chapter: string): Slide {
  return normalizeSlide(
    { type: 'section_break', layout: 'single_column', title: { text: chapter.slice(0, 40) }, speakerNotes: chapter },
    0,
  )
}

/** Assembles the final slide order: cover -> [agenda, if any chapters] ->
 * per-segment slides, with a section_break inserted at every chapter
 * boundary (including before the first chapter's first slide) and every
 * "conclusion"-section segment's slide forced to `type: 'summary'`
 * regardless of what the per-segment LLM call picked. Index fields are left
 * as placeholders; the caller does the final contiguous renumbering pass
 * (page_number_continuity requires index to exactly match array position). */
function assembleSlides(
  script: Script,
  segmentSlides: { segment: ScriptSegment; slide: Slide }[],
  opts: GenerateOptions,
): Slide[] {
  const fixed = segmentSlides.map(({ segment, slide }) =>
    segment.section === 'conclusion' ? { segment, slide: { ...slide, type: 'summary' as const } } : { segment, slide },
  )
  const chapters = collectChapters(fixed)

  const out: Slide[] = [buildCoverSlide(script)]
  if (chapters.length > 0) out.push(buildAgendaSlide(chapters, opts))

  let lastChapter: string | undefined
  for (const { segment, slide } of fixed) {
    if (chapters.length > 0 && segment.section === 'body' && segment.chapter && segment.chapter !== lastChapter) {
      out.push(buildSectionBreakSlide(segment.chapter))
      lastChapter = segment.chapter
    }
    out.push(slide)
  }
  return out
}

const CIRCLED_NUMBERS = ['①', '②', '③', '④', '⑤', '⑥', '⑦', '⑧', '⑨', '⑩']

/** Deterministic (no-LLM) fix for title_uniqueness: appends a circled-number
 * suffix to every slide whose (trimmed) title is shared by another slide.
 * Cheaper and more reliable than asking an LLM to rename a slide, and runs
 * before the LLM-based per-slide refine pass so those calls are spent only
 * on issues that actually need generation. */
function dedupeTitles(slides: Slide[]): Slide[] {
  const totalByTitle = new Map<string, number>()
  for (const s of slides) {
    const t = s.title.text.trim()
    if (t) totalByTitle.set(t, (totalByTitle.get(t) ?? 0) + 1)
  }
  const seen = new Map<string, number>()
  return slides.map((s) => {
    const t = s.title.text.trim()
    if (!t || (totalByTitle.get(t) ?? 0) < 2) return s
    const n = (seen.get(t) ?? 0) + 1
    seen.set(t, n)
    const suffix = CIRCLED_NUMBERS[n - 1] ?? `(${n})`
    return { ...s, title: { ...s.title, text: `${t}${suffix}` } }
  })
}

// ---------------------------------------------------------------------------
// Per-slide refine (GenerateOptions.refineStrategy === 'per_slide', default)
// — regenerates only the worst individual slides with one small bounded call
// each, instead of buildRefineMessages' whole-deck single call. More robust
// for local LLMs, whose single big-JSON refine response tends to get
// truncated (see notes-slide-quality.md's local-LLM section).

export interface WeakSlide {
  /** 0-based position in Deck.slides. */
  index: number
  issues: string[]
}

const MAX_WEAK_SLIDES = 4
const MAX_TITLE_CHARS = 30
const MAX_ON_SLIDE_TEXT_CHARS = 100 // matches STYLE_GUIDE's stated hard limit in prompts.ts
// Slide types the takeaway_presence metric actually scores (types.ts's
// MetricId doc: "diagram/data slides"). Structural slides (cover/agenda/
// section_break/summary) are exempt — a summary slide's whole body IS the
// takeaway, so requiring a dedicated calloutBox on top of that would be
// redundant busywork, not a quality signal.
const TAKEAWAY_SLIDE_TYPES: SlideType[] = ['content', 'diagram', 'data_table', 'chart']

function mindmapTextLength(nodes: MindmapNode[]): number {
  return nodes.reduce((n, node) => n + node.label.length + (node.children ? mindmapTextLength(node.children) : 0), 0)
}

/** Rough on-slide text budget, cheap enough to run every refine iteration
 * without an LLM call — sums title-excluded body/block text across every
 * block kind, matching prompts.ts's STYLE_GUIDE character-budget guidance. */
function estimateSlideTextLength(slide: Slide): number {
  let total = 0
  for (const b of slide.body.bullets) total += b.text.length
  for (const p of slide.body.paragraphs) total += p.length
  for (const block of slide.blocks ?? []) total += blockTextLength(block)
  return total
}

function blockTextLength(block: PositionedBlock): number {
  switch (block.kind) {
    case 'pillRow':
      return block.items.reduce((n, i) => n + i.text.length + (i.description?.length ?? 0), 0)
    case 'iconRow':
      return block.items.reduce((n, i) => n + i.label.length, 0)
    case 'boxGroup':
      return block.boxes.reduce((n, b) => n + b.label.length + (b.text?.length ?? 0), 0)
    case 'mindmap':
      return block.root.length + mindmapTextLength(block.branches)
    case 'comparison':
      return block.left.heading.length + block.left.bullets.join('').length + block.right.heading.length + block.right.bullets.join('').length
    case 'flow':
      return block.steps.reduce((n, s) => n + s.text.length, 0)
    case 'gridHeatmap':
      return block.legend.reduce((n, l) => n + l.label.length, 0) + (block.annotation?.length ?? 0)
    case 'calloutBox':
      return block.heading.length + block.bullets.join('').length
    case 'paragraph':
      return block.text.length
    case 'bulletList':
      return block.bullets.reduce((n, b) => n + b.text.length, 0)
    case 'quote':
      return block.text.length + (block.attribution?.length ?? 0)
    case 'imageRef':
      return block.caption.length
    case 'visual':
      return 0
    default:
      return 0
  }
}

function isEmptySlide(slide: Slide): boolean {
  return (
    !slide.title.text.trim() &&
    slide.body.bullets.length === 0 &&
    slide.body.paragraphs.length === 0 &&
    (slide.blocks?.length ?? 0) === 0 &&
    slide.visual.kind === 'none' &&
    slide.visual.elements.length === 0
  )
}

function hasCalloutBox(slide: Slide): boolean {
  return (slide.blocks ?? []).some((b) => b.kind === 'calloutBox')
}

/** Finds slides with cheaply-detectable local rule violations — no LLM call
 * needed, unlike the deck-level metrics in `score`. Returns at most
 * MAX_WEAK_SLIDES candidates, worst (most issues) first, for the per-slide
 * refine pass to regenerate one at a time. Title-uniqueness duplicates are
 * NOT included here — those get a deterministic (LLM-free) fix via
 * dedupeTitles before this ever runs. */
export function identifyWeakSlides(deck: Deck, _score: DeckScore): WeakSlide[] {
  const weak: WeakSlide[] = []
  deck.slides.forEach((slide, index) => {
    const issues: string[] = []
    if (isEmptySlide(slide)) {
      issues.push('This slide has no content — give it a specific, non-empty title and at least one block/bullet/paragraph.')
    }
    if (slide.title.text.trim().length > MAX_TITLE_CHARS) {
      issues.push(`Title is too long (${slide.title.text.trim().length} characters) — shorten it to roughly 10-20 characters.`)
    }
    const textLength = estimateSlideTextLength(slide)
    if (textLength > MAX_ON_SLIDE_TEXT_CHARS) {
      issues.push(`On-slide text is too dense (~${textLength} characters) — cut to the single main point, ~20-60 characters, not the full narration.`)
    }
    const hasContent = (slide.blocks?.length ?? 0) > 0 || slide.visual.kind !== 'none'
    if (TAKEAWAY_SLIDE_TYPES.includes(slide.type) && hasContent && !hasCalloutBox(slide)) {
      issues.push('Missing an explicit conclusion — add one calloutBox block stating the "so what" takeaway of this slide.')
    }
    if (issues.length > 0) weak.push({ index, issues })
  })
  return weak.sort((a, b) => b.issues.length - a.issues.length).slice(0, MAX_WEAK_SLIDES)
}

/** Regenerates each weak slide individually via buildSlideRefineMessages.
 * speakerNotes and id are always preserved from the original slide — the
 * refine call never sees or controls either (see buildSlideRefineMessages'
 * doc). A failed/unusable response for a given slide just keeps that slide
 * unchanged, same defensive philosophy as every other LLM call in this
 * pipeline. */
async function refineWeakSlides(
  deck: Deck,
  weak: WeakSlide[],
  segmentNarrationBySlideId: Map<string, string>,
  opts: GenerateOptions,
): Promise<Deck> {
  const slides = [...deck.slides]
  for (const w of weak) {
    const original = slides[w.index]
    if (!original) continue
    const narration = segmentNarrationBySlideId.get(original.id) ?? original.speakerNotes
    try {
      const raw = await requestChatCompletion(
        buildSlideRefineMessages(original, w.issues, narration, opts),
        chatOpts(opts, SEGMENT_TIMEOUT_MS),
      )
      const parsed = extractJson(raw)
      if (!parsed) continue
      const revised = normalizeSlide(parsed, original.index)
      slides[w.index] = { ...revised, id: original.id, speakerNotes: original.speakerNotes }
    } catch {
      // Keep the original slide for this index on any failure.
    }
  }
  return { ...deck, slides, updatedAt: new Date().toISOString() }
}

async function refineDeck(deck: Deck, score: DeckScore, opts: GenerateOptions): Promise<Deck> {
  try {
    const raw = await requestChatCompletion(buildRefineMessages(deck, score, opts), chatOpts(opts, REFINE_TIMEOUT_MS))
    const parsed = extractJson<{ title?: string; slides?: unknown[] }>(raw)
    const rawSlides = Array.isArray(parsed?.slides) ? parsed.slides : []
    if (rawSlides.length === 0) return deck // nothing usable came back — keep the prior deck for this iteration

    const slides = rawSlides.map((s, i) => normalizeSlide(s, i + 1))
    const title = typeof parsed?.title === 'string' && parsed.title.trim() ? parsed.title.trim() : deck.title
    return { ...deck, title, slides, updatedAt: new Date().toISOString() }
  } catch {
    return deck
  }
}

/** Deck score comparator for picking the best attempt across refine
 * iterations: a non-gated deck always beats a gated one; among decks with
 * the same gate status, higher `total` wins. */
function isBetter(a: DeckScore, b: DeckScore): boolean {
  if (a.gate !== b.gate) return !a.gate
  return a.total > b.total
}

export const generateDeck: GenerateDeckFn = async (sources, opts, onProgress) => {
  const threshold = opts.qualityThreshold ?? DEFAULT_QUALITY_THRESHOLD
  const maxIterations = opts.maxRefineIterations ?? DEFAULT_MAX_REFINE_ITERATIONS
  const useLlmJudge = opts.useLlmJudge ?? true
  const useVisionJudge = opts.useVisionJudge ?? false

  // Orchestrator/worker preset split (types.ts's workerPresetId doc): the
  // main presetId plans; the worker preset — when set — mass-produces the
  // per-segment slides and the small per-slide refine calls.
  const workerOpts: GenerateOptions = opts.workerPresetId ? { ...opts, presetId: opts.workerPresetId } : opts
  const pipelineMode = opts.pipelineMode ?? 'script_first'
  // plan_fanout reserves the orchestrator preset for the single plan call
  // (types.ts's pipelineMode doc — the whole point is keeping the expensive
  // planning preset's token spend minimal), so the LLM judge and the
  // deck-level batch refine run on the worker preset there. script_first
  // keeps them on the orchestrator preset, the historical behavior.
  const heavyOpts = pipelineMode === 'plan_fanout' ? workerOpts : opts

  const evalOpts = {
    useLlmJudge,
    useVisionJudge,
    visionPresetId: opts.visionPresetId,
    presetId: heavyOpts.presetId,
    connection: opts.connection,
    signal: opts.signal,
  }

  const resume = opts.resume

  let script: Script
  if (resume?.script) {
    script = resume.script
  } else if (pipelineMode === 'plan_fanout') {
    // tc-translate-style orchestrator: ONE compact plan call; the narration
    // is written per segment by the fan-out workers below.
    // checkAndFixScript is skipped — its rules judge full spoken narration,
    // which a plan's keyword briefs are not.
    onProgress?.({ stage: 'script', message: 'Planning deck structure' })
    script = await generatePlan(sources, opts)
    throwIfAborted(opts.signal)
    // `script` in the event is the checkpoint-commit payload (segment
    // narrations still hold the plan briefs; each completed slide's
    // speakerNotes carries the worker-authored narration).
    onProgress?.({ stage: 'script', script })
  } else {
    onProgress?.({ stage: 'script', message: 'Writing presentation script' })
    script = await generateScript(sources, opts)
    throwIfAborted(opts.signal)
    // Rule-check + (at most one) LLM repair pass BEFORE the checkpoint-commit
    // emit below — a resumed script (the `if` branch above) is already
    // committed/checkpointed, so it's intentionally never re-checked here.
    script = await checkAndFixScript(script, opts, onProgress)
    throwIfAborted(opts.signal)
    // `script` in the event is the checkpoint-commit payload — emitted only
    // for a freshly generated script (a resumed one is already committed).
    onProgress?.({ stage: 'script', script })
  }

  const total = script.segments.length
  // One slot per script segment, filled as slides finish (in any order once
  // workerConcurrency > 1). Resumed runs start with their committed slides
  // pre-filled and only generate the holes.
  const slots: ({ segment: ScriptSegment; slide: Slide } | null)[] = new Array(total).fill(null)
  if (resume) {
    for (const [key, slide] of Object.entries(resume.slides)) {
      const i = Number(key)
      const segment = Number.isInteger(i) ? script.segments[i] : undefined
      if (segment && slide) slots[i] = { segment, slide }
    }
  }

  const deckId = newId()
  const createdAt = new Date().toISOString()

  /** Live partial-deck snapshot for progressive UI rendering: the REAL
   * assembled structure (cover/agenda/section breaks) with skeleton
   * placeholders standing in for not-yet-generated segments. Rebuilt per
   * event — cheap (no LLM, no clone of slide internals) and always
   * consistent with `slots` at emit time. */
  const buildPartial = () => {
    const pendingSlideIds: string[] = []
    let segmentsDone = 0
    const segmentSlides = script.segments.map((segment, i) => {
      const done = slots[i]
      if (done) {
        segmentsDone += 1
        return done
      }
      const placeholder = pendingPlaceholderSlide(segment)
      pendingSlideIds.push(placeholder.id)
      return { segment, slide: placeholder }
    })
    const slides = assembleSlides(script, segmentSlides, opts).map((s, i) => ({ ...s, index: i + 1 }))
    const partialDeck: Deck = {
      id: deckId,
      title: script.title,
      lang: opts.language,
      theme: DEFAULT_DECK_THEME,
      slides,
      createdAt,
      updatedAt: new Date().toISOString(),
    }
    return { partialDeck, pendingSlideIds, segmentsDone, segmentsTotal: total }
  }

  // Preserves each segment's narration by the slide's (stable, pre-refine)
  // id, so the per-slide refine pass below can ground its regeneration call
  // in the right script segment even after deterministic structural slides
  // (agenda/section_break, which have no segment) get interleaved in.
  const segmentNarrationBySlideId = new Map<string, string>()

  let deck: Deck
  let iteration: number

  if (resume?.refined) {
    // Segment generation fully completed (and at least one refine iteration
    // committed) before the interruption — skip straight back into the
    // refine loop from the checkpointed snapshot.
    deck = resume.refined.deck
    iteration = resume.refined.iteration
  } else {
    // Skeleton first: the whole deck structure is visible (and rendered by
    // subscribers) before a single slide has generated.
    onProgress?.({ stage: 'slides', message: `Visualizing ${total} segment(s)`, ...buildPartial() })

    const concurrency = Math.max(1, Math.min(8, Math.trunc(opts.workerConcurrency ?? 1)))
    const layoutHints = planLayoutHints(script, opts)

    // The reactive previousLayoutSignature chain only exists sequentially;
    // concurrent workers rely on the planned hints alone (see
    // planLayoutHints' doc for why that still covers layout_variety).
    let previousLayoutSignature: string | undefined
    let cursor = 0
    const worker = async (): Promise<void> => {
      for (;;) {
        throwIfAborted(opts.signal)
        const i = cursor
        cursor += 1
        if (i >= total) return
        const segment = script.segments[i]
        if (!segment || slots[i]) continue
        // Counts included so progress labels ("3/12") don't flicker away on
        // start-of-segment events between the slide-completion snapshots.
        onProgress?.({
          stage: 'slides',
          message: `Segment ${i + 1}/${total}: ${segment.heading}`,
          segmentsDone: slots.filter(Boolean).length,
          segmentsTotal: total,
        })
        let committedSegment = segment
        let slide: Slide
        let fallback: boolean
        if (pipelineMode === 'plan_fanout') {
          // Worker writes narration + slide in one call; the authored
          // narration is promoted into this slot's segment so speaker notes,
          // refine grounding and partial-deck snapshots all read the real
          // narration, not the plan brief.
          const authored = await generateAuthoredSegment(
            segment,
            i + 1,
            total,
            script,
            sources,
            workerOpts,
            i + 2, // placeholder index — the final renumbering pass below is authoritative
            layoutHints[i],
          )
          slide = authored.slide
          fallback = authored.fallback
          if (!authored.fallback) committedSegment = { ...segment, narration: authored.narration }
        } else {
          const generated = await generateSegmentSlide(
            segment,
            i + 1,
            total,
            sources,
            workerOpts,
            i + 2, // placeholder index — the final renumbering pass below is authoritative
            concurrency === 1 ? previousLayoutSignature : undefined,
            layoutHints[i],
          )
          slide = generated.slide
          fallback = generated.fallback
        }
        // Before the slot commit: an abort mid-call surfaces as a swallowed
        // fallback slide, which must not be committed as this segment's
        // result — the resumed run should retry it.
        throwIfAborted(opts.signal)
        slots[i] = { segment: committedSegment, slide }
        previousLayoutSignature = layoutSignature(slide)
        // segmentIndex/slide/slideIsFallback = the checkpoint-commit
        // payload; partialDeck etc = the live UI snapshot.
        onProgress?.({ stage: 'slides', segmentIndex: i, slide, slideIsFallback: fallback, ...buildPartial() })
      }
    }
    await Promise.all(Array.from({ length: Math.min(concurrency, total) }, () => worker()))

    const segmentSlides = slots.filter((s): s is { segment: ScriptSegment; slide: Slide } => s !== null)
    // speakerNotes preferred over segment.narration: identical in
    // script_first mode, but a plan_fanout slide resumed from a checkpoint
    // carries the worker-authored narration only in its speakerNotes (the
    // checkpointed script's segments still hold the plan briefs).
    for (const { segment, slide } of segmentSlides) segmentNarrationBySlideId.set(slide.id, slide.speakerNotes || segment.narration)

    // Cover -> [agenda] -> per-segment slides with section_break dividers at
    // chapter boundaries, conclusion forced to type "summary" -> deterministic
    // title-uniqueness fix -> final contiguous renumbering (page_number_
    // continuity requires index to exactly match array position).
    const assembled = dedupeTitles(assembleSlides(script, segmentSlides, opts))
    const numberedSlides = assembled.map((s, i) => ({ ...s, index: i + 1 }))

    deck = {
      id: deckId,
      title: script.title,
      lang: opts.language,
      theme: DEFAULT_DECK_THEME,
      slides: numberedSlides,
      createdAt,
      updatedAt: new Date().toISOString(),
    }
    iteration = 0
  }

  throwIfAborted(opts.signal)
  onProgress?.({ stage: 'evaluate', iteration, message: 'Scoring initial draft', partialDeck: deck, pendingSlideIds: [], segmentsDone: total, segmentsTotal: total })
  let score = await evaluateDeck(deck, evalOpts)
  throwIfAborted(opts.signal)
  onProgress?.({ stage: 'evaluate', iteration, score: score.total })

  let best = { deck, score }

  const refineStrategy = opts.refineStrategy ?? 'per_slide'
  while ((score.total < threshold || score.gate) && iteration < maxIterations) {
    throwIfAborted(opts.signal)
    iteration += 1

    if (refineStrategy === 'batch') {
      onProgress?.({ stage: 'refine', iteration, score: score.total, message: 'Regenerating with feedback' })
      deck = await refineDeck(deck, score, heavyOpts)
    } else {
      const weak = identifyWeakSlides(deck, score)
      if (weak.length > 0) {
        onProgress?.({ stage: 'refine', iteration, score: score.total, message: `Regenerating ${weak.length} weak slide(s)` })
        deck = await refineWeakSlides(deck, weak, segmentNarrationBySlideId, workerOpts)
      } else {
        // No individually-fixable slide found but the deck score is still
        // low — a deck-level-only metric (e.g. narrative_flow) must be at
        // fault, so fall back to one whole-deck batch refine call for this
        // iteration only.
        onProgress?.({ stage: 'refine', iteration, score: score.total, message: 'Regenerating with feedback (deck-level fallback)' })
        deck = await refineDeck(deck, score, heavyOpts)
      }
    }
    throwIfAborted(opts.signal)

    onProgress?.({ stage: 'evaluate', iteration, message: 'Re-scoring revised deck' })
    score = await evaluateDeck(deck, evalOpts)
    throwIfAborted(opts.signal)
    // refinedDeck = the checkpoint-commit payload for this completed
    // iteration; partialDeck keeps the live preview tracking the refine too.
    onProgress?.({ stage: 'evaluate', iteration, score: score.total, refinedDeck: deck, partialDeck: deck, pendingSlideIds: [], segmentsDone: total, segmentsTotal: total })

    if (isBetter(score, best.score)) best = { deck, score }
  }

  onProgress?.({ stage: 'done', iteration, score: best.score.total })
  return best.deck
}

export default generateDeck
