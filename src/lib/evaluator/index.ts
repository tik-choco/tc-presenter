// evaluateDeck: the EvaluateDeckFn (types.ts) implementation. Orchestrates
// the 9 pure-rule metrics + rule side of 4 hybrid metrics (rules.ts, always
// synchronous/deterministic), when `opts.useLlmJudge` is true the single
// batched LLM-judge call (llmJudge.ts) covering the 6 LLM-only metrics plus
// the LLM side of the 4 hybrids, and when `opts.useVisionJudge` is true the
// separate vision-LLM call (visionJudge.ts) that scores a rendered PNG of
// each slide against design-spec.md's visual bar.
//
// Score/weight bookkeeping: every metric's `score` is normalized 0-1 and its
// `weight` is its point value out of 100 (weights.ts's METRIC_WEIGHT, which
// sum to exactly 100 across the 19 metrics — vision_design_compliance is a
// 20th, opt-in-only addition on top of that set, see its MetricId doc in
// types.ts). `DeckScore.total` is `sum(score*weight) / sum(weight) * 100`,
// rescaled by whichever metrics actually ran this time — so a rule-only pass
// (useLlmJudge: false, or the LLM judge failing/being unconfigured) still
// yields a meaningful 0-100 total over the 13 metrics that did run (weight
// 68), not a total that's silently capped at 68; the same rescaling is why
// turning useVisionJudge on/off doesn't skew totals out of the 0-100 range
// even though the metric set's total weight changes.
import type { Deck, DeckScore, EvaluateDeckFn, EvaluateDeckOptions, MetricId, MetricScore } from '../../types'
import { runLlmJudge, type LlmSlideJudgment } from './llmJudge'
import { clamp01, computeRuleMetrics, type RuleMetricOutcome } from './rules'
import { runVisionJudge } from './visionJudge'
import { METRIC_LABEL, METRIC_WEIGHT } from './weights'

export { METRIC_CLASS, METRIC_IMPROVEMENT_HINTS, METRIC_LABEL, METRIC_WEIGHT, type MetricClass } from './weights'
export { computeRuleMetrics, finalFormSlides } from './rules'

function aggregateSlideField(
  slides: LlmSlideJudgment[],
  field: keyof Omit<LlmSlideJudgment, 'index'>,
): RuleMetricOutcome {
  if (slides.length === 0) return { score: 1, reason: 'No slides to judge.' }

  const values = slides.map((s) => s[field])
  const avg = values.reduce((sum, v) => sum + v, 0) / values.length
  const weak = slides.filter((s) => s[field] < 0.5).map((s) => `#${s.index}`)
  const reason = weak.length
    ? `Avg ${avg.toFixed(2)} across ${slides.length} slide(s); weakest: ${weak.slice(0, 5).join(', ')}${weak.length > 5 ? '…' : ''}.`
    : `Avg ${avg.toFixed(2)} across ${slides.length} slide(s).`
  return { score: clamp01(avg), reason }
}

export const evaluateDeck: EvaluateDeckFn = async (deck: Deck, opts?: EvaluateDeckOptions): Promise<DeckScore> => {
  const useLlmJudge = opts?.useLlmJudge ?? true
  const useVisionJudge = opts?.useVisionJudge ?? false
  const rule = computeRuleMetrics(deck)

  const llm = useLlmJudge
    ? await runLlmJudge(deck, { presetId: opts?.presetId, connection: opts?.connection, signal: opts?.signal })
    : null

  // Runs after the text judge rather than in parallel with it: both are
  // best-effort/never-throw, but sequencing keeps this evaluator's total
  // concurrent LLM calls bounded to one at a time, which matters for local
  // (Ollama/LM Studio) providers that only serve one request at a time.
  const vision = useVisionJudge
    ? await runVisionJudge(deck, { presetId: opts?.visionPresetId || opts?.presetId, signal: opts?.signal })
    : null

  const metrics: MetricScore[] = []

  const pushRule = (id: MetricId, outcome: RuleMetricOutcome): void => {
    const entry: MetricScore = {
      id,
      label: METRIC_LABEL[id],
      kind: 'rule',
      score: outcome.score,
      weight: METRIC_WEIGHT[id],
      reason: outcome.reason,
    }
    if (outcome.gate) entry.gate = true
    metrics.push(entry)
  }

  pushRule('char_count_overflow', rule.char_count_overflow)
  pushRule('visual_ratio', rule.visual_ratio)
  pushRule('empty_slide', rule.empty_slide)
  pushRule('color_consistency', rule.color_consistency)
  pushRule('contrast_legibility', rule.contrast_legibility)
  pushRule('page_number_continuity', rule.page_number_continuity)
  pushRule('structure_coverage', rule.structure_coverage)
  pushRule('title_uniqueness', rule.title_uniqueness)
  pushRule('layout_variety', rule.layout_variety)

  // Hybrid metrics: blended with the LLM judge when available, otherwise
  // reported as rule-only (still using the metric's full point weight — the
  // rule component alone is still a meaningful, if partial, signal).
  const pushHybrid = (id: MetricId, ruleOutcome: RuleMetricOutcome, llmOutcome?: RuleMetricOutcome): void => {
    if (llmOutcome) {
      metrics.push({
        id,
        label: METRIC_LABEL[id],
        kind: 'llm',
        score: clamp01((ruleOutcome.score + llmOutcome.score) / 2),
        weight: METRIC_WEIGHT[id],
        reason: `Rule: ${ruleOutcome.reason} | LLM: ${llmOutcome.reason}`,
      })
    } else {
      metrics.push({
        id,
        label: METRIC_LABEL[id],
        kind: 'rule',
        score: ruleOutcome.score,
        weight: METRIC_WEIGHT[id],
        reason: ruleOutcome.reason,
      })
    }
  }

  const pushLlmOnly = (id: MetricId, outcome: RuleMetricOutcome): void => {
    metrics.push({
      id,
      label: METRIC_LABEL[id],
      kind: 'llm',
      score: outcome.score,
      weight: METRIC_WEIGHT[id],
      reason: outcome.reason,
    })
  }

  if (llm) {
    pushHybrid('bullet_parallelism', rule.bullet_parallelism_rule, aggregateSlideField(llm.slides, 'bulletParallelism'))
    pushHybrid('quant_data_quality', rule.quant_data_quality_rule, aggregateSlideField(llm.slides, 'quantQuality'))
    pushHybrid('citation_presence', rule.citation_presence_rule, aggregateSlideField(llm.slides, 'citationOk'))
    pushHybrid('takeaway_presence', rule.takeaway_presence_rule, aggregateSlideField(llm.slides, 'takeaway01'))

    pushLlmOnly('single_message_per_slide', aggregateSlideField(llm.slides, 'singleMessage'))
    pushLlmOnly('title_specificity', aggregateSlideField(llm.slides, 'titleSpecificity'))
    pushLlmOnly('jargon_annotation', aggregateSlideField(llm.slides, 'jargonAnnotation'))
    pushLlmOnly('speaker_notes_quality', aggregateSlideField(llm.slides, 'speakerNotes'))
    pushLlmOnly('visual_text_redundancy', aggregateSlideField(llm.slides, 'visualTextRedundancy'))
    pushLlmOnly('narrative_flow', llm.narrativeFlow)
  } else {
    pushHybrid('bullet_parallelism', rule.bullet_parallelism_rule)
    pushHybrid('quant_data_quality', rule.quant_data_quality_rule)
    pushHybrid('citation_presence', rule.citation_presence_rule)
    pushHybrid('takeaway_presence', rule.takeaway_presence_rule)
    // narrative_flow and the remaining pure-LLM metrics have no rule
    // fallback (they require semantic judgment) — they're simply omitted
    // when the LLM judge didn't run; `total` rescales over what did run.
  }

  if (vision) {
    metrics.push({
      id: 'vision_design_compliance',
      label: METRIC_LABEL.vision_design_compliance,
      kind: 'llm',
      score: vision.score,
      weight: METRIC_WEIGHT.vision_design_compliance,
      reason: vision.reason,
    })
  }
  // vision_design_compliance is simply omitted when useVisionJudge is off or
  // the judge call didn't produce a result — same "total rescales over
  // whatever ran" rule as every other metric here.

  const totalWeight = metrics.reduce((sum, m) => sum + m.weight, 0)
  const total = totalWeight > 0 ? Math.round((metrics.reduce((sum, m) => sum + m.score * m.weight, 0) / totalWeight) * 100) : 0
  const gate = metrics.some((m) => m.gate === true)

  return { total, gate, metrics, evaluatedAt: new Date().toISOString() }
}

export default evaluateDeck
