// Canonical domain types for TC Presenter. This is the single source of
// truth referenced by every wave (see PLAN.md's "インターフェース契約"):
//   - Wave2 A (features/generate + lib/evaluator) implements GenerateDeckFn /
//     EvaluateDeckFn against the Deck/Slide/DeckScore shapes below.
//   - Wave2 B (features/present) implements PresentPlayerProps.
//   - Wave2 C (features/sources/editor/settings) reads/writes SourceMaterial
//     and Deck via lib/kv.ts and the *TabProps contracts below.
// Do not casually change field names/shapes here once Wave2 has started —
// coordinate first, since every worker imports from this file.
//
// The Slide shape follows notes-slide-quality.md §5's JSON schema proposal
// (structured bullets with level/form, a typed `visual` union, citation,
// buildStage) rather than PLAN.md's shorthand `body: string[]` gloss: the
// 15-metric evaluator (§4 of that note, e.g. #3 "箇条書き並列性") needs the
// per-bullet `level`/`form` fields to do its job, and buildStage is required
// for the "same content, build-up vs static" duality PLAN.md calls out. A
// slide whose body is *just* prose can still be expressed as one bullet with
// no visual markers — `paragraphs` also remains available for pure prose.

// ---------------------------------------------------------------------------
// Deck / Slide

export type DeckThemeColorPalette = {
  /** Primary accent — wine red by default (see styles/tokens.css --primary). */
  primary: string
  /** Secondary accent — navy by default (see styles/tokens.css --secondary). */
  secondary: string
  /** Warnings, contrast/"before" states, "✕" markers. */
  accentWarning: string
  /** Placeholders, inactive/disabled elements. */
  neutralGray: string
  background: string
  textPrimary: string
}

export type DeckAspectRatio = '16:9' | '4:3'

export interface DeckTheme {
  colorPalette: DeckThemeColorPalette
  aspectRatio: DeckAspectRatio
  fontFamily: string
}

export type SlideType =
  | 'title'
  | 'agenda'
  | 'content'
  | 'diagram'
  | 'quote'
  | 'summary'
  | 'data_table'
  | 'chart'
  | 'section_break'

export type SlideLayout =
  | 'single_column'
  | 'two_column_text_diagram'
  | 'diagram_centered'
  | 'full_bleed_image'
  | 'grid'

/** Optional step/layer badge next to a slide title (e.g. "1. Transport層"). */
export interface SlideTitleBadge {
  number: number
  label: string
}

export interface SlideTitle {
  /** Empty string is invalid — evaluator metric #8 flags it as a fatal defect. */
  text: string
  badge?: SlideTitleBadge
}

/** Whether a bullet reads as a noun phrase ("体言止め", e.g. "レイテンシ削減") or a
 * verb phrase (e.g. "レイテンシを削減する"). Mixed forms within one indent level
 * is exactly what evaluator metric #3 ("箇条書き並列性") penalizes. */
export type BulletForm = 'noun_phrase' | 'verb_phrase'

export interface SlideBullet {
  text: string
  /** 0-based indent level. */
  level: number
  form?: BulletForm
}

export interface SlideBody {
  bullets: SlideBullet[]
  /** Free-form prose paragraphs, used sparingly (quote/summary slides mainly). */
  paragraphs: string[]
}

export type VisualKind =
  | 'none'
  | 'icon_diagram'
  | 'network_graph'
  | 'flowchart'
  | 'image'
  | 'screenshot'
  | 'chart_line'
  | 'chart_bar'
  | 'table'

export type VisualElementType = 'box' | 'icon' | 'arrow' | 'node' | 'edge' | 'image_ref'

/** Relative (0-1) position/size within the slide canvas. */
export interface VisualPosition {
  x: number
  y: number
  w: number
  h: number
}

export interface VisualElement {
  type: VisualElementType
  label: string
  /** Hex color, expected to come from DeckTheme.colorPalette for consistency
   * (evaluator metric #9 checks cross-slide palette consistency). */
  color: string
  position: VisualPosition
}

export interface DataTable {
  headers: string[]
  rows: string[][]
  unit: string
  significantDigits: number
}

export interface ChartSeriesPoint {
  x: number
  y: number
}

export interface ChartSeries {
  name: string
  points: ChartSeriesPoint[]
}

export type ChartKind = 'line' | 'bar'

export interface SlideChart {
  type: ChartKind
  xLabel: string
  yLabel: string
  series: ChartSeries[]
  /** Conclusion text baked directly into the figure; overlaying separately is discouraged. */
  annotation?: string
}

export interface SlideVisual {
  kind: VisualKind
  elements: VisualElement[]
  dataTable?: DataTable
  chart?: SlideChart
}

export interface SlideCitation {
  text: string
  url?: string
}

/** Lets one logical slide be emitted either as a single static slide or as a
 * sequence of progressively-revealed build slides sharing the same
 * `groupId`. The evaluator treats slides sharing a `groupId` as one unit
 * (using the group's final `stageIndex`) for metrics like body length and
 * figure ratio — see notes-slide-quality.md §5's footnote. */
export interface SlideBuildStage {
  isBuildSlide: boolean
  groupId: string | null
  stageIndex: number | null
}

export interface Slide {
  /** Stable id for editor operations (drag/reorder, React/Preact keys). Not
   * the same as the printed page number — see `index`. */
  id: string
  /** 1-based slide position; must be contiguous and match the footer number
   * evaluator metric #11 checks. Editors/generators must keep this in sync
   * with the slide's actual position in `Deck.slides`. */
  index: number
  type: SlideType
  layout: SlideLayout
  title: SlideTitle
  body: SlideBody
  visual: SlideVisual
  /** New block-based content model (preferred for new generations). See
   * design-spec.md §3. When non-empty, the renderer uses this exclusively
   * and ignores `body`/`visual`. */
  blocks?: PositionedBlock[]
  /** Required whenever the slide uses external data/images (evaluator metric #13). */
  citation?: SlideCitation
  /** Empty string is a evaluator metric #14 penalty, not a hard error. */
  speakerNotes: string
  buildStage: SlideBuildStage
}

// ---------------------------------------------------------------------------
// Block-based content model (v2). Additive — see scratchpad/design-spec.md §3.
// A Slide with a non-empty `blocks` array is rendered exclusively via this
// model; `body`/`visual` remain populated for backward compatibility with
// pre-v2 decks and are ignored by the renderer once `blocks` is present.

/** Indirection into DeckTheme.colorPalette — never a literal hex on a block. */
export type BlockColorRole = 'primary' | 'secondary' | 'warning' | 'neutral'

export type PillVariant = 'filled' | 'outline'
// filled = brand-color fill + white text (conclusion / confirmed / technical term)
// outline = white fill + colored border + dark text (intermediate / unconfirmed category)

export interface PillItem {
  text: string
  /** Optional explanatory text rendered beside the pill (pillRow's "ピル+右に説明文" pattern). */
  description?: string
  variant?: PillVariant // default 'filled'
  color?: BlockColorRole // default 'primary'
}

export interface PillRowBlock {
  kind: 'pillRow'
  direction?: 'horizontal' | 'vertical' // default 'horizontal'
  items: PillItem[] // max 6 recommended, see §4
}

export interface IconRowItem {
  label: string
  /** Free-text keyword resolved to a pictogram via the existing icons.ts lookup, e.g. "user", "server", "database". */
  icon?: string
  /** Renders a red X overlay and grays out the icon — the "対象外" exclusion variant. */
  excluded?: boolean
}

export interface IconRowBlock {
  kind: 'iconRow'
  items: IconRowItem[] // max 5 recommended
}

export interface BoxItem {
  label: string
  text?: string
  variant?: PillVariant // default 'outline'
  color?: BlockColorRole // default 'primary'
  /** Grid cell placement — required when the parent BoxGroupBlock.layout === 'grid'. */
  row?: number
  col?: number
}

export interface BoxGroupBlock {
  kind: 'boxGroup'
  layout: 'single' | 'grid' | 'nested'
  gridRows?: number // required when layout === 'grid'
  gridCols?: number // required when layout === 'grid'
  boxes: BoxItem[]
  /** Local color legend shown beside the group — see the p34-36 connection-budget grid. */
  legend?: { color: BlockColorRole; label: string }[]
}

export interface MindmapNode {
  label: string
  variant?: PillVariant // default 'outline'
  color?: BlockColorRole
  children?: MindmapNode[] // depth capped at 2 below root, see §4
}

export interface MindmapBlock {
  kind: 'mindmap'
  root: string
  branches: MindmapNode[] // max 6 recommended
}

export interface ComparisonSide {
  heading: string
  bullets: string[] // max 4 recommended
}

export interface ComparisonBlock {
  kind: 'comparison'
  left: ComparisonSide
  right: ComparisonSide
}

export interface FlowStep {
  text: string
  variant?: PillVariant // default 'filled'
  color?: BlockColorRole // default 'primary'
}

export interface FlowBlock {
  kind: 'flow'
  direction?: 'vertical' | 'horizontal' // default 'vertical'
  steps: FlowStep[] // max 5 recommended
}

export interface GridHeatmapCell {
  row: number
  col: number
  colorKey: string // must match one legend[].colorKey
}

export interface GridHeatmapBlock {
  kind: 'gridHeatmap'
  rows: number
  cols: number
  cells: GridHeatmapCell[] // omitted cells render as an empty/neutral placeholder cell
  legend: { colorKey: string; color: BlockColorRole; label: string }[] // max 4 recommended
  /** Conclusion text drawn from the grid, rendered beside it (never overlaid on top of cells). */
  annotation?: string
}

export interface CalloutBoxBlock {
  kind: 'calloutBox'
  heading: string
  bullets: string[] // max 4 recommended
  color?: BlockColorRole // default 'secondary'
}

export interface ParagraphBlock {
  kind: 'paragraph'
  text: string
}

export interface BulletListBlock {
  kind: 'bulletList'
  bullets: SlideBullet[] // reuses the existing SlideBullet shape
}

export interface QuoteBlock {
  kind: 'quote'
  text: string
  attribution?: string
}

/** Screenshot / raw-data / external-figure embed. Internal colors/fonts of the
 * referenced asset are NOT theme-controlled — see design-spec.md §2-L. */
export interface ImageRefBlock {
  kind: 'imageRef'
  caption: string // required — what the image shows
  source?: SlideCitation // required whenever the image is external (matches existing citation rules)
  /** Id into lib/imageStore.ts (IndexedDB-backed). When set, the renderer
   * shows the stored image instead of the caption placeholder. Never a data
   * URI — Deck JSON lives in localStorage and must stay small. */
  assetId?: string
  /** Vision-LLM-generated description of what the image shows — feeds the
   * text-only LLM pipeline (generation/refine/evaluation) and doubles as the
   * <img> alt text. */
  description?: string
  /** How the image fills its frame. Default 'contain'. */
  fit?: 'contain' | 'cover'
}

/** Escape hatch: wraps the existing diagram/network-graph/flowchart/table/chart
 * primitives so they can be mixed into the block list unchanged. */
export interface VisualBlock {
  kind: 'visual'
  visual: SlideVisual
}

export type ContentBlock =
  | PillRowBlock
  | IconRowBlock
  | BoxGroupBlock
  | MindmapBlock
  | ComparisonBlock
  | FlowBlock
  | GridHeatmapBlock
  | CalloutBoxBlock
  | ParagraphBlock
  | BulletListBlock
  | QuoteBlock
  | ImageRefBlock
  | VisualBlock

export interface SlideBlockPlacement {
  /** Coarse column assignment. Blocks sharing a column stack top-to-bottom in
   * declaration order; 'full' blocks span the whole width and break the
   * left/right pairing above/below them. Default 'full'. */
  column?: 'left' | 'right' | 'full'
}

export type PositionedBlock = ContentBlock & SlideBlockPlacement

export interface Deck {
  id: string
  title: string
  /** Content language of the deck (e.g. "en", "ja") — independent of the
   * app's own UI locale, see src/i18n. */
  lang: string
  author?: string
  theme: DeckTheme
  slides: Slide[]
  /** ISO 8601 */
  createdAt: string
  /** ISO 8601 */
  updatedAt: string
}

/** Lightweight listing shape returned by lib/kv.ts's listDecks(), so the
 * Sources/Editor tab list view doesn't have to load every full Deck (with
 * all slide bodies) just to render a picker. */
export interface DeckSummary {
  id: string
  title: string
  lang: string
  slideCount: number
  updatedAt: string
}

// ---------------------------------------------------------------------------
// Source material (features/sources, sharedBus `note-article` ingestion)

/** Where a SourceMaterial came from — 'tc-news' is populated by subscribing
 * to the sharedBus `note-article` topic (see lib/sharedBus.ts and
 * notes-tc-news.md §3(b)); 'tc-note' is populated by subscribing to the
 * sharedBus `note-doc-index` topic (see lib/noteDocIndex.ts and
 * notes-tc-note.md); other origins are added locally by the user. */
export type SourceMaterialOrigin = 'manual' | 'tc-news' | 'tc-note' | 'file' | 'url'

export interface SourceMaterialLink {
  title: string
  url: string
}

export interface SourceMaterial {
  id: string
  title: string
  /** Markdown or plain text body — the actual content fed to the generator. */
  body: string
  excerpt?: string
  tags?: string[]
  sourceLinks?: SourceMaterialLink[]
  origin: SourceMaterialOrigin
  /** Present when origin is a URL fetch or a tc-news article. */
  sourceUrl?: string
  /** ISO 8601 */
  addedAt: string
}

// ---------------------------------------------------------------------------
// Generation pipeline (features/generate)

// Narration script (script-first pipeline). These lived in
// features/generate/parse.ts originally; hoisted here so lib/-side modules
// (lib/generateCheckpoint.ts's per-unit checkpoint records, lib/
// generateJobs.ts's resume plumbing) can reference them without importing
// from features/. parse.ts re-exports them, so feature-side imports are
// unchanged.
export type ScriptSection = 'intro' | 'body' | 'conclusion'

export interface ScriptSegment {
  section: ScriptSection
  heading: string
  narration: string
  /** Chapter/section grouping label for this BODY segment — consecutive
   * body segments sharing the same (trimmed, non-empty) `chapter` string
   * belong to one chapter. generateDeck.ts uses this to deterministically
   * insert an agenda slide (cover-adjacent) and a section_break slide at
   * each chapter boundary — see the sample-deck analysis: missing chapter
   * dividers/agenda was a top structural gap. Undefined when the script
   * writer didn't group segments (small decks, or intro/conclusion
   * segments, which are never chapter members). */
  chapter?: string
  /** One-sentence statement of this segment's implication/"so what"
   * conclusion (never a paraphrase of `narration`), ~40 full-width
   * characters or fewer — rendered as a calloutBox (or an emphasized
   * one-line conclusion) on that segment's slide by
   * buildSegmentSlideMessages, feeding the takeaway_presence metric.
   * Undefined when the script writer didn't supply one. */
  keyTakeaway?: string
}

export interface Script {
  title: string
  /** One-line cover subtitle; "" if the script writer didn't provide one. */
  subtitle: string
  segments: ScriptSegment[]
}

/** Hard ceiling on segment count, independent of GenerateOptions.maxSlides
 * (which is only a soft hint baked into the script-writing prompt) — bounds
 * how many per-segment slide-generation LLM calls a single generateDeck()
 * run can trigger, so a chatty local LLM asked for an "auto" slide count
 * can't produce a runaway-large deck. Also bounds lib/generateCheckpoint.ts's
 * orphan-key sweep when a checkpoint's manifest is unreadable. */
export const MAX_SCRIPT_SEGMENTS = 40

/** 'script': writing the full spoken narration (see GenerateOptions doc) —
 * replaces the old outline stage now that generation is script-first.
 * 'slides': turning each script segment into one visualized slide. */
export type GenerateStage = 'script' | 'slides' | 'evaluate' | 'refine' | 'done'

export interface GenerateProgressEvent {
  stage: GenerateStage
  message?: string
  /** 1-based refine iteration, present once stage reaches 'evaluate'/'refine'. */
  iteration?: number
  /** Latest DeckScore.total, present once at least one evaluation has run. */
  score?: number
  /** The freshly generated narration script — present exactly once, on the
   * event that ends the 'script' stage (never on a resumed run, whose script
   * was already checkpointed). Consumers use it to commit the script
   * checkpoint unit. */
  script?: Script
  /** 0-based script-segment index whose slide just finished, paired with
   * `slide`. Present on each per-segment completion event. */
  segmentIndex?: number
  /** The finished slide for `segmentIndex` (speakerNotes already set to the
   * segment narration verbatim). */
  slide?: Slide
  /** True when `slide` is a local placeholder because its LLM call
   * failed/returned garbage — checkpoint consumers must NOT mark such a
   * segment done, so a resumed run retries it instead of freezing the
   * placeholder into the deck. */
  slideIsFallback?: boolean
  /** Live snapshot of the deck as generated so far — cover/agenda/section
   * breaks included, not-yet-generated segments as skeleton placeholder
   * slides — for progressive UI rendering. Ephemeral: never persist this
   * as-is (pending placeholders would be frozen in). */
  partialDeck?: Deck
  /** Ids of the slides inside `partialDeck` that are still pending
   * placeholders, so the UI can render them as skeletons. */
  pendingSlideIds?: string[]
  /** Completed / total segment-slide counts backing `partialDeck`, for
   * compact "3/12" progress labels. */
  segmentsDone?: number
  segmentsTotal?: number
  /** Current whole-deck snapshot after a refine iteration, for checkpointing
   * mid-refine progress. Present on the 'evaluate' event that closes each
   * refine iteration. */
  refinedDeck?: Deck
}

export type GenerateProgressCallback = (event: GenerateProgressEvent) => void

export interface GenerateOptions {
  /** Output language for slide content (e.g. "en", "ja"). */
  language: string
  /** tc-shared-llm-config-v1 preset id; "" / omitted = the config's defaultPresetId. */
  presetId?: string
  /** "api" (default) or "network" — forwarded to lib/llm.ts's requestChatCompletion. */
  connection?: 'api' | 'network'
  audience?: string
  tone?: string
  /** Soft upper bound on total slide count (cover + one per script segment).
   * The script-writing pass is told to stay at/under this many segments when
   * given; when omitted, the LLM chooses however many segments the source
   * material naturally supports (a hard internal ceiling still applies so a
   * chatty local LLM can't produce a runaway-large deck — see
   * generateDeck.ts's MAX_SEGMENTS). Historically this was a hard target;
   * it's now a hint only, since slide count is decided by the narrative
   * structure the script-writing pass produces. */
  maxSlides?: number
  /** DeckScore.total floor to accept without further refinement. Default 80. */
  qualityThreshold?: number
  /** Max additional generate→evaluate cycles after the first pass. Default 3. */
  maxRefineIterations?: number
  /** Whether evaluateDeck's LLM-judged metrics run during the refine loop
   * (rule-based metrics always run regardless). Default true. */
  useLlmJudge?: boolean
  /** Whether generateDeck.ts's checkAndFixScript rule-checks the freshly
   * written narration script (features/generate/scriptCheck.ts's
   * checkScript) before any slide is generated from it, attempting one
   * bounded LLM repair call when issues are found. Default true. Set false
   * to skip the check entirely (e.g. to save the extra round-trip on a
   * script that's already known-good, such as a hand-edited resume input). */
  scriptCheck?: boolean
  /** Whether evaluateDeck's vision-LLM design-compliance metric runs during
   * the refine loop, in addition to the text-based judges above. Requires
   * `visionPresetId` (or the config's default preset) to point at a
   * vision-capable model; silently skipped (never throws) when unset, the
   * preset can't render/respond, or the browser environment can't render
   * slides offscreen — see lib/evaluator/visionJudge.ts. Default false. */
  useVisionJudge?: boolean
  /** tc-shared-llm-config-v1 preset id for the vision judge specifically
   * (e.g. an Ollama qwen2.5vl:7b preset) — falls back to `presetId` /
   * the config's defaultPresetId when omitted, but that default preset is
   * usually a text-only model, so setting this explicitly is recommended
   * whenever `useVisionJudge` is on. */
  visionPresetId?: string
  /** Prompt size profile for the slide-generation calls. 'full' (default)
   * embeds the complete style guide + all 12 block shapes; 'compact' embeds a
   * trimmed guide restricted to the 6 most common block kinds, sized for
   * small local models (~7B) whose instruction-following degrades on long
   * system prompts. Evaluation is unaffected — only generation prompts. */
  promptProfile?: 'full' | 'compact'
  /** How the refine stage regenerates a low-scoring deck. 'per_slide'
   * (default) re-generates only the worst-scoring slides with one small
   * bounded call each — robust for local LLMs whose single big-JSON refine
   * response tends to get truncated. 'batch' is the legacy whole-deck
   * single-call refine, which preserves the most cross-slide context and
   * suits large hosted models. */
  refineStrategy?: 'per_slide' | 'batch'
  /** Preset for the per-segment slide-generation "worker" calls (and the
   * per-slide refine calls), when it should differ from the main `presetId`
   * — the orchestrator/worker split: a strong model plans (script, batch
   * refine, evaluation) via `presetId` while a cheaper/faster model
   * mass-produces segment slides via this. Falls back to `presetId` (or the
   * config default) when omitted. */
  workerPresetId?: string
  /** How many per-segment slide-generation calls may run concurrently.
   * Default 1 (fully sequential, the historical behavior — also the safe
   * choice for local LLM servers, which typically process one request at a
   * time anyway). Hosted APIs can take 2-8. Clamped internally. */
  workerConcurrency?: number
  /** Prior progress to resume from (lib/generateCheckpoint.ts): the already-
   * committed script and per-segment slides are reused verbatim instead of
   * regenerated; only missing segments (and everything downstream) run.
   * Callers other than lib/generateJobs.ts's resume path should omit this. */
  resume?: GenerateResumeState
  signal?: AbortSignal
}

/** Checkpointed progress a resumed generateDeck() run starts from. */
export interface GenerateResumeState {
  script: Script
  /** 0-based segment index -> that segment's committed slide, exactly as it
   * was generated (speakerNotes = narration verbatim). Sparse: only
   * segments that completed (with a real, non-fallback slide) appear. */
  slides: Record<number, Slide>
  /** Present when at least one refine iteration was checkpointed: the deck
   * snapshot after the last completed iteration, and that iteration number.
   * The resumed run skips segment generation entirely and continues the
   * refine loop from here. */
  refined?: { deck: Deck; iteration: number }
}

/**
 * Generates a Deck from `sources`. Internally: write the full narration
 * script -> generate one visualized slide per script segment -> evaluate ->
 * (if DeckScore.total < opts.qualityThreshold) refine with feedback from the
 * lowest-scoring metrics -> re-evaluate, up to opts.maxRefineIterations
 * times, then returns the best-scoring attempt. `onProgress` fires at each
 * stage transition; it's optional so non-UI callers (tests, CLI-ish tools)
 * can omit it.
 */
export type GenerateDeckFn = (
  sources: SourceMaterial[],
  opts: GenerateOptions,
  onProgress?: GenerateProgressCallback,
) => Promise<Deck>

export const DEFAULT_QUALITY_THRESHOLD = 80
export const DEFAULT_MAX_REFINE_ITERATIONS = 3

// ---------------------------------------------------------------------------
// Evaluation (lib/evaluator)

/** One row per notes-slide-quality.md §4 "指標一覧" (original 15) plus the
 * four benchmark-derived metrics added from the 2025-12-23 sample-deck
 * analysis (structure_coverage / title_uniqueness / takeaway_presence /
 * layout_variety) — 19 weighted metrics total, weights still sum to 100. */
export type MetricId =
  | 'char_count_overflow'
  | 'single_message_per_slide'
  | 'bullet_parallelism'
  | 'narrative_flow'
  | 'visual_ratio'
  | 'title_specificity'
  | 'jargon_annotation'
  | 'empty_slide'
  | 'color_consistency'
  | 'contrast_legibility'
  | 'page_number_continuity'
  | 'quant_data_quality'
  | 'citation_presence'
  | 'speaker_notes_quality'
  | 'visual_text_redundancy'
  /** Structural completeness the sample deck lacked entirely: at least one
   * section_break divider per major topic shift, a summary slide near the
   * end, and an agenda early on. Rule-based over Slide.type. */
  | 'structure_coverage'
  /** No two content slides may share an identical title without a
   * distinguishing suffix (the sample repeated "Kademlia DHTの仕組み" 3×
   * unlabeled). Rule-based exact-match after trimming. */
  | 'title_uniqueness'
  /** Share of diagram/data slides that carry one explicit takeaway line
   * ("so what") — a calloutBox or single emphasized conclusion. The sample
   * managed only ~30-35%; target is >=60%. Hybrid: rule detects presence,
   * LLM judges whether the line actually states an implication. */
  | 'takeaway_presence'
  /** Penalizes 3+ consecutive slides sharing the same layout/dominant block
   * kind (after collapsing build groups) — the sample's monotony problem.
   * Rule-based. */
  | 'layout_variety'
  /** Opt-in-only metric (not part of the original 15's "weights sum to
   * 100" set — see lib/evaluator/weights.ts) scored by a vision-capable LLM
   * from a rendered PNG of each slide: whitespace/margins, text density, use
   * of structured blocks vs. a wall of text, and overall visual polish
   * against design-spec.md. Only present in DeckScore.metrics when
   * EvaluateDeckOptions.useVisionJudge is on and the judge call succeeds. */
  | 'vision_design_compliance'

export type MetricKind = 'rule' | 'llm'

export interface MetricScore {
  id: MetricId
  label: string
  kind: MetricKind
  /** Normalized 0-1 (before weighting). */
  score: number
  /** Point weight out of the 100-point total (see notes-slide-quality.md §4). */
  weight: number
  /** Whether this metric hit a fatal-defect gate (e.g. an empty slide),
   * which caps DeckScore.total regardless of other metrics' scores. */
  gate?: boolean
  /** One-line rationale, required for LLM-judged metrics, optional for rule-based ones. */
  reason?: string
}

export interface DeckScore {
  /** 0-100. */
  total: number
  /** True if any metric's `gate` tripped (deck should be treated as
   * unacceptable regardless of `total` — see notes-slide-quality.md §4
   * "致命的指標...足切り"). */
  gate: boolean
  metrics: MetricScore[]
  /** ISO 8601 */
  evaluatedAt: string
}

export interface EvaluateDeckOptions {
  /** Whether to run the LLM-judged metrics in addition to the rule-based
   * ones. Default true. Rule-based-only evaluation is fully deterministic
   * and synchronous-fast, useful for editor live-feedback. */
  useLlmJudge?: boolean
  presetId?: string
  connection?: 'api' | 'network'
  /** Whether to render each slide to a PNG and score it with a vision LLM
   * (the 'vision_design_compliance' metric). Default false — this is
   * significantly more expensive than the text-only judge and requires a
   * vision-capable preset. See GenerateOptions.useVisionJudge. */
  useVisionJudge?: boolean
  /** Preset id for the vision judge; falls back to `presetId` when omitted.
   * See GenerateOptions.visionPresetId. */
  visionPresetId?: string
  signal?: AbortSignal
}

export type EvaluateDeckFn = (deck: Deck, opts?: EvaluateDeckOptions) => Promise<DeckScore>

// ---------------------------------------------------------------------------
// Presentation (features/present)

export interface PresentPlayerProps {
  deck: Deck
  onExit: () => void
  /** Start auto-playing (TTS + auto-advance) immediately on mount. Default true. */
  autoPlay?: boolean
  /** tc-shared-llm-config-v1 preset id used for TTS voice resolution; "" /
   * omitted falls back to the shared config's `tts` entry (lib/tts.ts). */
  presetId?: string
}

// ---------------------------------------------------------------------------
// App shell / tab contracts (src/app.tsx <-> features/<name>)
//
// Each features/<name>/index.tsx is expected to `export default` a Preact
// component accepting the corresponding props type below. app.tsx lazy-loads
// these and owns the top-level sources/deck state; features read/write it
// through these props rather than duplicating state.

export interface SourcesTabProps {
  sources: SourceMaterial[]
  onSourcesChange: (sources: SourceMaterial[]) => void
}

export interface EditorTabProps {
  deck: Deck | null
  onDeckChange: (deck: Deck) => void
  sources: SourceMaterial[]
}

export interface PresentTabProps {
  deck: Deck | null
  /** Monotonically increasing counter bumped by app.tsx's navigate listener
   * whenever the CustomEvent detail carries `autoStart: true` (e.g. editor's
   * "Present" button — an explicit user action that should jump straight
   * into playing). PresentTab compares this against the last value it
   * consumed so a plain tab switch back to Present never re-triggers it. */
  autoStartToken?: number
}

export type SettingsTabProps = Record<string, never>
