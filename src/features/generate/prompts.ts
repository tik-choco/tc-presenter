// Prompt builders for the script-first pipeline: write the full narration
// script -> generate one block-visualized slide per script segment -> refine.
// English system prompts always (per PLAN.md's LLM-usage convention, mirrored
// from tc-news's generate.ts: "システムプロンプトは英語固定+{language}差し込み");
// only the *content* language of the generated deck follows
// `GenerateOptions.language`. Kept deliberately compact/structured — this
// targets local LLMs (Ollama/LM Studio) over a bounded-timeout connection,
// not a frontier hosted model, so prompts favor explicit JSON shape
// repetition over cleverness. The script-then-slide split itself mirrors
// ../tc-news/src/lib/programGenerate.ts's "write the narration once, up
// front, as one structured document" approach.
import type { ChatMessage } from '../../lib/llm'
import type { Deck, DeckScore, GenerateOptions, Slide, SourceMaterial } from '../../types'
import type { ScriptSegment } from './parse'
import { METRIC_IMPROVEMENT_HINTS } from '../../lib/evaluator'

const MAX_SOURCE_CHARS = 2_000
const MAX_SOURCES_IN_PROMPT = 8

/** The quality baseline this app targets, distilled from grading a real
 * three-layer-architecture research deck (see notes-slide-quality.md §1-3):
 * short titles/bullets, one message per slide, citations, non-empty speaker
 * notes. Repeated verbatim in every generation/refine prompt. */
const STYLE_GUIDE = `Slide quality bar (matches a strong reference deck we benchmark against):
- Title: ~10-20 characters, specific (names the actual subject/number/outcome), never a generic label like "Overview".
- Progressive disclosure for information-heavy topics: instead of inventing a new diagram each time, split them into consecutive slides that repeat almost the same block structure and add/change/highlight only 1-2 elements per step — this stepwise build-up (not one overloaded slide) is the reference deck's signature move for dense content.
- Element budget: at most 6-8 independent visual elements per slide (each pill/box/icon/label is one element; an arrow-connected pair counts as one), 3-5 is the target. Over budget means split into another slide, never shrink the elements to fit.
- Exactly ONE message per slide: most slides are ONE structured block plus its key message, stated as a single short (~1 line) caption/paragraph beneath the block, nothing else. On-slide text budget (title excluded) ~20-60 characters, hard limit 100; pill/box/label text 4-10 characters; description/bullet lines 15-25 characters. If an idea needs more room, split it into multiple slides (progressive disclosure, above) instead of cramming.
- Bullets are a last resort, not a default: at most 3 bullets, each ONE line (no wrapped sentences), and only when no block above fits — before writing even a 2-item bullet list, check whether it converts to a pillRow or boxGroup instead. A deck where most slides are bullet lists is a quality failure — most slides should carry exactly one structured block instead.
- On-slide text is a KEYWORD/summary extracted from the narration, never the narration's sentences pasted verbatim — the audience hears the full sentence spoken aloud and reads only the label/number on the slide.
- Color discipline: white background + primary (wine-red) is the default for everything; the "warning" color role is reserved strictly for caution/exclusion/a called-out risk or trend, never for plain emphasis. Flat fills and thin borders only — no gradients, no drop shadows.
- Every slide that uses external data, a quote, an image, or a screenshot MUST have a citation (source text, and a URL if you have one).
- Tables (dataTable / visual "table") stay within 5-8 rows x 3-6 columns. Code or raw JSON is the one case allowed a denser, longer block of text instead of trying to compress it into pills/bullets.
- Prefer a diagram/chart/table/structured block over a wall of text where the source material supports it.
- If an imageRef block in the CURRENT slide JSON you were given already has an "assetId", copy that exact string through unchanged — never delete, edit, or invent one. An imageRef's "description" (if present) describes what the image actually shows; use it as grounding context for nearby text/speakerNotes, never restate it verbatim on the slide. When you add a brand-new imageRef yourself, leave "assetId" unset — it is a placeholder reference only and must never be invented.`

/** design-spec.md §4.1's block-selection guide, reproduced close to
 * verbatim — this is the vocabulary the segment-slide prompt below asks the
 * LLM to choose from instead of defaulting to a plain bullet list. */
const BLOCK_GUIDE = `Content block vocabulary — prefer ONE of these structured blocks over a plain paragraph/bullet list whenever the segment's content fits one:
- pillRow: a short horizontal/vertical list of labeled pills (4-10 characters each), each optionally with a one-line description. This is the default choice for standalone KEYWORDS/terms as well as agendas, category breakdowns, parallel factors/conclusions. variant "filled" + color "primary" = a keyword/conclusion/confirmed fact/named term (solid primary pill, white text); "outline" = an intermediate/unconfirmed category. Max 6 items.
- iconRow: a row of pictogram+label pairs describing parallel concepts/components. Set excluded:true on an item that is explicitly out of scope — it renders grayed out with a red X (this is the one place the warning/red color is expected). Max 5 items.
- boxGroup: rounded boxes as containers. layout "single" = one highlighted box, "grid" = a matrix of same-size cells (give gridRows/gridCols and a legend mapping each box color to its meaning; this is the right shape for an allocation/breakdown-by-cell slide), "nested" = a hierarchy of boxes inside boxes.
- mindmap: one root concept branching into up to 6 labeled nodes (each optionally with sub-branches, max depth 2), laid out left (root) to right (branches). Use for agendas and goal/topic breakdowns, and — reuse the EXACT SAME mindmap for both an agenda slide and a closing summary slide, changing only the slide title, when this deck has both.
- comparison: two labeled columns (left/right), each a heading + up to 4 bullets. Use for before/after, abstract-vs-concrete, option-A-vs-option-B.
- flow: a vertical/horizontal sequence of up to 5 pill-shaped steps for a step-by-step PROCEDURE. Prefix each step's text with its circled-number position (①②③④⑤) so the sequence still reads in order.
- gridHeatmap: a colored-cell grid with an explicit legend (color -> meaning). Use for a genuine categorical allocation/distribution breakdown, never as decoration.
- calloutBox: a highlighted box with a heading + up to 4 bullets, for a single "key takeaway"/"advantage" aside.
- paragraph / bulletList: fall back to these ONLY when the content is genuinely prose or a short flat list (max 3 items, one line each) that doesn't fit any block above — a bullet-heavy slide should be the exception in this deck, not the norm.
- quote: a single attributed quotation, no other content on the slide.
- imageRef: a screenshot/external figure/raw-data excerpt — ALWAYS include caption and, if external, source. Reference material only, never invented.
- visual: escape hatch for network graphs, flowcharts, data tables (keep to 5-8 rows x 3-6 columns), line/bar charts — use the "visual" field's kind/elements/dataTable/chart shape.
Rules: at most 3 blocks per slide (prefer 1 — one block plus its caption is the target shape for most slides). Set "column":"left"/"right" to pair exactly two blocks side by side; omit column (defaults "full") otherwise. Cover/title slides must NOT use blocks at all.`

/** design-spec.md §3's PositionedBlock shapes, condensed to exact field
 * names per `kind` so a local LLM has something to copy structurally instead
 * of guessing — full prose examples for all 12 kinds would blow the prompt
 * budget, so this is a compact cheatsheet instead. */
const BLOCK_SHAPES = `Block JSON shapes (fill exactly these fields; every block also accepts an optional top-level "column":"left"|"right"):
{"kind":"pillRow","direction":"horizontal|vertical","items":[{"text":"","description":"","variant":"filled|outline","color":"primary|secondary|warning|neutral"}]}
{"kind":"iconRow","items":[{"label":"","icon":"user|server|database|...","excluded":false}]}
{"kind":"boxGroup","layout":"single|grid|nested","gridRows":0,"gridCols":0,"boxes":[{"label":"","text":"","variant":"filled|outline","color":"primary","row":0,"col":0}],"legend":[{"color":"primary","label":""}]}
{"kind":"mindmap","root":"","branches":[{"label":"","variant":"outline","color":"primary","children":[{"label":""}]}]}
{"kind":"comparison","left":{"heading":"","bullets":[""]},"right":{"heading":"","bullets":[""]}}
{"kind":"flow","direction":"vertical|horizontal","steps":[{"text":"","variant":"filled","color":"primary"}]}
{"kind":"gridHeatmap","rows":0,"cols":0,"cells":[{"row":0,"col":0,"colorKey":"a"}],"legend":[{"colorKey":"a","color":"primary","label":""}],"annotation":""}
{"kind":"calloutBox","heading":"","bullets":[""],"color":"secondary"}
{"kind":"paragraph","text":""}
{"kind":"bulletList","bullets":[{"text":"","level":0,"form":"noun_phrase|verb_phrase"}]}
{"kind":"quote","text":"","attribution":""}
{"kind":"imageRef","caption":"","source":{"text":"","url":""},"assetId":"(copy through unchanged from the input if present, otherwise omit — never invent one)","description":"(copy through unchanged from the input if present)"}
{"kind":"visual","visual":{"kind":"network_graph|flowchart|table|chart_line|chart_bar|icon_diagram","elements":[{"type":"box|icon|arrow|node|edge","label":"","color":"#7a2048","position":{"x":0,"y":0,"w":0,"h":0}}],"dataTable":{"headers":[],"rows":[],"unit":"","significantDigits":3},"chart":{"type":"line|bar","xLabel":"","yLabel":"","series":[{"name":"","points":[[0,0]]}],"annotation":""}}}`

// ---------------------------------------------------------------------------
// Compact prompt profile (GenerateOptions.promptProfile === 'compact', see
// types.ts's doc): trimmed guides for small local models (~7B) whose
// instruction-following degrades on long system prompts. Restricted to the 6
// most-common structured blocks plus the paragraph fallback — comparable to
// STYLE_GUIDE/BLOCK_GUIDE/BLOCK_SHAPES above but compressed to well under
// half the length. The 'full' profile (default) is unaffected.

const STYLE_GUIDE_COMPACT = `Slide quality bar:
- Title: 10-20 chars, specific, never generic ("Overview").
- Info-heavy topics: split into consecutive slides that repeat the same block structure, changing/adding only 1-2 elements each time — don't cram into one slide.
- Element budget: max 6-8 visual elements per slide (3-5 ideal; each pill/box/icon/label is one element).
- ONE message per slide: one block + short caption below it. On-slide text ~20-60 chars, hard limit 100.
- Bullets are a last resort: max 3, one line each — check if it converts to a pillRow/boxGroup first.
- On-slide text = extracted keywords only, never narration sentences.
- Colors: white background + primary (wine-red) default; "warning" color only for risk/exclusion.
- Cite any slide using external data, a quote, or an image.`

const BLOCK_GUIDE_COMPACT = `Content blocks — prefer ONE of these over a plain paragraph/bullet list:
- pillRow: short labeled pills (terms, categories, agenda items). Max 6.
- boxGroup: rounded boxes; layout "single"|"grid"|"nested" ("grid" needs gridRows/gridCols + a legend).
- flow: up to 5 sequential pill-shaped steps for a procedure, prefix each with ①②③.
- comparison: two columns (left/right), each a heading + up to 4 bullets.
- calloutBox: heading + up to 4 bullets — the single "key takeaway" aside.
- bulletList / paragraph: fallback ONLY when nothing above fits.
Rules: at most 2 blocks per slide (prefer 1). Cover/title slides use no blocks.`

const BLOCK_SHAPES_COMPACT = `Block JSON shapes (fill exactly these fields):
{"kind":"pillRow","items":[{"text":"","variant":"filled|outline","color":"primary|secondary|warning|neutral"}]}
{"kind":"boxGroup","layout":"single|grid|nested","gridRows":0,"gridCols":0,"boxes":[{"label":"","text":"","color":"primary","row":0,"col":0}],"legend":[{"color":"primary","label":""}]}
{"kind":"flow","steps":[{"text":"","color":"primary"}]}
{"kind":"comparison","left":{"heading":"","bullets":[""]},"right":{"heading":"","bullets":[""]}}
{"kind":"calloutBox","heading":"","bullets":[""],"color":"secondary"}
{"kind":"bulletList","bullets":[{"text":"","level":0}]}
{"kind":"paragraph","text":""}`

function getStyleGuide(opts: GenerateOptions): string {
  return opts.promptProfile === 'compact' ? STYLE_GUIDE_COMPACT : STYLE_GUIDE
}

function getBlockGuide(opts: GenerateOptions): string {
  return opts.promptProfile === 'compact' ? BLOCK_GUIDE_COMPACT : BLOCK_GUIDE
}

function getBlockShapes(opts: GenerateOptions): string {
  return opts.promptProfile === 'compact' ? BLOCK_SHAPES_COMPACT : BLOCK_SHAPES
}

function slideJsonShape(): string {
  return `{
  "type": "title|agenda|content|diagram|quote|summary|data_table|chart|section_break",
  "layout": "single_column|two_column_text_diagram|diagram_centered|full_bleed_image|grid",
  "title": { "text": "string, required, non-empty", "badge": { "number": 1, "label": "string" } },
  "body": { "bullets": [], "paragraphs": [] },
  "visual": { "kind": "none", "elements": [] },
  "blocks": [ /* 0-3 items, see the block shapes below — leave [] if body/visual already cover the content, e.g. an agenda/quote slide */ ],
  "citation": { "text": "string", "url": "string" },
  "speakerNotes": "string, required, non-empty",
  "buildStage": { "isBuildSlide": false, "groupId": null, "stageIndex": null }
}`
}

function formatSources(sources: SourceMaterial[]): string {
  return sources
    .slice(0, MAX_SOURCES_IN_PROMPT)
    .map((s, i) => {
      const body = s.body.length > MAX_SOURCE_CHARS ? `${s.body.slice(0, MAX_SOURCE_CHARS)}…` : s.body
      const links = s.sourceLinks?.length ? `\nlinks: ${s.sourceLinks.map((l) => `${l.title} <${l.url}>`).join(', ')}` : ''
      return `[Source ${i + 1}] ${s.title}${s.sourceUrl ? ` <${s.sourceUrl}>` : ''}\n${body}${links}`
    })
    .join('\n\n')
}

/** Builds the script-writing prompt: ONE call that produces the deck's full
 * spoken narration, structured into intro/body/conclusion segments, BEFORE
 * any slide exists. `GenerateOptions.maxSlides` is now only a soft hint on
 * total segment count (see types.ts's doc) — when omitted, the model picks
 * however many segments the material naturally supports. */
export function buildScriptMessages(sources: SourceMaterial[], opts: GenerateOptions): ChatMessage[] {
  const capLine = opts.maxSlides
    ? `Keep the TOTAL segment count (intro + body + conclusion) at or under ${opts.maxSlides}.`
    : 'Choose however many segments the material naturally supports — a typical deck runs 6-20 total segments, but let the content decide; do not pad or compress artificially.'

  const system = `You are an expert presentation speechwriter. Write the FULL spoken narration script for a presentation, BEFORE any slide exists — slides are generated afterwards, one per segment, purely to visualize what you write here. Produce strict JSON only — no prose, no markdown fences.
Output shape exactly:
{"title": "deck title in ${opts.language}, punchy and ~10-20 characters — becomes the bold white headline on the full-bleed primary-color cover card, so keep it short", "subtitle": "optional ONE short line (<=30 characters) cover subtitle in ${opts.language}, shown small beneath the title, or \\"\\"", "segments": [ {"section": "intro|body|conclusion", "heading": "short topic label in ${opts.language}, 10-20 characters, becomes that slide's title", "narration": "the full spoken text for this segment in ${opts.language}, 80-200 words of natural, complete spoken sentences", "chapter": "chapter/section name in ${opts.language} shared by every body segment in the same chapter, or \\"\\" — see the grouping rule below", "keyTakeaway": "ONE sentence in ${opts.language}, ~40 characters or fewer, stating this segment's implication/conclusion — never a paraphrase of narration. Required for every segment, all sections."} ]}
Structure: exactly ONE "intro" segment (motivation/context), one or more "body" segments — each ONE coherent idea/step/finding, since each body segment becomes exactly ONE slide, so keep every body segment focused on a SINGLE point — and exactly ONE "conclusion" segment (wrap-up / takeaway). Follow a background -> objective -> proposal/content -> evaluation -> conclusion narrative arc across the body segments (adapt to the source material's actual subject).
Progressive disclosure: when a single topic carries more content than one slide comfortably holds, do NOT compress it into one dense body segment — write it as 2-4 CONSECUTIVE body segments that each add exactly ONE new point/step/detail on top of the previous one (each becomes its own slide that reuses the previous slide's visual structure with a small addition). These still count toward the total segment cap below, they are not extra segments on top of it.
${capLine}
Chapter grouping: if you write MORE THAN 6 body segments, group them into 2-5 chapters by giving every body segment in the same chapter the exact SAME "chapter" string (consecutive body segments only — never interleave two chapters). Leave "chapter":"" when you write 6 or fewer body segments, and always for intro/conclusion segments.
"narration" must be the actual words to be spoken aloud — not an outline, not bullet fragments. It will be used verbatim as that slide's speaker notes.`

  const audience = opts.audience ? `\nTarget audience: ${opts.audience}` : ''
  const tone = opts.tone ? `\nTone: ${opts.tone}` : ''
  const user = `Source material:\n\n${formatSources(sources)}${audience}${tone}\n\nProduce the narration script JSON now.`

  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ]
}

/** Builds the per-segment slide-generation prompt: ONE small call per
 * script segment (local-LLM-friendly, per PLAN.md — a single "visualize this
 * one paragraph" request is far more reliable than "write N slides" in one
 * shot). The LLM picks the slide's type/layout/blocks freely; speakerNotes
 * is intentionally NOT trusted from this call (generateDeck.ts overwrites it
 * with `segment.narration` verbatim regardless of what comes back here). */
export function buildSegmentSlideMessages(
  segment: ScriptSegment,
  segmentNumber: number,
  totalSegments: number,
  sources: SourceMaterial[],
  opts: GenerateOptions,
  /** layout+dominant-block-kind signature of the immediately preceding
   * generated slide (see generateDeck.ts's layoutSignature helper) — passed
   * so this prompt can steer away from repeating the same structure three
   * times in a row (the layout_variety metric's monotony penalty). Omitted
   * for the first segment slide, and for every slide when segments generate
   * concurrently (there is no meaningful "previous" then). */
  previousLayoutSignature?: string,
  /** Deck-wide variety plan's pre-assigned block kind for this segment (see
   * generateDeck.ts's planLayoutHints): the layout_variety defense that
   * works even when segment slides generate concurrently. Soft — the prompt
   * says content fit always wins. */
  layoutHint?: string,
): ChatMessage[] {
  const typeHint =
    segment.section === 'conclusion'
      ? 'a "summary" or "content" slide'
      : segment.section === 'intro'
        ? 'a "content", "agenda", or "diagram" slide (never "title" — the deck cover is generated separately)'
        : 'whichever of content/diagram/data_table/chart/quote best fits this segment'

  const takeawayLine = segment.keyTakeaway
    ? `This segment's key takeaway is: "${segment.keyTakeaway}". Render it as exactly ONE calloutBox block (heading = short label, bullets = the takeaway, max 4 bullets) — or, only if a calloutBox would be redundant with the slide's single main block, as one clearly emphasized one-line conclusion element instead. The takeaway must be visibly stated on the slide, not just implied by the diagram/data.`
    : ''
  const layoutVarietyLine = previousLayoutSignature
    ? `The immediately preceding slide's structure was "${previousLayoutSignature}" (layout:dominant-block-kind) — avoid repeating that same combination for an UNRELATED slide; pick a different block kind or layout when the content allows it. Exception: if this segment is a progressive-disclosure continuation of that same preceding slide's topic, deliberately repeating its structure is correct — see the progressive-disclosure instruction below.`
    : ''
  const layoutHintLine = layoutHint
    ? `Deck-wide variety plan: this slide was pre-assigned the block kind "${layoutHint}" so neighboring slides don't all share one structure. Use it — unless this segment's content clearly fits a different block kind better, in which case content wins over the assignment.`
    : ''
  const progressiveDisclosureLine = `Progressive disclosure: if this segment continues the SAME topic as the immediately preceding segment (a multi-part breakdown too dense for one slide), reuse that preceding slide's block kind, layout, and structure almost unchanged, and only add/change/highlight 1-2 elements to show this step — do not redesign the diagram from scratch. Keep the total element count within the 6-8 (ideally 3-5) budget from the style guide below.`
  const titleUniquenessLine = `If this slide's subject is a split/continuation of the same theme as another segment in this deck (e.g. a multi-part breakdown of one topic, per the progressive-disclosure instruction above), suffix the title with a circled number (①②③...) so no two slide titles are ever identical — never reuse an unlabeled duplicate title.`

  const system = `You are an expert presentation designer visualizing ONE segment of an already-written narration script into ONE slide. Produce strict JSON only — no prose, no markdown fences.
Output shape exactly: ${slideJsonShape()}
This is segment ${segmentNumber} of ${totalSegments} (section: "${segment.section}"). Suggested slide type: ${typeHint}. Never use "type":"title" or "type":"section_break" here — section-transition dividers are inserted mechanically elsewhere in the pipeline, not generated per-segment.
Choose the ONE content block (or up to 2 paired with "column") that best visualizes this segment's narration and put it in "blocks" — do NOT restate the narration as a wall of bullets or paragraphs; extract only the key terms/numbers/structure. Leave "body"/"visual" as their empty defaults when "blocks" is used; the renderer ignores them once "blocks" is non-empty.
Pick "layout" to match: "diagram_centered" for the common case of one block plus a short caption; "two_column_text_diagram" only when two blocks are paired via "column"; "grid" for a boxGroup grid or gridHeatmap block; "single_column" otherwise. Every layout keeps the same common grid — title top, content centered, citation/footnote pinned to the bottom — so pick by content shape, not to change that structure.
${takeawayLine}
${progressiveDisclosureLine}
${layoutVarietyLine}
${layoutHintLine}
${titleUniquenessLine}
${getBlockGuide(opts)}
${getBlockShapes(opts)}
${getStyleGuide(opts)}
The slide's title should be a specific, punchy restatement of "${segment.heading}" (10-20 characters) — tighten it if a better phrasing fits, don't just copy it verbatim. All content in ${opts.language}. Do not include an "index" field; do not write "speakerNotes" — it is filled in separately from the original script segment.`

  const audience = opts.audience ? `\nTarget audience: ${opts.audience}` : ''
  const tone = opts.tone ? `\nTone: ${opts.tone}` : ''
  const user = `Segment narration (context only — do NOT put this text on the slide verbatim, it already lives in speaker notes; extract only what's needed to visualize it):
"${segment.narration}"${audience}${tone}

Source material excerpts (for factual grounding; use only what's relevant to this segment):
${formatSources(sources)}

Produce this one slide's JSON now.`

  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ]
}

/** Builds the regeneration prompt for a refine iteration: the current deck's
 * slides plus targeted feedback drawn from whichever metrics scored lowest
 * (weights.ts's METRIC_IMPROVEMENT_HINTS + each metric's dynamic `reason` —
 * this is also how vision-judge feedback, when enabled, reaches this prompt:
 * a low-scoring 'vision_design_compliance' metric surfaces here exactly like
 * any other metric, see lib/evaluator/visionJudge.ts). Regenerates the WHOLE
 * deck in one call (unlike the chunked script/segment generation) since
 * refinement needs cross-slide context (e.g. narrative flow, deck-wide color
 * consistency, the mindmap agenda/summary "bookend" reuse) that per-segment
 * generation doesn't have. */
export function buildRefineMessages(deck: Deck, score: DeckScore, opts: GenerateOptions): ChatMessage[] {
  const weakMetrics = [...score.metrics]
    .filter((m) => m.gate || m.score < 0.75)
    .sort((a, b) => a.score - b.score)
    .slice(0, 8)

  const feedback = weakMetrics
    .map((m) => `- [${m.label}, currently ${Math.round(m.score * 100)}/100] ${METRIC_IMPROVEMENT_HINTS[m.id]}${m.reason ? ` (Detail: ${m.reason})` : ''}`)
    .join('\n')

  const system = `You are revising an existing slide deck to fix specific quality issues. Produce strict JSON only — no prose, no markdown fences.
Output shape exactly: {"title": "string", "slides": [ ${slideJsonShape()}, ... ]}
Return the FULL deck (all slides, in order), not just the changed ones. Preserve slides that are already good; only change what the feedback below asks you to fix. Cover/title slides ("type":"title") must keep "blocks":[] — every other slide may use blocks. All content must remain in ${opts.language}.
If any slide carries more than the 6-8 independent-element budget below, cut it down to the essential 3-5 rather than trying to keep everything — do not invent extra slides to hold the overflow unless the feedback explicitly asks for a split.
${getBlockGuide(opts)}
${getBlockShapes(opts)}
${getStyleGuide(opts)}`

  const currentSlidesJson = JSON.stringify(
    deck.slides.map((s) => ({
      index: s.index,
      type: s.type,
      layout: s.layout,
      title: s.title,
      body: s.body,
      visual: s.visual,
      blocks: s.blocks ?? [],
      citation: s.citation,
      speakerNotes: s.speakerNotes,
      buildStage: s.buildStage,
    })),
  )

  const user = `Current deck (title: "${deck.title}"), score ${score.total}/100:\n${currentSlidesJson}\n\nFix these issues (highest priority first):\n${feedback || '- General polish pass; no specific metric failures reported.'}\n\nProduce the revised full deck JSON now.`

  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ]
}

/** Builds the per-slide refine prompt (GenerateOptions.refineStrategy ===
 * 'per_slide', the default — see generateDeck.ts's identifyWeakSlides):
 * regenerates ONE already-generated slide, given the specific local-rule
 * issues detected on it, instead of the whole-deck buildRefineMessages call
 * above. Small and bounded like buildSegmentSlideMessages, for the same
 * local-LLM-reliability reason — a single-slide JSON response is far less
 * likely to get truncated than a whole-deck one. `segmentNarration` is the
 * slide's original script segment narration (or its current speakerNotes as
 * a fallback for slides with no segment, e.g. a deterministic structural
 * slide), given as grounding context only — the caller always keeps the
 * slide's existing speakerNotes verbatim regardless of what this call
 * returns. */
export function buildSlideRefineMessages(
  slide: Slide,
  issues: string[],
  segmentNarration: string,
  opts: GenerateOptions,
): ChatMessage[] {
  const system = `You are revising ONE slide to fix specific quality issues, without changing what it's about. Produce strict JSON only — no prose, no markdown fences.
Output shape exactly: ${slideJsonShape()}
Keep the same subject/topic and the same "type" unless a fix explicitly requires changing it. Cover/title slides ("type":"title") and section_break slides must keep "blocks":[]. Do not include an "index" field; do not write "speakerNotes" — it is filled in separately and your value is discarded. All content in ${opts.language}.
If this slide carries more than the 6-8 independent-element budget below, cut it down to the essential 3-5 rather than trying to keep everything.
${getBlockGuide(opts)}
${getBlockShapes(opts)}
${getStyleGuide(opts)}`

  const currentSlideJson = JSON.stringify({
    type: slide.type,
    layout: slide.layout,
    title: slide.title,
    body: slide.body,
    visual: slide.visual,
    blocks: slide.blocks ?? [],
    citation: slide.citation,
  })

  const user = `Original segment narration (context only — do not put this on the slide verbatim, it already lives in speaker notes):
"${segmentNarration}"

Current slide JSON:
${currentSlideJson}

Fix these issues:
${issues.map((issue) => `- ${issue}`).join('\n')}

Produce the revised slide JSON now.`

  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ]
}
