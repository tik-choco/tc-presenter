// The slide renderer. Dispatches on Slide.type/layout to a "sample-PDF"
// styled composition (wine-red/navy layered palette, pill boxes, low-text
// big typography, small bottom citation, footer page number — see
// notes-slide-quality.md §2 "デザインの特徴"). Exported standalone so both
// features/editor (thumbnails, per the Wave2 B contract: `<SlideView slide
// theme scale? />`) and features/present (full-screen playback) share one
// renderer instead of drifting.
//
// Sizing: authored at a fixed base canvas (1280x720 for 16:9, 960x720 for
// 4:3) in plain px, then the whole canvas is CSS `transform: scale()`d as a
// single unit — `scale` lets a caller fit it into any container (thumbnail
// vs full-screen) without a second unit system (container queries etc).
import { Check, ChevronRight, Quote } from 'lucide-preact'
import type { JSX } from 'preact'
import { t } from '../../i18n'
import type { DeckTheme, Slide, SlideBullet } from '../../types'
import { BlockStack } from './Blocks'
import './slides.css'
import { SlideVisualBlock } from './SlideVisual'

export interface SlideViewProps {
  slide: Slide
  theme: DeckTheme
  /** Uniform scale factor applied to the fixed-size base canvas. Default 1 (full size). */
  scale?: number
  /** Deck.slides.length — when given, the footer shows "index / total" instead of just "index". */
  pageTotal?: number
  /** Total stage count for this slide's buildStage.groupId, when known (PresentPlayer has full
   * deck context; the editor thumbnail case can omit this and just gets no "of N" suffix). */
  buildStageTotal?: number
}

const HERO_TYPES = new Set<Slide['type']>(['title', 'section_break'])

function BulletList({ bullets }: { bullets: SlideBullet[] }) {
  if (bullets.length === 0) return null
  return (
    <ul class="slide-bullet-list">
      {bullets.map((b, i) => (
        <li key={i} class="slide-bullet" data-form={b.form ?? 'noun_phrase'} style={{ '--indent': b.level }}>
          <span class="slide-bullet__marker" />
          <span class="slide-bullet__text">{b.text}</span>
        </li>
      ))}
    </ul>
  )
}

function AgendaTrail({ bullets }: { bullets: SlideBullet[] }) {
  return (
    <ol class="slide-agenda">
      {bullets.map((b, i) => (
        <li key={i} class="slide-agenda__item">
          {i > 0 && <ChevronRight class="slide-agenda__chevron" size={22} strokeWidth={2.5} aria-hidden="true" />}
          <span class="slide-agenda__num">{i + 1}</span>
          <span class="slide-agenda__label">{b.text}</span>
        </li>
      ))}
    </ol>
  )
}

function RecapList({ bullets }: { bullets: SlideBullet[] }) {
  return (
    <ul class="slide-recap">
      {bullets.map((b, i) => (
        <li key={i} class="slide-recap__item">
          <Check class="slide-recap__check" size={20} strokeWidth={3} aria-hidden="true" />
          <span>{b.text}</span>
        </li>
      ))}
    </ul>
  )
}

function QuoteBlock({ text }: { text: string }) {
  return (
    <div class="slide-quote">
      <Quote class="slide-quote__mark" size={40} strokeWidth={2} />
      <p class="slide-quote__text">{text}</p>
    </div>
  )
}

function Paragraphs({ paragraphs }: { paragraphs: string[] }) {
  if (paragraphs.length === 0) return null
  return (
    <>
      {paragraphs.map((p, i) => (
        <p key={i} class="slide-paragraph">
          {p}
        </p>
      ))}
    </>
  )
}

function SlideBody({ slide }: { slide: Slide }) {
  const { type, layout, body, visual } = slide
  const hasVisual = visual.kind !== 'none' && (visual.elements.length > 0 || !!visual.dataTable || !!visual.chart)

  switch (type) {
    case 'agenda':
      return (
        <div class="slide-content" data-layout={layout}>
          {hasVisual ? <SlideVisualBlock visual={visual} /> : <AgendaTrail bullets={body.bullets} />}
        </div>
      )
    case 'summary':
      return (
        <div class="slide-content" data-layout={layout}>
          <Paragraphs paragraphs={body.paragraphs} />
          <RecapList bullets={body.bullets} />
          {hasVisual && <SlideVisualBlock visual={visual} />}
        </div>
      )
    case 'quote':
      return (
        <div class="slide-content" data-layout={layout}>
          <QuoteBlock text={body.paragraphs[0] ?? body.bullets[0]?.text ?? ''} />
        </div>
      )
    case 'diagram':
      return (
        <div class="slide-content" data-layout={layout}>
          {hasVisual && (
            <div class="slide-content__visual-pane slide-content__visual-pane--main">
              <SlideVisualBlock visual={visual} />
            </div>
          )}
          {body.bullets.length > 0 && (
            <div class="slide-content__caption">
              <BulletList bullets={body.bullets} />
            </div>
          )}
        </div>
      )
    case 'data_table':
    case 'chart':
      return (
        <div class="slide-content" data-layout={layout}>
          {body.bullets.length > 0 && (
            <div class="slide-content__caption">
              <BulletList bullets={body.bullets} />
            </div>
          )}
          {hasVisual && <SlideVisualBlock visual={visual} />}
        </div>
      )
    case 'content':
    default:
      return (
        <div class="slide-content" data-layout={layout}>
          <div class="slide-content__text-pane">
            <Paragraphs paragraphs={body.paragraphs} />
            <BulletList bullets={body.bullets} />
          </div>
          {hasVisual && (
            <div class="slide-content__visual-pane">
              <SlideVisualBlock visual={visual} />
            </div>
          )}
        </div>
      )
  }
}

function HeroBody({ slide }: { slide: Slide }) {
  return (
    <div class="slide-hero">
      {slide.title.badge && (
        <span class="slide-hero__eyebrow">{slide.title.badge.label}</span>
      )}
      <h1 class="slide-hero__title">{slide.title.text || t('slide.untitled')}</h1>
      {slide.body.paragraphs.map((p, i) => (
        <p key={i} class="slide-hero__subtitle">
          {p}
        </p>
      ))}
      {slide.body.bullets.length > 0 && (
        <div class="slide-hero__tags">
          {slide.body.bullets.map((b, i) => (
            <span key={i} class="slide-hero__tag">
              {b.text}
            </span>
          ))}
        </div>
      )}
    </div>
  )
}

export function SlideView({ slide, theme, scale = 1, pageTotal, buildStageTotal }: SlideViewProps) {
  const isHero = HERO_TYPES.has(slide.type)
  const width = 1280
  const height = theme.aspectRatio === '4:3' ? Math.round((width * 3) / 4) : Math.round((width * 9) / 16)
  const palette = theme.colorPalette

  const canvasStyle: JSX.CSSProperties = {
    width: `${width}px`,
    height: `${height}px`,
    transform: `scale(${scale})`,
    transformOrigin: 'top left',
    '--slide-primary': palette?.primary,
    '--slide-secondary': palette?.secondary,
    '--slide-warning': palette?.accentWarning,
    '--slide-gray': palette?.neutralGray,
    '--slide-bg': palette?.background,
    '--slide-text': palette?.textPrimary,
    '--slide-font': theme.fontFamily || undefined,
  }

  const wrapStyle: JSX.CSSProperties = {
    width: `${width * scale}px`,
    height: `${height * scale}px`,
  }

  const buildBadge =
    slide.buildStage.isBuildSlide && slide.buildStage.stageIndex !== null
      ? buildStageTotal
        ? t('slide.buildPartOf', { n: slide.buildStage.stageIndex + 1, total: buildStageTotal })
        : t('slide.buildPart', { n: slide.buildStage.stageIndex + 1 })
      : null

  const hasBlocks = !isHero && !!slide.blocks && slide.blocks.length > 0

  return (
    <div class="slide-scale-wrap" style={wrapStyle}>
      <div class="slide-canvas" data-type={slide.type} data-layout={slide.layout} style={canvasStyle}>
        {buildBadge && <div class="slide-build-pill">{buildBadge}</div>}

        {isHero ? (
          <HeroBody slide={slide} />
        ) : (
          <>
            <header class="slide-header">
              {slide.title.badge && (
                <span class="slide-badge">
                  <span class="slide-badge__num">{slide.title.badge.number}</span>
                  <span class="slide-badge__label">{slide.title.badge.label}</span>
                </span>
              )}
              <h1 class="slide-title">{slide.title.text || t('slide.untitled')}</h1>
            </header>
            {hasBlocks ? <BlockStack blocks={slide.blocks!} /> : <SlideBody slide={slide} />}
          </>
        )}

        {slide.citation?.text && (
          <p class="slide-citation">
            {slide.citation.url ? (
              <a href={slide.citation.url} target="_blank" rel="noreferrer">
                {slide.citation.text}
              </a>
            ) : (
              slide.citation.text
            )}
          </p>
        )}

        {!isHero && (
          <footer class="slide-footer">
            <span class="slide-footer__page">{pageTotal ? `${slide.index} / ${pageTotal}` : slide.index}</span>
          </footer>
        )}
      </div>
    </div>
  )
}

export default SlideView
