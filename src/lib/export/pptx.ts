// Deck -> editable PPTX export. Hybrid strategy per slide:
//   - Text-only content (title/section_break hero slides, and any other
//     slide whose blocks are all text-shaped, or whose legacy `visual` is
//     empty) is rebuilt as real PowerPoint text boxes/bullets, so it stays
//     editable in PowerPoint/Keynote/Google Slides.
//   - Slides carrying a figure (a non-text block like mindmap/flow/
//     comparison/gridHeatmap/boxGroup/pillRow/iconRow/imageRef/visual, or a
//     populated legacy `visual`) are rasterized whole via the shared
//     SlideView renderer and placed as a single full-bleed image — mixing
//     "real text" over a background snapshot of the same slide would double
//     up the content, so these become "one PNG + speaker notes" slides
//     instead.
// pptxgenjs is loaded via a dynamic import so it never inflates the main
// app bundle.
import { renderSlideToPng } from '../evaluator/visionRender'
import type PptxGenJS from 'pptxgenjs'
import type { BlockColorRole, Deck, DeckAspectRatio, DeckTheme, PositionedBlock, Slide, SlideBullet } from '../../types'
import { sanitizeFilename } from './filename'
import { pngDataUriToJpeg } from './image'

const HERO_TYPES = new Set<Slide['type']>(['title', 'section_break'])
const TEXT_BLOCK_KINDS = new Set<PositionedBlock['kind']>(['bulletList', 'paragraph', 'quote', 'calloutBox'])

/** XML 1.0 forbids these control characters outright (everything except tab/
 * LF/CR in the C0 range); pptxgenjs writes text/attribute values straight
 * into the XML without stripping them, so any of these slipping through
 * (e.g. via LLM-generated slide text) produces a .pptx PowerPoint refuses to
 * open without a "repair" prompt. */
// eslint-disable-next-line no-control-regex
const XML_ILLEGAL_CHARS = /[\x00-\x08\x0B\x0C\x0E-\x1F]/g

/** Strip characters that are illegal in XML 1.0 text/attribute content.
 * Always returns a string (never undefined/null) so callers can use it
 * directly as TextProps.text. */
function sanitizeXmlText(value: string | null | undefined): string {
  if (!value) return ''
  return value.replace(XML_ILLEGAL_CHARS, '')
}

const HEX3 = /^[0-9a-fA-F]{3}$/
const HEX6 = /^[0-9a-fA-F]{6}$/

/** Normalize a theme color to the bare 6-digit hex pptxgenjs expects (no
 * leading '#'). Accepts '#rgb'/'rgb'/'#rrggbb'/'rrggbb'; anything else
 * (empty, a CSS var, `rgb(...)`, garbage) falls back to a known-safe color
 * instead of being written into the XML unchecked. */
function normalizeHex(value: string | undefined, fallback: string): string {
  let v = (value ?? '').trim()
  if (v.startsWith('#')) v = v.slice(1)
  if (HEX3.test(v)) v = v.replace(/./g, (c) => c + c)
  if (HEX6.test(v)) return v
  return fallback.startsWith('#') ? fallback.slice(1) : fallback
}

/** pptxgenjs embeds `fontFace` straight into `typeface="..."` XML attributes
 * without escaping (see its genXmlTextRunProperties()), so a CSS-style font
 * stack like `theme.fontFamily` — which contains embedded double quotes,
 * e.g. `Inter, ui-sans-serif, ..., "Segoe UI", ...` — prematurely closes the
 * attribute and corrupts every text run in the file. This is why every
 * export from this app broke: DEFAULT_DECK_THEME.fontFamily is a CSS
 * font-family list, not a single font name, and every deck (default + every
 * preset) uses it verbatim. Pick the first font name out of the stack and
 * strip any quoting/illegal characters so it's safe to embed. */
function resolveFontFace(fontFamily: string | undefined): string | undefined {
  const first = (fontFamily ?? '').split(',')[0]?.trim().replace(/^["']+|["']+$/g, '').trim()
  if (!first) return undefined
  const safe = sanitizeXmlText(first).replace(/"/g, '')
  return safe || undefined
}

/** Whether `slide` needs to be rasterized as a single image rather than
 * rebuilt as editable text boxes — see the module doc comment above. */
function isGraphicSlide(slide: Slide): boolean {
  if (HERO_TYPES.has(slide.type)) return false
  if (slide.blocks && slide.blocks.length > 0) {
    return slide.blocks.some((b) => !TEXT_BLOCK_KINDS.has(b.kind))
  }
  return slide.visual.kind !== 'none'
}

interface Geometry {
  w: number
  h: number
  titleY: number
  titleH: number
  bodyY: number
  bodyH: number
  citeY: number
}

function geometryFor(aspectRatio: DeckAspectRatio): Geometry {
  if (aspectRatio === '4:3') {
    return { w: 10, h: 7.5, titleY: 0.45, titleH: 0.95, bodyY: 1.6, bodyH: 5.15, citeY: 7.05 }
  }
  return { w: 10, h: 5.625, titleY: 0.35, titleH: 0.85, bodyY: 1.35, bodyH: 3.75, citeY: 5.2 }
}

function bulletsToTextProps(bullets: SlideBullet[], color: string, fontFace?: string): PptxGenJS.TextProps[] {
  return bullets
    .map((b) => ({ text: sanitizeXmlText(b.text), level: b.level }))
    .filter((b) => b.text.length > 0)
    .map((b) => ({
      text: b.text,
      options: { bullet: true, indentLevel: b.level, fontSize: Math.max(11, 16 - b.level * 2), color, breakLine: true, fontFace },
    }))
}

function paragraphsToTextProps(paragraphs: string[], color: string, fontFace?: string): PptxGenJS.TextProps[] {
  return paragraphs
    .map((text) => sanitizeXmlText(text))
    .filter((text) => text.length > 0)
    .map((text) => ({ text, options: { fontSize: 14, color, breakLine: true, fontFace } }))
}

function blocksToTextProps(
  blocks: PositionedBlock[],
  colorForRole: (role: BlockColorRole | undefined) => string,
  textColor: string,
  fontFace: string | undefined,
): PptxGenJS.TextProps[] {
  const items: PptxGenJS.TextProps[] = []
  for (const block of blocks) {
    switch (block.kind) {
      case 'bulletList':
        items.push(...bulletsToTextProps(block.bullets, textColor, fontFace))
        break
      case 'paragraph': {
        const text = sanitizeXmlText(block.text)
        if (text) items.push({ text, options: { fontSize: 14, color: textColor, breakLine: true, fontFace } })
        break
      }
      case 'quote': {
        const quoteText = sanitizeXmlText(block.text)
        const attribution = sanitizeXmlText(block.attribution)
        const text = attribution ? `“${quoteText}” — ${attribution}` : `“${quoteText}”`
        items.push({ text, options: { italic: true, fontSize: 16, color: textColor, breakLine: true, fontFace } })
        break
      }
      case 'calloutBox': {
        const heading = sanitizeXmlText(block.heading)
        if (heading) items.push({ text: heading, options: { bold: true, fontSize: 15, color: colorForRole(block.color), breakLine: true, fontFace } })
        items.push(
          ...block.bullets
            .map((text) => sanitizeXmlText(text))
            .filter((text) => text.length > 0)
            .map((text) => ({ text, options: { bullet: true, fontSize: 13, color: textColor, breakLine: true, fontFace } })),
        )
        break
      }
      default:
        // Non-text blocks never reach here — the caller only calls this
        // for slides where isGraphicSlide() is false.
        break
    }
  }
  return items
}

function addTitle(
  pSlide: PptxGenJS.PresSlide,
  slide: Slide,
  geo: Geometry,
  textColor: string,
  primaryColor: string,
  fontFace: string | undefined,
): void {
  const items: PptxGenJS.TextProps[] = []
  if (slide.title.badge) {
    const label = sanitizeXmlText(slide.title.badge.label)
    items.push({
      text: `${slide.title.badge.number}. ${label}`,
      options: { color: primaryColor, fontSize: 12, bold: true, breakLine: true, fontFace },
    })
  }
  items.push({ text: sanitizeXmlText(slide.title.text), options: { color: textColor, fontSize: 26, bold: true, fontFace } })
  pSlide.addText(items, { x: 0.5, y: geo.titleY, w: geo.w - 1, h: geo.titleH, valign: 'top', fontFace })
}

function addHeroTitle(
  pSlide: PptxGenJS.PresSlide,
  slide: Slide,
  geo: Geometry,
  textColor: string,
  primaryColor: string,
  fontFace: string | undefined,
): void {
  pSlide.addText(sanitizeXmlText(slide.title.text), {
    x: 0.5,
    y: geo.h * 0.28,
    w: geo.w - 1,
    h: geo.h * 0.3,
    align: 'center',
    valign: 'middle',
    fontSize: 40,
    bold: true,
    color: textColor,
    fontFace,
  })
  const heroBullets = slide.body.bullets.map((b) => sanitizeXmlText(b.text)).filter((text) => text.length > 0)
  if (heroBullets.length > 0) {
    pSlide.addText(heroBullets.join('    •    '), {
      x: 0.5,
      y: geo.h * 0.62,
      w: geo.w - 1,
      h: geo.h * 0.18,
      align: 'center',
      fontSize: 14,
      color: primaryColor,
      fontFace,
    })
  }
}

/** Signature of `renderSlideToPng` — injected so the deck->pptx conversion
 * itself can be exercised outside a DOM (e.g. under plain Node in tests)
 * without dragging the canvas-based rasterizer along. */
type SlideRenderer = (slide: Slide, theme: DeckTheme, total: number, scale: number) => Promise<string | null>

/** Builds the in-memory PptxGenJS presentation for `deck` (everything
 * `exportDeckToPptx` does except the final `writeFile`). Exported alongside
 * the public `exportDeckToPptx` so tooling/tests can inject a stub
 * `renderSlide` and inspect the generated pptxgenjs instance directly;
 * `exportDeckToPptx`'s own signature is unchanged. */
export async function buildDeckPptx(
  deck: Deck,
  renderSlide: SlideRenderer,
  onProgress?: (current: number, total: number) => void,
  signal?: AbortSignal,
): Promise<PptxGenJS> {
  const PptxGenJSCtor = (await import('pptxgenjs')).default
  const pptx = new PptxGenJSCtor()

  const theme: DeckTheme = deck.theme
  const geo = geometryFor(theme.aspectRatio)
  pptx.defineLayout({ name: 'TC_DECK', width: geo.w, height: geo.h })
  pptx.layout = 'TC_DECK'

  const palette = theme.colorPalette
  const fontFace = resolveFontFace(theme.fontFamily)
  const textColor = normalizeHex(palette?.textPrimary, '1a1a1a')
  const primaryColor = normalizeHex(palette?.primary, '7a1f3d')
  const secondaryColor = normalizeHex(palette?.secondary, '1c3a5e')
  const warningColor = normalizeHex(palette?.accentWarning, 'c0392b')
  const grayColor = normalizeHex(palette?.neutralGray, '9aa6ad')
  const bgColor = normalizeHex(palette?.background, 'ffffff')

  const colorForRole = (role: BlockColorRole | undefined): string => {
    switch (role) {
      case 'secondary':
        return secondaryColor
      case 'warning':
        return warningColor
      case 'neutral':
        return grayColor
      default:
        return primaryColor
    }
  }

  const total = deck.slides.length
  for (let i = 0; i < total; i++) {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')
    const slide = deck.slides[i]
    onProgress?.(i + 1, total)

    const pSlide = pptx.addSlide()
    pSlide.background = { color: bgColor }

    if (isGraphicSlide(slide)) {
      const png = await renderSlide(slide, theme, total, 2)
      if (png) {
        // Re-encoded to JPEG before embedding — see image.ts's doc comment.
        // Lossless PNGs at 2x pixel density blew a graphic-heavy deck's
        // .pptx up dramatically; JPEG cuts that roughly an order of
        // magnitude. Text-rebuilt (non-graphic) slides never hit this path.
        const jpeg = await pngDataUriToJpeg(png)
        pSlide.addImage({ data: jpeg, x: 0, y: 0, w: geo.w, h: geo.h })
      } else {
        console.error(`exportDeckToPptx: failed to rasterize slide ${slide.index}`)
      }
    } else {
      if (HERO_TYPES.has(slide.type)) {
        addHeroTitle(pSlide, slide, geo, textColor, primaryColor, fontFace)
      } else {
        addTitle(pSlide, slide, geo, textColor, primaryColor, fontFace)
        const items =
          slide.blocks && slide.blocks.length > 0
            ? blocksToTextProps(slide.blocks, colorForRole, textColor, fontFace)
            : [...bulletsToTextProps(slide.body.bullets, textColor, fontFace), ...paragraphsToTextProps(slide.body.paragraphs, textColor, fontFace)]
        if (items.length > 0) {
          pSlide.addText(items, { x: 0.5, y: geo.bodyY, w: geo.w - 1, h: geo.bodyH, valign: 'top', fontFace })
        }
      }
      const citationText = sanitizeXmlText(slide.citation?.text)
      if (citationText) {
        pSlide.addText(citationText, { x: 0.5, y: geo.citeY, w: geo.w - 1, h: 0.3, fontSize: 8, color: grayColor, fontFace })
      }
    }

    const notes = sanitizeXmlText(slide.speakerNotes)
    if (notes) pSlide.addNotes(notes)
  }

  return pptx
}

/** `onProgress(current, total)` fires before each slide is built, 1-based.
 * `signal`, when aborted, stops the export before starting its next slide
 * (or before the final `writeFile`) by throwing a DOMException named
 * 'AbortError' — exportJobs.ts's runJob recognizes that name and settles the
 * job as `cancelled` rather than `failed`. */
export async function exportDeckToPptx(
  deck: Deck,
  onProgress?: (current: number, total: number) => void,
  signal?: AbortSignal,
): Promise<void> {
  const pptx = await buildDeckPptx(deck, renderSlideToPng, onProgress, signal)
  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')
  await pptx.writeFile({ fileName: `${sanitizeFilename(deck.title)}.pptx` })
}
