// Static per-metric metadata for the 19 metrics: the original 15 from
// notes-slide-quality.md §4 ("指標一覧") plus 4 benchmark-derived metrics
// added from the 2025-12-23 sample-deck analysis (structure_coverage /
// title_uniqueness / takeaway_presence / layout_variety — see their MetricId
// doc comments in types.ts). Point weight (all 19 sum to exactly 100),
// display label, an internal classification (pure rule / hybrid rule+LLM /
// LLM-only — a finer split than types.ts's `MetricKind`, which only
// distinguishes what a *given* MetricScore instance ended up running as),
// and an English "improvement hint" per metric.
//
// The hints exist because MetricScore (types.ts) only carries a one-line
// `reason` (the *evaluation* rationale), not a dedicated "how to fix this"
// field — adding one would mean editing types.ts, which is out of this
// worker's file ownership. Instead features/generate's refine loop composes
// its regeneration prompt from `METRIC_IMPROVEMENT_HINTS[id]` (a stable,
// LLM-prompt-ready imperative instruction) plus each low-scoring metric's
// dynamic `reason`. See this file's final report note to the integrator: a
// first-class `MetricScore.feedback` field would be a reasonable follow-up
// if types.ts is revisited.
import type { MetricId } from '../../types'

export type MetricClass = 'rule' | 'hybrid' | 'llm'

export const METRIC_CLASS: Record<MetricId, MetricClass> = {
  char_count_overflow: 'rule',
  single_message_per_slide: 'llm',
  bullet_parallelism: 'hybrid',
  narrative_flow: 'llm',
  visual_ratio: 'rule',
  title_specificity: 'llm',
  jargon_annotation: 'llm',
  empty_slide: 'rule',
  color_consistency: 'rule',
  contrast_legibility: 'rule',
  page_number_continuity: 'rule',
  quant_data_quality: 'hybrid',
  citation_presence: 'hybrid',
  speaker_notes_quality: 'llm',
  visual_text_redundancy: 'llm',
  structure_coverage: 'rule',
  title_uniqueness: 'rule',
  takeaway_presence: 'hybrid',
  layout_variety: 'rule',
  vision_design_compliance: 'llm',
}

/** Point weights out of 100 — see notes-slide-quality.md §4's "重み(目安)"
 * column for the original 15, rebalanced against the 4 benchmark-derived
 * additions per the 2025-12-23 sample-deck analysis. All 19 entries below
 * sum to exactly 100, as documented in evaluator/index.ts.
 * `vision_design_compliance` is a 20th, opt-in-only addition (see types.ts's
 * MetricId doc) — its weight only enters DeckScore.total's rescaled average
 * when the vision judge actually ran that pass. */
export const METRIC_WEIGHT: Record<MetricId, number> = {
  char_count_overflow: 10,
  single_message_per_slide: 8,
  bullet_parallelism: 5,
  narrative_flow: 8,
  visual_ratio: 8,
  title_specificity: 5,
  jargon_annotation: 4,
  empty_slide: 7,
  color_consistency: 5,
  contrast_legibility: 5,
  page_number_continuity: 2,
  quant_data_quality: 5,
  citation_presence: 4,
  speaker_notes_quality: 4,
  visual_text_redundancy: 3,
  structure_coverage: 5,
  title_uniqueness: 3,
  takeaway_presence: 6,
  layout_variety: 3,
  vision_design_compliance: 10,
}

export const METRIC_LABEL: Record<MetricId, string> = {
  char_count_overflow: 'Character count limits',
  single_message_per_slide: 'Single message per slide',
  bullet_parallelism: 'Bullet parallelism',
  narrative_flow: 'Narrative flow',
  visual_ratio: 'Figure/diagram ratio',
  title_specificity: 'Title specificity',
  jargon_annotation: 'Jargon annotation',
  empty_slide: 'Empty/untitled slide check',
  color_consistency: 'Color palette consistency',
  contrast_legibility: 'Contrast & legibility',
  page_number_continuity: 'Page number continuity',
  quant_data_quality: 'Quantitative data quality',
  citation_presence: 'Citation presence',
  speaker_notes_quality: 'Speaker notes quality',
  visual_text_redundancy: 'Figure/text redundancy',
  structure_coverage: 'Structural coverage (agenda/section/summary)',
  title_uniqueness: 'Title uniqueness',
  takeaway_presence: 'Takeaway presence',
  layout_variety: 'Layout variety',
  vision_design_compliance: 'Vision judge: design compliance',
}

/** Imperative, English, LLM-prompt-ready instructions — fed into the refine
 * prompt for whichever metrics scored lowest. Kept generic (not slide-index
 * specific); per-metric `reason` text supplies the specifics. */
export const METRIC_IMPROVEMENT_HINTS: Record<MetricId, string> = {
  char_count_overflow:
    'Trim this slide: title must be <=25 characters, total body text <=120 characters, each bullet <=30 characters, and no more than 6 bullets. Cut, do not just rewrap.',
  single_message_per_slide:
    'This slide covers more than one idea. Split it into multiple slides or cut everything that is not the single main point.',
  bullet_parallelism:
    'Make bullets at the same indent level grammatically parallel: either all noun phrases or all verb phrases, not a mix.',
  narrative_flow:
    'Restructure the deck so it follows background -> objective -> proposal -> evaluation -> conclusion in order, with no missing or out-of-order sections.',
  visual_ratio:
    'Rebalance the deck so roughly 60-90% of slides carry a diagram/chart/image/table — add a simple visual to text-only slides, or simplify slides that are visual-only with no context.',
  title_specificity:
    'Replace generic titles (e.g. "Overview", "Summary") with a specific title naming the actual subject, number, or outcome of the slide.',
  jargon_annotation:
    'Add a short parenthetical or footnote explanation the first time a technical term or acronym is used.',
  empty_slide:
    'This slide has no title and/or no content. Give it a specific, non-empty title and at least one bullet, paragraph, or visual element, or remove the slide.',
  color_consistency:
    'Reuse only the deck theme palette colors (primary/secondary/accentWarning/neutralGray) for visual elements, and keep the same color meaning the same category (e.g. one color per layer/topic) across all slides.',
  contrast_legibility:
    'Increase the contrast between text color and background color to at least a 4.5:1 ratio (WCAG AA) for body text.',
  page_number_continuity:
    'Renumber slides so `index` is a contiguous sequence starting at 1 with no gaps or duplicates.',
  quant_data_quality:
    'For every table/chart, include a unit, a stated significant-digit precision, and axis/column labels; qualify quantitative claims in the text (comparison basis, uncertainty).',
  citation_presence:
    'Add a citation (source text, and a URL if available) for every slide that uses external data, a quoted figure, an image, or a screenshot.',
  speaker_notes_quality:
    'Write speaker notes that add information beyond the visible bullets: background context on numbers, likely audience questions, or transition cues — not empty or a verbatim restatement of the slide.',
  visual_text_redundancy:
    'Remove text that only restates what the diagram/chart already shows; keep on-slide text limited to what the visual cannot convey on its own.',
  structure_coverage:
    'Add an agenda slide within the first 3 slides, at least one section_break divider at each major topic shift in the main body (2+ when the deck has more than 16 content slides), and a summary slide within the last 3 slides.',
  title_uniqueness:
    'Give every slide a distinct title. When the same topic spans multiple slides, add a distinguishing suffix (e.g. a part number or sub-topic) instead of repeating the exact same title verbatim.',
  takeaway_presence:
    'Every diagram/data slide needs one explicit takeaway line stating what the figure implies, not just what it shows — add a short calloutBox or a single concise conclusion sentence, and make sure it states an actual implication rather than restating the figure.',
  layout_variety:
    'Break up runs of 3+ consecutive slides that share the same layout and dominant block kind — alternate layouts or block kinds (pillRow/boxGroup/mindmap/flow/etc.) to keep the deck visually varied.',
  vision_design_compliance:
    "Rework this slide's visual layout per the design spec: increase margins/whitespace, cut text density, prefer structured blocks (pillRow/boxGroup/mindmap/flow/etc.) over paragraphs or a wall of bullets, and match a clean, high-signal reference-deck composition.",
}
