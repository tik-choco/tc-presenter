// The vision-LLM half of the evaluator: renders a sample of slides to PNGs
// (visionRender.tsx) and asks a vision-capable model (e.g. Ollama's
// qwen2.5vl:7b) to score each one against design-spec.md's visual bar —
// whitespace/margins, text density, use of the structured `blocks` model vs.
// a wall of text, and overall polish. Modeled directly on llmJudge.ts's
// shape/conventions (one batched-ish call, num01 defaulting, never throws)
// so evaluator/index.ts can treat it the same way; the two differences are
// (1) this one is opt-in (useVisionJudge) since it's far more expensive
// (image payloads + a vision-capable model), and (2) it samples a bounded
// subset of slides rather than the whole deck, since every sampled slide
// costs an offscreen render plus image tokens.
import { requestChatCompletion, type ChatContentPart, type MultimodalChatMessage } from '../llm'
import type { Deck, Slide } from '../../types'
import { extractJson } from './json'
import { clamp01, finalFormSlides } from './rules'
import { renderSlideToPng } from './visionRender'

const VISION_TIMEOUT_MS = 90_000
/** Vision calls are expensive (image tokens + a render pass per slide); cap
 * how many of the deck's slides get judged per evaluateDeck() pass rather
 * than sending every slide of a large deck. */
const MAX_VISION_SLIDES = 8

export interface VisionSlideJudgment {
  index: number
  whitespaceMargins: number
  textDensity: number
  structureUse: number
  visualPolish: number
  feedback: string
}

export interface VisionJudgeResult {
  /** Aggregate 0-1 score across the four fields, averaged over judged slides. */
  score: number
  /** Compact summary (weakest slides + their feedback) fed into
   * evaluateDeck's metric `reason`, which in turn flows into the refine
   * prompt via prompts.ts's buildRefineMessages (same mechanism as every
   * other low-scoring metric — see METRIC_IMPROVEMENT_HINTS). */
  reason: string
}

export interface RunVisionJudgeOptions {
  /** Preset id for the vision-capable model. */
  presetId?: string
  signal?: AbortSignal
}

const SYSTEM_PROMPT = `You are a strict visual-design judge for slide-deck images (one image per slide, provided in order).
Score every field 0 (bad) to 1 (good), fractional values allowed. Judge against this bar:
- Generous margins and whitespace; content should not crowd the edges or feel crammed.
- Low text density: a slide should read as a few short structured pieces (labeled pills, boxes, a short diagram, a couple of bullets), never a dense paragraph or a long bullet list.
- Visible structure: prefer slides that use clearly bounded shapes (pills, boxes, a diagram, a table) over plain running text — a slide that is just a title and a paragraph/long bullet list should score LOW on structureUse.
- Overall polish: consistent, restrained color use; clear visual hierarchy (title stands out, one clear focal point); looks like a professional conference/research presentation.
- Some slides embed a real photo/screenshot (not a placeholder box) — that is legitimate content, not a structural deficiency, and must never be penalized on structureUse for "lacking structure". For those slides, judge polish by whether the image is appropriately sized/positioned (not stretched, cropped awkwardly, or overflowing its frame) and has a proper caption.
Respond with ONLY a single JSON object — no prose, no markdown code fences — matching exactly this shape:
{"slides":[{"index":1,"whitespaceMargins":0,"textDensity":0,"structureUse":0,"visualPolish":0,"feedback":"one short actionable sentence"}]}`

function num01(value: unknown, fallback = 0.6): number {
  return typeof value === 'number' && Number.isFinite(value) ? clamp01(value) : fallback
}

interface RawVisionSlide {
  index?: number
  whitespaceMargins?: number
  textDensity?: number
  structureUse?: number
  visualPolish?: number
  feedback?: string
}

/** Evenly samples up to `max` slides across the deck (always including the
 * first and last), preserving original order — a large deck gets a
 * representative spread rather than just its opening slides. */
function sampleSlides(slides: Slide[], max: number): Slide[] {
  if (slides.length <= max) return slides
  const chosen = new Map<number, Slide>()
  const step = (slides.length - 1) / (max - 1)
  for (let i = 0; i < max; i += 1) {
    const slide = slides[Math.round(i * step)]
    if (slide) chosen.set(slide.index, slide)
  }
  return [...chosen.values()].sort((a, b) => a.index - b.index)
}

/** Runs the vision judge for `deck`. Returns null (never throws) if there's
 * nothing to judge, the environment can't render slides offscreen, no slide
 * rendered successfully, the request fails/times out, or the response can't
 * be parsed — evaluator/index.ts treats null exactly like llmJudge.ts's null
 * (skip the metric, fall back to the text-only evaluation). */
export async function runVisionJudge(deck: Deck, opts: RunVisionJudgeOptions): Promise<VisionJudgeResult | null> {
  const slides = sampleSlides(finalFormSlides(deck), MAX_VISION_SLIDES)
  if (slides.length === 0) return null

  const parts: ChatContentPart[] = [
    {
      type: 'text',
      text: `Deck title: ${deck.title}\nTheme colors — primary ${deck.theme.colorPalette.primary}, secondary ${deck.theme.colorPalette.secondary}, background ${deck.theme.colorPalette.background}.\n${slides.length} slide image(s) follow, in order.`,
    },
  ]

  const rendered: Slide[] = []
  for (const slide of slides) {
    const png = await renderSlideToPng(slide, deck.theme, deck.slides.length)
    if (!png) continue
    rendered.push(slide)
    parts.push({ type: 'text', text: `--- Slide #${slide.index}: "${slide.title.text}" ---` })
    parts.push({ type: 'image_url', image_url: { url: png } })
  }
  if (rendered.length === 0) return null

  const messages: MultimodalChatMessage[] = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: parts },
  ]

  let raw: string
  try {
    raw = await requestChatCompletion(messages, {
      presetId: opts.presetId,
      // Images can't travel over the AI Network's text-only protocol — see
      // lib/llm.ts's requestChatCompletion network-branch guard.
      connection: 'api',
      signal: opts.signal,
      temperature: 0.2,
      timeoutMs: VISION_TIMEOUT_MS,
    })
  } catch {
    return null
  }

  const parsed = extractJson<{ slides?: RawVisionSlide[] }>(raw)
  if (!parsed || typeof parsed !== 'object') return null

  const rawSlides = Array.isArray(parsed.slides) ? parsed.slides : []
  const byIndex = new Map<number, RawVisionSlide>()
  for (const entry of rawSlides) {
    if (entry && typeof entry === 'object' && typeof entry.index === 'number') byIndex.set(entry.index, entry)
  }

  const judged: VisionSlideJudgment[] = rendered.map((slide) => {
    const entry = byIndex.get(slide.index)
    const whitespaceMargins = num01(entry?.whitespaceMargins)
    const textDensity = num01(entry?.textDensity)
    const structureUse = num01(entry?.structureUse)
    const visualPolish = num01(entry?.visualPolish)
    return {
      index: slide.index,
      whitespaceMargins,
      textDensity,
      structureUse,
      visualPolish,
      feedback: typeof entry?.feedback === 'string' && entry.feedback.trim() ? entry.feedback.trim() : '',
    }
  })

  const perSlideAvg = judged.map((j) => (j.whitespaceMargins + j.textDensity + j.structureUse + j.visualPolish) / 4)
  const score = clamp01(perSlideAvg.reduce((sum, v) => sum + v, 0) / perSlideAvg.length)

  const weakest = judged
    .map((j, i) => ({ j, avg: perSlideAvg[i] }))
    .filter(({ avg }) => avg < 0.6)
    .sort((a, b) => a.avg - b.avg)
    .slice(0, 4)

  const reason = weakest.length
    ? `Avg ${score.toFixed(2)} across ${judged.length} rendered slide(s); weakest: ${weakest
        .map(({ j }) => `#${j.index}${j.feedback ? ` (${j.feedback})` : ''}`)
        .join('; ')}.`
    : `Avg ${score.toFixed(2)} across ${judged.length} rendered slide(s); no slide fell below the visual-design bar.`

  return { score, reason }
}
