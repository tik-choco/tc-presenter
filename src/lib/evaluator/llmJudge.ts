// The LLM-judged half of the 15 metrics (single_message_per_slide,
// narrative_flow, title_specificity, jargon_annotation, speaker_notes_quality,
// visual_text_redundancy — plus the LLM-side component of the 3 hybrid rule
// metrics) is deliberately collapsed into ONE requestChatCompletion call per
// evaluateDeck(), not one call per metric/slide: local LLMs (Ollama/LM
// Studio, per PLAN.md) are slow and a naive per-metric fan-out would mean
// dozens of round trips for a single evaluation. The prompt asks the model to
// return one compact JSON object scoring every field for every slide at once.
//
// Never throws: any failure (no provider configured, network error, timeout,
// unparsable response) resolves to `null`, and the caller (index.ts)
// degrades to rule-only scoring for the affected metrics.
import { requestChatCompletion, type ChatMessage } from '../llm'
import type { Deck, Slide, SlideVisual } from '../../types'
import { extractJson } from './json'
import { clamp01, finalFormSlides } from './rules'

const JUDGE_TIMEOUT_MS = 180_000
const MAX_JUDGE_SLIDES = 60

export interface LlmSlideJudgment {
  index: number
  singleMessage: number
  titleSpecificity: number
  jargonAnnotation: number
  speakerNotes: number
  visualTextRedundancy: number
  bulletParallelism: number
  citationOk: number
  quantQuality: number
  /** LLM-side component of the takeaway_presence hybrid metric: does this
   * slide's diagram/data carry a takeaway line that actually states an
   * implication (not just a restatement of the figure)? See rules.ts's
   * takeawayPresenceRule for the rule-side presence check this pairs with. */
  takeaway01: number
}

export interface LlmJudgeResult {
  narrativeFlow: { score: number; reason: string }
  /** Per-slide judgments; index.ts's aggregateSlideField averages any field
   * here (including takeaway01) into a deck-level score for the caller. */
  slides: LlmSlideJudgment[]
}

export interface RunLlmJudgeOptions {
  presetId?: string
  connection?: 'api' | 'network'
  signal?: AbortSignal
}

const SYSTEM_PROMPT = `You are a strict presentation-quality judge for slide decks.
Score every requested field from 0 (bad) to 1 (good), using fractional values (e.g. 0.3, 0.75) when useful.
If a check does not apply to a given slide (e.g. no jargon present, no numeric data, no external data used), score that field 1 (no penalty).
Respond with ONLY a single JSON object — no prose, no markdown code fences — matching exactly this shape:
{"narrativeFlow":{"score":0,"reason":"..."},"slides":[{"index":1,"singleMessage":0,"titleSpecificity":0,"jargonAnnotation":0,"speakerNotes":0,"visualTextRedundancy":0,"bulletParallelism":0,"citationOk":0,"quantQuality":0,"takeaway01":0}]}

Field meanings:
- narrativeFlow.score (deck-level, one value): does the WHOLE deck follow background -> objective -> proposal -> evaluation -> conclusion, in a sensible order, with nothing important missing?
- singleMessage: does this slide make exactly one point? 0 if it mixes multiple unrelated points.
- titleSpecificity: is the title specific (names the actual subject/number/outcome) rather than a generic label like "Overview" or "Summary"?
- jargonAnnotation: are technical terms/acronyms used in this slide explained on first use (a short parenthetical or note)?
- speakerNotes: do the speaker notes add real value (background context, numbers explained, likely audience questions) beyond just repeating the bullets? 0 if empty or a verbatim restatement.
- visualTextRedundancy: 1 if the slide's text does NOT just restate what its own diagram/chart/table already shows; 0 if it is redundant with the visual.
- bulletParallelism: are bullets at the same indent level grammatically parallel (all noun phrases or all verb phrases, not mixed)?
- citationOk: if this slide uses external data, a quote, an image, or a screenshot, is it cited? 1 if it uses no external data.
- quantQuality: if this slide presents numeric data, is it presented with units, precision, and appropriate qualification? 1 if it has no numeric data.
- takeaway01: if this slide is a diagram/chart/table/data slide, does it carry an explicit takeaway line that states an actual implication ("so what") rather than just describing or restating what the figure already shows? 0 if there is no conclusion line at all, or if the only text present merely repeats the figure. 1 if this slide has no diagram/chart/table/data content that would need one.`

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value
}

function describeVisual(visual: SlideVisual): string {
  const parts: string[] = [visual.kind]
  if (visual.elements.length) parts.push(`${visual.elements.length} element(s)`)
  if (visual.dataTable) parts.push('table')
  if (visual.chart) parts.push('chart')
  return parts.join(', ')
}

function buildSlideDigest(slide: Slide): string {
  const bullets = slide.body.bullets
    .map((b) => `  - (level ${b.level}${b.form ? `, ${b.form}` : ''}) ${truncate(b.text, 80)}`)
    .join('\n')
  const paragraphs = slide.body.paragraphs.map((p) => `  - ${truncate(p, 120)}`).join('\n')
  const citation = slide.citation?.text ? `citation: ${truncate(slide.citation.text, 60)}` : 'citation: (none)'
  const notes = slide.speakerNotes.trim() ? truncate(slide.speakerNotes, 200) : '(empty)'

  return [
    `#${slide.index} [${slide.type}] "${truncate(slide.title.text, 60)}"`,
    bullets ? `bullets:\n${bullets}` : undefined,
    paragraphs ? `paragraphs:\n${paragraphs}` : undefined,
    `visual: ${describeVisual(slide.visual)}`,
    citation,
    `speakerNotes: ${notes}`,
  ]
    .filter((line): line is string => !!line)
    .join('\n')
}

function num01(value: unknown, fallback = 0.6): number {
  return typeof value === 'number' && Number.isFinite(value) ? clamp01(value) : fallback
}

interface RawJudgeSlide {
  index?: number
  singleMessage?: number
  titleSpecificity?: number
  jargonAnnotation?: number
  speakerNotes?: number
  visualTextRedundancy?: number
  bulletParallelism?: number
  citationOk?: number
  quantQuality?: number
  takeaway01?: number
}

interface RawJudgeResponse {
  narrativeFlow?: { score?: number; reason?: string }
  slides?: RawJudgeSlide[]
}

/** Runs the single batched LLM-judge call for `deck`. Returns null (never
 * throws) if no LLM is configured, the request fails/times out, or the
 * response can't be parsed as JSON at all — per-field gaps within an
 * otherwise-parsable response fall back to a neutral 0.6 score instead of
 * failing the whole judgment. */
export async function runLlmJudge(deck: Deck, opts: RunLlmJudgeOptions): Promise<LlmJudgeResult | null> {
  const slides = finalFormSlides(deck)
  if (slides.length === 0) return null

  const included = slides.slice(0, MAX_JUDGE_SLIDES)
  const omittedCount = slides.length - included.length
  const digest = included.map(buildSlideDigest).join('\n\n')
  const omittedNote = omittedCount > 0 ? `\n\n(${omittedCount} further slide(s) omitted for brevity.)` : ''
  const userPrompt = `Deck title: ${deck.title}\nContent language: ${deck.lang}\n\n${digest}${omittedNote}`

  const messages: ChatMessage[] = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: userPrompt },
  ]

  let raw: string
  try {
    raw = await requestChatCompletion(messages, {
      presetId: opts.presetId,
      connection: opts.connection,
      signal: opts.signal,
      temperature: 0.2,
      timeoutMs: JUDGE_TIMEOUT_MS,
    })
  } catch {
    return null
  }

  const parsed = extractJson<RawJudgeResponse>(raw)
  if (!parsed || typeof parsed !== 'object') return null

  const narrativeFlow = {
    score: num01(parsed.narrativeFlow?.score),
    reason:
      typeof parsed.narrativeFlow?.reason === 'string' && parsed.narrativeFlow.reason.trim() !== ''
        ? parsed.narrativeFlow.reason.trim()
        : 'LLM judge did not provide a rationale.',
  }

  const rawSlides = Array.isArray(parsed.slides) ? parsed.slides : []
  const byIndex = new Map<number, RawJudgeSlide>()
  for (const entry of rawSlides) {
    if (entry && typeof entry === 'object' && typeof entry.index === 'number') byIndex.set(entry.index, entry)
  }

  const judgedSlides: LlmSlideJudgment[] = included.map((slide) => {
    const entry = byIndex.get(slide.index)
    return {
      index: slide.index,
      singleMessage: num01(entry?.singleMessage),
      titleSpecificity: num01(entry?.titleSpecificity),
      jargonAnnotation: num01(entry?.jargonAnnotation),
      speakerNotes: num01(entry?.speakerNotes),
      visualTextRedundancy: num01(entry?.visualTextRedundancy),
      bulletParallelism: num01(entry?.bulletParallelism),
      citationOk: num01(entry?.citationOk),
      quantQuality: num01(entry?.quantQuality),
      takeaway01: num01(entry?.takeaway01),
    }
  })

  return { narrativeFlow, slides: judgedSlides }
}
