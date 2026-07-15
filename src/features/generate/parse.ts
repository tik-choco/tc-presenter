// Defensive parsing: turns whatever JSON-ish text an LLM (especially a local
// one) returns into typed, schema-valid `Slide`/outline structures. Follows
// the same philosophy as every other vendored lib/*.ts in this codebase
// (llmConfig.ts's sanitizeLlmConfig, kv.ts): never throw, drop/replace
// malformed fields individually with sane defaults rather than rejecting the
// whole object, and coerce close-enough shapes (e.g. `title` as a bare
// string) into the canonical shape.
import type {
  BlockColorRole,
  BoxGroupBlock,
  BoxItem,
  BulletForm,
  CalloutBoxBlock,
  ComparisonBlock,
  ComparisonSide,
  ContentBlock,
  FlowBlock,
  FlowStep,
  GridHeatmapBlock,
  GridHeatmapCell,
  IconRowBlock,
  IconRowItem,
  ImageRefBlock,
  MindmapBlock,
  MindmapNode,
  ParagraphBlock,
  PillItem,
  PillRowBlock,
  PillVariant,
  PositionedBlock,
  QuoteBlock,
  Slide,
  SlideBlockPlacement,
  SlideBody,
  SlideBuildStage,
  SlideBullet,
  SlideCitation,
  SlideLayout,
  SlideTitle,
  SlideType,
  SlideVisual,
  VisualBlock,
  VisualElement,
  VisualElementType,
  VisualKind,
  BulletListBlock,
  Script,
  ScriptSection,
  ScriptSegment,
} from '../../types'
import { MAX_SCRIPT_SEGMENTS } from '../../types'

/** Extracts the first top-level JSON object/array from `raw`, tolerating
 * prose or markdown fences around it (local LLMs routinely ignore "JSON
 * only" instructions) — the tc-news/tc-town `extractJson` pattern (see
 * notes-tc-news.md §4). Returns null (never throws) if nothing parses. */
export function extractJson<T = unknown>(raw: string): T | null {
  const tryParse = (candidate: string): T | null => {
    try {
      return JSON.parse(candidate) as T
    } catch {
      return null
    }
  }

  const direct = tryParse(raw.trim())
  if (direct !== null) return direct

  const firstBrace = raw.indexOf('{')
  const firstBracket = raw.indexOf('[')
  const starts = [firstBrace, firstBracket].filter((i) => i !== -1)
  if (starts.length === 0) return null
  const start = Math.min(...starts)
  const closer = raw[start] === '[' ? ']' : '}'
  const end = raw.lastIndexOf(closer)
  if (end > start) {
    const sliced = tryParse(raw.slice(start, end + 1))
    if (sliced !== null) return sliced
  }

  // Third fallback: no matching closer was found, or the naive slice still
  // didn't parse — the response looks truncated. Attempt a structural
  // repair before giving up; this is what rescues small local LLMs that get
  // cut off mid-JSON or leave a trailing comma.
  const repaired = repairJson(raw)
  if (repaired !== null) {
    const fixed = tryParse(repaired)
    if (fixed !== null) return fixed
  }

  return null
}

/** Best-effort repair of truncated/malformed JSON text — extractJson's third
 * fallback. Never throws; returns null if the text still can't be coaxed
 * into valid JSON, matching this file's "never throw, degrade gracefully"
 * philosophy. Handles the failure modes small local LLMs routinely produce:
 * markdown fences around the JSON, a response cut off mid-string-literal, a
 * trailing comma left by a truncated last element, and unbalanced trailing
 * `}`/`]` from the response simply stopping early. Does NOT attempt to
 * recover a value truncated mid-token (e.g. `"key": tr` for `true`) — that's
 * rare enough, and risky enough to guess at, that falling through to null
 * (the caller's existing fallback-slide/script behavior) is the safer
 * outcome. */
export function repairJson(raw: string): string | null {
  let text = raw
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```\s*$/, '')
    .trim()

  const firstBrace = text.indexOf('{')
  const firstBracket = text.indexOf('[')
  const starts = [firstBrace, firstBracket].filter((i) => i !== -1)
  if (starts.length === 0) return null
  text = text.slice(Math.min(...starts))

  // String-literal-aware scan: track whether we're inside a "..." literal
  // (respecting \" escapes) and the open-bracket stack, so the trailing-comma
  // strip and closer-count below aren't confused by punctuation that merely
  // appears inside narration/title text.
  let inString = false
  let escaped = false
  const stack: string[] = []
  for (const ch of text) {
    if (inString) {
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') {
      inString = true
    } else if (ch === '{' || ch === '[') {
      stack.push(ch)
    } else if (ch === '}' || ch === ']') {
      stack.pop()
    }
  }

  // Close an unterminated trailing string literal.
  if (inString) text += '"'

  // Drop a trailing comma left by a truncated next element/property.
  text = text.replace(/,\s*$/, '')

  // Append closers for every still-open bracket, innermost first.
  for (let i = stack.length - 1; i >= 0; i -= 1) {
    text += stack[i] === '{' ? '}' : ']'
  }

  return text
}

export function newId(): string {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID()
  } catch {
    // fall through
  }
  return `id-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
}

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
const VISUAL_KINDS: VisualKind[] = [
  'none',
  'icon_diagram',
  'network_graph',
  'flowchart',
  'image',
  'screenshot',
  'chart_line',
  'chart_bar',
  'table',
]
const VISUAL_ELEMENT_TYPES: VisualElementType[] = ['box', 'icon', 'arrow', 'node', 'edge', 'image_ref']
const BULLET_FORMS: BulletForm[] = ['noun_phrase', 'verb_phrase']
const COLOR_ROLES: BlockColorRole[] = ['primary', 'secondary', 'warning', 'neutral']
const PILL_VARIANTS: PillVariant[] = ['filled', 'outline']
const BOX_GROUP_LAYOUTS: BoxGroupBlock['layout'][] = ['single', 'grid', 'nested']
const BLOCK_COLUMNS: NonNullable<SlideBlockPlacement['column']>[] = ['left', 'right', 'full']

function isOneOf<T extends string>(value: unknown, allowed: T[]): value is T {
  return typeof value === 'string' && (allowed as string[]).includes(value)
}

function str(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback
}

function num(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : {}
}

function normalizeTitle(raw: unknown): SlideTitle {
  if (typeof raw === 'string') return { text: raw.trim() }
  const r = record(raw)
  const title: SlideTitle = { text: str(r.text).trim() }
  const badgeRaw = record(r.badge)
  if (typeof badgeRaw.number === 'number' && typeof badgeRaw.label === 'string') {
    title.badge = { number: badgeRaw.number, label: badgeRaw.label }
  }
  return title
}

function normalizeBullet(raw: unknown): SlideBullet | null {
  const r = record(raw)
  const text = str(r.text).trim()
  if (!text) return null
  const bullet: SlideBullet = { text, level: Math.max(0, Math.trunc(num(r.level, 0))) }
  if (isOneOf(r.form, BULLET_FORMS)) bullet.form = r.form
  return bullet
}

function normalizeBody(raw: unknown): SlideBody {
  const r = record(raw)
  const bulletsRaw = Array.isArray(r.bullets) ? r.bullets : []
  const bullets = bulletsRaw.map(normalizeBullet).filter((b): b is SlideBullet => b !== null)
  const paragraphsRaw = Array.isArray(r.paragraphs) ? r.paragraphs : []
  const paragraphs = paragraphsRaw.filter((p): p is string => typeof p === 'string' && p.trim() !== '')
  return { bullets, paragraphs }
}

function normalizeVisualElement(raw: unknown): VisualElement | null {
  const r = record(raw)
  if (!isOneOf(r.type, VISUAL_ELEMENT_TYPES)) return null
  const posRaw = record(r.position)
  return {
    type: r.type,
    label: str(r.label),
    color: str(r.color, '#9aa0a6'),
    position: { x: num(posRaw.x, 0), y: num(posRaw.y, 0), w: num(posRaw.w, 0), h: num(posRaw.h, 0) },
  }
}

function normalizeVisual(raw: unknown): SlideVisual {
  const r = record(raw)
  const kind: VisualKind = isOneOf(r.kind, VISUAL_KINDS) ? r.kind : 'none'
  const elementsRaw = Array.isArray(r.elements) ? r.elements : []
  const elements = elementsRaw.map(normalizeVisualElement).filter((e): e is VisualElement => e !== null)
  const visual: SlideVisual = { kind, elements }

  const tableRaw = record(r.dataTable)
  if (Array.isArray(tableRaw.headers) && Array.isArray(tableRaw.rows)) {
    visual.dataTable = {
      headers: tableRaw.headers.filter((h): h is string => typeof h === 'string'),
      rows: tableRaw.rows
        .filter((row): row is unknown[] => Array.isArray(row))
        .map((row) => row.map((cell) => (typeof cell === 'string' ? cell : String(cell)))),
      unit: str(tableRaw.unit),
      significantDigits: Math.max(0, Math.trunc(num(tableRaw.significantDigits, 0))),
    }
  }

  const chartRaw = record(r.chart)
  if (chartRaw.type === 'line' || chartRaw.type === 'bar') {
    const seriesRaw = Array.isArray(chartRaw.series) ? chartRaw.series : []
    visual.chart = {
      type: chartRaw.type,
      xLabel: str(chartRaw.xLabel),
      yLabel: str(chartRaw.yLabel),
      series: seriesRaw.map((s) => {
        const sr = record(s)
        const pointsRaw = Array.isArray(sr.points) ? sr.points : []
        return {
          name: str(sr.name),
          points: pointsRaw
            .filter((p): p is unknown[] => Array.isArray(p) && p.length >= 2)
            .map((p) => ({ x: num(p[0], 0), y: num(p[1], 0) })),
        }
      }),
    }
    const annotation = str(chartRaw.annotation)
    if (annotation) visual.chart.annotation = annotation
  }

  return visual
}

function normalizeCitation(raw: unknown): SlideCitation | undefined {
  const r = record(raw)
  const text = str(r.text).trim()
  if (!text) return undefined
  const citation: SlideCitation = { text }
  const url = str(r.url).trim()
  if (url) citation.url = url
  return citation
}

// ---------------------------------------------------------------------------
// Block-based content model (design-spec.md §3). Same defensive philosophy
// as the rest of this file: an individual malformed item/field is dropped or
// defaulted rather than invalidating its whole block or the slide, and array
// fields are clamped to design-spec.md §4.2's stated per-kind maximums so a
// chatty local LLM can't blow past what the renderer/quality bar expects.

function normalizeColorRole(raw: unknown): BlockColorRole | undefined {
  return isOneOf(raw, COLOR_ROLES) ? raw : undefined
}

function normalizePillVariant(raw: unknown): PillVariant | undefined {
  return isOneOf(raw, PILL_VARIANTS) ? raw : undefined
}

function normalizePillItem(raw: unknown): PillItem | null {
  const r = record(raw)
  const text = str(r.text).trim()
  if (!text) return null
  const item: PillItem = { text }
  const description = str(r.description).trim()
  if (description) item.description = description
  const variant = normalizePillVariant(r.variant)
  if (variant) item.variant = variant
  const color = normalizeColorRole(r.color)
  if (color) item.color = color
  return item
}

function normalizePillRow(raw: Record<string, unknown>): PillRowBlock | null {
  const itemsRaw = Array.isArray(raw.items) ? raw.items : []
  const items = itemsRaw.map(normalizePillItem).filter((i): i is PillItem => i !== null).slice(0, 6)
  if (items.length === 0) return null
  const block: PillRowBlock = { kind: 'pillRow', items }
  if (raw.direction === 'vertical') block.direction = 'vertical'
  return block
}

function normalizeIconRowItem(raw: unknown): IconRowItem | null {
  const r = record(raw)
  const label = str(r.label).trim()
  if (!label) return null
  const item: IconRowItem = { label }
  const icon = str(r.icon).trim()
  if (icon) item.icon = icon
  if (r.excluded === true) item.excluded = true
  return item
}

function normalizeIconRow(raw: Record<string, unknown>): IconRowBlock | null {
  const itemsRaw = Array.isArray(raw.items) ? raw.items : []
  const items = itemsRaw.map(normalizeIconRowItem).filter((i): i is IconRowItem => i !== null).slice(0, 5)
  if (items.length === 0) return null
  return { kind: 'iconRow', items }
}

function normalizeBoxItem(raw: unknown): BoxItem | null {
  const r = record(raw)
  const label = str(r.label).trim()
  if (!label) return null
  const item: BoxItem = { label }
  const text = str(r.text).trim()
  if (text) item.text = text
  const variant = normalizePillVariant(r.variant)
  if (variant) item.variant = variant
  const color = normalizeColorRole(r.color)
  if (color) item.color = color
  if (typeof r.row === 'number' && Number.isFinite(r.row)) item.row = Math.max(0, Math.trunc(r.row))
  if (typeof r.col === 'number' && Number.isFinite(r.col)) item.col = Math.max(0, Math.trunc(r.col))
  return item
}

function normalizeBoxGroup(raw: Record<string, unknown>): BoxGroupBlock | null {
  const boxesRaw = Array.isArray(raw.boxes) ? raw.boxes : []
  // 8x5 grid (design-spec.md §4.2's largest observed real example) is the
  // widest structural cap; smaller layouts naturally use far fewer boxes.
  const boxes = boxesRaw.map(normalizeBoxItem).filter((b): b is BoxItem => b !== null).slice(0, 40)
  if (boxes.length === 0) return null
  const layout = isOneOf(raw.layout, BOX_GROUP_LAYOUTS) ? raw.layout : 'single'
  const block: BoxGroupBlock = { kind: 'boxGroup', layout, boxes }
  if (layout === 'grid') {
    if (typeof raw.gridRows === 'number' && Number.isFinite(raw.gridRows)) block.gridRows = Math.max(1, Math.trunc(raw.gridRows))
    if (typeof raw.gridCols === 'number' && Number.isFinite(raw.gridCols)) block.gridCols = Math.max(1, Math.trunc(raw.gridCols))
  }
  const legendRaw = Array.isArray(raw.legend) ? raw.legend : []
  const legend = legendRaw
    .map((l) => {
      const lr = record(l)
      const color = normalizeColorRole(lr.color)
      const label = str(lr.label).trim()
      return color && label ? { color, label } : null
    })
    .filter((l): l is { color: BlockColorRole; label: string } => l !== null)
    .slice(0, 4)
  if (legend.length > 0) block.legend = legend
  return block
}

function normalizeMindmapNode(raw: unknown, depth: number): MindmapNode | null {
  const r = record(raw)
  const label = str(r.label).trim()
  if (!label) return null
  const node: MindmapNode = { label }
  const variant = normalizePillVariant(r.variant)
  if (variant) node.variant = variant
  const color = normalizeColorRole(r.color)
  if (color) node.color = color
  if (depth < 2 && Array.isArray(r.children)) {
    const children = r.children
      .map((c) => normalizeMindmapNode(c, depth + 1))
      .filter((c): c is MindmapNode => c !== null)
    if (children.length > 0) node.children = children
  }
  return node
}

function normalizeMindmap(raw: Record<string, unknown>): MindmapBlock | null {
  const root = str(raw.root).trim()
  if (!root) return null
  const branchesRaw = Array.isArray(raw.branches) ? raw.branches : []
  const branches = branchesRaw
    .map((b) => normalizeMindmapNode(b, 1))
    .filter((b): b is MindmapNode => b !== null)
    .slice(0, 6)
  if (branches.length === 0) return null
  return { kind: 'mindmap', root, branches }
}

function normalizeComparisonSide(raw: unknown): ComparisonSide | null {
  const r = record(raw)
  const heading = str(r.heading).trim()
  if (!heading) return null
  const bulletsRaw = Array.isArray(r.bullets) ? r.bullets : []
  const bullets = bulletsRaw.filter((b): b is string => typeof b === 'string' && b.trim() !== '').slice(0, 4)
  return { heading, bullets }
}

function normalizeComparison(raw: Record<string, unknown>): ComparisonBlock | null {
  const left = normalizeComparisonSide(raw.left)
  const right = normalizeComparisonSide(raw.right)
  if (!left || !right) return null
  return { kind: 'comparison', left, right }
}

function normalizeFlowStep(raw: unknown): FlowStep | null {
  const r = record(raw)
  const text = str(r.text).trim()
  if (!text) return null
  const step: FlowStep = { text }
  const variant = normalizePillVariant(r.variant)
  if (variant) step.variant = variant
  const color = normalizeColorRole(r.color)
  if (color) step.color = color
  return step
}

function normalizeFlow(raw: Record<string, unknown>): FlowBlock | null {
  const stepsRaw = Array.isArray(raw.steps) ? raw.steps : []
  const steps = stepsRaw.map(normalizeFlowStep).filter((s): s is FlowStep => s !== null).slice(0, 5)
  if (steps.length === 0) return null
  const block: FlowBlock = { kind: 'flow', steps }
  if (raw.direction === 'horizontal') block.direction = 'horizontal'
  return block
}

function normalizeGridHeatmapCell(raw: unknown): GridHeatmapCell | null {
  const r = record(raw)
  const colorKey = str(r.colorKey).trim()
  if (!colorKey) return null
  if (typeof r.row !== 'number' || typeof r.col !== 'number') return null
  return { row: Math.max(0, Math.trunc(r.row)), col: Math.max(0, Math.trunc(r.col)), colorKey }
}

function normalizeGridHeatmap(raw: Record<string, unknown>): GridHeatmapBlock | null {
  const legendRaw = Array.isArray(raw.legend) ? raw.legend : []
  const legend = legendRaw
    .map((l) => {
      const lr = record(l)
      const colorKey = str(lr.colorKey).trim()
      const color = normalizeColorRole(lr.color)
      const label = str(lr.label).trim()
      return colorKey && color && label ? { colorKey, color, label } : null
    })
    .filter((l): l is { colorKey: string; color: BlockColorRole; label: string } => l !== null)
    .slice(0, 4)
  // legend is required by the schema — a heatmap with no legend can't be read.
  if (legend.length === 0) return null

  const rows = typeof raw.rows === 'number' && Number.isFinite(raw.rows) ? Math.max(1, Math.trunc(raw.rows)) : 0
  const cols = typeof raw.cols === 'number' && Number.isFinite(raw.cols) ? Math.max(1, Math.trunc(raw.cols)) : 0
  if (rows === 0 || cols === 0) return null

  const cellsRaw = Array.isArray(raw.cells) ? raw.cells : []
  const cells = cellsRaw.map(normalizeGridHeatmapCell).filter((c): c is GridHeatmapCell => c !== null).slice(0, rows * cols)

  const block: GridHeatmapBlock = { kind: 'gridHeatmap', rows, cols, cells, legend }
  const annotation = str(raw.annotation).trim()
  if (annotation) block.annotation = annotation
  return block
}

function normalizeCalloutBox(raw: Record<string, unknown>): CalloutBoxBlock | null {
  const heading = str(raw.heading).trim()
  if (!heading) return null
  const bulletsRaw = Array.isArray(raw.bullets) ? raw.bullets : []
  const bullets = bulletsRaw.filter((b): b is string => typeof b === 'string' && b.trim() !== '').slice(0, 4)
  const block: CalloutBoxBlock = { kind: 'calloutBox', heading, bullets }
  const color = normalizeColorRole(raw.color)
  if (color) block.color = color
  return block
}

function normalizeParagraphBlock(raw: Record<string, unknown>): ParagraphBlock | null {
  const text = str(raw.text).trim()
  return text ? { kind: 'paragraph', text } : null
}

function normalizeBulletListBlock(raw: Record<string, unknown>): BulletListBlock | null {
  const bulletsRaw = Array.isArray(raw.bullets) ? raw.bullets : []
  const bullets = bulletsRaw.map(normalizeBullet).filter((b): b is SlideBullet => b !== null)
  return bullets.length > 0 ? { kind: 'bulletList', bullets } : null
}

function normalizeQuoteBlock(raw: Record<string, unknown>): QuoteBlock | null {
  const text = str(raw.text).trim()
  if (!text) return null
  const block: QuoteBlock = { kind: 'quote', text }
  const attribution = str(raw.attribution).trim()
  if (attribution) block.attribution = attribution
  return block
}

function normalizeImageRefBlock(raw: Record<string, unknown>): ImageRefBlock | null {
  const caption = str(raw.caption).trim()
  if (!caption) return null
  const block: ImageRefBlock = { kind: 'imageRef', caption }
  const source = normalizeCitation(raw.source)
  if (source) block.source = source
  return block
}

function normalizeVisualBlockKind(raw: Record<string, unknown>): VisualBlock | null {
  const visual = normalizeVisual(raw.visual)
  if (visual.kind === 'none' && visual.elements.length === 0 && !visual.dataTable && !visual.chart) return null
  return { kind: 'visual', visual }
}

function normalizeContentBlock(raw: unknown): ContentBlock | null {
  const r = record(raw)
  switch (r.kind) {
    case 'pillRow':
      return normalizePillRow(r)
    case 'iconRow':
      return normalizeIconRow(r)
    case 'boxGroup':
      return normalizeBoxGroup(r)
    case 'mindmap':
      return normalizeMindmap(r)
    case 'comparison':
      return normalizeComparison(r)
    case 'flow':
      return normalizeFlow(r)
    case 'gridHeatmap':
      return normalizeGridHeatmap(r)
    case 'calloutBox':
      return normalizeCalloutBox(r)
    case 'paragraph':
      return normalizeParagraphBlock(r)
    case 'bulletList':
      return normalizeBulletListBlock(r)
    case 'quote':
      return normalizeQuoteBlock(r)
    case 'imageRef':
      return normalizeImageRefBlock(r)
    case 'visual':
      return normalizeVisualBlockKind(r)
    default:
      return null
  }
}

function normalizePositionedBlock(raw: unknown): PositionedBlock | null {
  const content = normalizeContentBlock(raw)
  if (!content) return null
  const r = record(raw)
  const placement: SlideBlockPlacement = {}
  if (isOneOf(r.column, BLOCK_COLUMNS) && r.column !== 'full') placement.column = r.column
  return { ...content, ...placement }
}

/** Normalizes `Slide.blocks` (design-spec.md §3). Malformed/unrecognized
 * entries are dropped individually; the caller decides what an empty result
 * means (types.ts: an empty/absent `blocks` means "use body/visual"). */
export function normalizeBlocks(raw: unknown): PositionedBlock[] {
  if (!Array.isArray(raw)) return []
  return raw.map(normalizePositionedBlock).filter((b): b is PositionedBlock => b !== null)
}

function normalizeBuildStage(raw: unknown): SlideBuildStage {
  const r = record(raw)
  const isBuildSlide = r.isBuildSlide === true
  const groupId = typeof r.groupId === 'string' && r.groupId ? r.groupId : null
  const stageIndex = typeof r.stageIndex === 'number' && Number.isFinite(r.stageIndex) ? r.stageIndex : null
  return { isBuildSlide: isBuildSlide && groupId !== null, groupId: isBuildSlide ? groupId : null, stageIndex }
}

/** Normalizes one raw LLM slide object (or throws-free garbage) into a
 * schema-valid `Slide`. `index` is the caller-assigned 1-based position —
 * always wins over any `index` the LLM emitted, since page_number_continuity
 * (evaluator metric #11) requires slides to match their array position
 * exactly and the generator is the single source of truth for ordering. */
export function normalizeSlide(raw: unknown, index: number): Slide {
  const r = record(raw)
  const citation = normalizeCitation(r.citation)
  const type: SlideType = isOneOf(r.type, SLIDE_TYPES) ? r.type : 'content'
  // design-spec.md §4.1's slide-level rules: cover/title (and section_break)
  // slides must not use the blocks model — they stay title + optional
  // one-line subtitle/tags via body, per HeroBody's rendering in SlideView.
  const blocks = type === 'title' || type === 'section_break' ? [] : normalizeBlocks(r.blocks)
  return {
    id: newId(),
    index,
    type,
    layout: isOneOf(r.layout, SLIDE_LAYOUTS) ? r.layout : 'single_column',
    title: normalizeTitle(r.title),
    body: normalizeBody(r.body),
    visual: normalizeVisual(r.visual),
    ...(blocks.length > 0 ? { blocks } : {}),
    ...(citation ? { citation } : {}),
    speakerNotes: str(r.speakerNotes).trim(),
    buildStage: normalizeBuildStage(r.buildStage),
  }
}

// ---------------------------------------------------------------------------
// Narration script (script-first pipeline — see generateDeck.ts's top
// comment and ../tc-news's programGenerate.ts, which this is modeled on: the
// full spoken narration is written FIRST, as one structured document, and
// slides are generated afterwards to visualize it — not the other way
// around). `heading` seeds that segment's slide title; `narration` is used
// VERBATIM as that slide's speakerNotes (generateDeck.ts overwrites whatever
// the per-segment slide call returns, so this is guaranteed regardless of
// what the segment-slide LLM call does with it).
//
// The Script/ScriptSegment types (and MAX_SCRIPT_SEGMENTS) moved to
// ../../types so lib/-side modules (generateCheckpoint/generateJobs) can use
// them without importing from features/ — re-exported here so this file
// stays their feature-side home for existing importers.
export type { Script, ScriptSection, ScriptSegment } from '../../types'
export { MAX_SCRIPT_SEGMENTS } from '../../types'

const SCRIPT_SECTIONS: ScriptSection[] = ['intro', 'body', 'conclusion']

/** Normalizes the script-generation LLM response. Falls back to a minimal
 * one-segment script (so the pipeline can always proceed to slide
 * generation) when the response is missing/malformed. */
export function normalizeScript(raw: unknown, fallbackTitle: string, maxSlides?: number): Script {
  const r = record(raw)
  const title = str(r.title, fallbackTitle).trim() || fallbackTitle
  const subtitle = str(r.subtitle).trim()
  const segmentsRaw = Array.isArray(r.segments) ? r.segments : []
  const cap = maxSlides && maxSlides > 0 ? Math.min(MAX_SCRIPT_SEGMENTS, Math.trunc(maxSlides)) : MAX_SCRIPT_SEGMENTS

  const segments: ScriptSegment[] = segmentsRaw
    .map((s): ScriptSegment | null => {
      const sr = record(s)
      const heading = str(sr.heading).trim()
      const narration = str(sr.narration).trim()
      if (!heading || !narration) return null
      const chapter = str(sr.chapter).trim()
      const keyTakeaway = str(sr.keyTakeaway).trim()
      return {
        section: isOneOf(sr.section, SCRIPT_SECTIONS) ? sr.section : 'body',
        heading,
        narration,
        ...(chapter ? { chapter } : {}),
        ...(keyTakeaway ? { keyTakeaway } : {}),
      }
    })
    .filter((s): s is ScriptSegment => s !== null)
    .slice(0, cap)

  if (segments.length > 0) return { title, subtitle, segments }

  return {
    title,
    subtitle,
    segments: [{ section: 'body', heading: title.slice(0, 20) || 'Overview', narration: `This presentation covers ${title}.` }],
  }
}
