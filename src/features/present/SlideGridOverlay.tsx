// Shared Q&A slide-overview grid: renders every slide of the deck as a
// clickable thumbnail grid, so a presenter can jump straight to whichever
// slide a question is about instead of stepping through linearly.
//
// Used by both windows of the Present split (see stageSync.ts's header
// comment for the two-window design):
//   - PresentPlayer (presenter window): interactive — passes `onSelect` so
//     clicking a thumbnail jumps to that slide.
//   - StageWindow (audience window): read-only mirror — omits `onSelect`,
//     shown whenever the mirrored StageState.gridVisible flag is true, so
//     the audience sees the same overview the presenter is looking at
//     (with no click affordance, since the audience can't drive playback).
//
// Thumbnail sizing follows the same base-canvas-plus-scale approach as
// PresentPlayer/StageWindow's main slide (see components/slides/SlideView.tsx's
// header comment): SlideView always renders at a fixed 1280-wide canvas and
// is scaled via its `scale` prop. The grid is fit-to-screen: it measures the
// overlay's content box and picks the column count that lets EVERY slide fit
// without scrolling at the largest possible thumbnail size (audience
// legibility beats density during Q&A). Only when even that would drop below
// MIN_CELL_WIDTH (tiny window / huge deck) does it clamp to the minimum and
// fall back to scrolling.
import { useEffect, useRef, useState } from 'preact/hooks'
import { SlideView } from '../../components/slides/SlideView'
import { t } from '../../i18n'
import type { Deck } from '../../types'
import './slide-grid.css'

const BASE_WIDTH = 1280
/** Must match `.slide-grid { gap }` in slide-grid.css. */
const GRID_GAP = 16
/** Below this the slide body is unreadable anyway — clamp and scroll instead. */
const MIN_CELL_WIDTH = 160

interface GridLayout {
  cols: number
  cellWidth: number
}

export interface SlideGridOverlayProps {
  deck: Deck
  currentIndex: number
  /** Presenter side: jump to a slide. Omitted on the stage window (read-only mirror). */
  onSelect?: (index: number) => void
}

export function SlideGridOverlay({ deck, currentIndex, onSelect }: SlideGridOverlayProps) {
  const [layout, setLayout] = useState<GridLayout | null>(null)
  const overlayRef = useRef<HTMLDivElement>(null)
  const currentItemRef = useRef<HTMLElement>(null)

  const baseHeight = deck.theme.aspectRatio === '4:3' ? Math.round((BASE_WIDTH * 3) / 4) : Math.round((BASE_WIDTH * 9) / 16)
  const slideCount = deck.slides.length

  // Fit-to-screen layout: try every column count and keep the one that fits
  // all rows inside the overlay's content box at the widest cell. Items only
  // render once a layout exists, so there's no wrong-size first paint.
  useEffect(() => {
    const el = overlayRef.current
    if (!el || slideCount === 0) return
    const ratio = baseHeight / BASE_WIDTH
    const compute = () => {
      const styles = getComputedStyle(el)
      const w = el.clientWidth - parseFloat(styles.paddingLeft) - parseFloat(styles.paddingRight)
      const h = el.clientHeight - parseFloat(styles.paddingTop) - parseFloat(styles.paddingBottom)
      if (!(w > 0) || !(h > 0)) return
      let best: GridLayout | null = null
      for (let cols = 1; cols <= slideCount; cols++) {
        const rows = Math.ceil(slideCount / cols)
        const cellWidth = (w - (cols - 1) * GRID_GAP) / cols
        if (cellWidth <= 0) break
        const totalHeight = rows * cellWidth * ratio + (rows - 1) * GRID_GAP
        if (totalHeight <= h && (!best || cellWidth > best.cellWidth)) best = { cols, cellWidth }
      }
      if (!best || best.cellWidth < MIN_CELL_WIDTH) {
        // Nothing readable fits without scrolling — clamp to the minimum
        // readable width and let the overlay scroll vertically instead.
        const cols = Math.max(1, Math.floor((w + GRID_GAP) / (MIN_CELL_WIDTH + GRID_GAP)))
        best = { cols, cellWidth: (w - (cols - 1) * GRID_GAP) / cols }
      }
      setLayout({ cols: best.cols, cellWidth: Math.floor(best.cellWidth) })
    }
    compute()
    const ro = new ResizeObserver(compute)
    ro.observe(el)
    return () => ro.disconnect()
  }, [slideCount, baseHeight])

  // Keep the current slide's thumbnail in view (only matters in the clamped
  // scrolling fallback — the fit-to-screen case shows everything anyway).
  // Items don't exist until a layout has been computed, hence the extra dep.
  const hasLayout = layout !== null
  useEffect(() => {
    currentItemRef.current?.scrollIntoView({ block: 'nearest' })
  }, [currentIndex, hasLayout])

  const scale = layout ? layout.cellWidth / BASE_WIDTH : 1

  return (
    <div class="slide-grid-overlay" ref={overlayRef}>
      <div class="slide-grid" style={layout ? { gridTemplateColumns: `repeat(${layout.cols}, ${layout.cellWidth}px)` } : undefined}>
        {layout && deck.slides.map((slide, index) => {
          const isCurrent = index === currentIndex
          const label = t('present.gridJump', { n: index + 1 })
          const thumbStyle = { aspectRatio: `1280 / ${baseHeight}` }

          const content = (
            <>
              <div class="slide-grid__thumb" style={thumbStyle}>
                <SlideView slide={slide} theme={deck.theme} scale={scale} pageTotal={deck.slides.length} />
              </div>
              <span class="slide-grid__num">{index + 1}</span>
            </>
          )

          const itemClass = `slide-grid__item${isCurrent ? ' slide-grid__item--current' : ''}`

          return onSelect ? (
            <button
              key={slide.id}
              type="button"
              class={itemClass}
              aria-label={label}
              title={label}
              ref={isCurrent ? (currentItemRef as unknown as (el: HTMLButtonElement | null) => void) : undefined}
              onClick={() => onSelect(index)}
            >
              {content}
            </button>
          ) : (
            <div
              key={slide.id}
              class={itemClass}
              aria-label={label}
              title={label}
              ref={isCurrent ? (currentItemRef as unknown as (el: HTMLDivElement | null) => void) : undefined}
            >
              {content}
            </div>
          )
        })}
      </div>
    </div>
  )
}

export default SlideGridOverlay
