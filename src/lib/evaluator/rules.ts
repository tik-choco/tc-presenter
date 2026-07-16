// Pure, synchronous, deterministic implementations of the rule-based half of
// the 19 metrics (the original 15 from notes-slide-quality.md §4 plus 4
// benchmark-derived additions, see types.ts's MetricId doc): the 9 pure-rule
// metrics (char_count_overflow, visual_ratio, empty_slide, color_consistency,
// contrast_legibility, page_number_continuity, structure_coverage,
// title_uniqueness, layout_variety) plus the rule-side component of the 4
// hybrid metrics (bullet_parallelism, quant_data_quality, citation_presence,
// takeaway_presence — see METRIC_CLASS in weights.ts). No LLM calls, no
// network I/O, no `await` — safe to call from synchronous contexts (e.g. the
// editor's live-feedback UI) via `computeRuleMetrics`.
import type {
  BulletForm,
  Deck,
  ParagraphBlock,
  PositionedBlock,
  Slide,
  SlideBullet,
  SlideBody,
  SlideType,
  SlideVisual,
  VisualKind,
} from '../../types'
import { contrastRatio, normalizeHex } from './colorUtils'

export interface RuleMetricOutcome {
  score: number
  reason: string
  gate?: boolean
}

export interface RuleMetrics {
  char_count_overflow: RuleMetricOutcome
  visual_ratio: RuleMetricOutcome
  empty_slide: RuleMetricOutcome
  color_consistency: RuleMetricOutcome
  contrast_legibility: RuleMetricOutcome
  page_number_continuity: RuleMetricOutcome
  bullet_parallelism_rule: RuleMetricOutcome
  quant_data_quality_rule: RuleMetricOutcome
  citation_presence_rule: RuleMetricOutcome
  structure_coverage: RuleMetricOutcome
  title_uniqueness: RuleMetricOutcome
  takeaway_presence_rule: RuleMetricOutcome
  layout_variety: RuleMetricOutcome
}

export function clamp01(value: number): number {
  if (Number.isNaN(value)) return 0
  return Math.min(1, Math.max(0, value))
}

/** Collapses `buildStage`-grouped slides (same `groupId`) down to each
 * group's highest `stageIndex` (its final, fully-revealed form), per
 * types.ts's Slide.buildStage doc and notes-slide-quality.md §5's footnote.
 * Standalone slides (no group) pass through unchanged. Preserves the deck's
 * original slide order (first appearance of a group wins the position). */
export function finalFormSlides(deck: Deck): Slide[] {
  const bestByGroup = new Map<string, Slide>()
  for (const slide of deck.slides) {
    const groupId = slide.buildStage.isBuildSlide ? slide.buildStage.groupId : null
    if (!groupId) continue
    const current = bestByGroup.get(groupId)
    const stage = slide.buildStage.stageIndex ?? 0
    if (!current || (current.buildStage.stageIndex ?? 0) < stage) bestByGroup.set(groupId, slide)
  }

  const emittedGroups = new Set<string>()
  const result: Slide[] = []
  for (const slide of deck.slides) {
    const groupId = slide.buildStage.isBuildSlide ? slide.buildStage.groupId : null
    if (!groupId) {
      result.push(slide)
      continue
    }
    if (emittedGroups.has(groupId)) continue
    emittedGroups.add(groupId)
    const winner = bestByGroup.get(groupId)
    if (winner) result.push(winner)
  }
  return result
}

function bodyCharCount(body: SlideBody): number {
  const bulletChars = body.bullets.reduce((sum, b) => sum + b.text.length, 0)
  const paraChars = body.paragraphs.reduce((sum, p) => sum + p.length, 0)
  return bulletChars + paraChars
}

function hasVisualContent(visual: SlideVisual): boolean {
  return visual.kind !== 'none' || visual.elements.length > 0 || !!visual.dataTable || !!visual.chart
}

function isSlideEmpty(slide: Slide): boolean {
  const noTitle = slide.title.text.trim() === ''
  const noBody =
    slide.body.bullets.every((b) => b.text.trim() === '') && slide.body.paragraphs.every((p) => p.trim() === '')
  const noVisual = !hasVisualContent(slide.visual)
  return noTitle || (noBody && noVisual)
}

// --- 1. char_count_overflow -------------------------------------------------

const TITLE_MAX = 25
const BODY_MAX = 120
const BULLET_MAX = 30
const BULLET_COUNT_MAX = 6

function charCountOverflow(slides: Slide[]): RuleMetricOutcome {
  if (slides.length === 0) return { score: 1, reason: 'No slides to check.' }

  let violationRatioSum = 0
  const offenders: string[] = []
  for (const slide of slides) {
    let violations = 0
    if (slide.title.text.length > TITLE_MAX) violations += 1
    if (bodyCharCount(slide.body) > BODY_MAX) violations += 1
    if (slide.body.bullets.some((b) => b.text.length > BULLET_MAX)) violations += 1
    if (slide.body.bullets.length > BULLET_COUNT_MAX) violations += 1
    if (violations > 0) offenders.push(`#${slide.index}`)
    violationRatioSum += violations / 4
  }

  const score = clamp01(1 - violationRatioSum / slides.length)
  const reason = offenders.length
    ? `${offenders.length}/${slides.length} slide(s) exceed length limits (title>${TITLE_MAX}, body>${BODY_MAX}, bullet>${BULLET_MAX}, or >${BULLET_COUNT_MAX} bullets): ${offenders.slice(0, 5).join(', ')}${offenders.length > 5 ? '…' : ''}.`
    : 'All slides are within title/body/bullet length limits.'
  return { score, reason }
}

// --- 5. visual_ratio ---------------------------------------------------------

const VISUAL_RATIO_MIN = 0.6
const VISUAL_RATIO_MAX = 0.9

function visualRatio(slides: Slide[]): RuleMetricOutcome {
  if (slides.length === 0) return { score: 1, reason: 'No slides to check.' }

  const ratio = slides.filter((s) => hasVisualContent(s.visual)).length / slides.length
  let score: number
  if (ratio >= VISUAL_RATIO_MIN && ratio <= VISUAL_RATIO_MAX) score = 1
  else if (ratio < VISUAL_RATIO_MIN) score = clamp01(ratio / VISUAL_RATIO_MIN)
  else score = clamp01(1 - (ratio - VISUAL_RATIO_MAX) / (1 - VISUAL_RATIO_MAX))

  return {
    score,
    reason: `${Math.round(ratio * 100)}% of slides carry a visual (target ${VISUAL_RATIO_MIN * 100}-${VISUAL_RATIO_MAX * 100}%).`,
  }
}

// --- 8. empty_slide (gate) ---------------------------------------------------

function emptySlideCheck(deck: Deck): RuleMetricOutcome {
  const slides = deck.slides // checked pre-collapse: every printed slide must stand on its own
  if (slides.length === 0) return { score: 0, gate: true, reason: 'Deck has no slides.' }

  const offenders = slides.filter(isSlideEmpty)
  const gate = offenders.length > 0
  const score = clamp01(1 - offenders.length / slides.length)
  const reason = gate
    ? `${offenders.length} slide(s) are empty or untitled: ${offenders
        .slice(0, 5)
        .map((s) => `#${s.index}`)
        .join(', ')}${offenders.length > 5 ? '…' : ''}.`
    : 'No empty or untitled slides.'
  return { score, gate, reason }
}

// --- 9. color_consistency ----------------------------------------------------

function colorConsistency(deck: Deck): RuleMetricOutcome {
  const palette = new Set(
    Object.values(deck.theme.colorPalette)
      .map((c) => normalizeHex(c))
      .filter((c): c is string => !!c),
  )

  const usedColors: string[] = []
  for (const slide of deck.slides) {
    for (const el of slide.visual.elements) {
      const norm = normalizeHex(el.color)
      if (norm) usedColors.push(norm)
    }
  }

  if (usedColors.length === 0) return { score: 1, reason: 'No visual elements use explicit colors.' }

  const offPalette = usedColors.filter((c) => !palette.has(c))
  const distinctOffPalette = [...new Set(offPalette)]
  const score = clamp01(1 - offPalette.length / usedColors.length)
  const reason = distinctOffPalette.length
    ? `${offPalette.length}/${usedColors.length} visual-element colors fall outside the theme palette (${distinctOffPalette.slice(0, 5).join(', ')}).`
    : 'All visual-element colors match the theme palette.'
  return { score, reason }
}

// --- 10. contrast_legibility --------------------------------------------------

function contrastLegibility(deck: Deck): RuleMetricOutcome {
  const { textPrimary, background, primary, secondary } = deck.theme.colorPalette
  const pairs: Array<[string, string, number]> = [
    [textPrimary, background, 1],
    [primary, background, 0.5],
    [secondary, background, 0.5],
  ]

  let weightedScore = 0
  let weightSum = 0
  const details: string[] = []
  for (const [fg, bg, weight] of pairs) {
    const ratio = contrastRatio(fg, bg)
    if (ratio === null) continue
    const s = clamp01(ratio / 4.5)
    weightedScore += s * weight
    weightSum += weight
    details.push(`${fg} on ${bg} = ${ratio.toFixed(2)}:1`)
  }

  if (weightSum === 0) return { score: 1, reason: 'Theme colors could not be parsed as hex; check skipped.' }

  return { score: clamp01(weightedScore / weightSum), reason: `Contrast ratios — ${details.join('; ')} (target >=4.5:1).` }
}

// --- 11. page_number_continuity -----------------------------------------------

function pageNumberContinuity(deck: Deck): RuleMetricOutcome {
  const slides = deck.slides
  if (slides.length === 0) return { score: 1, reason: 'No slides to check.' }

  let matches = 0
  const mismatches: string[] = []
  slides.forEach((slide, i) => {
    if (slide.index === i + 1) matches += 1
    else mismatches.push(`position ${i + 1} has index ${slide.index}`)
  })

  const score = clamp01(matches / slides.length)
  const reason = mismatches.length
    ? `Non-contiguous slide indices: ${mismatches.slice(0, 5).join(', ')}${mismatches.length > 5 ? '…' : ''}.`
    : 'Slide indices are a contiguous sequence starting at 1.'
  return { score, reason }
}

// --- 3. bullet_parallelism (rule component) -----------------------------------

function bulletParallelismRule(slides: Slide[]): RuleMetricOutcome {
  let consistentGroups = 0
  let totalGroups = 0
  const offenders = new Set<string>()

  for (const slide of slides) {
    const byLevel = new Map<number, SlideBullet[]>()
    for (const bullet of slide.body.bullets) {
      const list = byLevel.get(bullet.level) ?? []
      list.push(bullet)
      byLevel.set(bullet.level, list)
    }
    for (const bullets of byLevel.values()) {
      if (bullets.length < 2) continue
      const forms = bullets.map((b) => b.form).filter((f): f is BulletForm => !!f)
      if (forms.length < 2) continue // not enough form metadata on this group to judge
      totalGroups += 1
      const allSame = forms.every((f) => f === forms[0])
      if (allSame) consistentGroups += 1
      else offenders.add(`#${slide.index}`)
    }
  }

  if (totalGroups === 0) {
    return { score: 1, reason: 'No multi-bullet groups with `form` metadata to check (structural check skipped).' }
  }

  const score = clamp01(consistentGroups / totalGroups)
  const reason = offenders.size
    ? `Mixed noun-phrase/verb-phrase bullets within a level in: ${[...offenders].slice(0, 5).join(', ')}.`
    : 'Bullets are grammatically parallel within each indent level.'
  return { score, reason }
}

// --- 12. quant_data_quality (rule component) ----------------------------------

function quantDataQualityRule(slides: Slide[]): RuleMetricOutcome {
  let checked = 0
  let ok = 0
  const offenders: string[] = []

  for (const slide of slides) {
    const table = slide.visual.dataTable
    if (table) {
      checked += 1
      const good = table.unit.trim() !== '' && table.significantDigits > 0 && table.headers.length > 0 && table.rows.length > 0
      if (good) ok += 1
      else offenders.push(`#${slide.index} table`)
    }
    const chart = slide.visual.chart
    if (chart) {
      checked += 1
      const good = chart.xLabel.trim() !== '' && chart.yLabel.trim() !== '' && chart.series.length > 0
      if (good) ok += 1
      else offenders.push(`#${slide.index} chart`)
    }
  }

  if (checked === 0) return { score: 1, reason: 'No tables/charts present (nothing to check).' }

  const score = clamp01(ok / checked)
  const reason = offenders.length
    ? `Tables/charts missing unit, significant digits, or axis/column labels: ${offenders.slice(0, 5).join(', ')}.`
    : 'Tables/charts include units, precision, and labels.'
  return { score, reason }
}

// --- 13. citation_presence (rule component) -----------------------------------

const CITATION_REQUIRED_KINDS: VisualKind[] = ['image', 'screenshot', 'chart_line', 'chart_bar', 'table']

function citationPresenceRule(slides: Slide[]): RuleMetricOutcome {
  const requiring = slides.filter(
    (s) => CITATION_REQUIRED_KINDS.includes(s.visual.kind) || !!s.visual.dataTable || !!s.visual.chart,
  )
  if (requiring.length === 0) {
    return { score: 1, reason: 'No slides use external data, images, or charts that would require a citation.' }
  }

  const missing = requiring.filter((s) => !s.citation || s.citation.text.trim() === '')
  const score = clamp01(1 - missing.length / requiring.length)
  const reason = missing.length
    ? `${missing.length}/${requiring.length} data/image slide(s) are missing a citation: ${missing
        .slice(0, 5)
        .map((s) => `#${s.index}`)
        .join(', ')}.`
    : 'All data/image/chart slides carry a citation.'
  return { score, reason }
}

// --- 16. structure_coverage ----------------------------------------------------

/** Slide types that make up the deck's structural scaffolding rather than its
 * main body — excluded from the "本編" (main body) count that drives the
 * section_break expectation below. */
const STRUCTURAL_SLIDE_TYPES: SlideType[] = ['title', 'agenda', 'summary', 'section_break']

/** Below this total slide count, the agenda/section_break sub-scores are
 * awarded in full regardless — a 5-slide deck doesn't need an agenda or a
 * topic-shift divider, per the sample-deck analysis's "don't over-demand
 * structure on tiny decks" note. */
const STRUCTURE_SMALL_DECK_MAX = 5

function structureCoverage(slides: Slide[]): RuleMetricOutcome {
  if (slides.length === 0) return { score: 1, reason: 'No slides to check.' }

  const smallDeck = slides.length <= STRUCTURE_SMALL_DECK_MAX
  const firstThree = slides.slice(0, 3)
  const lastThree = slides.slice(-3)
  const bodySlideCount = slides.filter((s) => !STRUCTURAL_SLIDE_TYPES.includes(s.type)).length

  const hasAgenda = firstThree.some((s) => s.type === 'agenda')
  const agendaOk = smallDeck || hasAgenda
  const agendaScore = agendaOk ? 0.25 : 0

  const hasSummary = lastThree.some((s) => s.type === 'summary')
  const summaryScore = hasSummary ? 0.4 : 0

  const sectionBreakCount = slides.filter((s) => s.type === 'section_break').length
  const expectedBreaks = bodySlideCount > 16 ? 2 : bodySlideCount > 8 ? 1 : 0
  const sectionBreakOk = smallDeck || sectionBreakCount >= expectedBreaks
  const sectionBreakScore = sectionBreakOk ? 0.35 : 0

  const score = clamp01(agendaScore + summaryScore + sectionBreakScore)

  const gaps: string[] = []
  if (!agendaOk) gaps.push('no agenda slide within the first 3')
  if (!hasSummary) gaps.push('no summary slide within the last 3')
  if (!sectionBreakOk) gaps.push(`only ${sectionBreakCount}/${expectedBreaks} expected section_break divider(s)`)

  const reason = gaps.length
    ? `Structural gaps: ${gaps.join('; ')}.`
    : 'Deck has an agenda, expected section breaks, and a summary in the expected positions.'
  return { score, reason }
}

// --- 17. title_uniqueness -------------------------------------------------------

function titleUniqueness(slides: Slide[]): RuleMetricOutcome {
  const candidates = slides.filter((s) => s.type !== 'section_break' && s.type !== 'title')
  if (candidates.length === 0) return { score: 1, reason: 'No slides to check for duplicate titles.' }

  const counts = new Map<string, number>()
  for (const slide of candidates) {
    const key = slide.title.text.trim().toLowerCase()
    if (!key) continue
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }

  const duplicates = [...counts.entries()].filter(([, count]) => count > 1)
  const excess = duplicates.reduce((sum, [, count]) => sum + (count - 1), 0)
  const score = clamp01(1 - excess / candidates.length)
  const reason = duplicates.length
    ? `Duplicate titles found: ${duplicates.map(([title, count]) => `"${title}" x${count}`).join(', ')}.`
    : 'All slide titles are unique.'
  return { score, reason }
}

// --- 18. takeaway_presence (rule component) --------------------------------------

/** Block kinds that mark a slide as "図解・データ系" (diagram/data-bearing) for
 * takeaway-line purposes, per the sample-deck analysis. */
const TAKEAWAY_VISUAL_BLOCK_KINDS: PositionedBlock['kind'][] = [
  'pillRow',
  'boxGroup',
  'mindmap',
  'flow',
  'gridHeatmap',
  'comparison',
  'visual',
]
const TAKEAWAY_SLIDE_TYPES: SlideType[] = ['diagram', 'data_table', 'chart']
/** "短い(全角60字以内)" — a takeaway line longer than this reads as a restated
 * description, not a punchy conclusion. */
const TAKEAWAY_MAX_LEN = 60

function isTakeawayCandidate(slide: Slide): boolean {
  const blocks = slide.blocks ?? []
  const hasVisualBlock = blocks.some((b) => TAKEAWAY_VISUAL_BLOCK_KINDS.includes(b.kind))
  return hasVisualBlock || TAKEAWAY_SLIDE_TYPES.includes(slide.type)
}

function isParagraphBlock(block: PositionedBlock): block is ParagraphBlock & PositionedBlock {
  return block.kind === 'paragraph'
}

function isConclusionLine(text: string): boolean {
  const trimmed = text.trim()
  return trimmed !== '' && trimmed.length <= TAKEAWAY_MAX_LEN
}

function hasTakeawayLine(slide: Slide): boolean {
  const blocks = slide.blocks ?? []
  if (blocks.some((b) => b.kind === 'calloutBox')) return true

  const paragraphBlocks = blocks.filter(isParagraphBlock)
  if (paragraphBlocks.length === 1 && isConclusionLine(paragraphBlocks[0].text)) return true

  if (slide.body.paragraphs.length === 1 && isConclusionLine(slide.body.paragraphs[0])) return true

  return false
}

function takeawayPresenceRule(slides: Slide[]): RuleMetricOutcome {
  const targets = slides.filter(isTakeawayCandidate)
  if (targets.length === 0) return { score: 1, reason: 'No diagram/data slides to check for a takeaway line.' }

  const withTakeaway = targets.filter(hasTakeawayLine)
  const ratio = withTakeaway.length / targets.length
  const score = clamp01(ratio / 0.6)
  const reason = `${withTakeaway.length}/${targets.length} diagram/data slide(s) carry an explicit takeaway line (target >=60%).`
  return { score, reason }
}

// --- 19. layout_variety -----------------------------------------------------------

/** A slide's "sameness" signature for layout-monotony purposes: its layout
 * plus the dominant block kind (first block, or the legacy visual's kind
 * when there are no blocks). */
function layoutSignature(slide: Slide): string {
  const blocks = slide.blocks ?? []
  const dominant = blocks.length > 0 ? blocks[0].kind : slide.visual.kind
  return `${slide.layout}|${dominant}`
}

/** Consecutive-same-signature run length that counts as monotony rather than
 * intentional structure. Raised from 3 to 4: prompts.ts's STYLE_GUIDE now
 * directs the LLM to use "progressive disclosure" for information-heavy
 * topics — 2-3 consecutive slides that deliberately repeat the same
 * layout+block-kind signature, adding only 1-2 elements per step. A 3-slide
 * run is that intended pattern, not a defect, so it must not be flagged;
 * a 4+ run still reads as genuine layout fatigue. */
const MONOTONY_RUN_THRESHOLD = 4

function layoutVariety(slides: Slide[]): RuleMetricOutcome {
  if (slides.length === 0) return { score: 1, reason: 'No slides to check.' }

  const signatures = slides.map(layoutSignature)
  let runs = 0
  const offenders: string[] = []
  let i = 0
  while (i < signatures.length) {
    let j = i + 1
    while (j < signatures.length && signatures[j] === signatures[i]) j += 1
    const runLength = j - i
    if (runLength >= MONOTONY_RUN_THRESHOLD) {
      runs += 1
      offenders.push(`#${slides[i].index}-#${slides[j - 1].index} (${signatures[i]})`)
    }
    i = j
  }

  const maxAllowedRuns = Math.max(1, Math.floor(slides.length / 3))
  const score = clamp01(1 - runs / maxAllowedRuns)
  const reason = runs
    ? `${runs} run(s) of ${MONOTONY_RUN_THRESHOLD}+ consecutive same-layout slides: ${offenders.join(', ')}.`
    : `No ${MONOTONY_RUN_THRESHOLD}+ consecutive slides share the same layout and dominant block kind.`
  return { score, reason }
}

/** Runs every rule-based metric (and the rule-side component of every hybrid
 * metric) synchronously. No LLM/network calls — safe for live-feedback UI. */
export function computeRuleMetrics(deck: Deck): RuleMetrics {
  const finalSlides = finalFormSlides(deck)
  return {
    char_count_overflow: charCountOverflow(finalSlides),
    visual_ratio: visualRatio(finalSlides),
    empty_slide: emptySlideCheck(deck),
    color_consistency: colorConsistency(deck),
    contrast_legibility: contrastLegibility(deck),
    page_number_continuity: pageNumberContinuity(deck),
    bullet_parallelism_rule: bulletParallelismRule(finalSlides),
    quant_data_quality_rule: quantDataQualityRule(finalSlides),
    citation_presence_rule: citationPresenceRule(finalSlides),
    // Evaluated on the raw, pre-collapse slide list — agenda/summary
    // position and section_break placement are about the deck's physical
    // page sequence, same rationale as empty_slide above.
    structure_coverage: structureCoverage(deck.slides),
    title_uniqueness: titleUniqueness(finalSlides),
    takeaway_presence_rule: takeawayPresenceRule(finalSlides),
    layout_variety: layoutVariety(finalSlides),
  }
}
